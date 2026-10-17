/* API-тесты «Змейки»: поднимают отдельный сервер на временной папке. */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PORT = 5391;
const BASE = `http://127.0.0.1:${PORT}`;
const tempDir = await mkdtemp(path.join(tmpdir(), 'snake-smoke-'));
const dataFile = path.join(tempDir, 'leaderboard.json');
const results = [];
const failures = [];

function check(condition, message) {
  if (condition) results.push('ok — ' + message);
  else failures.push('FAIL — ' + message);
}

const server = spawn(process.execPath, ['server.js'], {
  cwd: process.cwd(),
  env: Object.assign({}, process.env, {
    PORT: String(PORT),
    HOST: '127.0.0.1',
    SNAKE_DATA_FILE: dataFile
  }),
  stdio: 'ignore'
});

async function waitForServer() {
  for (let i = 0; i < 80; i++) {
    try {
      const response = await fetch(BASE + '/api/health');
      if (response.ok) return;
    } catch {
      /* сервер ещё не поднялся */
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error('Сервер не запустился на порту ' + PORT);
}

try {
  await waitForServer();

  const health = await fetch(BASE + '/api/health').then((response) => response.json());
  check(health.ok === true, 'health отвечает ok');
  check(health.version === '1.0.0', 'версия API');

  const index = await fetch(BASE + '/');
  const html = await index.text();
  check(index.status === 200, 'главная страница отдаётся');
  check(html.includes('ЗМЕЙКА'), 'HTML содержит название игры');
  check(index.headers.get('content-security-policy')?.includes("script-src 'self'"), 'CSP выставлен');

  const cssResponse = await fetch(BASE + '/css/styles.css');
  check(cssResponse.status === 200, 'CSS отдаётся');
  const etag = cssResponse.headers.get('etag');
  check(Boolean(etag), 'ETag присутствует');
  if (etag) {
    const cached = await fetch(BASE + '/css/styles.css', { headers: { 'If-None-Match': etag } });
    check(cached.status === 304, 'повторный запрос отдаёт 304');
  }

  const jsResponse = await fetch(BASE + '/js/game.js');
  check(jsResponse.status === 200, 'JS игры отдаётся');

  const board = await fetch(BASE + '/api/leaderboard?limit=10').then((response) => response.json());
  check(board.ok === true, 'leaderboard отвечает ok');
  check(board.total === 5, 'стартовый демо-рейтинг содержит 5 записей');
  check(board.entries.length === 5, 'топ возвращает записи');
  check(board.entries[0].rank === 1 && board.entries[0].score === 420, 'топ отсортирован по очкам');

  const valid = await fetch(BASE + '/api/scores', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname: 'Тест-игрок', score: 120, level: 3, duration: 26, difficulty: 'classic' })
  });
  const saved = await valid.json();
  check(valid.status === 201, 'корректный результат принимается');
  check(saved.saved === true && saved.rank === 6, 'новый результат получает место #6');
  check(saved.entry.nickname === 'Тест-игрок', 'ник сохраняется в UTF-8');

  const after = await fetch(BASE + '/api/leaderboard?limit=10').then((response) => response.json());
  check(after.total === 6, 'рейтинг обновился');
  check(after.entries.some((entry) => entry.nickname === 'Тест-игрок'), 'новая запись видна в топе');

  const invalidName = await fetch(BASE + '/api/scores', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname: 'X', score: 10, level: 1, duration: 5, difficulty: 'classic' })
  });
  check(invalidName.status === 422, 'короткое имя отклоняется');

  const cheat = await fetch(BASE + '/api/scores', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname: 'Читер', score: 50000, level: 9, duration: 2, difficulty: 'classic' })
  });
  check(cheat.status === 422, 'невозможный счёт отклоняется');

  const notFound = await fetch(BASE + '/no-such-page');
  check(notFound.status === 404, 'несуществующая страница отдаёт 404');

  const stats = await fetch(BASE + '/api/stats').then((response) => response.json());
  check(stats.ok && stats.stats.games === 6, 'статистика считает партии');
} catch (error) {
  failures.push('FAIL — ' + error.message);
} finally {
  server.kill();
  await new Promise((resolve) => setTimeout(resolve, 300));
  await rm(tempDir, { recursive: true, force: true });
}

console.log(JSON.stringify({ passed: results, failed: failures, ok: failures.length === 0 }, null, 2));
process.exit(failures.length === 0 ? 0 : 1);
