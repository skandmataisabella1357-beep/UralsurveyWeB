'use strict';
// Тесты модуля «Расчёт подсети»: порядок расчёта, прореживание потока, настройки и разбор
// ответа RTKLIB, загрузка эфемерид. Сам RTKLIB здесь не запускается: он стоит только на сервере.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { plan } = require('../modules/rtknet/plan');
const { Thinner, gpsTow } = require('../modules/rtknet/thin');
const rtklib = require('../modules/rtknet/rtklib');
const ephemeris = require('../modules/rtknet/ephemeris');
const sim = require('../core/simulator');
const { StreamParser } = require('../core/stream');

test('порядок расчёта: цепочка через ближайших соседей, а не всё от опорной', () => {
  const links = plan('A', { A: [0, 0, 0], B: [10000, 0, 0], C: [20000, 0, 0], D: [0, 5000, 0] });
  assert.deepEqual(links.map((l) => `${l.from}>${l.code}`), ['A>D', 'A>B', 'B>C']);
  assert.equal(links[2].length, 10000);
  assert.deepEqual(plan('X', { A: [0, 0, 0] }), []);
});

test('прореживание: остаются эпохи раз в 5 секунд, служебные сообщения проходят все', () => {
  const sats = [{ prn: 3, rangeMs: 70.2, signals: [{ id: 2, cnr: 45 }] }];
  const payload = (type, epoch) => new StreamParser().push(sim.encodeMsm4({ type, stationId: 1, epoch, multiple: false, sats }))[0].payload;
  assert.equal(gpsTow(1074, payload(1074, 345000)), 345000);
  const t = new Thinner(5000);
  assert.equal(t.take(1005, Buffer.alloc(19)), true);
  assert.equal(t.take(1074, payload(1074, 345000)), true);
  // ГЛОНАСС идёт в своей шкале времени: судьбу решает эпоха GPS перед ним
  assert.equal(t.take(1084, payload(1084, 1)), true);
  assert.equal(t.take(1074, payload(1074, 346000)), false);
  assert.equal(t.take(1084, payload(1084, 2)), false);
  assert.equal(t.take(1033, Buffer.alloc(30)), true);
});

test('настройки RTKLIB: короткий вектор с фиксацией, длинный — плавающий на двух частотах', () => {
  const short = rtklib.config({ base: [1.5, 2.25, 3], long: false });
  const long = rtklib.config({ base: [1, 2, 3], long: true });
  assert.match(short, /pos2-armode\s+=continuous/);
  assert.match(short, /ant2-pos1\s+=1\.5000/);
  assert.match(short, /pos1-posmode\s+=static/);
  assert.match(long, /pos1-ionoopt\s+=dual-freq/);
  assert.match(long, /pos2-armode\s+=off/);
});

test('разбор решения: ответ — последняя строка, фиксация должна держаться', () => {
  const line = (t, x, q, ratio) => `2026/10/05 20:${t}.0   ${x}   3041916.2530   5347115.1680   ${q}  22   0.0048   0.0038   0.0028  -0.0023   0.0016   0.0013   0.00    ${ratio}`;
  const fixed = rtklib.parsePos(['% шапка', line('28:00', '1626414.3976', 2, '1.1'), line('28:05', '1626414.7000', 1, '5.2'), line('30:00', '1626414.7012', 1, '8.4')].join('\n'));
  assert.deepEqual(fixed.ecef, [1626414.7012, 3041916.253, 5347115.168]);
  assert.equal(fixed.epochs, 3);
  assert.equal(fixed.spanMs, 120000);
  assert.equal(rtklib.quality(fixed, false), 'fix');
  assert.equal(rtklib.quality(fixed, true), 'float');
  const flicker = rtklib.parsePos([line('28:00', '1', 1, '3'), line('28:05', '1', 2, '1'), line('28:10', '1', 2, '1'), line('28:15', '1', 1, '3')].join('\n'));
  assert.equal(rtklib.quality(flicker, false), 'float');
  assert.equal(rtklib.parsePos('% только шапка\n'), null);
  assert.equal(rtklib.quality(null, false), 'none');
});

test('эфемериды: файл суток скачивается один раз, сбой сети оставляет прежний', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ural-brdc-'));
  try {
    assert.match(ephemeris.urlOf(Date.UTC(2026, 9, 5, 20)), /BRDC\/2026\/278\/BRDC00WRD_S_20262780000_01D_MN\.rnx\.gz$/);
    let calls = 0;
    const good = async () => { calls++; return zlib.gzipSync(Buffer.from('     3.05           N: GNSS NAV DATA    M: MIXED\n')); };
    // Расчёт начался вчера: нужны файлы за оба дня
    const now = Date.now();
    const first = await ephemeris.ensure(dir, now - 864e5, now, good);
    assert.equal(first.files.length, 2);
    assert.equal(calls, 2);
    const again = await ephemeris.ensure(dir, now - 864e5, now, async () => { throw new Error('сети нет'); });
    assert.equal(again.files.length, 2);
    assert.equal(again.error, '');
    const empty = await ephemeris.ensure(path.join(dir, 'x'), now, now, async () => { throw new Error('сети нет'); });
    assert.deepEqual([empty.files.length, empty.error], [0, 'сети нет']);
    const wrong = await ephemeris.ensure(path.join(dir, 'y'), now, now, async () => zlib.gzipSync(Buffer.from('<html>')));
    assert.equal(wrong.files.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('точные орбиты: выбор файлов CDDIS по времени расчёта', () => {
  const orbits = require('../modules/rtknet/orbits');
  const names = ['COD0OPSULT_20262780000_02D_05M_ORB.SP3.gz', 'COD0OPSULT_20262771800_02D_05M_ORB.SP3.gz', 'COD0OPSULT_20262780000_02D_02D_SUM.SUM.gz',
    'GFZ0OPSULT_20262771800_02D_05M_ORB.SP3.gz', 'IGS0OPSULT_20262771200_02D_15M_ORB.SP3.gz', 'мусор'];
  const at = (day, hour) => Date.UTC(2026, 0, day, hour);
  assert.deepEqual(orbits.parseName(names[0]), { name: names[0], center: 'COD0OPSULT', start: at(278, 0), end: at(280, 0) });
  assert.equal(orbits.parseName(names[2]), null);
  assert.equal(orbits.gpsWeek(at(278, 20)), 2439);
  // Расчёт идёт сегодня: хватает самого свежего файла
  assert.deepEqual(orbits.choose(names, at(278, 19), at(278, 21)).files.map((f) => f.name), [names[0]]);
  // Расчёт начат вчера вечером: нужен ещё и файл, покрывающий начало
  assert.deepEqual(orbits.choose(names, at(277, 20), at(278, 21)).files.map((f) => f.name), [names[1], names[0]]);
  // У первого центра файлов на это время нет — берётся следующий
  assert.equal(orbits.choose(names.slice(3), at(278, 19), at(278, 21)).center, 'GFZ0OPSULT');
  assert.equal(orbits.choose(names, at(290, 0), at(290, 1)), null);
  const conf = rtklib.config({ base: [1, 2, 3], long: true, precise: true, antex: '/x/igs20.atx' });
  assert.match(conf, /pos1-sateph\s+=precise/);
  assert.match(conf, /file-satantfile\s+=\/x\/igs20\.atx/);
  assert.match(rtklib.config({ base: [1, 2, 3], long: true }), /pos1-sateph\s+=brdc/);
});

test('сеть: взаимные треугольники, уравнивание и незамыкания находят испорченный вектор', () => {
  const network = require('../modules/rtknet/network');
  const { llhToEcef, D2R } = require('../core/geo');
  const where = { A: [57, 60], B: [57, 61], C: [57.6, 60.5], D: [56.5, 60.5], E: [57.2, 63.5] };
  const pos = {};
  for (const k of Object.keys(where)) pos[k] = llhToEcef(where[k][0] * D2R, where[k][1] * D2R, 200);
  const edges = network.edges(pos);
  // Каждая станция связана, у внутренних сторон по два треугольника; очень длинная сторона по краю убрана
  assert.deepEqual(edges.map((e) => e.a + e.b), ['AB', 'AC', 'AD', 'BC', 'BD', 'BE']);
  const { tree, extra } = network.order('A', edges);
  assert.deepEqual(tree.map((e) => `${e.from}>${e.to}`), ['A>B', 'B>D', 'B>C', 'B>E']);
  assert.equal(extra.length, 2);
  const exact = [...tree, ...extra].map((e) => ({ from: e.from, to: e.to, d: pos[e.to].map((v, i) => v - pos[e.from][i]), sigma: 0.01 }));
  const clean = network.adjust('A', pos.A, exact);
  for (const k of Object.keys(pos)) assert.ok(Math.hypot(...clean.coords[k].map((v, i) => v - pos[k][i])) < 1e-6, k);
  assert.ok(network.closures(exact).triangles.every((t) => t.closure < 1e-6));
  // Вектор B→D испорчен на 5 см: незамыкание показывает именно его треугольник, невязка у него наибольшая
  const bad = exact.map((v) => (v.from === 'B' && v.to === 'D' ? { ...v, d: [v.d[0] + 0.05, v.d[1], v.d[2]] } : v));
  const res = network.adjust('A', pos.A, bad);
  const closures = network.closures(bad);
  assert.deepEqual(closures.triangles.map((t) => [t.codes.join(''), Math.round(t.closure * 1000)]), [['ABC', 0], ['ABD', 50]]);
  assert.equal(Math.round(closures.worst['B|D'] * 1000), 50);
  assert.equal(closures.worst['B|C'], 0);
  const worst = res.residuals.indexOf(Math.max(...res.residuals));
  assert.ok(['B>D', 'A>B', 'A>D'].includes(`${bad[worst].from}>${bad[worst].to}`));
  assert.ok(res.sigma0 > 1);
  // Точка C в испорченный треугольник не входит: её координаты не пострадали
  assert.ok(Math.hypot(...res.coords.C.map((v, i) => v - pos.C[i])) < 0.01);
  assert.equal(network.adjust('A', pos.A, exact.filter((v) => v.to !== 'E' && v.from !== 'E')).coords.E, undefined);
});

test('ГЛОНАСС: номера частот из эфемерид и сообщение-подсказка для RTKLIB', () => {
  const glonass = require('../modules/rtknet/glonass');
  const rtcmMessages = require('../server/rtcm/messages');
  const { BitUnpacker } = require('../server/rtcm/bitpack');
  const nav = ['R01 2026 10 05 00 15 00 1.880684867501e-04 9.094947017729e-13 8.640000000000e+04',
    '     8.026401367188e+03 2.044006347656e+00 9.313225746155e-10 0.000000000000e+00',
    '    -7.162733398438e+03 2.419936180115e+00-2.793967723846e-09 1.000000000000e+00',
    '    -2.313386572266e+04-3.955650329590e-02 9.313225746155e-10 0.000000000000e+00',
    'R02 2026 10 05 00 15 00 1.880684867501e-04 9.094947017729e-13 8.640000000000e+04',
    '     8.026401367188e+03 2.044006347656e+00 9.313225746155e-10 0.000000000000e+00',
    '    -7.162733398438e+03 2.419936180115e+00-2.793967723846e-09-4.000000000000e+00',
    '    -2.313386572266e+04-3.955650329590e-02 9.313225746155e-10 0.000000000000e+00',
    'G30 2026 10 05 22 00 00 3.851465880871e-04 1.170974428533e-11 0.000000000000e+00'].join('\n');
  const fcn = glonass.channels(nav);
  assert.deepEqual(fcn, { 1: 1, 2: -4 });
  const frame = glonass.hint(18, fcn, Date.UTC(2026, 9, 5, 21, 13, 0));
  assert.equal(rtcmMessages.frameType(frame), 1010);
  assert.equal(rtcmMessages.frameStationId(frame), 18);
  const r = new BitUnpacker(frame.subarray(3, frame.length - 3), 24);
  assert.equal(r.u(27), ((21 + 3) % 24 * 3600 + 13 * 60) * 1000); // время суток по Москве
  assert.equal(r.u(1), 1); // «дальше будут ещё сообщения»: пустая эпоха в наблюдения не попадает
  assert.equal(r.u(5), 2);
  r.u(4);
  assert.deepEqual([r.u(6), r.u(1), r.u(5) - 7], [1, 0, 1]);
  r.u(25);
  assert.equal(r.u(20), 0x80000); // фаза — «нет измерения»
  assert.equal(glonass.hint(18, {}, 0).length, 0);
  const conf = rtklib.config({ base: [1, 2, 3], method: 'ionoest', glonass: true, l5: true });
  assert.match(conf, /pos1-ionoopt\s+=est-stec/);
  assert.match(conf, /pos1-navsys\s+=45/);
  assert.match(conf, /pos1-frequency\s+=l1\+l2\+l5/);
  assert.match(conf, /pos2-armode\s+=continuous/);
});

test('ионосфера по вектору: разброс задержки между спутниками в конце расчёта', () => {
  const lines = [];
  // 16 эпох; в начале оценки гуляют, к концу устоялись: спутники расходятся на ±3 см вокруг общей части
  for (let e = 0; e < 16; e++) {
    const noise = e < 12 ? 0.5 : 0;
    [0.03, -0.03, 0.03, -0.03, 0.03, -0.03].forEach((v, i) => lines.push(`$ION,2439,${79200 + e * 30}.000,2,G${10 + i},120.0,45.0,${(1.2 + v + noise * i).toFixed(4)},0.0000`));
    lines.push(`$ION,2439,${79200 + e * 30}.000,2,G30,10.0,12.0,9.0000,0.0000`); // низкий спутник не в счёт
    lines.push(`$POS,2439,${79200 + e * 30}.000,2,1.0,2.0,3.0,0,0,0`);
  }
  const sigma = rtklib.parseIono(lines.join('\n'));
  assert.ok(Math.abs(sigma - 0.0329) < 0.001, String(sigma));
  assert.equal(rtklib.parseIono('$POS,1,2,3\n'), null);
  assert.match(rtklib.config({ base: [1, 2, 3], method: 'ionoest' }), /out-outstat\s+=state/);
  assert.match(rtklib.config({ base: [1, 2, 3], method: 'ionofree' }), /out-outstat\s+=off/);
});

test('PPP-AR: разбор ответа программы и перевод ITRF2020 в ITRF2014', () => {
  const ppp = require('../modules/rtknet/ppp');
  const row = (text, label) => text.padEnd(60) + label;
  const pos = [row('abmf', 'STATION'), row('2020  1  1  0  0  0.00', 'OBS FIRST EPOCH'), row('2020  1  1 23 59 30.00', 'OBS LAST EPOCH'),
    row('WUM0MGXRAP_20200010000_01D_05M_ORB.SP3', 'SAT ORBIT'), row('TRM57971.00     NONE', 'SITE ANTENNA TYPE'), row('YES  GPS    40  GAL    24', 'AMB FIXING'), row('', 'END OF HEADER'),
    '*Name         Mjd               X               Y               Z                       Sx                       Sy                       Sz                      Rxy                      Rxz                      Ryz                     Sig0           Nobs',
    ' abmf  58849.4998   2919785.79087  -5383744.95942   1774604.85992     0.44535648859620E-08     0.12326947455656E-07     0.19030328992069E-08    -0.61562831362205E-08     0.19597047215955E-08    -0.36630922504825E-08     0.25138906710711E+01          86121'].join('\n');
  const sol = ppp.parsePos(pos);
  assert.deepEqual(sol.ecef, [2919785.79087, -5383744.95942, 1774604.85992]);
  assert.equal(sol.fixed, true);
  assert.equal(sol.products, 'WUM0MGXRAP');
  assert.equal(sol.nobs, 86121);
  assert.equal(sol.last - sol.first, (24 * 3600 - 30) * 1000);
  // Точность: Sig0·√S — доли миллиметра за сутки
  assert.ok(Math.abs(sol.sd[0] - 2.5138906710711 * Math.sqrt(0.4453564885962e-8)) < 1e-9);
  assert.equal(ppp.parsePos('шапка без решения\n'), null);
  // Перевод систем — миллиметры: на эпоху 2026,76 сдвиг по Z растёт на 0,2 мм в год
  const moved = ppp.itrf2020to2014([1647585.2585, 3057841.8377, 5331652.6642], 2026.76);
  const d = moved.map((v, i) => (v - [1647585.2585, 3057841.8377, 5331652.6642][i]) * 1000);
  assert.ok(Math.abs(d[0] - (-1.4 - 0.692)) < 0.01 && Math.abs(d[1] - (-0.9 - 1.176 - 1.284)) < 0.01 && Math.abs(d[2] - (1.4 + 2.352 - 2.239)) < 0.01, d.join(' '));
  assert.ok(Math.abs(ppp.decimalYear(Date.UTC(2026, 6, 2, 12)) - 2026.5) < 0.001);
});
