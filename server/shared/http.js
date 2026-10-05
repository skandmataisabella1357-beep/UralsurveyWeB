'use strict';
// Мелкие помощники для служебных HTTP-страниц состояния внутри сервера.

const http = require('http');

// Сервер, отвечающий JSON по точным путям. routes: { '/state': () => объект }
function jsonServer(routes, { host, port, fallback }) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    const handler = req.method === 'GET' ? routes[url.pathname] : null;
    try {
      if (handler) {
        const body = JSON.stringify(await handler(url));
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(body);
      } else if (fallback) {
        await fallback(req, res, url);
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end('{"error":"нет такого адреса"}');
      }
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
  const ready = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server.address().port));
  });
  return {
    ready,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    }),
  };
}

// Запрос JSON у соседней службы. При любой неудаче возвращает null: служба считается недоступной.
function getJson(url, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          resolve(res.statusCode === 200 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null);
        } catch (err) {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

module.exports = { jsonServer, getJson };
