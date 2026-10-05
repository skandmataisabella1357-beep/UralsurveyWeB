'use strict';
// Синтетическая база тестовой сети: сама подключается к порту сервера и шлёт поток RTCM,
// как настоящий приёмник в режиме «TCP-клиент». По заданию изображает неисправность.

const net = require('net');
const { syntheticSource, encodeMsm4 } = require('../../core/simulator');
const rtcm3 = require('../../core/rtcm3');
const { random } = require('./stations');

class TestBase {
  constructor({ station, host, log = () => {} }) {
    this.station = station;
    this.host = host;
    this.log = log;
    this.rnd = random(station.stationId * 7919);
    this.fault = station.fault;
    this.socket = null;
    this.extra = null; // второе подключение для неисправности «два подключения сразу»
    this.timers = new Set();
    this.held = []; // данные, придержанные для выдачи пачкой
    this.tick = 0;
    this.connectedAt = 0;
    this.stats = { connects: 0, bytes: 0, corrupted: 0, skipped: 0 };
    const pos = { stationId: station.stationId, lat: station.lat, lon: station.lon, h: station.h };
    this.source = syntheticSource({ ...pos, withPosition: this.fault !== 'nopos' });
    // «Координаты сменились»: вторая станция в полукилометре севернее
    this.moved = this.fault === 'moved' ? syntheticSource({ ...pos, lat: station.lat + 0.005 }) : null;
    this.startedAt = 0;
  }

  between(a, b) {
    return a + this.rnd() * (b - a);
  }

  later(fn, ms) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (this.running) fn();
    }, ms);
    this.timers.add(t);
  }

  start() {
    this.running = true;
    this.startedAt = Date.now();
    this.clock = setInterval(() => this.second(), 1000);
    if (this.fault === 'dead') return;
    this.later(() => this.connect(), this.fault === 'late' ? 60000 : this.between(0, 1500));
  }

  stop() {
    this.running = false;
    clearInterval(this.clock);
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    if (this.socket) this.socket.destroy();
    if (this.extra) this.extra.destroy();
  }

  connect() {
    if (!this.running || this.socket) return;
    const socket = net.connect({ host: this.host, port: this.station.port });
    this.socket = socket;
    socket.setNoDelay(true);
    socket.on('connect', () => {
      this.stats.connects++;
      this.connectedAt = Date.now();
      // Плановые неисправности, которые начинаются после подключения
      if (this.fault === 'drop') this.later(() => this.drop(this.between(3000, 10000)), this.between(45000, 90000));
      if (this.fault === 'flap') this.later(() => this.drop(this.between(1000, 4000)), this.between(5000, 8000));
      if (this.fault === 'duplicate') this.later(() => this.duplicate(), this.between(15000, 30000));
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      // Сервер закрыл соединение или его нет: настоящий приёмник пробует снова
      if (this.running && !this.dropping) this.later(() => this.connect(), this.between(2000, 5000));
    });
  }

  // Обрыв со стороны базы и возвращение через pause миллисекунд
  drop(pause) {
    if (!this.socket) return;
    this.dropping = true;
    this.socket.destroy();
    this.socket = null;
    this.later(() => {
      this.dropping = false;
      this.connect();
    }, pause);
  }

  // Вторая «база» на том же порту: так бывает, когда приёмник переподключился,
  // а старое соединение ещё не умерло
  duplicate() {
    if (this.extra) this.extra.destroy();
    const extra = net.connect({ host: this.host, port: this.station.port });
    this.extra = extra;
    extra.on('error', () => {});
    extra.on('close', () => { if (this.extra === extra) this.extra = null; });
    this.later(() => this.duplicate(), this.between(15000, 30000));
  }

  write(data) {
    const target = this.extra && !this.extra.destroyed && this.extra.readyState === 'open' ? this.extra : this.socket;
    if (!target || target.destroyed || target.readyState !== 'open') return;
    this.stats.bytes += data.length;
    if (this.fault === 'fragment') {
      // По несколько байт с паузами: кадр приходит на сервер кусками
      let at = 0;
      const step = () => {
        if (at >= data.length || target.destroyed) return;
        const n = 1 + Math.floor(this.rnd() * 40);
        target.write(data.subarray(at, at + n));
        at += n;
        setTimeout(step, 2);
      };
      step();
      return;
    }
    target.write(data);
  }

  frames() {
    const elapsed = Date.now() - this.startedAt;
    const source = this.moved && elapsed > 60000 ? this.moved : this.source;
    let frames = source.next();
    if (this.fault === 'fewsats') {
      // Вместо полного набора — три спутника GPS, остальные системы пропали
      frames = frames.map((f) => {
        const type = (f[3] << 4) | (f[4] >> 4);
        if (type !== 1074) return type >= 1071 && type <= 1137 ? null : f;
        const obs = rtcm3.decodeMsm(type, f.subarray(3, f.length - 3));
        return encodeMsm4({
          type, stationId: this.station.stationId, epoch: obs.epoch, multiple: false,
          sats: [2, 13, 29].map((prn, i) => ({ prn, rangeMs: 70.4 + i * 3.1, signals: [{ id: 2, cnr: 33 - i }] })),
        });
      }).filter(Boolean);
    }
    if (this.fault === 'corrupt') {
      frames = frames.map((f) => {
        if (this.rnd() > 0.05) return f;
        const bad = Buffer.from(f);
        bad[3 + Math.floor(this.rnd() * (bad.length - 6))] ^= 1 << Math.floor(this.rnd() * 8);
        this.stats.corrupted++;
        return bad;
      });
    }
    if (this.fault === 'garbage' && this.rnd() < 0.3) {
      const junk = this.rnd() < 0.5
        ? Buffer.from('$GPTXT,01,01,02,ANTSTATUS=OK*3B\r\n', 'latin1')
        : Buffer.from(Array.from({ length: 5 + Math.floor(this.rnd() * 60) }, () => Math.floor(this.rnd() * 256)));
      frames.splice(1 + Math.floor(this.rnd() * (frames.length - 1)), 0, junk);
    }
    return frames;
  }

  second() {
    this.tick++;
    if (this.fault === 'dead' || this.fault === 'halfopen') return;
    const frames = this.frames();
    // Молчание при живом соединении: 30 секунд из каждых 90
    if (this.fault === 'stall' && this.connectedAt && ((Date.now() - this.connectedAt) / 1000) % 90 > 60) return;
    if (this.fault === 'gaps' && this.rnd() < 0.2) {
      this.stats.skipped++;
      return;
    }
    const data = Buffer.concat(frames);
    if (this.fault === 'burst') {
      // Копим 6 секунд и отдаём разом, как сотовый модем с плохим сигналом
      this.held.push(data);
      if (this.tick % 6 === 0) this.write(Buffer.concat(this.held.splice(0)));
      return;
    }
    this.write(data);
  }
}

module.exports = { TestBase };
