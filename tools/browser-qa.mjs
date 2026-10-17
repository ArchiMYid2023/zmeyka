/* Браузерные тесты «Змейки» через headless Edge (CDP). Запускать при работающем сервере. */
import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const ROOT = process.cwd();
const SHOTS = path.join(ROOT, 'screenshots');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9334;
const PROFILE = path.join(os.tmpdir(), 'snake-qa-profile');
const PAGE_URL = 'http://127.0.0.1:5178/';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const errors = [];

function check(condition, message) {
  if (!condition) throw new Error('ASSERT: ' + message);
  results.push('ok — ' + message);
}

let browser;
let ws;
let msgId = 0;
const pending = new Map();

async function waitTarget() {
  for (let i = 0; i < 100; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await response.json();
      const page = list.find((target) => target.type === 'page');
      if (page && page.webSocketDebuggerUrl) return page;
    } catch {
      /* Edge ещё поднимается */
    }
    await sleep(200);
  }
  throw new Error('Не дождались CDP-таргета Edge');
}

function send(method, params = {}) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error('CDP timeout: ' + method));
      }
    }, 20000);
  });
}

async function evalJS(expression) {
  const response = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true
  });
  if (response.exceptionDetails) {
    const description = response.exceptionDetails.exception?.description || response.exceptionDetails.text;
    throw new Error('JS exception: ' + description);
  }
  return response.result.value;
}

async function shot(name, width = 1440, height = 1100, full = false) {
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width < 700,
    screenWidth: width,
    screenHeight: height
  });
  await sleep(350);
  let params = { format: 'png', captureBeyondViewport: false };
  if (full) {
    const metrics = await send('Page.getLayoutMetrics');
    const contentHeight = Math.min(6000, Math.ceil(metrics.cssContentSize.height));
    params = {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width, height: Math.max(height, contentHeight + 40), scale: 1 }
    };
  }
  const response = await send('Page.captureScreenshot', params);
  await writeFile(path.join(SHOTS, name + '.png'), Buffer.from(response.data, 'base64'));
  await send('Emulation.clearDeviceMetricsOverride');
  await sleep(200);
}

async function quickShot(name) {
  const response = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(SHOTS, name + '.png'), Buffer.from(response.data, 'base64'));
}

async function run() {
  await rm(PROFILE, { recursive: true, force: true });
  await mkdir(SHOTS, { recursive: true });

  browser = spawn(EDGE, [
    '--headless=new',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + PROFILE,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-extensions',
    '--hide-scrollbars',
    '--window-size=1440,1100',
    'about:blank'
  ], { stdio: 'ignore' });

  const target = await waitTarget();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
      return;
    }
    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails;
      errors.push(details.exception?.description || details.text || 'unknown exception');
    }
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
      errors.push(message.params.entry.text);
    }
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.navigate', { url: PAGE_URL });
  await sleep(1600);

  /* ---------- страница ---------- */
  check(await evalJS('document.title.includes("ЗМЕЙКА")'), 'заголовок страницы на месте');
  check(await evalJS('!!document.querySelector("#gameCanvas")'), 'canvas игры существует');
  check(await evalJS('document.querySelector("#gameCanvas").width') > 300, 'canvas отрисован');
  check(await evalJS('document.querySelectorAll("#leaderboardList .rank-row").length') >= 5, 'рейтинг загрузился с сервера');
  check(await evalJS('document.querySelector("#serverStatus").classList.contains("is-ok")'), 'статус сервера зелёный');
  check(await evalJS('document.querySelector("#leaderboardList").textContent.includes("Луна")'), 'демо-рекорды видны');
  await shot('01-home', 1440, 1100, true);

  /* ---------- имя ---------- */
  await evalJS('document.querySelector("#nickname").value = "Гость"');
  await evalJS('document.querySelector("#nicknameForm").requestSubmit()');
  await sleep(500);
  check(await evalJS('document.querySelector("#profileName").textContent') === 'Гость', 'имя сохраняется в интерфейсе');
  check(await evalJS('JSON.parse(localStorage.getItem("snake.nickname.v1"))') === 'Гость', 'имя сохраняется в localStorage');
  check(await evalJS('document.querySelector("#leaderboardError").hidden'), 'нет ошибки рейтинга');

  /* ---------- игра ---------- */
  await evalJS('document.querySelector("#game").scrollIntoView({ block: "start" })');
  await sleep(400);
  await evalJS('document.querySelector("#playButton").click()');
  await sleep(550);
  check(await evalJS('SNAKE_GAME.status') === 'running', 'игра запускается');
  const headBefore = await evalJS('JSON.stringify(SNAKE_GAME.snake[0])');
  await sleep(350);
  const headAfter = await evalJS('JSON.stringify(SNAKE_GAME.snake[0])');
  check(headBefore !== headAfter, 'змейка двигается');
  check(await evalJS('document.querySelector("#boardOverlay").classList.contains("is-hidden")'), 'оверлей скрыт во время игры');
  await evalJS('SNAKE_GAME.setDirection("down")');
  await sleep(120);
  await evalJS('document.querySelectorAll(".toast").forEach((toast) => toast.remove())');
  await quickShot('02-gameplay');
  check(await evalJS('SNAKE_GAME.status') === 'running', 'игра не прервалась во время скриншота');

  /* ---------- еда и счёт ---------- */
  await evalJS(`
    (function () {
      const g = SNAKE_GAME;
      const head = g.snake[0];
      g.food = { x: head.x, y: head.y + 1 };
      return true;
    })();
  `);
  await sleep(220);
  const scoreAfterEat = await evalJS('SNAKE_GAME.score');
  check(scoreAfterEat >= 10, 'яблоко увеличивает счёт (' + scoreAfterEat + ')');
  check(await evalJS('document.querySelector("#score").textContent') === String(scoreAfterEat), 'HUD показывает счёт');

  /* ---------- пауза ---------- */
  await evalJS('SNAKE_GAME.pause()');
  await sleep(300);
  check(await evalJS('SNAKE_GAME.status') === 'paused', 'пауза работает');
  check(await evalJS('!document.querySelector("#overlayButton").closest(".board-overlay").classList.contains("is-hidden")'), 'оверлей паузы показан');
  await evalJS('document.querySelector("#overlayButton").click()');
  await sleep(300);
  check(await evalJS('SNAKE_GAME.status') === 'running', 'игра продолжается с оверлея');

  /* ---------- завершение партии ---------- */
  await evalJS(`
    (function () {
      const g = SNAKE_GAME;
      g.snake = [{ x: 8, y: 8 }, { x: 8, y: 7 }, { x: 9, y: 7 }];
      g.direction = { x: 0, y: -1 };
      g.queue = [];
      return true;
    })();
  `);
  await sleep(600);
  check(await evalJS('SNAKE_GAME.status') === 'over', 'столкновение завершает игру');
  check(await evalJS('!document.querySelector("#gameOverModal").hidden'), 'модалка результата открывается');
  await sleep(1200);
  const saveText = await evalJS('document.querySelector("#saveStatus").textContent');
  check(saveText.includes('место') || saveText.includes('сохранён'), 'результат сохранён на сервере: ' + saveText);
  check(await evalJS('document.querySelector("#finalScore").textContent') === String(scoreAfterEat), 'в модалке верный счёт');
  check(Number(await evalJS('localStorage.getItem("snake.best.v1")')) >= scoreAfterEat, 'личный рекорд обновился');
  await evalJS('document.querySelectorAll(".toast").forEach((toast) => toast.remove())');
  await shot('03-game-over', 1440, 1100, false);

  /* ---------- заново и сложность ---------- */
  await evalJS('document.querySelector("#playAgain").click()');
  await sleep(400);
  check(await evalJS('SNAKE_GAME.status') === 'running', 'кнопка «Играть снова» запускает партию');
  await evalJS('SNAKE_GAME.pause()');
  await evalJS('document.querySelector("[data-difficulty=hardcore]").click()');
  await sleep(400);
  check(await evalJS('SNAKE_GAME.difficulty.key') === 'hardcore', 'сложность переключается');
  check(await evalJS('SNAKE_GAME.obstacles.length') === 6, 'в хардкоре появляются препятствия');
  check(await evalJS('SNAKE_GAME.status') === 'idle', 'после смены сложности игра ждёт старта');
  check(await evalJS('document.querySelector("[data-difficulty=hardcore]").classList.contains("is-active")'), 'активная сложность подсвечена');

  /* ---------- API из браузера ---------- */
  check(await evalJS('fetch("/api/leaderboard?limit=3").then(r => r.json()).then(d => d.entries.length)') === 3, 'API доступен из браузера');
  check(await evalJS('document.querySelector("#leaderboardList").textContent.includes("Гость")'), 'результат игрока появился в рейтинге');

  /* ---------- мобильная версия ---------- */
  await send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
    screenWidth: 390, screenHeight: 844
  });
  await send('Page.reload');
  await sleep(1500);
  check(await evalJS('document.documentElement.scrollWidth <= 392'), 'на телефоне нет горизонтального скролла');
  check(await evalJS('getComputedStyle(document.querySelector(".dpad")).display') === 'grid', 'мобильный D-pad виден');
  await evalJS('document.querySelector("#game").scrollIntoView({ block: "start" })');
  await sleep(400);
  const mobileGame = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(SHOTS, '04-mobile-game.png'), Buffer.from(mobileGame.data, 'base64'));
  await evalJS('window.scrollTo(0, 0)');
  await sleep(300);
  const mobileHome = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(SHOTS, '05-mobile-home.png'), Buffer.from(mobileHome.data, 'base64'));
  await send('Emulation.clearDeviceMetricsOverride');

  check(errors.length === 0, 'нет JS-ошибок и ошибок консоли' + (errors.length ? ': ' + errors.join(' | ') : ''));
}

let failure = null;
try {
  await run();
} catch (error) {
  failure = error;
  errors.push('FAILED: ' + error.message);
} finally {
  try { ws?.close(); } catch {}
  try { browser?.kill(); } catch {}
  await sleep(400);
}

const report = { passed: results, errors, ok: !failure && errors.length === 0 };
await writeFile(path.join(ROOT, 'qa-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
