'use strict';

/*
 * ЗМЕЙКА — игровой сервер.
 * Node.js без внешних зависимостей: статика, API рекордов, JSON-хранилище.
 */

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT) || 5178;
const IS_HOSTED = process.env.NODE_ENV === 'production'
  || Boolean(process.env.RENDER)
  || Boolean(process.env.RAILWAY_ENVIRONMENT)
  || Boolean(process.env.FLY_APP_NAME);
const HOST = process.env.HOST || (IS_HOSTED ? '0.0.0.0' : '127.0.0.1');
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const DATA_FILE = process.env.SNAKE_DATA_FILE
  ? path.resolve(process.env.SNAKE_DATA_FILE)
  : path.join(DATA_DIR, 'leaderboard.json');
const VERSION = '1.0.0';
const MAX_ENTRIES = 200;
const MAX_BODY_BYTES = 8 * 1024;
const STARTED_AT = Date.now();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2'
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'SAMEORIGIN',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': [
    "default-src 'self'",
    "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join('; ')
};

/** @type {{updatedAt: string, entries: Array<object>}} */
let board = { updatedAt: new Date().toISOString(), entries: [] };
let persistChain = Promise.resolve();

/* ---------- данные ---------- */

function compareEntries(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  return String(a.createdAt).localeCompare(String(b.createdAt));
}

function rankOf(entryId) {
  return board.entries.findIndex((entry) => entry.id === entryId) + 1;
}

function publicEntry(entry, index) {
  return {
    rank: index + 1,
    id: entry.id,
    nickname: entry.nickname,
    score: entry.score,
    level: entry.level,
    duration: entry.duration,
    difficulty: entry.difficulty || 'classic',
    createdAt: entry.createdAt
  };
}

function topEntries(limit) {
  return board.entries.slice(0, limit).map(publicEntry);
}

function stats() {
  const players = new Set(board.entries.map((entry) => entry.nickname.toLowerCase()));
  const bestScore = board.entries.reduce((best, entry) => Math.max(best, entry.score), 0);
  return {
    games: board.entries.length,
    players: players.size,
    bestScore,
    updatedAt: board.updatedAt
  };
}

function demoEntries() {
  const now = Date.now();
  const samples = [
    ['Луна', 420, 5, 138, 'classic', 1.2],
    ['Кирилл', 330, 4, 121, 'hardcore', 4.5],
    ['Алиса', 280, 3, 102, 'classic', 9],
    ['Макс', 210, 3, 84, 'chill', 20],
    ['Соня', 160, 2, 66, 'classic', 30]
  ];
  return samples.map(([nickname, score, level, duration, difficulty, hoursAgo], index) => ({
    id: 'demo-' + (index + 1),
    nickname,
    score,
    level,
    duration,
    difficulty,
    createdAt: new Date(now - hoursAgo * 3600 * 1000).toISOString()
  }));
}

async function loadBoard() {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.entries)) throw new Error('bad shape');
    board.entries = parsed.entries
      .filter((entry) => entry && typeof entry.nickname === 'string' && Number.isFinite(entry.score))
      .map((entry) => ({
        id: String(entry.id || crypto.randomUUID()),
        nickname: String(entry.nickname).slice(0, 20),
        score: Math.max(0, Math.round(Number(entry.score))),
        level: Math.max(1, Math.round(Number(entry.level) || 1)),
        duration: Math.max(0, Math.round(Number(entry.duration) || 0)),
        difficulty: entry.difficulty || 'classic',
        createdAt: entry.createdAt || new Date().toISOString()
      }))
      .sort(compareEntries)
      .slice(0, MAX_ENTRIES);
    board.updatedAt = parsed.updatedAt || new Date().toISOString();
    console.log(`[snake] рейтинг загружен: ${board.entries.length} записей`);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('[snake] не удалось прочитать рейтинг:', error.message);
      try {
        await fs.rename(DATA_FILE, DATA_FILE + '.broken-' + Date.now());
        console.warn('[snake] повреждённый файл сохранён рядом');
      } catch {
        /* ignore */
      }
    }
    board = {
      updatedAt: new Date().toISOString(),
      entries: demoEntries().sort(compareEntries)
    };
    await persist();
    console.log('[snake] создан стартовый рейтинг');
  }
}

function persist() {
  const snapshot = JSON.stringify({ updatedAt: board.updatedAt, entries: board.entries }, null, 2);
  persistChain = persistChain
    .then(async () => {
      await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
      const tmp = DATA_FILE + '.tmp';
      await fs.writeFile(tmp, snapshot, 'utf8');
      await fs.rename(tmp, DATA_FILE);
    })
    .catch((error) => {
      console.error('[snake] ошибка сохранения рейтинга:', error.message);
    });
  return persistChain;
}

/* ---------- ответы ---------- */

function baseHeaders(extra) {
  return Object.assign({}, SECURITY_HEADERS, extra || {});
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, baseHeaders({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  }));
  res.end(body);
}

function fail(res, status, message) {
  sendJson(res, status, { ok: false, error: { message } });
}

function redirect(res, location) {
  res.writeHead(302, baseHeaders({ Location: location }));
  res.end();
}

/* ---------- валидация ---------- */

function normalizeNickname(value) {
  if (typeof value !== 'string') return null;
  const clean = value
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .replace(/\s+/g, ' ');
  if (clean.length < 2 || clean.length > 20) return null;
  if (!/^[\p{L}\p{N}][\p{L}\p{N} _.\-]*$/u.test(clean)) return null;
  return clean;
}

function validateScore(body) {
  const nickname = normalizeNickname(body.nickname);
  if (!nickname) return { error: 'Имя: 2–20 символов, буквы, цифры, пробел, точка, дефис или _' };

  const score = Number(body.score);
  const level = Number(body.level);
  const duration = Number(body.duration);
  const difficulty = ['chill', 'classic', 'hardcore'].includes(body.difficulty) ? body.difficulty : 'classic';

  if (!Number.isInteger(score) || score < 0 || score > 500000) {
    return { error: 'Некорректный счёт' };
  }
  if (!Number.isInteger(level) || level < 1 || level > 99) {
    return { error: 'Некорректный уровень' };
  }
  if (!Number.isFinite(duration) || duration < 0 || duration > 7200) {
    return { error: 'Некорректная длительность партии' };
  }
  if (score > 0 && duration < 1) {
    return { error: 'Слишком короткая партия для такого счёта' };
  }
  if (score > duration * 60 + 500) {
    return { error: 'Счёт не сходится с длительностью партии' };
  }

  return { value: { nickname, score, level, duration: Math.round(duration), difficulty } };
}

/* ---------- rate limit ---------- */

const buckets = new Map();

function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || now - bucket.start > windowMs) {
    bucket = { start: now, count: 0 };
    buckets.set(key, bucket);
  }
  bucket.count += 1;
  if (buckets.size > 4000) {
    for (const [bucketKey, value] of buckets) {
      if (now - value.start > windowMs) buckets.delete(bucketKey);
    }
  }
  return bucket.count <= limit;
}

function clientIp(req) {
  return req.socket.remoteAddress || 'unknown';
}

/* ---------- API ---------- */

async function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        const error = new Error('Слишком большой запрос');
        error.status = 413;
        reject(error);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        const error = new Error('Некорректный JSON');
        error.status = 400;
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

async function handleApi(req, res, url) {
  const pathname = url.pathname;

  if (req.method === 'GET' && pathname === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      status: 'ok',
      version: VERSION,
      uptimeSeconds: Math.round((Date.now() - STARTED_AT) / 1000),
      entries: board.entries.length
    });
  }

  if (req.method === 'GET' && pathname === '/api/leaderboard') {
    if (!rateLimit('get:' + clientIp(req), 240, 60 * 1000)) {
      return fail(res, 429, 'Слишком много запросов, попробуйте через минуту');
    }
    const requested = Number(url.searchParams.get('limit'));
    const limit = Number.isFinite(requested) ? Math.min(Math.max(Math.trunc(requested), 1), 50) : 10;
    return sendJson(res, 200, {
      ok: true,
      entries: topEntries(limit),
      total: board.entries.length,
      stats: stats()
    });
  }

  if (req.method === 'GET' && pathname === '/api/stats') {
    return sendJson(res, 200, { ok: true, stats: stats() });
  }

  if (req.method === 'POST' && pathname === '/api/scores') {
    if (!rateLimit('post:' + clientIp(req), 20, 10 * 60 * 1000)) {
      return fail(res, 429, 'Слишком много попыток сохранить результат');
    }

    let body;
    try {
      body = await readJson(req);
    } catch (error) {
      return fail(res, error.status || 400, error.message);
    }

    const checked = validateScore(body);
    if (checked.error) return fail(res, 422, checked.error);

    const entry = {
      id: crypto.randomUUID(),
      nickname: checked.value.nickname,
      score: checked.value.score,
      level: checked.value.level,
      duration: checked.value.duration,
      difficulty: checked.value.difficulty,
      createdAt: new Date().toISOString()
    };

    board.entries.push(entry);
    board.entries.sort(compareEntries);
    board.entries = board.entries.slice(0, MAX_ENTRIES);
    board.updatedAt = entry.createdAt;
    await persist();

    const rank = rankOf(entry.id);
    if (rank > 0) {
      return sendJson(res, 201, {
        ok: true,
        saved: true,
        rank,
        entry: publicEntry(entry, rank - 1),
        entries: topEntries(10),
        total: board.entries.length,
        stats: stats()
      });
    }

    return sendJson(res, 202, {
      ok: true,
      saved: false,
      rank: null,
      message: 'Результат не попал в топ-200 — попробуйте улучшить счёт',
      entries: topEntries(10),
      total: board.entries.length,
      stats: stats()
    });
  }

  if (pathname === '/api/scores') {
    return fail(res, 405, 'Метод не поддерживается');
  }

  return fail(res, 404, 'API-метод не найден');
}

/* ---------- статика ---------- */

async function handleStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return fail(res, 405, 'Метод не поддерживается');
  }

  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return fail(res, 400, 'Некорректный путь');
  }

  let relative = decoded;
  if (relative === '/') relative = '/index.html';
  if (relative.endsWith('/')) relative += 'index.html';

  const filePath = path.resolve(PUBLIC_DIR, '.' + relative);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    return fail(res, 403, 'Доступ запрещён');
  }

  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return notFound(res);
  }
  if (!stat.isFile()) return notFound(res);

  const extension = path.extname(filePath).toLowerCase();
  const contentType = MIME[extension] || 'application/octet-stream';
  const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, baseHeaders({ ETag: etag }));
    return res.end();
  }

  let data;
  try {
    data = await fs.readFile(filePath);
  } catch {
    return fail(res, 500, 'Не удалось прочитать файл');
  }

  const cacheControl = extension === '.html'
    ? 'no-cache'
    : 'public, max-age=600';

  res.writeHead(200, baseHeaders({
    'Content-Type': contentType,
    'Content-Length': data.length,
    'Cache-Control': cacheControl,
    'ETag': etag
  }));
  if (req.method === 'HEAD') return res.end();
  res.end(data);
}

async function notFound(res) {
  try {
    const page = await fs.readFile(path.join(PUBLIC_DIR, '404.html'));
    res.writeHead(404, baseHeaders({
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': page.length,
      'Cache-Control': 'no-cache'
    }));
    return res.end(page);
  } catch {
    res.writeHead(404, baseHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }));
    return res.end('404 — страница не найдена');
  }
}

/* ---------- сервер ---------- */

function logRequest(req, res, startedAt) {
  const duration = Number(process.hrtime.bigint() - startedAt) / 1e6;
  const time = new Date().toISOString().slice(11, 19);
  console.log(`[snake] ${time} ${req.method} ${req.url} → ${res.statusCode} ${duration.toFixed(0)}ms`);
}

const server = http.createServer(async (req, res) => {
  const startedAt = process.hrtime.bigint();
  res.on('finish', () => logRequest(req, res, startedAt));

  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/health') return redirect(res, '/api/health');
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return await handleStatic(req, res, url.pathname);
  } catch (error) {
    console.error('[snake] необработанная ошибка:', error);
    if (!res.headersSent) return fail(res, 500, 'Внутренняя ошибка сервера');
    res.end();
  }
});

async function shutdown(signal) {
  console.log(`\n[snake] получен ${signal}, сохраняем данные и выходим`);
  server.close();
  await persistChain;
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

(async () => {
  await loadBoard();
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`[snake] порт ${PORT} уже занят. Задайте другой: PORT=5179 npm start`);
      process.exit(1);
    }
    console.error('[snake] ошибка сервера:', error);
    process.exit(1);
  });
  server.listen(PORT, HOST, () => {
    console.log('');
    console.log('  ЗМЕЙКА — сервер запущен');
    console.log(`  Открыть: http://${HOST}:${PORT}`);
    console.log(`  API:     http://${HOST}:${PORT}/api/health`);
    console.log(`  Данные:  ${DATA_FILE}`);
    console.log('');
  });
})();
