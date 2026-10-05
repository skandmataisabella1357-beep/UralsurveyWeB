'use strict';
// Внутренняя шина сервера: соединение между службой приёма и её потребителями
// (раздача, позже архив и контроль). Работает только внутри машины.
//
// Сообщение: 4 байта — длина остального; 2 байта — длина заголовка; заголовок в JSON;
// затем тело — байты потока как есть. Заголовок говорит, что это и от какой станции.

const net = require('net');
const { EventEmitter } = require('events');

const MAX_MESSAGE = 1024 * 1024;
const MAX_QUEUE = 4 * 1024 * 1024; // потребитель, отставший на столько байт, отключается

function encode(header, body = Buffer.alloc(0)) {
  const head = Buffer.from(JSON.stringify(header), 'utf8');
  const out = Buffer.allocUnsafe(6 + head.length + body.length);
  out.writeUInt32BE(2 + head.length + body.length, 0);
  out.writeUInt16BE(head.length, 4);
  head.copy(out, 6);
  body.copy(out, 6 + head.length);
  return out;
}

// Разбор потока шины на сообщения. push(chunk) возвращает [{ header, body }].
class Decoder {
  constructor() {
    this.buf = Buffer.alloc(0);
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out = [];
    while (this.buf.length >= 6) {
      const total = this.buf.readUInt32BE(0);
      if (total < 2 || total > MAX_MESSAGE) throw new Error('повреждённое сообщение шины');
      if (this.buf.length < 4 + total) break;
      const headLen = this.buf.readUInt16BE(4);
      if (headLen > total - 2) throw new Error('повреждённый заголовок сообщения шины');
      const header = JSON.parse(this.buf.toString('utf8', 6, 6 + headLen));
      out.push({ header, body: this.buf.subarray(6 + headLen, 4 + total) });
      this.buf = this.buf.subarray(4 + total);
    }
    return out;
  }
}

// Сторона приёма: принимает потребителей и рассылает им сообщения
class BusServer extends EventEmitter {
  constructor({ host = '127.0.0.1', port }) {
    super();
    this.clients = new Set();
    this.server = net.createServer((socket) => {
      socket.setNoDelay(true);
      socket.on('error', () => {});
      socket.on('close', () => this.clients.delete(socket));
      this.clients.add(socket);
      this.emit('client', socket);
    });
    this.ready = new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => resolve(this.server.address().port));
    });
  }

  publish(header, body) {
    if (!this.clients.size) return;
    const msg = encode(header, body);
    for (const socket of this.clients) {
      // Зависший потребитель не должен копить память службы приёма
      if (socket.writableLength > MAX_QUEUE) {
        socket.destroy();
        continue;
      }
      socket.write(msg);
    }
  }

  // Сообщение одному потребителю — например, начальные сведения при подключении
  send(socket, header, body) {
    if (!socket.destroyed) socket.write(encode(header, body));
  }

  close() {
    for (const socket of this.clients) socket.destroy();
    return new Promise((resolve) => this.server.close(resolve));
  }
}

// Сторона потребителя: держит соединение с приёмом и поднимает его заново после обрыва
class BusClient extends EventEmitter {
  constructor({ host = '127.0.0.1', port, retryMs = 1000 }) {
    super();
    this.options = { host, port, retryMs };
    this.connected = false;
    this.running = false;
    this.socket = null;
    this.timer = null;
  }

  start() {
    this.running = true;
    this.connect();
  }

  connect() {
    const { host, port, retryMs } = this.options;
    const socket = net.connect({ host, port });
    const decoder = new Decoder();
    this.socket = socket;
    socket.setNoDelay(true);
    socket.on('connect', () => {
      this.connected = true;
      this.emit('up');
    });
    socket.on('data', (chunk) => {
      try {
        for (const m of decoder.push(chunk)) this.emit('message', m.header, m.body);
      } catch (err) {
        this.emit('fault', err.message);
        socket.destroy();
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      if (this.socket !== socket) return;
      const was = this.connected;
      this.connected = false;
      this.socket = null;
      if (was) this.emit('down');
      if (this.running) this.timer = setTimeout(() => this.connect(), retryMs);
    });
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    if (this.socket) this.socket.destroy();
  }
}

module.exports = { encode, Decoder, BusServer, BusClient };
