/* Движок «Змейки»: canvas, шаги, столкновения, еда, частицы */
(function () {
  'use strict';

  const COLS = 24;
  const ROWS = 24;
  const CELL = 25;
  const SIZE = COLS * CELL;
  const GOLD_LIFETIME = 7;

  const DIFFICULTIES = {
    chill: { key: 'chill', label: 'Спокойная', base: 152, min: 96, wrap: true, obstacles: false },
    classic: { key: 'classic', label: 'Классика', base: 124, min: 76, wrap: false, obstacles: false },
    hardcore: { key: 'hardcore', label: 'Хардкор', base: 106, min: 60, wrap: false, obstacles: true }
  };

  const DIRECTIONS = {
    up: { x: 0, y: -1 },
    down: { x: 0, y: 1 },
    left: { x: -1, y: 0 },
    right: { x: 1, y: 0 }
  };

  const REASONS = {
    wall: 'Змейка врезалась в стену.',
    self: 'Змейка укусила свой хвост.',
    obstacle: 'Препятствие оказалось сильнее.'
  };

  const HARD_BLOCKS = [
    { x: 3, y: 5, w: 5, h: 1 },
    { x: 16, y: 5, w: 5, h: 1 },
    { x: 3, y: 18, w: 5, h: 1 },
    { x: 16, y: 18, w: 5, h: 1 },
    { x: 11, y: 2, w: 2, h: 2 },
    { x: 11, y: 20, w: 2, h: 2 }
  ];

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  class SnakeGame {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.listeners = {};
      this.difficulty = DIFFICULTIES.classic;
      this.raf = 0;
      this.scale = 1;
      this.lastFrame = 0;
      this.accumulator = 0;
      this.elapsed = 0;
      this.status = 'idle';
      this.shake = 0;

      this.loop = this.loop.bind(this);
      this.handleResize = this.handleResize.bind(this);

      if (window.ResizeObserver) {
        this.resizeObserver = new ResizeObserver(this.handleResize);
        this.resizeObserver.observe(canvas);
      } else {
        window.addEventListener('resize', this.handleResize);
      }

      this.reset();
    }

    on(event, handler) {
      if (!this.listeners[event]) this.listeners[event] = [];
      this.listeners[event].push(handler);
      return this;
    }

    emit(event, payload) {
      (this.listeners[event] || []).forEach((handler) => {
        try {
          handler(payload);
        } catch (error) {
          console.error('[snake] обработчик события', event, error);
        }
      });
    }

    get interval() {
      return Math.max(this.difficulty.min, this.difficulty.base - (this.level - 1) * 7);
    }

    get speedMultiplier() {
      return this.difficulty.base / this.interval;
    }

    reset() {
      this.stopLoop();
      this.status = 'idle';
      this.score = 0;
      this.level = 1;
      this.eaten = 0;
      this.elapsed = 0;
      this.accumulator = 0;
      this.lastFrame = 0;
      this.particles = [];
      this.shake = 0;
      this.gold = null;
      this.direction = { x: 1, y: 0 };
      this.queue = [];
      this.obstacles = this.difficulty.obstacles ? HARD_BLOCKS.slice() : [];

      const middleY = Math.floor(ROWS / 2);
      const startX = Math.floor(COLS / 2) - 1;
      this.snake = [
        { x: startX, y: middleY },
        { x: startX - 1, y: middleY },
        { x: startX - 2, y: middleY },
        { x: startX - 3, y: middleY }
      ];

      this.food = this.randomEmptyCell();
      this.emit('state', this.getState());
      this.emit('score', this.getState());
      this.draw();
    }

    setDifficulty(key) {
      if (!DIFFICULTIES[key]) return;
      const wasRunning = this.status === 'running' || this.status === 'paused';
      this.difficulty = DIFFICULTIES[key];
      this.reset();
      if (wasRunning) this.emit('difficulty', this.difficulty);
    }

    start() {
      if (this.status === 'running') return;
      if (this.status === 'paused') return this.resume();
      if (this.status === 'over') this.reset();

      this.status = 'running';
      this.lastFrame = 0;
      this.accumulator = 0;
      this.emit('start', this.getState());
      this.emit('state', this.getState());
      this.raf = window.requestAnimationFrame(this.loop);
    }

    pause() {
      if (this.status !== 'running') return;
      this.status = 'paused';
      this.stopLoop();
      this.draw();
      this.emit('pause', this.getState());
      this.emit('state', this.getState());
    }

    resume() {
      if (this.status !== 'paused') return;
      this.status = 'running';
      this.lastFrame = 0;
      this.accumulator = 0;
      this.emit('resume', this.getState());
      this.emit('state', this.getState());
      this.raf = window.requestAnimationFrame(this.loop);
    }

    togglePause() {
      if (this.status === 'running') this.pause();
      else if (this.status === 'paused') this.resume();
    }

    restart() {
      this.reset();
      this.start();
    }

    stopLoop() {
      if (this.raf) {
        window.cancelAnimationFrame(this.raf);
        this.raf = 0;
      }
    }

    setDirection(name) {
      const next = typeof name === 'string' ? DIRECTIONS[name] : name;
      if (!next) return false;

      const last = this.queue.length ? this.queue[this.queue.length - 1] : this.direction;
      if (next.x === -last.x && next.y === -last.y) return false;
      if (next.x === last.x && next.y === last.y) return false;
      if (this.queue.length >= 2) return false;

      this.queue.push(next);
      return true;
    }

    loop(timestamp) {
      if (this.status !== 'running') return;

      if (!this.lastFrame) this.lastFrame = timestamp;
      const dt = clamp(timestamp - this.lastFrame, 0, 200);
      this.lastFrame = timestamp;
      this.elapsed += dt / 1000;
      this.accumulator += dt;

      const stepInterval = this.interval;
      let guard = 0;
      while (this.accumulator >= stepInterval && this.status === 'running' && guard < 6) {
        this.accumulator -= stepInterval;
        this.step();
        guard += 1;
      }

      this.updateEffects(dt);
      this.draw(timestamp);

      if (this.status === 'running') {
        this.raf = window.requestAnimationFrame(this.loop);
      }
    }

    step() {
      if (this.queue.length) this.direction = this.queue.shift();

      const head = this.snake[0];
      let nx = head.x + this.direction.x;
      let ny = head.y + this.direction.y;

      if (this.difficulty.wrap) {
        nx = (nx + COLS) % COLS;
        ny = (ny + ROWS) % ROWS;
      } else if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) {
        return this.gameOver('wall');
      }

      if (this.isObstacle(nx, ny)) return this.gameOver('obstacle');

      const willGrow = Boolean(this.food && nx === this.food.x && ny === this.food.y);
      const willGold = Boolean(this.gold && nx === this.gold.x && ny === this.gold.y);
      const body = willGrow ? this.snake : this.snake.slice(0, Math.max(0, this.snake.length - 1));

      if (body.some((segment) => segment.x === nx && segment.y === ny)) {
        return this.gameOver('self');
      }

      this.snake.unshift({ x: nx, y: ny });

      if (willGrow) {
        this.eaten += 1;
        this.score += 10;
        this.spawnParticles(nx, ny, '#ff7b7b', 14);
        this.eatShake(0.35);
        this.emit('eat', { golden: false, state: this.getState() });
        this.spawnFood();

        const newLevel = 1 + Math.floor(this.eaten / 5);
        if (newLevel !== this.level) {
          this.level = newLevel;
          this.emit('levelup', this.getState());
        }
        if (this.eaten % 4 === 0 && !this.gold) this.spawnGold();
        this.emit('score', this.getState());
      } else if (willGold) {
        this.score += 50;
        this.spawnParticles(nx, ny, '#ffc857', 22);
        this.eatShake(0.5);
        this.emit('eat', { golden: true, state: this.getState() });
        this.gold = null;
        this.snake.pop();
        this.emit('score', this.getState());
      } else {
        this.snake.pop();
      }

      if (this.gold && this.elapsed >= this.gold.expiresAt) this.gold = null;
      this.emit('state', this.getState());
    }

    gameOver(reason) {
      this.stopLoop();
      this.status = 'over';
      this.shake = 1;
      this.spawnParticles(this.snake[0].x, this.snake[0].y, '#b7ff6a', 26);
      this.emit('gameover', {
        reason,
        message: REASONS[reason] || 'Игра окончена.',
        score: this.score,
        level: this.level,
        duration: Math.round(this.elapsed),
        difficulty: this.difficulty.key
      });
      this.emit('state', this.getState());
      this.draw();
    }

    eatShake(value) {
      this.shake = Math.max(this.shake, value);
    }

    isObstacle(x, y) {
      return this.obstacles.some((block) => (
        x >= block.x && x < block.x + block.w && y >= block.y && y < block.y + block.h
      ));
    }

    occupiedCells() {
      const occupied = new Set();
      this.snake.forEach((segment) => occupied.add(segment.x + ',' + segment.y));
      this.obstacles.forEach((block) => {
        for (let x = block.x; x < block.x + block.w; x++) {
          for (let y = block.y; y < block.y + block.h; y++) {
            occupied.add(x + ',' + y);
          }
        }
      });
      if (this.food) occupied.add(this.food.x + ',' + this.food.y);
      if (this.gold) occupied.add(this.gold.x + ',' + this.gold.y);
      return occupied;
    }

    randomEmptyCell() {
      const occupied = this.occupiedCells();
      const free = [];
      for (let x = 0; x < COLS; x++) {
        for (let y = 0; y < ROWS; y++) {
          if (!occupied.has(x + ',' + y)) free.push({ x, y });
        }
      }
      if (!free.length) return { x: 1, y: 1 };
      return free[Math.floor(Math.random() * free.length)];
    }

    spawnFood() {
      this.food = this.randomEmptyCell();
      this.emit('food', this.food);
    }

    spawnGold() {
      const cell = this.randomEmptyCell();
      this.gold = { x: cell.x, y: cell.y, expiresAt: this.elapsed + GOLD_LIFETIME, bornAt: this.elapsed };
      this.emit('gold', this.gold);
    }

    spawnParticles(cellX, cellY, color, count) {
      for (let i = 0; i < count; i++) {
        const angle = Math.random() * Math.PI * 2;
        const force = 40 + Math.random() * 150;
        this.particles.push({
          x: (cellX + 0.5) * CELL,
          y: (cellY + 0.5) * CELL,
          vx: Math.cos(angle) * force,
          vy: Math.sin(angle) * force,
          life: 0.45 + Math.random() * 0.5,
          maxLife: 0.95,
          size: 2 + Math.random() * 3.5,
          color
        });
      }
    }

    updateEffects(dt) {
      const seconds = dt / 1000;
      this.shake = Math.max(0, this.shake - seconds * 2.9);
      this.particles = this.particles.filter((particle) => {
        particle.life -= seconds;
        particle.x += particle.vx * seconds;
        particle.y += particle.vy * seconds;
        particle.vx *= 0.96;
        particle.vy *= 0.96;
        return particle.life > 0;
      });
    }

    handleResize() {
      this.draw();
    }

    syncCanvas() {
      const rect = this.canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const size = Math.max(1, Math.round(rect.width * dpr));
      if (this.canvas.width !== size || this.canvas.height !== size) {
        this.canvas.width = size;
        this.canvas.height = size;
      }
      this.scale = this.canvas.width / SIZE;
    }

    draw(timestamp) {
      const ctx = this.ctx;
      this.syncCanvas();
      if (!this.scale) return;

      ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
      ctx.clearRect(0, 0, SIZE, SIZE);

      if (this.shake > 0) {
        const offset = this.shake * 7;
        ctx.translate((Math.random() - 0.5) * offset, (Math.random() - 0.5) * offset);
      }

      this.drawBackground(ctx);
      if (this.status === 'idle') this.drawIdleDecor(ctx);
      this.drawObstacles(ctx);
      if (this.food) this.drawFood(ctx, timestamp || 0);
      if (this.gold) this.drawGold(ctx, timestamp || 0);
      this.drawSnake(ctx);
      this.drawParticles(ctx);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }

    drawBackground(ctx) {
      const gradient = ctx.createRadialGradient(SIZE * 0.5, SIZE * 0.38, 40, SIZE * 0.5, SIZE * 0.5, SIZE * 0.78);
      gradient.addColorStop(0, '#0b1b12');
      gradient.addColorStop(1, '#040c08');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, SIZE, SIZE);

      ctx.strokeStyle = 'rgba(183, 255, 106, 0.05)';
      ctx.lineWidth = 1;
      for (let i = 1; i < COLS; i++) {
        ctx.beginPath();
        ctx.moveTo(i * CELL, 0);
        ctx.lineTo(i * CELL, SIZE);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, i * CELL);
        ctx.lineTo(SIZE, i * CELL);
        ctx.stroke();
      }

      const vignette = ctx.createRadialGradient(SIZE / 2, SIZE / 2, SIZE * 0.25, SIZE / 2, SIZE / 2, SIZE * 0.72);
      vignette.addColorStop(0, 'rgba(0, 0, 0, 0)');
      vignette.addColorStop(1, 'rgba(0, 0, 0, 0.45)');
      ctx.fillStyle = vignette;
      ctx.fillRect(0, 0, SIZE, SIZE);
    }

    drawIdleDecor(ctx) {
      const path = [
        { x: 2, y: 21 }, { x: 3, y: 21 }, { x: 4, y: 21 }, { x: 5, y: 21 },
        { x: 6, y: 21 }, { x: 7, y: 21 }, { x: 7, y: 20 }, { x: 7, y: 19 },
        { x: 8, y: 19 }, { x: 9, y: 19 }, { x: 10, y: 19 }, { x: 11, y: 19 },
        { x: 11, y: 20 }, { x: 11, y: 21 }, { x: 12, y: 21 }, { x: 13, y: 21 },
        { x: 14, y: 21 }, { x: 15, y: 21 }, { x: 16, y: 21 }
      ];

      ctx.save();
      for (let index = path.length - 1; index >= 0; index--) {
        const cell = path[index];
        const ratio = index / (path.length - 1);
        ctx.globalAlpha = index === path.length - 1 ? 0.42 : 0.2;
        ctx.fillStyle = 'hsl(' + lerp(96, 158, ratio) + ', 78%, ' + lerp(58, 40, ratio) + '%)';
        this.roundRect(ctx, cell.x * CELL + 3, cell.y * CELL + 3, CELL - 6, CELL - 6, 6);
        ctx.fill();
      }

      const head = path[path.length - 1];
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = '#07120c';
      ctx.beginPath();
      ctx.arc((head.x + 0.66) * CELL, (head.y + 0.34) * CELL, 1.7, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc((head.x + 0.66) * CELL, (head.y + 0.66) * CELL, 1.7, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    drawObstacles(ctx) {
      this.obstacles.forEach((block) => {
        const x = block.x * CELL + 2;
        const y = block.y * CELL + 2;
        const w = block.w * CELL - 4;
        const h = block.h * CELL - 4;
        ctx.save();
        ctx.fillStyle = 'rgba(255, 112, 112, 0.12)';
        ctx.strokeStyle = 'rgba(255, 112, 112, 0.5)';
        ctx.lineWidth = 1.4;
        this.roundRect(ctx, x, y, w, h, 5);
        ctx.fill();
        ctx.stroke();
        ctx.strokeStyle = 'rgba(255, 112, 112, 0.18)';
        for (let lineX = x + 7; lineX < x + w; lineX += 9) {
          ctx.beginPath();
          ctx.moveTo(lineX, y + 4);
          ctx.lineTo(lineX, y + h - 4);
          ctx.stroke();
        }
        ctx.restore();
      });
    }

    drawFood(ctx, timestamp) {
      const cx = (this.food.x + 0.5) * CELL;
      const cy = (this.food.y + 0.5) * CELL;
      const pulse = 1 + Math.sin(timestamp / 260) * 0.07;

      ctx.save();
      ctx.shadowColor = 'rgba(255, 92, 92, 0.8)';
      ctx.shadowBlur = 18;
      const gradient = ctx.createRadialGradient(cx - 3, cy - 4, 1, cx, cy, 11 * pulse);
      gradient.addColorStop(0, '#ffb3a8');
      gradient.addColorStop(0.45, '#ff6b6b');
      gradient.addColorStop(1, '#b81f38');
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(cx, cy, 9 * pulse, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      ctx.strokeStyle = '#7cf08a';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx + 1, cy - 8);
      ctx.quadraticCurveTo(cx + 5, cy - 14, cx + 9, cy - 12);
      ctx.stroke();
    }

    drawGold(ctx, timestamp) {
      const remaining = clamp((this.gold.expiresAt - this.elapsed) / GOLD_LIFETIME, 0, 1);
      const cx = (this.gold.x + 0.5) * CELL;
      const cy = (this.gold.y + 0.5) * CELL;
      const blink = remaining < 0.3 ? 0.55 + Math.sin(timestamp / 90) * 0.35 : 1;
      const pulse = 1 + Math.sin(timestamp / 180) * 0.08;

      ctx.save();
      ctx.globalAlpha = blink;
      ctx.shadowColor = 'rgba(255, 200, 87, 0.9)';
      ctx.shadowBlur = 22;
      const gradient = ctx.createRadialGradient(cx - 3, cy - 4, 1, cx, cy, 12 * pulse);
      gradient.addColorStop(0, '#fff6c9');
      gradient.addColorStop(0.5, '#ffd166');
      gradient.addColorStop(1, '#c98b16');
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(cx, cy, 10 * pulse, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      ctx.save();
      ctx.strokeStyle = 'rgba(255, 216, 120, ' + (0.35 + remaining * 0.55) + ')';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, 14, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * remaining);
      ctx.stroke();
      ctx.restore();
    }

    drawSnake(ctx) {
      const length = this.snake.length;
      for (let index = length - 1; index >= 0; index--) {
        const segment = this.snake[index];
        const ratio = length <= 1 ? 0 : index / (length - 1);
        const x = segment.x * CELL + 2;
        const y = segment.y * CELL + 2;
        const size = CELL - 4;
        const hue = lerp(96, 152, ratio);
        const lightness = lerp(66, 38, ratio);
        const alpha = lerp(1, 0.72, ratio);

        ctx.save();
        ctx.globalAlpha = alpha;
        if (index === 0) {
          ctx.shadowColor = 'rgba(183, 255, 106, 0.65)';
          ctx.shadowBlur = 18;
        }
        ctx.fillStyle = 'hsl(' + hue + ', 82%, ' + lightness + '%)';
        this.roundRect(ctx, x, y, size, size, 7);
        ctx.fill();

        if (index === 0) {
          ctx.shadowBlur = 0;
          ctx.fillStyle = 'rgba(255, 255, 255, 0.28)';
          this.roundRect(ctx, x + 4, y + 4, size - 8, 5, 3);
          ctx.fill();
          this.drawEyes(ctx, x, y, size);
        }
        ctx.restore();
      }
    }

    drawEyes(ctx, x, y, size) {
      const dir = this.direction;
      const forwardX = dir.x;
      const forwardY = dir.y;
      const sideX = -forwardY;
      const sideY = forwardX;
      const centerX = x + size / 2;
      const centerY = y + size / 2;

      ctx.fillStyle = '#07120c';
      const positions = [
        { x: centerX + forwardX * 5 - sideX * 4.5, y: centerY + forwardY * 5 - sideY * 4.5 },
        { x: centerX + forwardX * 5 + sideX * 4.5, y: centerY + forwardY * 5 + sideY * 4.5 }
      ];
      positions.forEach((eye) => {
        ctx.beginPath();
        ctx.arc(eye.x, eye.y, 2.2, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
      positions.forEach((eye) => {
        ctx.beginPath();
        ctx.arc(eye.x + forwardX * 0.8, eye.y + forwardY * 0.8, 0.8, 0, Math.PI * 2);
        ctx.fill();
      });
    }

    drawParticles(ctx) {
      this.particles.forEach((particle) => {
        const alpha = clamp(particle.life / particle.maxLife, 0, 1);
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.fillStyle = particle.color;
        ctx.beginPath();
        ctx.arc(particle.x, particle.y, particle.size, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      });
    }

    roundRect(ctx, x, y, width, height, radius) {
      const r = Math.min(radius, width / 2, height / 2);
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + width, y, x + width, y + height, r);
      ctx.arcTo(x + width, y + height, x, y + height, r);
      ctx.arcTo(x, y + height, x, y, r);
      ctx.arcTo(x, y, x + width, y, r);
      ctx.closePath();
    }

    getState() {
      return {
        status: this.status,
        score: this.score,
        level: this.level,
        length: this.snake.length,
        eaten: this.eaten,
        elapsed: Math.round(this.elapsed),
        speed: this.speedMultiplier,
        interval: this.interval,
        difficulty: this.difficulty.key,
        food: this.food,
        gold: this.gold
      };
    }
  }

  window.SnakeGame = SnakeGame;
  window.SNAKE_DIFFICULTIES = DIFFICULTIES;
})();
