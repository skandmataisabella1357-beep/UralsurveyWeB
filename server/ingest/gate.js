'use strict';
// Шлюз станции: слой службы приёма перед ядром для баз, которые сами шлют поток на свой порт.
// Ядро про него не знает: шлюз принимает базу на внешнем порту, проверяет её и передаёт байты
// ядру по соединению внутри машины.
//
// Что проверяется:
//   1. адрес — список разрешённых адресов станции (отдельные адреса и подсети IPv4);
//   2. пароль станции — если задан, база обязана представиться как NTRIP-сервер
//      (SOURCE пароль /ТОЧКА или POST /ТОЧКА с Basic); поток без представления не принимается;
//   3. данные — подключение становится действующим только после первого целого кадра RTCM.
// Живое соединение молчащим не заменяется: новое подключение ждёт в запасе и занимает место
// действующего, только когда то замолчало, а новое уже прислало верный кадр.

const net = require('net');
const crypto = require('crypto');
const { StreamParser } = require('../../core/stream');

const DEFAULTS = {
  liveMs: 3000, // действующее соединение «живое», если данные были не раньше
  candidateMs: 15000, // столько новое подключение может ждать своей очереди или первого кадра
  handshakeMs: 10000, // столько ждём представления базы
  maxCandidates: 3,
  maxHead: 2048,
};

function normalize(address) {
  return String(address || '').replace(/^::ffff:/, '');
}

function ipv4(text) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (!m || m.slice(1).some((p) => Number(p) > 255)) return null;
  return ((Number(m[1]) << 24) | (Number(m[2]) << 16) | (Number(m[3]) << 8) | Number(m[4])) >>> 0;
}

// Правило списка: «1.2.3.4» или «10.0.0.0/8». Возвращает функцию проверки адреса.
function rule(text) {
  const [base, bitsText] = String(text).trim().split('/');
  const ip = ipv4(base);
  const bits = bitsText === undefined ? 32 : Number(bitsText);
  if (ip === null || !Number.isInteger(bits) || bits < 0 || bits > 32) {
    throw new Error(`Список разрешённых адресов: «${text}» — не адрес IPv4 и не подсеть вида 10.0.0.0/8.`);
  }
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (address) => {
    const v = ipv4(normalize(address));
    return v !== null && ((v & mask) >>> 0) === ((ip & mask) >>> 0);
  };
}

function sameText(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

// Представление базы как NTRIP-сервера. Возвращает { pending } | { invalid } | { version, mount, password, rest }.
function parseSource(buf, maxHead) {
  let end = buf.indexOf('\r\n\r\n');
  let skip = 4;
  if (end === -1) {
    // Версия 1 у части приёмников — одна строка без пустой строки следом
    const line = buf.indexOf('\r\n');
    if (line !== -1 && /^SOURCE\s/i.test(buf.toString('latin1', 0, line)) && buf.length > line + 2 && buf[line + 2] === 0xd3) {
      end = line;
      skip = 2;
    } else {
      return buf.length > maxHead ? { invalid: true } : { pending: true };
    }
  }
  const lines = buf.toString('latin1', 0, end).split('\r\n');
  const rest = buf.subarray(end + skip);
  const v1 = /^SOURCE\s+(\S*)\s+\/?(\S+)\s*$/i.exec(lines[0]);
  if (v1) return { version: 1, password: v1[1], mount: v1[2], rest };
  const v2 = /^POST\s+\/?(\S+)\s+HTTP\/1\.[01]\s*$/i.exec(lines[0]);
  if (!v2) return { invalid: true };
  const auth = lines.map((l) => /^Authorization:\s*Basic\s+(\S+)/i.exec(l)).find(Boolean);
  let password = '';
  if (auth) {
    const pair = Buffer.from(auth[1], 'base64').toString('utf8');
    password = pair.includes(':') ? pair.slice(pair.indexOf(':') + 1) : pair;
  }
  return { version: 2, password, mount: v2[1], rest };
}

class StationGate {
  // code — код станции; host, port — внешний адрес и порт; allow — список разрешённых адресов
  // (пустой — любые); password — пароль станции (пустой — без представления)
  constructor({ code, host = '127.0.0.1', port, allow = [], password = '', log = () => {}, timing = {} }) {
    this.code = code;
    this.log = log;
    this.password = password || '';
    this.rules = allow.map(rule);
    this.t = { ...DEFAULTS, ...timing };
    this.current = null; // действующее подключение базы
    this.candidates = new Set();
    this.core = null; // соединение ядра, куда уходят байты
    this.stats = { accepted: 0, switched: 0, refusedAddress: 0, refusedPassword: 0, refusedSilent: 0, refusedBusy: 0, lastRefusal: null };

    this.outer = net.createServer((socket) => this.onBase(socket));
    // Внутренний порт только для ядра: оно подключается сюда как к обычному порту приёмника
    this.inner = net.createServer((socket) => {
      if (this.core) this.core.destroy();
      this.core = socket;
      socket.on('error', () => {});
      socket.on('close', () => { if (this.core === socket) this.core = null; });
    });
    this.ready = Promise.all([
      new Promise((resolve, reject) => { this.outer.once('error', reject); this.outer.listen(port, host, () => resolve(this.outer.address().port)); }),
      new Promise((resolve, reject) => { this.inner.once('error', reject); this.inner.listen(0, '127.0.0.1', () => resolve(this.inner.address().port)); }),
    ]).then(([outerPort, innerPort]) => {
      this.port = outerPort;
      this.pipePort = innerPort;
      return this;
    });
    this.watch = setInterval(() => this.review(), 250);
    if (this.watch.unref) this.watch.unref();
  }

  refuse(socket, kind, text, reply) {
    this.stats[kind]++;
    this.stats.lastRefusal = { at: Date.now(), address: normalize(socket.remoteAddress), reason: text };
    this.log(`приём ${this.code}: подключение с ${normalize(socket.remoteAddress)} отклонено — ${text}`);
    if (reply) socket.end(reply);
    else socket.destroy();
  }

  onBase(socket) {
    const address = normalize(socket.remoteAddress);
    socket.on('error', () => {});
    if (this.rules.length && !this.rules.some((ok) => ok(address))) {
      this.refuse(socket, 'refusedAddress', 'адрес не входит в список разрешённых');
      return;
    }
    if (this.candidates.size >= this.t.maxCandidates) {
      this.refuse(socket, 'refusedBusy', 'слишком много одновременных подключений к порту станции');
      return;
    }
    const c = {
      socket, address, since: Date.now(), lastAt: 0, bytes: 0,
      authed: !this.password, proven: false, head: Buffer.alloc(0), parser: new StreamParser(), pending: [],
    };
    this.candidates.add(c);
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 10000);
    socket.on('data', (chunk) => this.onChunk(c, chunk));
    socket.on('close', () => {
      this.candidates.delete(c);
      if (this.current === c) this.current = null;
    });
  }

  onChunk(c, chunk) {
    if (!c.authed) {
      // Пароль задан: до потока база обязана представиться
      c.head = Buffer.concat([c.head, chunk]);
      const first = c.head.toString('latin1', 0, Math.min(c.head.length, 7)).toUpperCase();
      const mayBe = ['SOURCE ', 'POST '].some((word) => word.startsWith(first) || first.startsWith(word));
      if (!mayBe) {
        this.refuse(c.socket, 'refusedPassword', 'поток без пароля станции');
        return;
      }
      const req = parseSource(c.head, this.t.maxHead);
      if (req.pending) return;
      if (req.invalid) {
        this.refuse(c.socket, 'refusedPassword', 'непонятное представление базы');
        return;
      }
      if (!sameText(req.password, this.password) || req.mount.toUpperCase() !== this.code.toUpperCase()) {
        const reply = req.version === 2 ? 'HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n' : 'ERROR - Bad Password\r\n';
        this.refuse(c.socket, 'refusedPassword', 'неверный пароль станции или чужая точка', reply);
        return;
      }
      c.authed = true;
      c.head = null;
      c.socket.write(req.version === 2 ? 'HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n' : 'ICY 200 OK\r\n\r\n');
      if (!req.rest.length) return;
      chunk = req.rest;
    }

    c.bytes += chunk.length;
    if (this.current === c) {
      c.lastAt = Date.now();
      if (this.core && !this.core.destroyed) this.core.write(chunk);
      return;
    }
    // Запасное подключение: ждём первый целый кадр, данные придерживаем
    if (!c.proven) {
      const frames = c.parser.push(chunk);
      if (frames.some((f) => f.kind === 'rtcm')) c.proven = true;
    }
    c.lastAt = Date.now();
    c.pending.push(chunk);
    // В запасе держим не больше нескольких секунд потока
    let size = c.pending.reduce((s, b) => s + b.length, 0);
    while (size > 65536 && c.pending.length > 1) size -= c.pending.shift().length;
    this.review();
  }

  // Решение о смене действующего подключения и уборка запаса
  review() {
    const now = Date.now();
    const live = this.current && now - this.current.lastAt <= this.t.liveMs;
    if (!live) {
      // Действующее молчит (или его нет): место занимает запасное, уже приславшее верный кадр
      let best = null;
      for (const c of this.candidates) {
        if (c !== this.current && c.authed && c.proven && now - c.lastAt <= this.t.liveMs && (!best || c.lastAt > best.lastAt)) best = c;
      }
      if (best) this.promote(best);
    }
    for (const c of [...this.candidates]) {
      if (c === this.current) continue;
      const waited = now - c.since;
      if (!c.authed && waited > this.t.handshakeMs) this.refuse(c.socket, 'refusedPassword', 'база не представилась');
      else if (c.authed && !c.proven && waited > this.t.candidateMs) this.refuse(c.socket, 'refusedSilent', 'подключение не прислало ни одного кадра');
      else if (c.authed && c.proven && waited > this.t.candidateMs) this.refuse(c.socket, 'refusedBusy', 'на порту уже работает живая база');
    }
  }

  promote(c) {
    const old = this.current;
    this.current = c;
    this.stats.accepted++;
    if (old) {
      this.stats.switched++;
      this.log(`приём ${this.code}: база переподключилась с ${c.address}, прежнее соединение замолчало и закрыто`);
      old.socket.destroy();
    }
    if (this.core && !this.core.destroyed) for (const chunk of c.pending) this.core.write(chunk);
    c.pending = [];
  }

  snapshot() {
    const now = Date.now();
    const cur = this.current;
    return {
      code: this.code,
      port: this.port,
      protectedByPassword: Boolean(this.password),
      protectedByAddress: this.rules.length > 0,
      current: cur ? { address: cur.address, since: cur.since, bytes: cur.bytes, lastDataAgeMs: cur.lastAt ? now - cur.lastAt : null } : null,
      standby: [...this.candidates].filter((c) => c !== cur).length,
      ...this.stats,
    };
  }

  close() {
    clearInterval(this.watch);
    for (const c of this.candidates) c.socket.destroy();
    if (this.core) this.core.destroy();
    return Promise.all([new Promise((r) => this.outer.close(r)), new Promise((r) => this.inner.close(r))]);
  }
}

module.exports = { StationGate, rule, parseSource };
