'use strict';
// Справочник из базы данных: станции, точки подключения и логины с правами.
// Службы приёма и раздачи раз в несколько секунд спрашивают его у службы управления
// и применяют изменения на ходу. Если управление или база недоступны, службы работают
// по последней полученной копии: раздача от базы не зависит.

const fs = require('fs');
const http = require('http');
const path = require('path');
const { EventEmitter } = require('events');

// Ключ для обращений к службе управления лежит в файле рядом с настройками сервера
function readKey() {
  const dir = process.env.URAL_DATA || (process.env.URAL_CONFIG ? path.dirname(process.env.URAL_CONFIG) : path.join(__dirname, '..', '..', 'backend', 'data'));
  try {
    return fs.readFileSync(path.join(dir, 'internal.key'), 'ascii').trim();
  } catch (err) {
    return '';
  }
}

function request(method, url, key, body, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(url, {
      method,
      timeout: timeoutMs,
      headers: { 'X-Ural-Key': key, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          resolve(res.statusCode === 200 ? { ok: true, body: JSON.parse(text), text } : { ok: false });
        } catch (err) {
          resolve({ ok: false });
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve({ ok: false }));
    if (data) req.write(data);
    req.end();
  });
}

// url — адрес службы управления, например http://127.0.0.1:8110
class Directory extends EventEmitter {
  constructor({ url, key, intervalMs = 3000 }) {
    super();
    this.url = url.replace(/\/+$/, '');
    this.key = key === undefined ? readKey() : key;
    this.intervalMs = intervalMs;
    this.current = null;
    this.lastText = '';
    this.lastOkAt = 0;
    this.timer = null;
    this.busy = false;
  }

  async poll() {
    if (this.busy) return;
    this.busy = true;
    try {
      if (!this.key) this.key = readKey(); // служба управления создаёт ключ при первом запуске
      const res = await request('GET', `${this.url}/internal/directory`, this.key);
      if (!res.ok) return;
      this.lastOkAt = Date.now();
      if (res.text === this.lastText) return;
      this.lastText = res.text;
      this.current = res.body;
      this.emit('update', res.body);
    } finally {
      this.busy = false;
    }
  }

  start() {
    this.poll();
    this.timer = setInterval(() => this.poll(), this.intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
  }

  // События раздачи для журнала сеансов. Возвращает true, если служба управления их приняла.
  async send(events, alive) {
    const res = await request('POST', `${this.url}/internal/events`, this.key, { events, alive });
    return res.ok;
  }
}

module.exports = { Directory, readKey, request };
