'use strict';
// Канал связи со станцией. Три режима:
//   tcp    — подключаемся к порту приёмника или сервера;
//   ntrip  — подключаемся к NTRIP-кастеру как клиент;
//   listen — открываем порт и ждём, пока приёмник подключится сам.
// Канал сам переподключается и рвёт соединение, если данные перестали идти.

const net = require('net');
const os = require('os');
const { EventEmitter } = require('events');

const CONNECT_TIMEOUT_MS = 10000;
const BACKOFF_MS = [1000, 2000, 5000, 10000, 20000, 30000];
const STABLE_MS = 30000; // столько должен прожить поток, чтобы сбросить счётчик попыток

const STATES = {
  idle: 'Остановлено',
  connecting: 'Подключение',
  listening: 'Ожидание приёмника',
  waiting: 'Соединено, данных нет',
  online: 'Данные идут',
  retry: 'Повтор подключения',
  error: 'Ошибка',
};

function describeError(err) {
  switch (err && err.code) {
    case 'ECONNREFUSED': return 'порт закрыт: соединение отклонено';
    case 'ETIMEDOUT': return 'адрес не отвечает';
    case 'EHOSTUNREACH': case 'ENETUNREACH': return 'нет маршрута до адреса';
    case 'ENOTFOUND': case 'EAI_AGAIN': return 'имя узла не найдено';
    case 'ECONNRESET': return 'соединение сброшено удалённой стороной';
    case 'EADDRINUSE': return 'порт уже занят другой программой';
    case 'EACCES': return 'нет прав на открытие порта';
    default: return (err && err.message) || 'неизвестная ошибка';
  }
}

class Transport extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = { stallTimeoutSec: 15, ...cfg };
    this.state = 'idle';
    this.detail = '';
    this.running = false;
    this.socket = null;
    this.server = null;
    this.attempt = 0;
    this.reconnects = 0;
    this.lastDataAt = 0;
    this.onlineSince = 0;
    this.timers = new Set();
    this.watchdog = null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.attempt = 0;
    this.watchdog = setInterval(() => this.checkStall(), 1000);
    if (this.cfg.mode === 'listen') this.listen();
    else this.connect();
  }

  stop() {
    this.running = false;
    clearInterval(this.watchdog);
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    if (this.socket) this.socket.destroy();
    this.socket = null;
    if (this.server) this.server.close();
    this.server = null;
    this.setState('idle');
  }

  setState(state, detail = '') {
    if (state === this.state && detail === this.detail) return;
    this.state = state;
    this.detail = detail;
    this.emit('state', state, detail);
  }

  later(fn, ms) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (this.running) fn();
    }, ms);
    this.timers.add(t);
    return t;
  }

  scheduleReconnect(reason, minDelay = 0) {
    if (!this.running) return;
    const delay = Math.max(minDelay, BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]);
    this.attempt++;
    this.reconnects++;
    this.setState('retry', `${reason}; повтор через ${Math.round(delay / 1000)} с`);
    this.later(() => this.connect(), delay);
  }

  // Данные перестали идти: рвём соединение, дальше сработает обычное переподключение
  checkStall() {
    if (!this.socket || !this.lastDataAt) return;
    const idle = Date.now() - this.lastDataAt;
    if (this.state === 'online' && this.onlineSince && Date.now() - this.onlineSince > STABLE_MS) {
      this.attempt = 0;
    }
    if (idle > this.cfg.stallTimeoutSec * 1000) {
      this.stallClose = this.state === 'online'
        ? 'данные перестали идти'
        : 'соединение есть, но данные не поступают';
      this.socket.destroy();
    }
  }

  onData(chunk) {
    this.lastDataAt = Date.now();
    if (this.state !== 'online') {
      this.onlineSince = Date.now();
      this.setState('online');
    }
    this.emit('data', chunk);
  }

  // ---- Исходящее подключение: TCP или NTRIP ----
  connect() {
    const { host, port, mode } = this.cfg;
    this.setState('connecting');
    const socket = net.connect({ host, port });
    this.socket = socket;
    this.stallClose = null;
    let failure = null;
    let fatal = false;
    let refused = false; // кастер ответил отказом: повторяем реже
    let header = mode === 'ntrip' ? Buffer.alloc(0) : null;

    const timeout = this.later(() => {
      failure = 'адрес не отвечает';
      socket.destroy();
    }, CONNECT_TIMEOUT_MS);

    socket.setNoDelay(true);
    socket.setKeepAlive(true, 10000);

    socket.on('connect', () => {
      clearTimeout(timeout);
      this.timers.delete(timeout);
      this.lastDataAt = Date.now(); // отсчёт для сторожа начинается с момента соединения
      this.setState('waiting');
      if (mode === 'ntrip') socket.write(this.ntripRequest());
    });

    socket.on('data', (chunk) => {
      if (header === null) {
        this.onData(chunk);
        return;
      }
      // Ответ кастера: строка статуса, затем поток
      header = Buffer.concat([header, chunk]);
      const res = parseNtripResponse(header);
      if (res.pending) {
        if (header.length > 4096) {
          failure = 'кастер прислал непонятный ответ';
          socket.destroy();
        }
        return;
      }
      if (res.error) {
        failure = res.error;
        fatal = Boolean(res.fatal);
        refused = true;
        socket.destroy();
        return;
      }
      header = null;
      this.lastDataAt = Date.now();
      if (res.rest.length) this.onData(res.rest);
    });

    socket.on('error', (err) => {
      if (!failure) failure = describeError(err);
    });

    socket.on('close', () => {
      clearTimeout(timeout);
      this.timers.delete(timeout);
      if (this.socket !== socket) return;
      this.socket = null;
      this.lastDataAt = 0;
      this.onlineSince = 0;
      if (!this.running) return;
      const reason = failure || this.stallClose || 'соединение закрыто удалённой стороной';
      this.emit('log', 'warn', `Связь потеряна: ${reason}`);
      if (fatal) {
        // Неверный пароль: не долбим кастер, ждём правки настроек
        this.setState('error', reason);
        return;
      }
      this.scheduleReconnect(reason, refused ? 15000 : 0);
    });
  }

  ntripRequest() {
    const { host, port, mountpoint = '', username = '', password = '' } = this.cfg;
    const lines = [
      `GET /${mountpoint.replace(/^\//, '')} HTTP/1.0`,
      `Host: ${host}:${port}`,
      'User-Agent: NTRIP UralsurveyLite/0.1',
      'Accept: */*',
    ];
    if (username || password) {
      lines.push(`Authorization: Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`);
    }
    return `${lines.join('\r\n')}\r\n\r\n`;
  }

  // ---- Входящее подключение: приёмник сам приходит на наш порт ----
  listen() {
    const { port } = this.cfg;
    const server = net.createServer((socket) => {
      if (this.socket) this.socket.destroy(); // новое подключение заменяет старое
      this.socket = socket;
      this.stallClose = null;
      this.lastDataAt = Date.now();
      this.setState('waiting', `подключился ${socket.remoteAddress}`);
      this.emit('log', 'info', `Приёмник подключился с адреса ${socket.remoteAddress}`);
      socket.setKeepAlive(true, 10000);
      socket.on('data', (chunk) => this.onData(chunk));
      socket.on('error', () => {});
      socket.on('close', () => {
        if (this.socket !== socket) return;
        this.socket = null;
        this.lastDataAt = 0;
        this.onlineSince = 0;
        if (!this.running) return;
        this.reconnects++;
        this.emit('log', 'warn', this.stallClose ? `Связь потеряна: ${this.stallClose}` : 'Приёмник отключился');
        this.setState('listening', `порт ${port}`);
      });
    });
    this.server = server;
    server.on('error', (err) => {
      const reason = describeError(err);
      this.emit('log', 'error', `Не удалось открыть порт ${port}: ${reason}`);
      this.server = null;
      this.setState('retry', `${reason}; повтор через 10 с`);
      this.later(() => this.listen(), 10000);
    });
    server.listen(port, () => this.setState('listening', `порт ${port}`));
  }
}

// Разбор ответа NTRIP-кастера. Возвращает { pending } пока ответ не дочитан,
// { error, fatal } при отказе или { rest } — начало потока данных.
function parseNtripResponse(buf) {
  const eol = buf.indexOf('\r\n');
  if (eol === -1) return { pending: true };
  const status = buf.toString('latin1', 0, eol);

  if (/^ICY 200/.test(status)) {
    let start = eol + 2;
    if (buf.length < start + 2) return { pending: true };
    if (buf[start] === 0x0d && buf[start + 1] === 0x0a) start += 2;
    return { rest: buf.subarray(start) };
  }
  if (/^HTTP\/1\.[01] 200/.test(status)) {
    const end = buf.indexOf('\r\n\r\n');
    if (end === -1) return { pending: true };
    const head = buf.toString('latin1', 0, end);
    if (/content-type:\s*gnss\/sourcetable/i.test(head)) {
      return { error: 'точка подключения не найдена на кастере' };
    }
    return { rest: buf.subarray(end + 4) };
  }
  if (/^SOURCETABLE 200/.test(status)) return { error: 'точка подключения не найдена на кастере' };
  if (/\b401\b/.test(status)) return { error: 'кастер отклонил логин или пароль', fatal: true };
  if (/\b403\b/.test(status)) return { error: 'доступ к точке подключения запрещён', fatal: true };
  if (/\b404\b/.test(status)) return { error: 'точка подключения не найдена на кастере' };
  return { error: `кастер ответил: ${status.slice(0, 60)}` };
}

// Имя сетевого интерфейса VPN, через который ушло соединение, или null.
// VPN-туннель принимает соединение сам, не дойдя до адресата: порт выглядит открытым
// и молчащим, хотя до приёмника запрос мог и не добраться.
const TUNNEL_RE = /tun|tap|vpn|wireguard|^wg\d|ppp|happ|sing|tailscale|zerotier/i;

function tunnelName(localAddress, interfaces = os.networkInterfaces()) {
  if (!localAddress) return null;
  const addr = localAddress.replace(/^::ffff:/, '');
  for (const [name, list] of Object.entries(interfaces)) {
    if (TUNNEL_RE.test(name) && list.some((i) => i.address === addr)) return name;
  }
  return null;
}

// Проверка «молчащего» порта: отдельным соединением спрашиваем у него таблицу источников,
// как это делает любой NTRIP-клиент. По ответу видно, кастер это или нет.
// Возвращает { kind: 'caster', mountpoints } | { kind: 'stream' } | { kind: 'text', text }
// | { kind: 'silent' } | { kind: 'error', text }. Если соединение ушло через VPN,
// в ответе есть поле tunnel с именем интерфейса.
function probePort(host, port, timeoutMs = 6000) {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    let done = false;
    let tunnel = null;
    const socket = net.connect({ host, port });
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(tunnel ? { ...result, tunnel } : result);
    };
    const classify = () => {
      if (!buf.length) return { kind: 'silent' };
      const text = buf.toString('latin1');
      if (/^SOURCETABLE 200|gnss\/sourcetable|^STR;/m.test(text)) {
        const mountpoints = text.split(/\r?\n/).filter((l) => l.startsWith('STR;')).map((l) => {
          const f = l.split(';');
          return { name: f[1], format: f[3] || '', details: f[4] || '', systems: f[6] || '', auth: f[15] || '' };
        });
        return { kind: 'caster', mountpoints };
      }
      if (buf.includes(0xd3) && !/^[\x20-\x7e\r\n\t]*$/.test(text.slice(0, 200))) return { kind: 'stream' };
      return { kind: 'text', text: text.replace(/[^\x20-\x7e]+/g, ' ').trim().slice(0, 160) };
    };
    const timer = setTimeout(() => finish(classify()), timeoutMs);
    socket.on('connect', () => {
      tunnel = tunnelName(socket.localAddress);
      socket.write(`GET / HTTP/1.0\r\nHost: ${host}:${port}\r\nUser-Agent: NTRIP UralsurveyLite/0.1\r\nAccept: */*\r\n\r\n`);
    });
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > 65536 || /ENDSOURCETABLE/.test(buf.toString('latin1'))) finish(classify());
    });
    socket.on('error', (err) => finish(buf.length ? classify() : { kind: 'error', text: describeError(err) }));
    socket.on('close', () => finish(classify()));
  });
}

module.exports = { Transport, STATES, parseNtripResponse, probePort, tunnelName };
