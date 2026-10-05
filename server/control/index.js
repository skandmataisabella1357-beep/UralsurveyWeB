'use strict';
// Служба управления: единственная, к которой обращается веб-интерфейс. Собирает состояние
// приёма и раздачи, отдаёт открытую страницу состояния и панель администратора за входом.
// На путь потока не влияет: её остановка раздачу не прерывает.
//
// Запуск отдельно: node server/control/index.js

const fs = require('fs');
const http = require('http');
const path = require('path');
const { getJson } = require('../shared/http');
const { loadConfig } = require('../shared/config');
const auth = require('./auth');

const ROOT = path.join(__dirname, '..', '..');
// Что отдаётся браузеру: страницы сервера, общий визуал из окна и модуль координат
const STATIC = [
  { prefix: '/ui/', dir: path.join(ROOT, 'app', 'renderer') },
  { prefix: '/modules/coordsys/', dir: path.join(ROOT, 'modules', 'coordsys') },
  { prefix: '/', dir: path.join(ROOT, 'server', 'web') },
];
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
};
const COOKIE = 'ural_session';

function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }
  const route = STATIC.find((s) => url.pathname.startsWith(s.prefix));
  let rel;
  try {
    rel = decodeURIComponent(url.pathname.slice(route.prefix.length)) || 'index.html';
  } catch (err) {
    rel = '\0';
  }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(route.dir, rel));
  // Наружу отдаются только файлы из своих папок
  if (rel.includes('\0') || !file.startsWith(route.dir + path.sep) || !TYPES[path.extname(file)]) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Нет такой страницы');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Нет такой страницы');
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)], 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

function sendJson(res, code, body, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('слишком длинный запрос'));
        req.destroy();
      } else {
        chunks.push(c);
      }
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (err) {
        reject(new Error('запрос не читается'));
      }
    });
    req.on('error', reject);
  });
}

function cookieOf(req) {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([0-9a-f]{64})`).exec(req.headers.cookie || '');
  return m ? m[1] : null;
}

async function start({ config, log = console.log, usingExample = false, adminFile }) {
  const startedAt = Date.now();
  const ingestUrl = `http://${config.bind}:${config.ingest.statePort}/state`;
  const casterUrl = `http://${config.bind}:${config.caster.statePort}/state`;
  const sessions = new auth.Sessions();
  const attempts = new auth.Attempts();
  const admin = () => auth.loadAdmin(adminFile || auth.adminFile());

  const collect = async () => {
    const [ingest, caster] = await Promise.all([getJson(ingestUrl), getJson(casterUrl)]);
    const services = {
      ingest: ingest ? { up: true, startedAt: ingest.startedAt, consumers: ingest.consumers } : { up: false },
      caster: caster
        ? { up: true, startedAt: caster.startedAt, ingestLink: caster.ingestLink, listening: caster.listening, port: caster.port, sessions: caster.sessions, openAccess: caster.openAccess }
        : { up: false },
      control: { up: true, startedAt },
    };
    return { ingest, caster, services };
  };

  // Открытая сводка: службы и станции без адресов источников, журналов и сведений о подключениях
  const publicState = async () => {
    const { ingest, caster, services } = await collect();
    const feeds = new Map(((caster && caster.feeds) || []).map((f) => [f.station, f]));
    return {
      at: Date.now(),
      usingExample,
      services,
      stations: ((ingest && ingest.stations) || []).map((s) => ({
        id: s.id,
        name: s.name,
        link: { state: s.link.state, bitsPerSec: s.link.bitsPerSec, reconnects: s.link.reconnects },
        format: s.format,
        satTotal: s.satTotal,
        crcErrors: s.crcErrors,
        feed: feeds.has(s.id) ? { bytes: feeds.get(s.id).bytes, lastDataAgeMs: feeds.get(s.id).lastDataAgeMs } : null,
      })),
    };
  };

  // Полная сводка для администратора
  const adminState = async () => {
    const { ingest, caster, services } = await collect();
    const feeds = new Map(((caster && caster.feeds) || []).map((f) => [f.station, f]));
    const gates = new Map(((ingest && ingest.gates) || []).map((g) => [g.code, g]));
    return {
      at: Date.now(),
      usingExample,
      services,
      stations: ((ingest && ingest.stations) || []).map((s) => ({ ...s, feed: feeds.get(s.id) || null, gate: gates.get(s.id) || null })),
      points: (caster && caster.points) || [],
      clients: (caster && caster.clients) || [],
      refusals: (caster && caster.refusals) || [],
    };
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    const ip = String(req.headers['x-real-ip'] || req.socket.remoteAddress || '');
    const signedIn = sessions.has(cookieOf(req));
    try {
      if (url.pathname === '/api/state' && req.method === 'GET') return sendJson(res, 200, await publicState());

      if (url.pathname === '/api/me' && req.method === 'GET') {
        return sendJson(res, 200, { signedIn, configured: Boolean(admin()) });
      }

      if (url.pathname === '/api/login' && req.method === 'POST') {
        const record = admin();
        if (!record) return sendJson(res, 409, { error: 'Пароль администратора ещё не задан. Задайте его на сервере командой node server/control/set-admin.js.' });
        if (!attempts.allowed(ip)) return sendJson(res, 429, { error: 'Слишком много попыток входа. Подождите минуту.' });
        const body = await readBody(req);
        if (!auth.verifyPassword(body.password || '', record)) {
          attempts.failed(ip);
          log(`управление: неудачный вход в панель с ${ip}`);
          return sendJson(res, 401, { error: 'Неверный пароль.' });
        }
        const token = sessions.create();
        const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
        log(`управление: вход в панель с ${ip}`);
        return sendJson(res, 200, { signedIn: true }, {
          'Set-Cookie': `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${auth.SESSION_MS / 1000}${secure}`,
        });
      }

      if (url.pathname === '/api/logout' && req.method === 'POST') {
        sessions.drop(cookieOf(req));
        return sendJson(res, 200, { signedIn: false }, { 'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` });
      }

      if (url.pathname.startsWith('/api/admin/')) {
        if (!signedIn) return sendJson(res, 401, { error: 'Нужен вход администратора.' });
        if (url.pathname === '/api/admin/state' && req.method === 'GET') return sendJson(res, 200, await adminState());
        return sendJson(res, 404, { error: 'нет такого адреса' });
      }

      if (url.pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'нет такого адреса' });
      return serveStatic(req, res, url);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  });

  const port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.control.port, config.bind, () => resolve(server.address().port));
  });
  const ports = { web: port };
  log(`управление: страница сервера — http://${config.bind}:${port}/, панель администратора — в службе управления на Python (backend)`);

  return {
    ports,
    async stop() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

if (require.main === module) {
  // Запускающий процесс исчез — служба не остаётся сиротой и не держит порты
  process.on('disconnect', () => process.exit(0));
  const { config, usingExample } = loadConfig();
  start({ config, usingExample }).catch((err) => {
    console.error(`управление не запустилось: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { start };
