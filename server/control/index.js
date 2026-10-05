'use strict';
// Служба управления: единственная, к которой обращается веб-интерфейс. Собирает состояние
// приёма и раздачи и отдаёт страницу. На путь потока не влияет: её остановка раздачу не прерывает.
//
// Запуск отдельно: node server/control/index.js

const fs = require('fs');
const path = require('path');
const { jsonServer, getJson } = require('../shared/http');
const { loadConfig } = require('../shared/config');

const ROOT = path.join(__dirname, '..', '..');
// Что отдаётся браузеру: страница сервера и общий визуал из окна (стили, шрифты, тема)
const STATIC = [
  { prefix: '/ui/', dir: path.join(ROOT, 'app', 'renderer') },
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

function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }
  const route = STATIC.find((s) => url.pathname.startsWith(s.prefix));
  let rel = decodeURIComponent(url.pathname.slice(route.prefix.length)) || 'index.html';
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(route.dir, rel));
  // Наружу отдаются только файлы из своих папок
  if (!file.startsWith(route.dir + path.sep) || !TYPES[path.extname(file)]) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Нет такой страницы');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Нет такой страницы');
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)], 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

async function start({ config, log = console.log, usingExample = false }) {
  const startedAt = Date.now();
  const ingestUrl = `http://${config.bind}:${config.ingest.statePort}/state`;
  const casterUrl = `http://${config.bind}:${config.caster.statePort}/state`;

  const web = jsonServer({
    // Сводное состояние сервера для страницы: службы и станции
    '/api/state': async () => {
      const [ingest, caster] = await Promise.all([getJson(ingestUrl), getJson(casterUrl)]);
      const feeds = new Map(((caster && caster.feeds) || []).map((f) => [f.station, f]));
      const gates = new Map(((ingest && ingest.gates) || []).map((g) => [g.code, g]));
      return {
        at: Date.now(),
        usingExample,
        services: {
          ingest: ingest ? { up: true, startedAt: ingest.startedAt, consumers: ingest.consumers } : { up: false },
          caster: caster
            ? { up: true, startedAt: caster.startedAt, ingestLink: caster.ingestLink, listening: caster.listening, port: caster.port, sessions: caster.sessions, openAccess: caster.openAccess }
            : { up: false },
          control: { up: true, startedAt },
        },
        stations: ((ingest && ingest.stations) || []).map((s) => ({ ...s, feed: feeds.get(s.id) || null, gate: gates.get(s.id) || null })),
      };
    },
  }, { host: config.bind, port: config.control.port, fallback: serveStatic });

  const ports = { web: await web.ready };
  log(`управление: страница сервера — http://${config.bind}:${ports.web}/`);

  return {
    ports,
    async stop() {
      await web.close();
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
