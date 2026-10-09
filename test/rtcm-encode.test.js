'use strict';
// Тесты кодирования служебных сообщений RTCM на сервере.
//
// Эталонные кадры ниже собраны этим же кодом и прочитаны независимой библиотекой
// pyrtcm 1.2.0 (5 октября 2026): она вернула те же значения полей. Тест следит,
// чтобы байты не изменились. Отдельно: служебные кадры из записей потоков
// разбираются и собираются заново байт в байт.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const m = require('../server/rtcm/messages');
const { BitPacker, BitUnpacker } = require('../server/rtcm/bitpack');
const { ServiceSet, mirror } = require('../server/rtcm/service');
const { StreamParser } = require('../core/stream');
const rtcm = require('../core/rtcm3');

const FIXTURES = path.join(__dirname, 'fixtures');
const payloadOf = (frame) => frame.subarray(3, frame.length - 3);

test('упаковка битов: поля любой длины и знака читаются обратно', () => {
  const fields = [[1, 1], [12, 1005], [38, -26940451234], [3, 5], [38, 53316526642], [16, 15432], [5, 0], [32, -17500], [25, -22000], [36, 68719476735], [35, -5911057630]];
  const w = new BitPacker(fields.reduce((s, f) => s + f[0], 0));
  for (const [len, v] of fields) (v < 0 || len === 38 || len === 35 ? w.s(len, v) : w.u(len, v));
  const r = new BitUnpacker(w.buf);
  for (const [len, v] of fields) assert.equal(v < 0 || len === 38 || len === 35 ? r.s(len) : r.u(len), v, `поле ${len} бит`);
  assert.throws(() => new BitPacker(8).u(4, 16), /не помещается/);
  assert.throws(() => new BitPacker(8).s(4, 8), /не помещается/);
  assert.throws(() => new BitPacker(8).u(12, 1), /длиннее/);
  assert.throws(() => new BitUnpacker(Buffer.alloc(1)).u(9), /короче/);
});

test('1005 и 1006: эталонные кадры, координаты до 0,1 мм', () => {
  const a = m.encodePosition({ stationId: 1, ecef: [1647585.2585, 3057841.8377, 5331652.6642] });
  assert.equal(a.toString('hex'), 'd300133ed0010383d6098f29071e9da2c90c69e9a232d96126');
  const b = m.encodePosition({
    stationId: 4095, ecef: [-2694045.1234, -4293642.5678, -3857878.9012], antennaHeight: 1.5432,
    itrfYear: 14, gps: 1, glonass: 0, galileo: 1, referenceStation: 1, singleOscillator: 1, quarterCycle: 2,
  });
  assert.equal(b.toString('hex'), 'd300153eefff3af9ba39565eb600ca2332b70486656c3c485bda1c');

  const back = m.decodePosition(payloadOf(b));
  assert.deepEqual(back.ecef, [-2694045.1234, -4293642.5678, -3857878.9012]);
  assert.equal(back.antennaHeight, 1.5432);
  assert.equal(back.itrfYear, 14);
  assert.equal(back.glonass, 0);
  // Ядро читает тот же кадр теми же числами
  const core = rtcm.decodeStationPosition(1006, payloadOf(b));
  assert.equal(core.stationId, 4095);
  assert.ok(Math.abs(core.ecef[0] + 2694045.1234) < 1e-6);
  assert.throws(() => m.encodePosition({ stationId: 4096, ecef: [0, 0, 0] }), /номер станции/);
});

test('1007, 1008, 1033: эталонные кадры и пустые поля', () => {
  assert.equal(m.encodeDescriptor({ type: 1007, stationId: 7, antenna: 'TRM59800.00     NONE', setupId: 3 }).toString('hex'),
    'd300193ef0071454524d35393830302e303020202020204e4f4e450365584c');
  assert.equal(m.encodeDescriptor({ type: 1008, stationId: 8, antenna: 'JAVRINGANT_DM   SCIS', antennaSerial: '00123' }).toString('hex'),
    'd3001f3f0008144a415652494e47414e545f444d20202053434953000530303132339b8701');
  // Как в нынешних потоках сети: тип антенны пустой, приёмник заполнен
  const f = m.encodeDescriptor({ type: 1033, stationId: 6, receiver: 'TRIMBLE BD970', firmware: '5.37', receiverSerial: '5222K12345' });
  assert.equal(f.toString('hex'), 'd300244090060000000d5452494d424c4520424439373004352e33370a353232324b313233343580130c');
  assert.deepEqual(m.decodeDescriptor(payloadOf(f)), {
    type: 1033, stationId: 6, antenna: '', setupId: 0, antennaSerial: '', receiver: 'TRIMBLE BD970', firmware: '5.37', receiverSerial: '5222K12345',
  });
  assert.throws(() => m.encodeDescriptor({ stationId: 1, receiver: 'Приёмник' }), /латиница/);
  assert.throws(() => m.encodeDescriptor({ stationId: 1, receiver: 'X'.repeat(32) }), /31/);
});

test('1230: значения из потоков сети, пустое сообщение, пределы', () => {
  assert.equal(m.encodeGlonassBiases({ stationId: 10, aligned: 1, biases: { l1ca: 19.06, l1p: 0, l2ca: -71.94, l2p: 0.02 } }).toString('hex'),
    'd3000c4ce00a8f03b90000f1f30001da095a');
  assert.equal(m.encodeGlonassBiases({ stationId: 18 }).toString('hex'), 'd300044ce0120062738e');
  const f = m.encodeGlonassBiases({ stationId: 11, aligned: 1, biases: { l1ca: -71.94, l2p: 655.34 } });
  assert.equal(f.toString('hex'), 'd300084ce00b89f1f37fff940c8c');
  assert.deepEqual(m.decodeGlonassBiases(payloadOf(f)), { type: 1230, stationId: 11, aligned: 1, reserved: 0, biases: { l1ca: -71.94, l2p: 655.34 } });
  assert.throws(() => m.encodeGlonassBiases({ stationId: 1, biases: { l1ca: 700 } }), /не помещается/);
});

test('1021 и 1025: эталонные кадры и обратный разбор', () => {
  const helmert = {
    sourceName: 'ITRF2014', targetName: 'MSK-66 zone 1', systemId: 12, utilized: 1, plate: 0, computation: 0, heightIndicator: 1,
    area: { lat: 57, lon: 61, dLat: 1.5, dLon: 3 }, dx: 23.57, dy: -140.95, dz: -79.8, rx: 0, ry: -0.35, rz: -0.79, scale: -0.22,
    sourceA: 6378137, sourceB: 6356752.314, targetA: 6378245, targetB: 6356863.019, horizontalQuality: 2, verticalQuality: 3,
  };
  const f = m.encodeHelmert(helmert);
  assert.equal(f.toString('hex'), 'd300493fd424aa29231918189a35354d2cb4d8d881e9bdb99480c43001002643206b3a0a8c546002e097dd96afd909000000001ffff7749fffecb69ffaa107c292833841d3ee7841a2e2ad30b5e997');
  assert.deepEqual(m.decodeHelmert(payloadOf(f)), { type: 1021, ...helmert });
  // Сдвиг больше, чем вмещает формат, в поток не уйдёт
  assert.throws(() => m.encodeHelmert({ ...helmert, dx: 5000 }), /не помещается/);
  assert.ok(m.HELMERT_LIMITS.shift < 4195);

  const p = m.encodeProjection({ systemId: 12, projection: m.PROJECTION.TM, lat0: 0, lon0: 60.05, scale: 1, falseEasting: 1500000, falseNorthing: -5911057.63 });
  assert.equal(p.toString('hex'), 'd300194010c040000000028ac63bbb4dc938002cb4178069fac6b22063fdef');
  const back = m.decodeProjection(payloadOf(p));
  assert.equal(back.projection, 1);
  assert.ok(Math.abs(back.lon0 - 60.05) < 1.1e-8);
  assert.equal(back.scale, 1);
  assert.equal(back.falseEasting, 1500000);
  assert.equal(back.falseNorthing, -5911057.63);
});

test('служебные кадры из записей собираются заново байт в байт', () => {
  const seen = {};
  for (const file of fs.readdirSync(FIXTURES)) {
    for (const fr of new StreamParser().push(fs.readFileSync(path.join(FIXTURES, file)))) {
      if (fr.kind !== 'rtcm') continue;
      let again = null;
      if (fr.type === 1005 || fr.type === 1006) again = m.encodePosition(m.decodePosition(fr.payload));
      else if ([1007, 1008, 1033].includes(fr.type)) again = m.encodeDescriptor(m.decodeDescriptor(fr.payload));
      else if (fr.type === 1230) again = m.encodeGlonassBiases(m.decodeGlonassBiases(fr.payload));
      else continue;
      assert.ok(again.equals(m.frame(fr.payload)), `${file}: сообщение ${fr.type} собралось иначе`);
      seen[fr.type] = (seen[fr.type] || 0) + 1;
    }
  }
  for (const type of [1005, 1006, 1007, 1008, 1033, 1230]) assert.ok(seen[type] > 0, `в записях нет сообщения ${type}`);
});

test('замена номера станции: наблюдения не меняются, контрольная сумма верна', () => {
  const frames = [];
  for (const fr of new StreamParser().push(fs.readFileSync(path.join(FIXTURES, 'gmsd-msm4-rtklib.rtcm3')))) {
    if (fr.kind === 'rtcm') frames.push({ type: fr.type, buf: m.frame(fr.payload) });
  }
  let obs = 0;
  let eph = 0;
  for (const { type, buf } of frames) {
    const before = Buffer.from(buf);
    const changed = m.restamp(buf, 77);
    if (rtcm.isMsm(type)) {
      assert.equal(changed, true);
      // Кадр по-прежнему проходит проверку контрольной суммы и разбирается ядром
      const parsed = new StreamParser().push(buf);
      assert.equal(parsed.length, 1, 'кадр после замены не прошёл проверку');
      const a = rtcm.decodeMsm(type, payloadOf(before));
      const b = rtcm.decodeMsm(type, parsed[0].payload);
      assert.equal(b.stationId, 77);
      assert.deepEqual({ ...b, stationId: 0 }, { ...a, stationId: 0 });
      // Отличаются только два байта заголовка и три байта контрольной суммы
      const diff = [];
      for (let i = 0; i < buf.length; i++) if (buf[i] !== before[i]) diff.push(i);
      assert.ok(diff.every((i) => i === 4 || i === 5 || i >= buf.length - 3), `изменены байты ${diff}`);
      assert.equal(m.restamp(buf, 77), false, 'повторная замена на тот же номер ничего не делает');
      obs++;
    } else if (!m.hasStationId(type)) {
      // Эфемериды: на месте номера станции — номер спутника, кадр не трогаем
      assert.equal(changed, false);
      assert.ok(buf.equals(before));
      eph++;
    }
  }
  assert.ok(obs > 0 && eph > 0, `наблюдений ${obs}, эфемерид ${eph}`);
  assert.equal(m.hasStationId(1019), false);
  assert.equal(m.hasStationId(1020), false);
  assert.equal(m.hasStationId(1124), true);
});

test('набор служебных сообщений: собирается один раз и повторяет поток станции', () => {
  const set = new ServiceSet({
    stationId: 6,
    position: { ecef: [1499264.8225, 3031597.7404, 5389560.6973] },
    descriptors: [{ type: 1007 }, { type: 1033, receiver: 'TRIMBLE BD970', firmware: '5.37', receiverSerial: 'X1' }],
    glonassBiases: { aligned: 0, biases: {} },
  });
  const types = new StreamParser().push(set.burst).map((f) => f.type);
  assert.deepEqual(types, [1005, 1007, 1033, 1230]);
  const same = set.burst;
  assert.equal(set.burst, same, 'готовые байты не пересобираются при каждом обращении');
  assert.equal(set.version, 1);

  // Набор из разобранных кадров потока даёт те же байты, только с новым номером станции
  const payloads = new StreamParser().push(set.burst).map((f) => f.payload);
  const copy = mirror(6, payloads);
  assert.ok(copy.burst.equals(set.burst));
  const moved = mirror(19, payloads);
  assert.equal(m.frameStationId(moved.position), 19);
  assert.deepEqual(m.decodePosition(payloadOf(moved.position)).ecef, [1499264.8225, 3031597.7404, 5389560.6973]);
  assert.throws(() => mirror(1, payloads.slice(1)), /нет координат/);
});

test('1023: сетка искажений NTv2p — окно из 16 узлов собирается, кодируется и читается обратно', () => {
  const transform = require('../modules/transform/transform');
  const grid = { name: 'NTv2p', stations: [
    { code: 'A', lat: 56.8, lon: 60.6, e: 0.02, n: -0.01, u: 0.03 }, { code: 'B', lat: 56.4, lon: 61.9, e: -0.36, n: 0.43, u: 0.96 },
    { code: 'C', lat: 57.5, lon: 60.3, e: 1.28, n: -0.25, u: -0.59 }, { code: 'D', lat: 56.6, lon: 57.8, e: 0.85, n: -0.75, u: 0.12 }] };
  // На станции — её остаток; между станциями — между их остатками; далеко от сети значение конечно
  assert.deepStrictEqual(transform.residualAt(grid, 56.8, 60.6), { e: 0.02, n: -0.01, u: 0.03 });
  const mid = transform.residualAt(grid, 56.6, 61.25); // середина между A и B
  assert.ok(mid.e < 0.02 && mid.e > -0.36 && mid.n > -0.01 && mid.n < 0.43, JSON.stringify(mid));
  const far = transform.residualAt(grid, 70, 100);
  assert.ok(Object.values(far).every(Number.isFinite) && Math.abs(far.e) < 1.28);
  // Окно: ровер в средней клетке, узлы строками с юга на север
  const win = transform.gridWindow(grid, 56.83, 60.61);
  assert.strictEqual(win.nodes.length, 16);
  assert.ok(win.lat0 < 56.83 - 300 / 3600 && win.lat0 + 2 * 300 / 3600 > 56.83 && win.lon0 + 600 / 3600 <= 60.61 && win.lon0 + 2 * 600 / 3600 > 60.61, JSON.stringify([win.lat0, win.lon0]));
  assert.strictEqual(win.clipped, 0);
  // Среднее плюс отклонение узла возвращают остаток в узле с точностью полей сообщения
  const node = { lat: win.lat0 + 300 / 3600, lon: win.lon0 + 600 / 3600 };
  const want = transform.residualAt(grid, node.lat, node.lon);
  const arc = transform.toArc(node.lat, want.e, want.n);
  const body = m.encodeResiduals({ ...win, systemId: 1, mjd: 61323 });
  assert.strictEqual(body.length, 3 + Math.ceil(578 / 8) + 3);
  const got = m.decodeResiduals(body.subarray(3, body.length - 3));
  assert.deepStrictEqual([got.type, got.systemId, got.horizontal, got.vertical, got.dLat, got.dLon, got.mjd], [1023, 1, true, true, 300, 600, 61323]);
  assert.ok(Math.abs(got.lat0 - win.lat0) < 1e-4 && Math.abs(got.lon0 - win.lon0) < 1e-4);
  assert.ok(Math.abs(got.meanLat + got.nodes[5].dLat - arc.dLat) < 0.00004 && Math.abs(got.meanLon + got.nodes[5].dLon - arc.dLon) < 0.00004, JSON.stringify([got.meanLat, got.nodes[5], arc]));
  assert.ok(Math.abs(got.meanH + got.nodes[5].dH - want.u) < 0.0011);
  // Резкий перепад рядом с выбивающейся станцией не переполняет поле: узлы обрезаются до предела
  const steep = transform.gridWindow({ stations: [{ code: 'A', lat: 56.8, lon: 60.6, e: 0, n: 0, u: 0 }, { code: 'B', lat: 56.85, lon: 60.7, e: 3, n: 3, u: 3 }, { code: 'C', lat: 57.5, lon: 60.3, e: 0, n: 0, u: 0 }] }, 56.83, 60.65);
  assert.ok(steep.clipped > 0);
  assert.doesNotThrow(() => m.encodeResiduals({ ...steep, systemId: 1, mjd: 1 }));
  // План пересчёта объявляет в 1021, что вместе с ним идёт и 1023; для ГСК-2011 сетки нет
  const plan = transform.plan({ target: 'msk66', link: { tx: 1, ty: 1, tz: 1, rx: 0, ry: 0, rz: 0, m: 0 }, grid });
  assert.strictEqual(plan.helmert.utilized, transform.UTILIZED_1025 | transform.UTILIZED_1023);
  assert.strictEqual(plan.grid, grid);
  assert.strictEqual(transform.plan({ target: 'gsk2011', epoch: 2026.7, grid }).grid, null);
  assert.strictEqual(transform.plan({ target: 'msk66', link: { tx: 1, ty: 1, tz: 1, rx: 0, ry: 0, rz: 0, m: 0 } }).helmert.utilized, transform.UTILIZED_1025);
});
