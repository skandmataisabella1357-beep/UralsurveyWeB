'use strict';
// Имитатор базовой станции для тестов и демонстрации: отдаёт поток RTCM 3
// по TCP или как NTRIP-кастер. Источник данных — синтетическая станция
// либо запись реального потока из файла.

const fs = require('fs');
const net = require('net');
const { BitWriter } = require('./bits');
const { crc24q } = require('./crc24q');
const { StreamParser } = require('./stream');
const { llhToEcef, D2R } = require('./geo');

function frame(payload) {
  const out = Buffer.alloc(payload.length + 6);
  out[0] = 0xd3;
  out[1] = (payload.length >> 8) & 0x03;
  out[2] = payload.length & 0xff;
  payload.copy(out, 3);
  const crc = crc24q(out, 0, payload.length + 3);
  out[payload.length + 3] = (crc >> 16) & 0xff;
  out[payload.length + 4] = (crc >> 8) & 0xff;
  out[payload.length + 5] = crc & 0xff;
  return out;
}

function encode1006({ stationId, ecef, antennaHeight = 0 }) {
  const w = new BitWriter();
  w.u(12, 1006).u(12, stationId).u(6, 0).u(1, 1).u(1, 1).u(1, 1).u(1, 0);
  w.s(38, ecef[0] * 1e4).u(2, 0);
  w.s(38, ecef[1] * 1e4).u(2, 0);
  w.s(38, ecef[2] * 1e4);
  w.u(16, antennaHeight * 1e4);
  return frame(w.toBuffer());
}

function encode1033({ stationId, antenna, antennaSerial, receiver, firmware, receiverSerial }) {
  const w = new BitWriter();
  w.u(12, 1033).u(12, stationId);
  w.u(8, antenna.length).str(antenna).u(8, 0);
  for (const s of [antennaSerial, receiver, firmware, receiverSerial]) w.u(8, s.length).str(s);
  return frame(w.toBuffer());
}

// MSM4: sats = [{ prn, rangeMs, signals: [{ id, cnr }] }]
function encodeMsm4({ type, stationId, epoch, multiple, sats }) {
  const sigIds = [...new Set(sats.flatMap((s) => s.signals.map((g) => g.id)))].sort((a, b) => a - b);
  const w = new BitWriter();
  w.u(12, type).u(12, stationId).u(30, epoch).u(1, multiple ? 1 : 0);
  w.u(3, 0).u(7, 0).u(2, 0).u(2, 0).u(1, 0).u(3, 0);
  for (let i = 1; i <= 64; i++) w.u(1, sats.some((s) => s.prn === i) ? 1 : 0);
  for (let i = 1; i <= 32; i++) w.u(1, sigIds.includes(i) ? 1 : 0);
  const cells = [];
  for (const s of sats) {
    for (const id of sigIds) {
      const sig = s.signals.find((g) => g.id === id);
      w.u(1, sig ? 1 : 0);
      if (sig) cells.push(sig);
    }
  }
  for (const s of sats) w.u(8, Math.floor(s.rangeMs));
  for (const s of sats) w.u(10, Math.floor((s.rangeMs % 1) * 1024));
  for (let i = 0; i < cells.length; i++) w.s(15, 0); // точная часть псевдодальности
  for (let i = 0; i < cells.length; i++) w.s(22, 0); // точная часть фазы
  for (let i = 0; i < cells.length; i++) w.u(4, 15); // время непрерывного слежения
  for (let i = 0; i < cells.length; i++) w.u(1, 0);
  for (const c of cells) w.u(6, Math.max(1, Math.min(63, Math.round(c.cnr))));
  return frame(w.toBuffer());
}

const GPS_EPOCH_MS = Date.UTC(1980, 0, 6);
const WEEK_MS = 604800000;

// Синтетическая станция: координаты, описание оборудования и MSM4 четырёх систем.
// Псевдодальности правдоподобны по величине, но не согласованы с орбитами.
function syntheticSource({ stationId = 1, lat, lon, h = 250, withPosition = true }) {
  const ecef = llhToEcef(lat * D2R, lon * D2R, h);
  const systems = [
    { type: 1074, prns: [2, 5, 7, 13, 15, 20, 29, 30], signals: [2, 10], offset: 0 },
    { type: 1084, prns: [1, 2, 8, 11, 12, 22, 23], signals: [2, 8], offset: 1 },
    { type: 1094, prns: [3, 5, 9, 15, 24, 31], signals: [2, 23, 15], offset: 2 },
    { type: 1124, prns: [6, 9, 11, 16, 23, 28, 37], signals: [2, 14, 8], offset: 3 },
  ];
  let tick = 0;
  return {
    next() {
      const now = Date.now();
      const tow = (now - GPS_EPOCH_MS + 18000) % WEEK_MS;
      const utc3 = new Date(now + 3 * 3600 * 1000);
      const gloEpoch = utc3.getUTCDay() * 2 ** 27 + (now + 3 * 3600 * 1000) % 86400000;
      const frames = [];
      if (withPosition && tick % 5 === 0) frames.push(encode1006({ stationId, ecef, antennaHeight: 0.085 }));
      if (tick % 10 === 0) {
        frames.push(encode1033({
          stationId,
          antenna: 'DEMO.ANTENNA    NONE',
          antennaSerial: 'A0001',
          receiver: 'DEMO RECEIVER',
          firmware: '1.0',
          receiverSerial: `R${String(stationId).padStart(4, '0')}`,
        }));
      }
      systems.forEach((sys, idx) => {
        const sats = sys.prns.map((prn, i) => {
          const phase = tick / 40 + prn * 1.7 + sys.offset;
          const base = 34 + 12 * Math.abs(Math.sin(prn * 0.9 + sys.offset));
          return {
            prn,
            rangeMs: 68 + ((prn * 7 + i * 3) % 17) + 0.37,
            signals: sys.signals.map((id, k) => ({ id, cnr: base + 3 * Math.sin(phase) - k * 3 })),
          };
        });
        let epoch = tow;
        if (sys.type === 1084) epoch = gloEpoch;
        if (sys.type === 1124) epoch = (tow + WEEK_MS - 14000) % WEEK_MS;
        frames.push(encodeMsm4({ type: sys.type, stationId, epoch, multiple: idx < systems.length - 1, sats }));
      });
      tick++;
      return frames;
    },
  };
}

// Воспроизведение записи: эпоха за эпохой, по кругу. drop — типы сообщений, которые вырезать.
function replaySource(file, { drop = [], loop = true } = {}) {
  const parser = new StreamParser();
  const groups = [];
  for (const f of parser.push(fs.readFileSync(file))) {
    if (f.kind !== 'rtcm' || drop.includes(f.type)) continue;
    const startsEpoch = f.type >= 1071 && f.type <= 1077;
    if (startsEpoch || !groups.length) groups.push([]);
    groups[groups.length - 1].push(frame(f.payload));
  }
  let i = 0;
  return {
    epochs: groups.length,
    next() {
      if (i >= groups.length) {
        if (!loop) return [];
        i = 0;
      }
      return groups[i++];
    },
  };
}

// Сервер-имитатор. protocol: 'tcp' — отдаёт поток сразу; 'ntrip' — после запроса GET.
function createSimulator({
  source,
  port = 0,
  host = '127.0.0.1',
  protocol = 'tcp',
  mountpoint = 'DEMO',
  username = '',
  password = '',
  intervalMs = 1000,
}) {
  const clients = new Set();
  let paused = false;

  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    socket.on('close', () => clients.delete(socket));
    if (protocol === 'tcp') {
      clients.add(socket);
      return;
    }
    let req = '';
    const onData = (chunk) => {
      req += chunk.toString('latin1');
      if (!req.includes('\r\n\r\n')) return;
      socket.off('data', onData);
      const path = (req.match(/^GET\s+(\S+)/) || [])[1] || '';
      const auth = (req.match(/Authorization:\s*Basic\s+(\S+)/i) || [])[1] || '';
      const expected = Buffer.from(`${username}:${password}`).toString('base64');
      if (path !== `/${mountpoint}`) {
        socket.end('SOURCETABLE 200 OK\r\nContent-Type: text/plain\r\n\r\nENDSOURCETABLE\r\n');
      } else if ((username || password) && auth !== expected) {
        socket.end('HTTP/1.0 401 Unauthorized\r\n\r\n');
      } else {
        socket.write('ICY 200 OK\r\n\r\n');
        clients.add(socket);
      }
    };
    socket.on('data', onData);
  });

  const timer = setInterval(() => {
    if (paused) return;
    const frames = source.next();
    if (!frames.length || !clients.size) return;
    const data = Buffer.concat(frames);
    for (const c of clients) c.write(data);
  }, intervalMs);

  const ready = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server.address().port));
  });

  return {
    ready,
    pause(value) {
      paused = value;
    },
    dropClients() {
      for (const c of clients) c.destroy();
    },
    close() {
      clearInterval(timer);
      for (const c of clients) c.destroy();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

module.exports = { frame, encode1006, encode1033, encodeMsm4, syntheticSource, replaySource, createSimulator };
