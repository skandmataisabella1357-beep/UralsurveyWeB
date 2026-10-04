'use strict';
// Раздача принятого потока дальше: порт на этом компьютере, к которому могут
// подключаться другие программы (RTKNAVI, str2str, свой кастер) и получать
// тот же поток байт в байт. Нужна, когда приёмник отдаёт данные только одному клиенту.

const net = require('net');
const { EventEmitter } = require('events');

const MAX_PENDING = 1024 * 1024; // клиент, который не успевает читать, отключается

class Relay extends EventEmitter {
  constructor(port, host = '127.0.0.1') {
    super();
    this.port = port;
    this.host = host;
    this.clients = new Set();
    this.server = null;
    this.error = null;
    this.running = false;
    this.retryTimer = null;
  }

  start() {
    this.running = true;
    this.listen();
  }

  listen() {
    const server = net.createServer((socket) => {
      this.clients.add(socket);
      this.emit('log', 'info', `К раздаче подключился клиент ${socket.remoteAddress}`);
      socket.on('error', () => {});
      socket.on('data', () => {}); // входящие от клиента не нужны
      socket.on('close', () => {
        if (this.clients.delete(socket)) this.emit('log', 'info', 'Клиент раздачи отключился');
      });
    });
    this.server = server;
    server.on('error', (err) => {
      this.server = null;
      this.error = err.code === 'EADDRINUSE' ? 'порт занят другой программой' : err.message;
      this.emit('log', 'error', `Раздача на порту ${this.port} не запущена: ${this.error}`);
      if (this.running) this.retryTimer = setTimeout(() => this.listen(), 10000);
    });
    server.listen(this.port, this.host, () => {
      this.error = null;
      this.emit('log', 'info', `Раздача потока открыта на порту ${this.port}`);
    });
  }

  write(chunk) {
    for (const c of this.clients) {
      if (c.writableLength > MAX_PENDING) {
        c.destroy();
        continue;
      }
      c.write(chunk);
    }
  }

  stop() {
    this.running = false;
    clearTimeout(this.retryTimer);
    for (const c of this.clients) c.destroy();
    this.clients.clear();
    if (this.server) this.server.close();
    this.server = null;
  }

  status() {
    return { port: this.port, clients: this.clients.size, error: this.error };
  }
}

module.exports = { Relay };
