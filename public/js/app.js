/* Интерфейс «Змейки»: игра, рекорды, звук, модальные окна */
(function () {
  'use strict';

  const $ = (selector, root) => (root || document).querySelector(selector);
  const $$ = (selector, root) => Array.from((root || document).querySelectorAll(selector));

  const KEYS = {
    nickname: 'snake.nickname.v1',
    best: 'snake.best.v1',
    games: 'snake.games.v1',
    lastScore: 'snake.lastScore.v1',
    history: 'snake.history.v1',
    sound: 'snake.sound.v1',
    difficulty: 'snake.difficulty.v1'
  };

  const DIFFICULTY_LABELS = {
    chill: 'Спокойная',
    classic: 'Классика',
    hardcore: 'Хардкор'
  };

  const state = {
    nickname: '',
    best: 0,
    games: 0,
    lastScore: null,
    history: [],
    sound: true,
    difficulty: 'classic',
    myRank: null,
    submitted: false
  };

  const dom = {};
  let game = null;
  let modalOpen = false;
  let audioContext = null;
  let pointerStart = null;
  let leaderboardLoading = false;

  /* ---------- утилиты ---------- */

  function readStorage(key, fallback) {
    try {
      const raw = window.localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  function writeStorage(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* локальное хранилище может быть недоступно */
    }
  }

  function formatTime(totalSeconds) {
    const seconds = Math.max(0, Math.round(Number(totalSeconds) || 0));
    const minutes = Math.floor(seconds / 60);
    return minutes + ':' + String(seconds % 60).padStart(2, '0');
  }

  function displayNickname() {
    return state.nickname || 'Игрок';
  }

  function normalizeNickname(value) {
    const clean = String(value || '')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim()
      .replace(/\s+/g, ' ');
    if (clean.length < 2 || clean.length > 20) return null;
    if (!/^[\p{L}\p{N}][\p{L}\p{N} _.\-]*$/u.test(clean)) return null;
    return clean;
  }

  function toast(message, type) {
    const root = dom.toasts;
    if (!root) return;
    while (root.children.length >= 3) root.removeChild(root.firstElementChild);

    const element = document.createElement('div');
    element.className = 'toast toast--' + (type || 'ok');
    element.textContent = message;
    root.appendChild(element);
    window.requestAnimationFrame(() => element.classList.add('is-visible'));
    window.setTimeout(() => {
      element.classList.remove('is-visible');
      window.setTimeout(() => element.remove(), 220);
    }, 3800);
  }

  /* ---------- звук ---------- */

  function ensureAudio() {
    if (!state.sound) return null;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    if (!audioContext) audioContext = new Ctor();
    if (audioContext.state === 'suspended') audioContext.resume();
    return audioContext;
  }

  function tone(frequency, options) {
    if (!state.sound) return;
    const ctx = ensureAudio();
    if (!ctx) return;
    const config = Object.assign({ duration: 0.08, type: 'square', gain: 0.03, when: 0, slide: null }, options || {});
    const start = ctx.currentTime + config.when;
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();

    oscillator.type = config.type;
    oscillator.frequency.setValueAtTime(frequency, start);
    if (config.slide) {
      oscillator.frequency.exponentialRampToValueAtTime(Math.max(30, config.slide), start + config.duration);
    }

    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(config.gain, start + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + config.duration);

    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start(start);
    oscillator.stop(start + config.duration + 0.03);
  }

  function soundEat(golden) {
    if (golden) {
      tone(880, { duration: 0.08, type: 'triangle', gain: 0.045 });
      tone(1320, { duration: 0.12, type: 'triangle', gain: 0.04, when: 0.07 });
      tone(1760, { duration: 0.1, type: 'sine', gain: 0.025, when: 0.14 });
    } else {
      tone(620, { duration: 0.06, type: 'square', gain: 0.03, slide: 880 });
    }
  }

  function soundLevelUp() {
    [523, 659, 784].forEach((frequency, index) => {
      tone(frequency, { duration: 0.1, type: 'triangle', gain: 0.038, when: index * 0.075 });
    });
  }

  function soundGameOver() {
    tone(330, { duration: 0.5, type: 'sawtooth', gain: 0.03, slide: 80 });
    tone(220, { duration: 0.4, type: 'triangle', gain: 0.025, when: 0.08, slide: 60 });
  }

  function soundStart() {
    tone(440, { duration: 0.07, type: 'square', gain: 0.03 });
    tone(660, { duration: 0.1, type: 'square', gain: 0.03, when: 0.07 });
  }

  function soundPause() {
    tone(340, { duration: 0.07, type: 'triangle', gain: 0.025, slide: 260 });
  }

  /* ---------- HUD и оверлей ---------- */

  function renderHud(snapshot) {
    if (!snapshot) return;
    dom.score.textContent = String(snapshot.score);
    dom.best.textContent = String(Math.max(state.best, snapshot.score));
    dom.level.textContent = String(snapshot.level);
    dom.length.textContent = String(snapshot.length);
    dom.speed.textContent = '×' + snapshot.speed.toFixed(1);
  }

  function renderOverlay() {
    if (!game) return;
    const status = game.status;
    const snapshot = game.getState();

    dom.boardOverlay.classList.toggle('is-hidden', status === 'running');

    if (status === 'idle') {
      dom.overlayEyebrow.textContent = 'Готовы?';
      dom.overlayTitle.textContent = 'Соберите яблоки';
      dom.overlayText.textContent = 'Стрелки, WASD или свайпы. Кнопки — внизу.';
      dom.overlayButton.textContent = 'Начать игру';
    } else if (status === 'paused') {
      dom.overlayEyebrow.textContent = 'Пауза';
      dom.overlayTitle.textContent = 'Передышка';
      dom.overlayText.textContent = 'Продолжите, когда будете готовы.';
      dom.overlayButton.textContent = 'Продолжить';
    } else if (status === 'over') {
      dom.overlayEyebrow.textContent = 'Партия окончена';
      dom.overlayTitle.textContent = 'Ещё раз?';
      dom.overlayText.textContent = 'Счёт: ' + snapshot.score + '. Попробуйте побить свой рекорд.';
      dom.overlayButton.textContent = 'Играть заново';
    }
  }

  function updateControls() {
    if (!game) return;
    const status = game.status;
    dom.playButton.disabled = status === 'running';
    dom.pauseButton.disabled = status !== 'running' && status !== 'paused';
    dom.pauseButton.textContent = status === 'paused' ? 'Продолжить' : 'Пауза';
  }

  function renderGame(snapshot) {
    renderHud(snapshot || game.getState());
    renderOverlay();
    updateControls();
  }

  /* ---------- локальная статистика ---------- */

  function renderLocalStats() {
    dom.bestLocal.textContent = String(state.best);
    dom.gamesLocal.textContent = String(state.games);
    dom.lastScore.textContent = state.lastScore === null ? '—' : String(state.lastScore);
    dom.myRank.textContent = state.myRank ? '#' + state.myRank : '—';
    dom.profileName.textContent = displayNickname();
    renderHistory();
  }

  function renderHistory() {
    dom.historyList.innerHTML = '';
    if (!state.history.length) {
      const empty = document.createElement('li');
      empty.className = 'empty-note';
      empty.textContent = 'Пока нет результатов';
      dom.historyList.appendChild(empty);
      return;
    }

    state.history.slice(0, 5).forEach((run) => {
      const item = document.createElement('li');
      const meta = document.createElement('span');
      meta.className = 'run-meta';

      const score = document.createElement('strong');
      score.textContent = run.score + ' очков';
      const time = document.createElement('span');
      time.textContent = formatTime(run.duration) + ' · ' + (DIFFICULTY_LABELS[run.difficulty] || 'Классика');

      meta.appendChild(score);
      meta.appendChild(time);

      const level = document.createElement('span');
      level.className = 'run-diff';
      level.textContent = 'ур. ' + run.level;

      item.appendChild(meta);
      item.appendChild(level);
      dom.historyList.appendChild(item);
    });
  }

  function recordResult(result) {
    state.games += 1;
    state.lastScore = result.score;
    state.best = Math.max(state.best, result.score);
    state.history.unshift({
      score: result.score,
      level: result.level,
      duration: result.duration,
      difficulty: result.difficulty,
      date: new Date().toISOString()
    });
    state.history = state.history.slice(0, 10);

    writeStorage(KEYS.best, state.best);
    writeStorage(KEYS.games, state.games);
    writeStorage(KEYS.lastScore, state.lastScore);
    writeStorage(KEYS.history, state.history);
    renderLocalStats();
  }

  /* ---------- рейтинг ---------- */

  function setServerStatus(ok, message) {
    dom.serverStatus.classList.toggle('is-ok', Boolean(ok));
    dom.serverStatus.classList.toggle('is-bad', !ok);
    dom.serverStatusText.textContent = message;
  }

  function updateHeroStats(total, players) {
    if (typeof total === 'number') dom.heroGames.textContent = String(total);
    if (typeof players === 'number') dom.heroPlayers.textContent = String(players);
  }

  function renderLeaderboard(entries) {
    dom.leaderboardList.innerHTML = '';

    if (!entries.length) {
      const empty = document.createElement('li');
      empty.className = 'empty-note';
      empty.textContent = 'Пока никто не играл. Станьте первым!';
      dom.leaderboardList.appendChild(empty);
      return;
    }

    const own = displayNickname().toLowerCase();

    entries.slice(0, 10).forEach((entry) => {
      const item = document.createElement('li');
      item.className = 'rank-row';
      if (entry.rank === 1) item.classList.add('rank-row--first');
      if (entry.rank === 2) item.classList.add('rank-row--second');
      if (entry.rank === 3) item.classList.add('rank-row--third');
      if (entry.nickname.toLowerCase() === own) item.classList.add('is-me');

      const position = document.createElement('span');
      position.className = 'rank-row__pos';
      position.textContent = String(entry.rank);

      const name = document.createElement('span');
      name.className = 'rank-row__name';
      const strong = document.createElement('strong');
      strong.textContent = entry.nickname;
      const small = document.createElement('small');
      small.textContent = (DIFFICULTY_LABELS[entry.difficulty] || 'Классика') + ' · ур. ' + entry.level;
      name.appendChild(strong);
      name.appendChild(small);

      const score = document.createElement('span');
      score.className = 'rank-row__score';
      score.textContent = String(entry.score);

      item.appendChild(position);
      item.appendChild(name);
      item.appendChild(score);
      dom.leaderboardList.appendChild(item);
    });
  }

  function applyBoardData(data) {
    if (Array.isArray(data.entries)) renderLeaderboard(data.entries);
    if (data.stats) updateHeroStats(data.total, data.stats.players);
    if (typeof data.total === 'number') {
      dom.leaderboardFoot.textContent = data.total + ' партий · ' + (data.stats ? data.stats.players : 0) + ' игроков';
    }
  }

  async function loadLeaderboard(quiet) {
    if (leaderboardLoading) return;
    leaderboardLoading = true;
    dom.refreshLeaderboard.classList.add('is-loading');
    dom.refreshLeaderboard.disabled = true;
    dom.leaderboardError.hidden = true;

    try {
      const data = await window.SnakeAPI.leaderboard(10);
      applyBoardData(data);

      const own = displayNickname().toLowerCase();
      const mine = (data.entries || [])
        .filter((entry) => entry.nickname.toLowerCase() === own)
        .sort((a, b) => b.score - a.score)[0];

      if (mine) {
        state.myRank = mine.rank;
        if (mine.score > state.best) {
          state.best = mine.score;
          writeStorage(KEYS.best, state.best);
          renderHud(game.getState());
        }
      } else {
        state.myRank = null;
      }
      renderLocalStats();
      setServerStatus(true, 'Сервер на связи · ' + data.total + ' партий');
    } catch (error) {
      dom.leaderboardError.hidden = false;
      dom.leaderboardFoot.textContent = 'Нет связи с сервером';
      dom.leaderboardList.innerHTML = '';
      const offline = document.createElement('li');
      offline.className = 'empty-note';
      offline.textContent = 'Рекорды появятся, когда сервер будет доступен.';
      dom.leaderboardList.appendChild(offline);
      setServerStatus(false, 'Сервер не отвечает — запустите node server.js');
      if (!quiet) toast('Не удалось загрузить рекорды', 'error');
    } finally {
      leaderboardLoading = false;
      dom.refreshLeaderboard.classList.remove('is-loading');
      dom.refreshLeaderboard.disabled = false;
    }
  }

  async function checkServer() {
    try {
      const health = await window.SnakeAPI.health();
      setServerStatus(true, 'Сервер на связи · Node.js ' + health.version);
    } catch {
      setServerStatus(false, 'Сервер не отвечает — запустите node server.js');
    }
  }

  function setSaveStatus(text, tone) {
    dom.saveStatus.textContent = text;
    dom.saveStatus.classList.remove('is-ok', 'is-bad');
    if (tone === 'ok') dom.saveStatus.classList.add('is-ok');
    if (tone === 'bad') dom.saveStatus.classList.add('is-bad');
  }

  async function submitResult(result) {
    if (!result || result.score <= 0) {
      setSaveStatus('Счёт 0 — сохранять нечего.', '');
      dom.retrySave.hidden = true;
      return;
    }

    dom.retrySave.hidden = true;
    setSaveStatus('Сохраняем результат…', '');

    try {
      const data = await window.SnakeAPI.submitScore({
        nickname: displayNickname(),
        score: result.score,
        level: result.level,
        duration: Math.max(1, Math.round(result.duration)),
        difficulty: result.difficulty
      });

      if (data.saved) {
        state.myRank = data.rank;
        setSaveStatus('Результат сохранён · место #' + data.rank, 'ok');
        toast('Вы в зале славы: #' + data.rank, 'ok');
      } else {
        setSaveStatus(data.message || 'Результат не попал в топ.', '');
      }

      applyBoardData(data);
      renderLocalStats();
    } catch (error) {
      setSaveStatus('Не удалось сохранить: ' + error.message, 'bad');
      dom.retrySave.hidden = false;
    }
  }

  /* ---------- модальное окно ---------- */

  function openGameOver(result) {
    state.lastResult = result;
    state.submitted = false;
    dom.gameOverReason.textContent = result.message;
    dom.finalScore.textContent = String(result.score);
    dom.finalLevel.textContent = String(result.level);
    dom.finalTime.textContent = formatTime(result.duration);
    dom.retrySave.hidden = true;
    setSaveStatus(result.score > 0 ? 'Сохраняем результат…' : 'Счёт 0 — сохранять нечего.', '');

    dom.gameOverModal.hidden = false;
    modalOpen = true;
    document.body.classList.add('no-scroll');
    window.setTimeout(() => dom.playAgain.focus({ preventScroll: true }), 60);
    renderOverlay();
  }

  function closeModal() {
    if (!modalOpen) return;
    dom.gameOverModal.hidden = true;
    modalOpen = false;
    document.body.classList.remove('no-scroll');
    if (game.status === 'over') renderOverlay();
    if (dom.canvas) dom.canvas.focus({ preventScroll: true });
  }

  /* ---------- игровые действия ---------- */

  function startGame() {
    ensureAudio();
    if (game.status === 'paused') {
      game.resume();
      return;
    }
    if (game.status === 'over') game.reset();
    if (game.status === 'idle') {
      game.start();
      dom.canvas.focus({ preventScroll: true });
    }
  }

  function playAgain() {
    closeModal();
    ensureAudio();
    game.restart();
    dom.canvas.focus({ preventScroll: true });
  }

  function restartGame() {
    closeModal();
    ensureAudio();
    game.restart();
  }

  function setDifficulty(key) {
    if (!window.SNAKE_DIFFICULTIES[key] || state.difficulty === key) return;
    state.difficulty = key;
    writeStorage(KEYS.difficulty, key);
    updateDifficultyButtons();
    closeModal();
    game.setDifficulty(key);
    renderGame(game.getState());
    toast('Сложность: ' + DIFFICULTY_LABELS[key] + '. Новая игра.', 'info');
  }

  function updateDifficultyButtons() {
    $$('#difficulty [data-difficulty]').forEach((button) => {
      const active = button.getAttribute('data-difficulty') === state.difficulty;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  }

  /* ---------- никнейм ---------- */

  function updateNicknameUi() {
    dom.nickname.value = state.nickname;
    dom.profileName.textContent = displayNickname();
    dom.nicknameNote.textContent = '2–20 символов: буквы, цифры, пробел, точка, дефис или _';
    dom.nicknameNote.classList.remove('is-error');
  }

  function saveNickname(event) {
    if (event) event.preventDefault();
    const name = normalizeNickname(dom.nickname.value);
    if (!name) {
      dom.nicknameNote.textContent = 'Имя не подходит: 2–20 символов, буквы, цифры, пробел, точка, дефис или _';
      dom.nicknameNote.classList.add('is-error');
      dom.nickname.focus();
      return;
    }

    state.nickname = name;
    writeStorage(KEYS.nickname, state.nickname);
    updateNicknameUi();
    renderLocalStats();
    toast('Имя сохранено: ' + name, 'ok');
    loadLeaderboard(true);
  }

  /* ---------- звук ---------- */

  function updateSoundButton() {
    dom.soundToggle.classList.toggle('is-muted', !state.sound);
    dom.soundToggle.setAttribute('aria-pressed', String(state.sound));
    dom.soundToggle.setAttribute('aria-label', state.sound ? 'Выключить звук' : 'Включить звук');
    dom.soundToggle.title = state.sound ? 'Звук включён (M)' : 'Звук выключен (M)';
  }

  function toggleSound() {
    state.sound = !state.sound;
    writeStorage(KEYS.sound, state.sound);
    updateSoundButton();
    if (state.sound) {
      ensureAudio();
      tone(880, { duration: 0.08, type: 'triangle', gain: 0.03 });
    }
  }

  /* ---------- события игры ---------- */

  function bindGameEvents() {
    game.on('state', (snapshot) => {
      renderGame(snapshot);
    });

    game.on('score', (snapshot) => {
      renderHud(snapshot);
    });

    game.on('start', () => {
      soundStart();
      renderGame(game.getState());
    });

    game.on('pause', () => {
      soundPause();
      renderGame(game.getState());
    });

    game.on('resume', () => {
      renderGame(game.getState());
    });

    game.on('eat', (payload) => {
      soundEat(payload.golden);
    });

    game.on('levelup', () => {
      soundLevelUp();
    });

    game.on('gameover', (result) => {
      soundGameOver();
      recordResult(result);
      openGameOver(result);
      if (result.score > 0) submitResult(result);
    });
  }

  /* ---------- ввод ---------- */

  function handleKeydown(event) {
    const tag = event.target && event.target.tagName;
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

    if (event.key === 'Escape') {
      if (modalOpen) closeModal();
      return;
    }
    if (typing) return;

    const key = event.key.toLowerCase();

    if ([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(key)) {
      event.preventDefault();
    }

    if (key === ' ' || key === 'spacebar' || key === 'p') {
      if (game.status === 'running') game.pause();
      else if (game.status === 'paused') game.resume();
      else if (game.status === 'idle' || game.status === 'over') {
        if (modalOpen) playAgain();
        else startGame();
      }
      return;
    }

    if (key === 'enter') {
      if (modalOpen) playAgain();
      else if (game.status === 'paused') game.resume();
      else if (game.status === 'idle' || game.status === 'over') startGame();
      return;
    }

    if (key === 'r') {
      restartGame();
      return;
    }

    if (key === 'm') {
      toggleSound();
      return;
    }

    const directions = {
      arrowup: 'up', w: 'up',
      arrowdown: 'down', s: 'down',
      arrowleft: 'left', a: 'left',
      arrowright: 'right', d: 'right'
    };

    const direction = directions[key];
    if (!direction) return;

    if (game.status === 'idle' || game.status === 'over') {
      startGame();
    }
    if (game.status === 'running') {
      game.setDirection(direction);
    }
  }

  function handlePointerDown(event) {
    pointerStart = { x: event.clientX, y: event.clientY, time: Date.now() };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }
  }

  function handlePointerUp(event) {
    if (!pointerStart) return;
    const dx = event.clientX - pointerStart.x;
    const dy = event.clientY - pointerStart.y;
    const distance = Math.max(Math.abs(dx), Math.abs(dy));

    if (distance < 18) {
      if (game.status === 'idle' && !modalOpen) startGame();
      pointerStart = null;
      return;
    }

    const direction = Math.abs(dx) > Math.abs(dy)
      ? (dx > 0 ? 'right' : 'left')
      : (dy > 0 ? 'down' : 'up');

    if (game.status === 'idle' && !modalOpen) startGame();
    if (game.status === 'running') game.setDirection(direction);
    pointerStart = null;
  }

  /* ---------- привязка интерфейса ---------- */

  function bindEvents() {
    dom.nicknameForm.addEventListener('submit', saveNickname);
    dom.nickname.addEventListener('input', () => {
      dom.nicknameNote.classList.remove('is-error');
    });

    dom.playButton.addEventListener('click', startGame);
    dom.pauseButton.addEventListener('click', () => game.togglePause());
    dom.restartButton.addEventListener('click', restartGame);
    dom.overlayButton.addEventListener('click', () => {
      if (game.status === 'paused') game.resume();
      else if (game.status === 'over') game.restart();
      else startGame();
    });

    dom.playAgain.addEventListener('click', playAgain);
    dom.retrySave.addEventListener('click', () => {
      if (state.lastResult) submitResult(state.lastResult);
    });

    $$('[data-close-modal]').forEach((element) => {
      element.addEventListener('click', closeModal);
    });

    dom.gameOverModal.addEventListener('click', (event) => {
      if (event.target === dom.gameOverModal) closeModal();
    });

    $$('#difficulty [data-difficulty]').forEach((button) => {
      button.addEventListener('click', () => setDifficulty(button.getAttribute('data-difficulty')));
    });

    $$('[data-dir]').forEach((button) => {
      button.addEventListener('click', () => {
        if (game.status === 'idle' || game.status === 'over') startGame();
        if (game.status === 'running') game.setDirection(button.getAttribute('data-dir'));
      });
    });

    dom.soundToggle.addEventListener('click', toggleSound);
    dom.refreshLeaderboard.addEventListener('click', () => loadLeaderboard());
    dom.retryLeaderboard.addEventListener('click', () => loadLeaderboard());

    dom.clearHistory.addEventListener('click', () => {
      if (!state.history.length) return;
      state.history = [];
      writeStorage(KEYS.history, state.history);
      renderHistory();
      toast('История забегов очищена', 'info');
    });

    dom.heroPlay.addEventListener('click', (event) => {
      event.preventDefault();
      dom.gameSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
      window.setTimeout(() => {
        if (!modalOpen) startGame();
      }, 380);
    });

    dom.canvas.addEventListener('pointerdown', handlePointerDown);
    dom.canvas.addEventListener('pointerup', handlePointerUp);
    dom.canvas.addEventListener('pointercancel', () => { pointerStart = null; });

    document.addEventListener('keydown', handleKeydown);

    document.addEventListener('visibilitychange', () => {
      if (document.hidden && game.status === 'running') game.pause();
    });

    window.addEventListener('blur', () => {
      if (game.status === 'running') game.pause();
    });
  }

  /* ---------- инициализация ---------- */

  function cacheDom() {
    dom.canvas = $('#gameCanvas');
    dom.score = $('#score');
    dom.best = $('#best');
    dom.level = $('#level');
    dom.length = $('#length');
    dom.speed = $('#speed');
    dom.bestLocal = $('#bestLocal');
    dom.gamesLocal = $('#gamesLocal');
    dom.lastScore = $('#lastScore');
    dom.myRank = $('#myRank');
    dom.profileName = $('#profileName');
    dom.historyList = $('#historyList');
    dom.clearHistory = $('#clearHistory');

    dom.boardOverlay = $('#boardOverlay');
    dom.overlayEyebrow = $('#overlayEyebrow');
    dom.overlayTitle = $('#overlayTitle');
    dom.overlayText = $('#overlayText');
    dom.overlayButton = $('#overlayButton');

    dom.playButton = $('#playButton');
    dom.pauseButton = $('#pauseButton');
    dom.restartButton = $('#restartButton');
    dom.playAgain = $('#playAgain');
    dom.retrySave = $('#retrySave');

    dom.gameOverModal = $('#gameOverModal');
    dom.gameOverReason = $('#gameOverReason');
    dom.finalScore = $('#finalScore');
    dom.finalLevel = $('#finalLevel');
    dom.finalTime = $('#finalTime');
    dom.saveStatus = $('#saveStatus');

    dom.nicknameForm = $('#nicknameForm');
    dom.nickname = $('#nickname');
    dom.nicknameNote = $('#nicknameNote');

    dom.leaderboardList = $('#leaderboardList');
    dom.leaderboardError = $('#leaderboardError');
    dom.leaderboardFoot = $('#leaderboardFoot');
    dom.refreshLeaderboard = $('#refreshLeaderboard');
    dom.retryLeaderboard = $('#retryLeaderboard');
    dom.heroGames = $('#heroGames');
    dom.heroPlayers = $('#heroPlayers');

    dom.serverStatus = $('#serverStatus');
    dom.serverStatusText = $('#serverStatusText');
    dom.soundToggle = $('#soundToggle');
    dom.toasts = $('#toasts');
    dom.gameSection = $('#game');
    dom.heroPlay = $('#heroPlay');
  }

  function init() {
    cacheDom();

    state.nickname = readStorage(KEYS.nickname, '') || '';
    state.best = Number(readStorage(KEYS.best, 0)) || 0;
    state.games = Number(readStorage(KEYS.games, 0)) || 0;
    state.lastScore = readStorage(KEYS.lastScore, null);
    state.history = Array.isArray(readStorage(KEYS.history, [])) ? readStorage(KEYS.history, []) : [];
    state.sound = readStorage(KEYS.sound, true) !== false;
    const storedDifficulty = readStorage(KEYS.difficulty, 'classic');
    state.difficulty = DIFFICULTY_LABELS[storedDifficulty] ? storedDifficulty : 'classic';

    game = new window.SnakeGame(dom.canvas);
    window.SNAKE_GAME = game;
    game.setDifficulty(state.difficulty);

    bindGameEvents();
    bindEvents();
    updateNicknameUi();
    updateSoundButton();
    updateDifficultyButtons();
    renderLocalStats();
    renderGame(game.getState());
    loadLeaderboard();
    checkServer();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
