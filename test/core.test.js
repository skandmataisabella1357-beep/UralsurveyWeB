'use strict';
// Тесты ядра. Эталонные значения получены независимыми средствами:
// RTKLIB (convbin, rnx2rtkp) и pyrtcm на тех же записях из test/fixtures.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { StreamParser } = require('../core/stream');
const rtcm = require('../core/rtcm3');
const { parseGga } = require('../core/nmea');
const { ecefToLlh, llhToEcef, D2R, R2D } = require('../core/geo');
const { solveEpoch, PositionAverager } = require('../core/spp');
const { parseNtripResponse, probePort } = require('../core/transport');
const sim = require('../core/simulator');
const { StationSession } = require('../core/station');

const fixture = (name) => path.join(__dirname, 'fixtures', name);
const GMSD = fixture('GMSD7_20121014.rtcm3');

function frames(file) {
  return new StreamParser().push(fs.readFileSync(file)).filter((f) => f.kind === 'rtcm');
}

function near(actual, expected, tolerance, label) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label || 'значение'}: ${actual} вместо ${expected} (допуск ${tolerance})`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(check, timeoutMs = 4000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (check()) return;
    await sleep(25);
  }
  assert.fail('условие не выполнилось за отведённое время');
}

test('поток: кадры реальной записи выделяются без потерь', () => {
  const data = fs.readFileSync(GMSD);
  const whole = new StreamParser();
  whole.push(data);
  assert.equal(whole.stats.rtcmFrames, 1143);
  assert.equal(whole.stats.crcErrors, 0);
  assert.equal(whole.format().label, 'RTCM 3');

  // Тот же поток, нарезанный произвольными кусками, даёт тот же результат
  const pieces = new StreamParser();
  for (let i = 0; i < data.length; i += 37) pieces.push(data.subarray(i, i + 37));
  assert.equal(pieces.stats.rtcmFrames, 1143);
});

test('поток: после мусора и испорченного кадра синхронизация восстанавливается', () => {
  const list = frames(GMSD).slice(0, 6).map((f) => sim.frame(f.payload));
  const broken = Buffer.from(list[2]);
  broken[10] ^= 0xff;
  const p = new StreamParser();
  const out = p.push(Buffer.concat([list[0], list[1], Buffer.from([1, 2, 0xd3, 0, 4]), broken, list[3], list[4]]));
  assert.equal(out.length, 4);
  assert.equal(p.stats.crcErrors, 1);
});

test('поток: NMEA и UBX распознаются', () => {
  const p = new StreamParser();
  const gga = '$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,*47\r\n';
  const ubx = Buffer.from([0xb5, 0x62, 0x01, 0x02, 0x02, 0x00, 0xaa, 0xbb, 0x6a, 0x27]);
  const out = p.push(Buffer.concat([Buffer.from(gga), ubx, Buffer.from(gga)]));
  assert.equal(out.filter((f) => f.kind === 'nmea').length, 2);
  assert.equal(p.stats.ubxFrames, 1);
  const g = parseGga(out[0].line);
  near(g.lat * R2D, 48.1173, 1e-4);
  near(g.lon * R2D, 11.516667, 1e-4);
  near(g.h, 592.3, 1e-6);
});

test('1005: координаты станции совпадают с pyrtcm', () => {
  const f = frames(fixture('testglo.rtcm3')).find((x) => x.type === 1005);
  const p = rtcm.decodeStationPosition(1005, f.payload);
  near(p.ecef[0], -3869297.5138, 1e-4);
  near(p.ecef[1], 3436571.3345, 1e-4);
  near(p.ecef[2], 3717369.3757, 1e-4);
  assert.equal(p.antennaHeight, null);
});

test('1019: эфемериды GPS совпадают с pyrtcm', () => {
  const f = frames(GMSD).find((x) => x.type === 1019);
  const e = rtcm.decodeGpsEphemeris(f.payload);
  assert.equal(e.prn, 28);
  assert.equal(e.week, 685);
  assert.equal(e.toe, 604784);
  assert.equal(e.toc, 604784);
  assert.equal(e.health, 0);
  near(e.sqrtA, 5153.630821228027, 1e-9);
  near(e.ecc, 0.018162566586397588, 1e-15);
  near(e.m0 / Math.PI, 0.5709883873350918, 1e-12);
  near(e.af0, 0.0001947185955941677, 1e-15);
  near(e.tgd, -1.0710209608078003e-8, 1e-18);
  near(e.crs, 67.3125, 1e-9);
});

test('MSM7: псевдодальности совпадают с RINEX из RTKLIB', () => {
  const f = frames(GMSD).find((x) => x.type === 1077);
  const m = rtcm.decodeMsm(1077, f.payload);
  assert.equal(m.sys, 'GPS');
  assert.equal(m.level, 7);
  assert.equal(m.stationId, 611);
  assert.equal(m.epoch, 604784000);
  assert.deepEqual(m.sats.map((s) => s.prn), [1, 3, 6, 7, 11, 13, 16, 19, 21, 23, 30, 31]);
  const g01 = Object.fromEntries(m.sats[0].signals.map((s) => [s.code, s]));
  near(g01['1C'].pr, 24922227.578, 1e-3);
  near(g01['2W'].pr, 24922248.613, 1e-3);
  near(g01['2X'].pr, 24922248.379, 1e-3);
  near(g01['5X'].pr, 24922250.090, 1e-3);
  near(g01['1C'].cnr, 35.375, 1e-9);
});

test('описание оборудования, старые наблюдения и смешанный поток разбираются', () => {
  const d = rtcm.decodeDescriptors(1033, frames(GMSD).find((x) => x.type === 1033).payload);
  assert.equal(d.receiver, 'TRIMBLE NETR9');

  const glo = frames(fixture('testglo.rtcm3'));
  const h = rtcm.decodeLegacyObsHeader(1004, glo.find((x) => x.type === 1004).payload);
  assert.equal(h.sys, 'GPS');
  assert.ok(h.satCount >= 4 && h.satCount <= 14);

  // В этой записи по одному сообщению каждого вида. Число спутников и ячеек
  // в сообщениях MSM сверено с pyrtcm (часть сообщений в записи пустые).
  const expected = {
    1076: [10, 42], 1077: [10, 42], 1086: [8, 28], 1087: [8, 28], 1096: [7, 35], 1097: [7, 35], 1106: [2, 3],
    1107: [2, 3], 1116: [0, 0], 1117: [0, 0], 1126: [11, 23], 1127: [11, 23], 1136: [0, 0], 1137: [0, 0],
  };
  let msmSeen = 0;
  for (const f of frames(fixture('uscl-mixed.rtcm3'))) {
    if (rtcm.isMsm(f.type)) {
      const m = rtcm.decodeMsm(f.type, f.payload);
      const cells = m.sats.reduce((sum, sat) => sum + sat.signals.length, 0);
      assert.deepEqual([m.sats.length, cells], expected[f.type], `MSM ${f.type}`);
      msmSeen++;
    }
    if (f.type === 1005 || f.type === 1006) assert.ok(Math.hypot(...rtcm.decodeStationPosition(f.type, f.payload).ecef) > 6e6);
    if (rtcm.EPHEMERIS_TYPES[f.type]) assert.ok(rtcm.ephemerisSat(f.type, f.payload).prn > 0);
  }
  assert.equal(msmSeen, 14);
});

test('кодирование и разбор 1006 и MSM4 согласованы', () => {
  const ecef = llhToEcef(56.8389 * D2R, 60.6057 * D2R, 270);
  const p = new StreamParser();
  const [f1, f2] = p.push(Buffer.concat([
    sim.encode1006({ stationId: 42, ecef, antennaHeight: 1.234 }),
    sim.encodeMsm4({
      type: 1084,
      stationId: 42,
      epoch: 123456,
      multiple: false,
      sats: [
        { prn: 3, rangeMs: 70.5, signals: [{ id: 2, cnr: 44 }] },
        { prn: 17, rangeMs: 81.25, signals: [{ id: 2, cnr: 38 }, { id: 8, cnr: 31 }] },
      ],
    }),
  ]));
  const pos = rtcm.decodeStationPosition(1006, f1.payload);
  assert.equal(pos.stationId, 42);
  for (let i = 0; i < 3; i++) near(pos.ecef[i], ecef[i], 1e-4);
  near(pos.antennaHeight, 1.234, 1e-9);

  const m = rtcm.decodeMsm(1084, f2.payload);
  assert.equal(m.sys, 'GLO');
  assert.deepEqual(m.sats.map((s) => s.label), ['R03', 'R17']);
  assert.deepEqual(m.sats[1].signals.map((s) => [s.code, s.cnr]), [['1C', 38], ['2C', 31]]);
  near(m.sats[1].signals[0].pr, 81.25 * rtcm.RANGE_MS, 1e-6);
});

test('геодезия: ECEF и геодезические координаты переходят друг в друга', () => {
  const ecef = llhToEcef(57.01 * D2R, 60.47 * D2R, 263.5);
  const g = ecefToLlh(...ecef);
  near(g.lat * R2D, 57.01, 1e-10);
  near(g.lon * R2D, 60.47, 1e-10);
  near(g.h, 263.5, 1e-4);
});

test('расчёт координат по наблюдениям совпадает с RTKLIB', () => {
  // Эталон: rnx2rtkp, режим single, ионосферно-свободная комбинация, та же эпоха 00:04:00
  const ref = [-3607660.1317, 4147856.1820, 3223725.3807];
  const eph = new Map();
  const avg = new PositionAverager();
  let atRef = null;
  let solved = 0;
  for (const f of frames(GMSD)) {
    if (f.type === 1019) {
      const e = rtcm.decodeGpsEphemeris(f.payload);
      eph.set(e.prn, e);
    } else if (f.type === 1077) {
      const m = rtcm.decodeMsm(1077, f.payload);
      const s = solveEpoch(m.epoch / 1000, m.sats, eph);
      if (!s.ok) continue;
      solved++;
      avg.add(s.ecef, s.gdop);
      if (m.epoch === 240000) atRef = s;
    }
  }
  assert.ok(solved > 50);
  assert.equal(atRef.mode, 'dual');
  for (let i = 0; i < 3; i++) near(atRef.ecef[i], ref[i], 0.05, `координата ${i}`);
  // Среднее за сеанс остаётся в пределах метровой точности от эталона
  assert.ok(Math.hypot(...avg.mean.map((v, i) => v - ref[i])) < 10);
});

test('MSM4 с эфемеридами и без координат: разбор и расчёт положения', () => {
  // Та же запись, перекодированная в MSM4 программой str2str из RTKLIB:
  // состав потока как у базы без сообщений 1005/1006.
  const full = new Map();
  for (const f of frames(GMSD)) {
    if (f.type === 1077) {
      const m = rtcm.decodeMsm(1077, f.payload);
      full.set(m.epoch, m);
    }
  }
  const eph = new Map();
  let cells = 0;
  let last = null;
  for (const f of frames(fixture('gmsd-msm4-rtklib.rtcm3'))) {
    if (f.type === 1019) {
      const e = rtcm.decodeGpsEphemeris(f.payload);
      eph.set(e.prn, e);
      continue;
    }
    assert.equal(f.type, 1074);
    const m = rtcm.decodeMsm(1074, f.payload);
    const ref = full.get(m.epoch);
    for (const sat of m.sats) {
      const refSat = ref.sats.find((x) => x.prn === sat.prn);
      for (const sig of sat.signals) {
        const refSig = refSat.signals.find((x) => x.code === sig.code);
        if (sig.pr === null || refSig.pr === null) continue;
        // Шаг дальности в MSM4 — 1,8 см, поэтому расхождение с MSM7 не больше половины шага
        near(sig.pr, refSig.pr, 0.0091, `${sat.label} ${sig.code}`);
        cells++;
      }
    }
    if (m.epoch === 240000) last = solveEpoch(m.epoch / 1000, m.sats, eph);
  }
  assert.ok(cells > 7000);
  assert.equal(last.ok, true);
  const ref = [-3607660.1317, 4147856.1820, 3223725.3807];
  assert.ok(Math.hypot(...last.ecef.map((v, i) => v - ref[i])) < 0.5);
});

test('расчёт координат: без эфемерид решения нет, причина названа', () => {
  const m = rtcm.decodeMsm(1077, frames(GMSD).find((x) => x.type === 1077).payload);
  const s = solveEpoch(m.epoch / 1000, m.sats, new Map());
  assert.equal(s.ok, false);
  assert.equal(s.reason, 'ephemeris');
  assert.equal(s.available, 0);
});

test('ответы NTRIP-кастера', () => {
  assert.deepEqual(parseNtripResponse(Buffer.from('ICY 200 OK\r\n\r\n\xd3\x00', 'latin1')).rest, Buffer.from([0xd3, 0]));
  assert.equal(parseNtripResponse(Buffer.from('ICY 200')).pending, true);
  assert.equal(parseNtripResponse(Buffer.from('HTTP/1.0 401 Unauthorized\r\n\r\n')).fatal, true);
  assert.match(parseNtripResponse(Buffer.from('SOURCETABLE 200 OK\r\n')).error, /не найдена/);
  assert.equal(parseNtripResponse(Buffer.from('HTTP/1.1 200 OK\r\nNtrip-Version: Ntrip/2.0\r\n\r\nAB')).rest.toString(), 'AB');
});

test('станция с координатами в потоке: TCP', async () => {
  const s = sim.createSimulator({ source: sim.syntheticSource({ stationId: 7, lat: 56.8389, lon: 60.6057, h: 270 }), intervalMs: 30 });
  const session = new StationSession({ id: 'a', name: 'A', mode: 'tcp', host: '127.0.0.1', port: await s.ready });
  session.start();
  try {
    await until(() => session.snapshot().position !== null && session.snapshot().satTotal === 28);
    const snap = session.snapshot();
    assert.equal(snap.link.state, 'online');
    assert.equal(snap.position.source, 'rtcm');
    near(snap.position.lat, 56.8389, 1e-7);
    near(snap.position.lon, 60.6057, 1e-7);
    assert.equal(snap.stationId, 7);
    assert.equal(snap.descriptors.receiver, 'DEMO RECEIVER');
    assert.deepEqual(snap.constellations.map((c) => c.key), ['GPS', 'GLO', 'GAL', 'BDS']);
  } finally {
    session.stop();
    await s.close();
  }
});

test('станция без координат в потоке: NTRIP, положение вычисляется', async () => {
  const s = sim.createSimulator({
    source: sim.replaySource(GMSD),
    intervalMs: 3,
    protocol: 'ntrip',
    mountpoint: 'GMSD',
    username: 'user',
    password: 'pass',
  });
  const port = await s.ready;
  const base = { mode: 'ntrip', host: '127.0.0.1', port, mountpoint: 'GMSD', username: 'user' };
  const good = new StationSession({ id: 'g', name: 'G', ...base, password: 'pass' });
  const bad = new StationSession({ id: 'b', name: 'B', ...base, password: 'wrong' });
  const lost = new StationSession({ id: 'l', name: 'L', ...base, mountpoint: 'NONE', password: 'pass' });
  for (const x of [good, bad, lost]) x.start();
  try {
    assert.match(good.positionNote() || '', /^$/); // до первых данных подсказки нет
    await until(() => good.snapshot().position !== null, 8000);
    const snap = good.snapshot();
    assert.equal(snap.position.source, 'computed');
    near(snap.position.lat, 30.5566, 2e-3);
    near(snap.position.lon, 131.0156, 2e-3);
    assert.equal(snap.ephemeris.GPS > 3, true);

    await until(() => bad.snapshot().link.state === 'error');
    assert.match(bad.snapshot().link.detail, /логин или пароль/);
    await until(() => lost.snapshot().link.state === 'retry');
    assert.match(lost.snapshot().link.detail, /не найдена/);
  } finally {
    for (const x of [good, bad, lost]) x.stop();
    await s.close();
  }
});

test('связь: обрыв и зависание потока приводят к переподключению', async () => {
  const s = sim.createSimulator({ source: sim.syntheticSource({ lat: 57, lon: 60 }), intervalMs: 30 });
  const session = new StationSession({ id: 'a', name: 'A', mode: 'tcp', host: '127.0.0.1', port: await s.ready, stallTimeoutSec: 0.5 });
  session.start();
  try {
    await until(() => session.snapshot().link.state === 'online');
    s.dropClients();
    await until(() => session.snapshot().link.reconnects === 1 && session.snapshot().link.state === 'online');

    s.pause(true); // соединение живо, но данные не идут
    await until(() => session.snapshot().link.reconnects === 2);
    assert.ok(session.snapshot().log.some((e) => /данные перестали идти/.test(e.text)));
    s.pause(false);
    await until(() => session.snapshot().link.state === 'online');
  } finally {
    session.stop();
    await s.close();
  }
});

test('связь: приёмник сам подключается к открытому порту', async () => {
  const net = require('net');
  const port = 20000 + Math.floor(Math.random() * 20000);
  const session = new StationSession({ id: 'a', name: 'A', mode: 'listen', port });
  session.start();
  try {
    await until(() => session.snapshot().link.state === 'listening');
    const client = net.connect({ host: '127.0.0.1', port });
    const src = sim.syntheticSource({ lat: 57, lon: 60 });
    const timer = setInterval(() => client.write(Buffer.concat(src.next())), 30);
    await until(() => session.snapshot().position !== null);
    assert.equal(session.snapshot().link.state, 'online');
    clearInterval(timer);
    client.destroy();
    await until(() => session.snapshot().link.state === 'listening');
  } finally {
    session.stop();
  }
});

test('проверка молчащего порта: кастер, поток и тишина различаются', async () => {
  const net = require('net');
  const serve = (handler) => new Promise((resolve) => {
    const server = net.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
  const table = 'SOURCETABLE 200 OK\r\nContent-Type: text/plain\r\n\r\n'
    + 'STR;SRED;Sredneuralsk;RTCM 3.2;1074(1),1084(1);2;GPS+GLO;URS;RUS;57.0;60.5;0;0;sim;none;B;N;5000;\r\n'
    + 'STR;EKB1;Ekaterinburg;RTCM 3.2;1074(1);2;GPS;URS;RUS;56.8;60.6;0;0;sim;none;N;N;5000;\r\nENDSOURCETABLE\r\n';
  const caster = await serve((sock) => sock.once('data', () => sock.end(table)));
  const silent = await serve((sock) => sock.on('error', () => {}));
  const stream = await serve((sock) => sock.once('data', () => sock.write(sim.encode1006({ stationId: 1, ecef: [1e6, 2e6, 6e6] }))));
  try {
    const c = await probePort('127.0.0.1', caster.address().port, 1500);
    assert.equal(c.kind, 'caster');
    assert.deepEqual(c.mountpoints.map((m) => [m.name, m.format, m.auth]), [['SRED', 'RTCM 3.2', 'B'], ['EKB1', 'RTCM 3.2', 'N']]);
    assert.equal((await probePort('127.0.0.1', silent.address().port, 600)).kind, 'silent');
    assert.equal((await probePort('127.0.0.1', stream.address().port, 600)).kind, 'stream');
    assert.equal((await probePort('127.0.0.1', 1, 600)).kind, 'error');
  } finally {
    for (const s of [caster, silent, stream]) s.close();
  }
});

test('раздача: поток уходит подключённым программам байт в байт, эпоха из двух сообщений склеивается', async () => {
  const net = require('net');
  const relayPort = 20000 + Math.floor(Math.random() * 20000);
  // BeiDou приходит двумя сообщениями на эпоху, как в потоке базы
  let tick = 0;
  const source = {
    next() {
      const epoch = 1000 * tick++;
      const sat = (prn) => ({ prn, rangeMs: 75.5, signals: [{ id: 2, cnr: 40 }] });
      return [
        sim.encodeMsm4({ type: 1124, stationId: 5, epoch, multiple: true, sats: [sat(6), sat(9)] }),
        sim.encodeMsm4({ type: 1124, stationId: 5, epoch, multiple: false, sats: [sat(16), sat(23), sat(37)] }),
      ];
    },
  };
  const s = sim.createSimulator({ source, intervalMs: 40 });
  const session = new StationSession({ id: 'a', name: 'A', mode: 'tcp', host: '127.0.0.1', port: await s.ready, relayPort });
  session.start();
  const got = [];
  let client;
  try {
    await until(() => session.snapshot().link.state === 'online');
    client = net.connect({ host: '127.0.0.1', port: relayPort });
    client.on('data', (c) => got.push(c));
    await until(() => session.snapshot().relay.clients === 1);
    await until(() => Buffer.concat(got).length > 400);
    const p = new StreamParser();
    const out = p.push(Buffer.concat(got));
    assert.ok(out.length >= 4);
    assert.equal(p.stats.crcErrors, 0);
    assert.equal(out.every((f) => f.type === 1124), true);
    await until(() => session.snapshot().satTotal === 5);
    assert.deepEqual(session.snapshot().constellations[0].sats.map((x) => x.label), ['C06', 'C09', 'C16', 'C23', 'C37']);
  } finally {
    if (client) client.destroy();
    session.stop();
    await s.close();
  }
});
