'use strict';
// Модуль «VRS»: проверка на модельной сети. Спутники летят по придуманным орбитам, у станций
// свои часы, целые неоднозначности, наклонная ионосфера и остаток тропосферы — всё известно
// заранее. Сеть обязана найти целые и выдать в точке ровера наблюдения, которые совпадают
// с «настоящими» до миллиметров.

const test = require('node:test');
const assert = require('node:assert');
const { llhToEcef, ecefToLlh, ecefToEnu, D2R } = require('../core/geo');
const obs = require('../modules/vrs/obs');
const navlib = require('../modules/vrs/nav');
const model = require('../modules/vrs/model');
const { Network, weights } = require('../modules/vrs/network');
const { Filter } = require('../modules/vrs/baseline');
const { clean, defaults, OPTIONS } = require('../modules/vrs/options');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { BusServer, Decoder, encode } = require('../server/shared/bus');
const { StreamParser } = require('../core/stream');
const rtcm = require('../server/rtcm/messages');
const vrsService = require('../server/vrs');

const T0 = 1475000000; // секунды GPS: начало проверки
const C = obs.CLIGHT;
const F = { G: [1575.42e6, 1227.6e6], E: [1575.42e6, 1207.14e6] };
const SIG = { G: [2, 10], E: [2, 15] };

// Придуманное созвездие: круговые орбиты в шести плоскостях
function constellation() {
  const nav = new Map();
  let n = 0;
  for (const [sys, count, a, inc] of [['G', 30, 26560e3, 55], ['E', 24, 29600e3, 56]]) {
    for (let i = 0; i < count; i++) {
      const sat = `${sys}${String(i + 1).padStart(2, '0')}`;
      nav.set(sat, [{
        sat, sys, toc: T0, toe: T0, af0: 1e-5 * ((n * 7) % 11 - 5), af1: 0, af2: 0, crs: 0, deln: 0, m0: (i * 137.5 + 20) * D2R, cuc: 0, ecc: 0.001, cus: 0, sqrtA: Math.sqrt(a),
        cic: 0, omega0: (i % 6) * 60 * D2R + 0.3, cis: 0, i0: inc * D2R, crc: 0, omega: 0.5, omegaDot: 0, idot: 0, health: 0, source: 0x201,
      }]);
      n++;
    }
  }
  return nav;
}

const CENTER = { lat: 56.8, lon: 60.6 };
const place = (code, north, east, h = 250) => ({ code, north, east, ecef: llhToEcef((CENTER.lat + north / 111.2) * D2R, (CENTER.lon + east / 60.9) * D2R, h) });
const STATIONS = [place('AAAA', 0, 0), place('BBBB', 35, 5, 310), place('CCCC', -10, 40, 200), place('DDDD', -30, -25, 280), place('EEEE', 20, -35, 240)];
const ROVER = place('ROVR', 6, 8, 262);

// «Погода» над районом: ионосфера и остаток тропосферы меняются по местности линейно
const ionoAt = (p) => 2.0 + 0.004 * p.north - 0.003 * p.east; // м на L1 в зените, наклон 3–4 мм на км
const ztdAt = (p) => 0.02 + 0.0004 * p.north + 0.0003 * p.east; // м
const slant = (el) => 1 / Math.sqrt(1 - (6371e3 * Math.cos(el) / (6371e3 + 350e3)) ** 2);

// Наблюдения станции на эпоху t. amb — её целые (создаются по мере появления спутников).
function observe(p, t, nav, amb, { clock = 0, exact = false, rough = 0 } = {}) {
  const st = model.site(p.ecef);
  const raw = new Map();
  for (const [sat, list] of nav) {
    const eph = list[0];
    const g = navlib.range(eph, t, p.ecef, clock / C);
    const dir = model.look(st, g.los);
    if (dir.el < 12 * D2R) continue;
    const geo = g.rho - g.clock + model.troposphere(st, dir.el) + model.mapWet(dir.el) * ztdAt(p) + clock;
    // rough — неровность: у каждой пары «станция — спутник» своя добавка к ионосфере, метры в зените
    const seed = Math.sin(sat.charCodeAt(0) * 7.1 + sat.charCodeAt(1) * 131.7 + sat.charCodeAt(2) * 17.3 + p.code.charCodeAt(0) * 911.9) * 43758.5453;
    const bump = rough ? rough * 2 * (seed - Math.floor(seed) - 0.5) : 0;
    const iono = slant(dir.el) * (ionoAt(p) + bump);
    const sigs = new Map();
    F[eph.sys].forEach((f, k) => {
      const key = `${sat}.${k}`;
      if (amb && !amb.has(key)) amb.set(key, Math.round(((sat.charCodeAt(1) * 31 + sat.charCodeAt(2) * 17 + k * 5 + p.code.charCodeAt(0)) % 41) - 20));
      const scale = (F.G[0] / f) ** 2;
      const lam = C / f;
      sigs.set(SIG[eph.sys][k], { sig: SIG[eph.sys][k], pr: geo + scale * iono, ph: geo - scale * iono + (amb ? lam * amb.get(key) : 0), lock: 15, half: 0, cnr: 45 });
    });
    raw.set(sat, sigs);
  }
  if (exact) return raw;
  // Через сообщения MSM и обратно — как в жизни
  const asm = new obs.Assembler();
  let out = null;
  for (const body of messages(raw, t)) out = asm.push(body.readUInt16BE(0) >> 4, body, t) || out;
  return out.raw;
}

// Наблюдения эпохи в виде сообщений MSM4 (тела без кадра)
function messages(raw, t) {
  const systems = ['G', 'E'];
  return systems.map((sys, i) => {
    const sats = [...raw].filter(([sat]) => sat[0] === sys).map(([sat, sigs]) => ({ prn: Number(sat.slice(1)), sigs: [...sigs.values()].map((x) => ({ ...x, lock: 600 })) }));
    return obs.encode({ sys, stationId: 1, epoch: obs.epochField(sys, t), multiple: i < systems.length - 1, sats });
  });
}

test('VRS: сообщение MSM4 собирается и разбирается обратно без потерь', () => {
  const sats = [{ prn: 5, sigs: [{ sig: 2, pr: 21234567.891, ph: 21234560.1234, lock: 40, half: 0, cnr: 44 }, { sig: 10, pr: 21234570.2, ph: 21234555.5, lock: 3, half: 0, cnr: 38 }] },
    { prn: 17, sigs: [{ sig: 2, pr: 23999999.5, ph: null, lock: 0, half: 0, cnr: 30 }] }];
  const body = obs.encode({ sys: 'G', stationId: 77, epoch: 123456000, multiple: false, sats });
  const m = obs.decode(1074, body);
  assert.strictEqual(m.stationId, 77);
  assert.strictEqual(m.epoch, 123456000);
  assert.strictEqual(m.sats.length, 2);
  const a = m.sats[0].sigs;
  assert.ok(Math.abs(a[0].pr - 21234567.891) < 0.01);
  assert.ok(Math.abs(a[0].ph - 21234560.1234) < 0.0004);
  assert.ok(Math.abs(a[1].ph - 21234555.5) < 0.0004);
  assert.strictEqual(m.sats[1].sigs[0].ph, null);
  // Время эпохи: у BeiDou своя шкала, у остальных — шкала GPS
  for (const sys of ['G', 'E', 'C', 'R']) assert.ok(Math.abs(obs.epochTime(sys, obs.epochField(sys, T0 + 5), T0) - (T0 + 5)) < 1e-6, sys);
});

// Эфемериды в виде файла RINEX 3 — как их отдаёт архив
function rinex(nav, only) {
  const n = (v) => { const s = v.toExponential(12).replace('e', 'D'); const m = /^(-?)(\d\.\d+)D([+-])(\d+)$/.exec(s); return `${m[1] || ' '}${m[2]}D${m[3]}${m[4].padStart(2, '0')}`.padStart(19); };
  const lines = ['     3.04           N: GNSS NAV DATA    M: MIXED            RINEX VERSION / TYPE', '                                                            END OF HEADER'];
  for (const [sat, list] of nav) {
    if (only && sat !== only) continue;
    const e = list[0];
    const d = new Date(obs.unixFromGps(e.toc) + 18000);
    const sow = ((e.toe % 604800) + 604800) % 604800;
    const rows = [[0, e.crs, e.deln, e.m0], [e.cuc, e.ecc, e.cus, e.sqrtA], [sow, e.cic, e.omega0, e.cis], [e.i0, e.crc, e.omega, e.omegaDot], [e.idot, e.sys === 'E' ? 513 : 0, 2400, 0], [2, 0, 0, 0], [sow, 4, 0, 0]];
    lines.push(`${sat} ${d.getUTCFullYear()} ${String(d.getUTCMonth() + 1).padStart(2, '0')} ${String(d.getUTCDate()).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')} ${String(d.getUTCMinutes()).padStart(2, '0')} ${String(d.getUTCSeconds()).padStart(2, '0')}${n(e.af0)}${n(e.af1)}${n(e.af2)}`,
      ...rows.map((r) => `    ${r.map(n).join('')}`));
  }
  return lines.join('\n');
}

test('VRS: эфемериды из файла RINEX дают то же положение спутника', () => {
  const nav = constellation();
  const e = nav.get('G07')[0];
  const parsed = navlib.parse(rinex(nav, 'G07')).get('G07')[0];
  assert.strictEqual(navlib.parse(rinex(nav)).size, nav.size);
  assert.ok(Math.abs(parsed.toe - e.toe) < 1e-6);
  const a = navlib.state(e, T0 + 900); const b = navlib.state(parsed, T0 + 900);
  assert.ok(Math.hypot(a.pos[0] - b.pos[0], a.pos[1] - b.pos[1], a.pos[2] - b.pos[2]) < 1e-3);
  assert.ok(Math.abs(a.clock - b.clock) < 1e-12);
  // Спутник на своей орбите: расстояние до центра Земли — большая полуось
  assert.ok(Math.abs(Math.hypot(...a.pos) - e.sqrtA ** 2) < 50e3);
});

test('VRS: веса соседей — внутри сети точные, за краем ограничены', () => {
  const pts = [{ e: 40e3, n: 0 }, { e: 0, n: 40e3 }];
  // Поправка, линейная по местности, восстанавливается точно
  const field = (p) => 3e-6 * p.e - 2e-6 * p.n;
  const p = { e: 10e3, n: 15e3 };
  const { w, reach } = weights('plane', pts, p);
  assert.strictEqual(reach, 1);
  assert.ok(Math.abs(w.reduce((s, v, i) => s + v * field(pts[i]), 0) - field(p)) < 1e-9);
  // Далеко за краем веса не растут без конца
  const far = weights('plane', pts, { e: 200e3, n: 200e3 });
  assert.ok(far.reach < 1);
  assert.ok(far.w.reduce((s, v) => s + Math.abs(v), 0) <= 1.5 + 1e-9);
  // Соседи на одной прямой: наклон поперёк неё не выдумывается
  const line = weights('plane', [{ e: 30e3, n: 0 }, { e: 60e3, n: 100 }], { e: 15e3, n: 50e3 });
  assert.ok(line.w.every(Number.isFinite));
  assert.ok(Math.abs(line.w[0] * 30e3 + line.w[1] * 60e3 - 15e3) < 500);
  // По расстояниям: у самой ведущей поправки нет, веса в сумме меньше единицы
  assert.deepStrictEqual(weights('idw', pts, { e: 0, n: 0 }).w, [0, 0]);
  const idw = weights('idw', pts, { e: 30e3, n: 5e3 }).w;
  assert.ok(idw[0] > idw[1] && idw[0] + idw[1] < 1);
  assert.deepStrictEqual(weights('none', pts, p).w, [0, 0]);
});

test('VRS: фильтр оценивает неизвестные и закрепляет заданные', () => {
  const kf = new Filter();
  kf.add('a', 0, 100); kf.add('b', 0, 100);
  for (let i = 0; i < 20; i++) { kf.update([['a', 1], ['b', 1]], 5, 0.01); kf.update([['a', 1], ['b', -1]], 1, 0.01); }
  assert.ok(Math.abs(kf.get('a') - 3) < 0.01 && Math.abs(kf.get('b') - 2) < 0.01);
  kf.update([['b', 1]], 7, 1e-10);
  assert.ok(Math.abs(kf.get('b') - 7) < 1e-4 && kf.sigma('b') < 1e-4);
  kf.remove('a');
  assert.ok(!kf.has('a') && Math.abs(kf.get('b') - 7) < 1e-4);
});

test('VRS: настройки приводятся к допустимым', () => {
  const d = defaults();
  assert.strictEqual(Object.keys(d).length, OPTIONS.length);
  assert.strictEqual(clean({ aux: 99, method: 'что-то', systems: ['G', 'X'], mask: 12 }).aux, d.aux);
  assert.strictEqual(clean({ method: 'idw' }).method, 'idw');
  assert.deepStrictEqual(clean({ systems: ['G', 'X'] }).systems, d.systems);
  assert.strictEqual(clean({ mask: 12 }).mask, 12);
  assert.strictEqual(clean({ aux: 1, minAux: 3 }).minAux, 1);
});

test('VRS: сеть находит целые и выдаёт роверу наблюдения с точностью до миллиметров', () => {
  const nav = constellation();
  const net = new Network({ stations: STATIONS.map((s) => ({ code: s.code, ecef: s.ecef })), nav, options: { maxKm: 120 }, baseline: { step: 5 } });
  assert.strictEqual(net.baselines.length, 10);
  assert.ok(net.triangles.length >= 4);
  const amb = new Map(STATIONS.map((s) => [s.code, new Map()]));
  const clocks = STATIONS.map((s, i) => 30 * (i - 2)); // часы приёмников, метры
  const last = T0 + 300;
  for (let t = T0; t <= last; t += 5) {
    // Станции присылают эпоху в разном порядке и с разной задержкой: одна отстаёт на две эпохи
    STATIONS.forEach((s, i) => { if (i !== 3) net.push(s.code, t, observe(s, t, nav, amb.get(s.code), { clock: clocks[i] + 0.01 * (t - T0) })); });
    if (t - 10 >= T0) net.push(STATIONS[3].code, t - 10, observe(STATIONS[3], t - 10, nav, amb.get(STATIONS[3].code), { clock: clocks[3] }));
  }
  for (const t of [last - 5, last]) net.push(STATIONS[3].code, t, observe(STATIONS[3], t, nav, amb.get(STATIONS[3].code), { clock: clocks[3] }));

  // Все стороны закрепили почти все спутники, тропосфера и вектор не уведены
  for (const bl of net.baselines) {
    const s = bl.summary();
    assert.ok(s.fixed >= s.seen - 2 && s.fixed >= 10, `${s.a}-${s.b}: закреплено ${s.fixed} из ${s.seen}`);
    assert.ok(Math.abs(s.ztd) < 0.05, `${s.a}-${s.b}: тропосфера ${s.ztd}`);
    assert.strictEqual(s.count.restart, 0);
    assert.strictEqual(s.count.closure, 0);
    // Найденные целые — настоящие (с точностью до общего сдвига системы)
    const diffs = { G: new Set(), E: new Set() };
    for (const [sat, x] of bl.sats) {
      if (x.n1 === null) continue;
      const truth = amb.get(bl.b.code).get(`${sat}.0`) - amb.get(bl.a.code).get(`${sat}.0`);
      diffs[sat[0]].add(x.n1 - truth);
    }
    assert.ok(diffs.G.size === 1 && diffs.E.size === 1, `${s.a}-${s.b}: целые расходятся с заданными`);
  }

  // Виртуальная база в точке ровера против «настоящих» наблюдений там же
  const v = net.virtual(ROVER.ecef, { t: last });
  assert.strictEqual(v.master, 'AAAA');
  assert.strictEqual(v.reach, 1);
  assert.ok(v.sats.length >= 14, `спутников ${v.sats.length}`);
  const truth = observe(ROVER, last, nav, null, { exact: true });
  const master = amb.get('AAAA');
  for (const sys of ['G', 'E']) {
    for (const k of [0, 1]) {
      const lam = C / F[sys][k];
      const phase = []; const code = [];
      for (const s of v.sats.filter((x) => x.sys === sys)) {
        const g = s.sigs.find((x) => x.sig === SIG[sys][k]);
        const real = truth.get(s.sat).get(SIG[sys][k]);
        phase.push(g.ph - lam * master.get(`${s.sat}.${k}`) - real.ph);
        code.push(g.pr - real.pr);
      }
      // Общая часть — часы ведущей станции; ровер её не замечает
      const spread = (list) => { const m = list.reduce((a, b) => a + b, 0) / list.length; return Math.max(...list.map((x) => Math.abs(x - m))); };
      assert.ok(spread(phase) < 0.004, `${sys} частота ${k + 1}: фаза расходится на ${(spread(phase) * 1000).toFixed(1)} мм`);
      assert.ok(spread(code) < 0.05, `${sys} частота ${k + 1}: код расходится на ${(spread(code) * 100).toFixed(1)} см`);
    }
  }
  // Без поправок сети то же место даёт ошибку в сантиметры: сеть не для красоты
  const plain = net.virtual(ROVER.ecef, { t: last, method: 'idw' });
  assert.ok(plain.sats.length >= 14);

  // Самопроверка: станцию, исключённую из расчёта, сеть предсказывает по соседям
  const c = net.check('BBBB');
  assert.ok(c && c.sats >= 10);
  assert.ok(c.rawIono > 0.02, 'между станциями ионосфера заметная');
  // Крайняя станция предсказывается продолжением за край сети — здесь важен порядок величины
  assert.ok(c.phase < c.rawIono, `ошибка сети ${c.phase} не меньше разности без сети ${c.rawIono}`);
});

test('VRS: обрыв связи со станцией не сбрасывает найденные целые', () => {
  const nav = constellation();
  const two = STATIONS.slice(0, 2);
  const net = new Network({ stations: two.map((s) => ({ code: s.code, ecef: s.ecef })), nav, options: { maxKm: 120 }, baseline: { step: 5 } });
  const amb = new Map(two.map((s) => [s.code, new Map()]));
  const feed = (t, codes) => { for (const s of two) if (codes.includes(s.code)) net.push(s.code, t, observe(s, t, nav, amb.get(s.code), { clock: 5 })); };
  for (let t = T0; t <= T0 + 200; t += 5) feed(t, ['AAAA', 'BBBB']);
  const bl = net.baselines[0];
  const before = bl.summary().fixed;
  assert.ok(before >= 10);
  const fixes = bl.count.fix;
  // Вторая станция молчит 40 секунд (обрыв у источника), приёмник спутники не терял
  for (let t = T0 + 205; t <= T0 + 240; t += 5) feed(t, ['AAAA']);
  for (let t = T0 + 245; t <= T0 + 260; t += 5) feed(t, ['AAAA', 'BBBB']);
  const after = bl.summary();
  assert.ok(after.fixed >= before - 1, `после обрыва закреплено ${after.fixed}, было ${before}`);
  assert.strictEqual(bl.count.fix, fixes, 'целые не искались заново');
  // А настоящий срыв слежения у спутника восстанавливается сразу — по плавности поправок
  const slipped = [...amb.get('BBBB').keys()].find((k) => k.endsWith('.0') && bl.sats.get(k.slice(0, 3)) && bl.sats.get(k.slice(0, 3)).n1 !== null);
  amb.get('BBBB').set(slipped, amb.get('BBBB').get(slipped) + 7);
  feed(T0 + 265, ['AAAA', 'BBBB']);
  const s = bl.sats.get(slipped.slice(0, 3));
  assert.ok(s && s.n1 !== null && s.bridged, 'спутник после срыва закреплён сразу');
  assert.strictEqual(bl.count.bridge, 1);
});

test('VRS: положение спутника и геометрия согласованы', () => {
  const nav = constellation();
  const st = model.site(STATIONS[0].ecef);
  let seen = 0;
  for (const [, list] of nav) {
    const g = navlib.range(list[0], T0 + 100, st.ecef, 0);
    const dir = model.look(st, g.los);
    if (dir.el < 10 * D2R) continue;
    seen++;
    assert.ok(g.rho > 19e6 && g.rho < 29e6);
    assert.ok(Math.abs(Math.hypot(...g.los) - 1) < 1e-12);
  }
  assert.ok(seen >= 12);
  // Тропосфера: в зените около 2,3 м, у горизонта в разы больше
  assert.ok(Math.abs(model.troposphere(st, Math.PI / 2) - 2.33) < 0.15);
  assert.ok(model.troposphere(st, 10 * D2R) > 4 * model.troposphere(st, Math.PI / 2));
  const g = ecefToLlh(...STATIONS[0].ecef);
  assert.ok(Math.abs(ecefToEnu(g.lat, g.lon, [0, 0, 0])[0]) < 1e-9);
});

test('VRS: служба целиком — потоки станций с шины, ровер через раздачу получает кадры виртуальной базы', async () => {
  const nav = constellation();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ural-vrs-'));
  const navFile = path.join(dir, 'brdc.rnx');
  fs.writeFileSync(navFile, rinex(nav));
  // Сеть объявляет роверу координаты со сдвигом (как сеть «как основная»): расчёт идёт в своих
  const SHIFT = [1.714, -3.776, 1.452];
  const tasks = path.join(dir, 'tasks.json');
  fs.writeFileSync(tasks, JSON.stringify({ networks: [{ id: 7, name: 'N3_VRS', stations: STATIONS.map((s) => ({ code: s.code, ecef: s.ecef, out: s.ecef.map((v, i) => v + SHIFT[i]) })), options: { maxKm: 120, stationId: 100, residuals: true } }] }));
  const bus = new BusServer({ port: 0 });
  const busPort = await bus.ready;
  let now = T0;
  const service = await vrsService.start({
    config: { bind: '127.0.0.1', ingest: { busPort }, vrs: { port: 0 } }, log: () => {}, dataDir: dir, statePort: 0, tasksFile: tasks, directoryUrl: '',
    fetchNav: async () => ({ files: [navFile], error: '' }), clock: () => obs.unixFromGps(now),
  });
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  try {
    assert.strictEqual(service.engines.size, 1);
    for (let i = 0; i < 200 && !bus.clients.size; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    const amb = new Map(STATIONS.map((s) => [s.code, new Map()]));
    const feed = async (t) => {
      now = t + 0.3;
      for (const s of STATIONS) {
        const raw = observe(s, t, nav, amb.get(s.code), { clock: 3, exact: true });
        bus.publish({ t: 'data', station: s.code }, Buffer.concat(messages(raw, t).map((b) => rtcm.frame(b))));
      }
      for (let i = 0; i < 3; i++) await tick();
    };
    // Раздача: внутреннее соединение со службой
    const got = [];
    const link = net.connect(service.ports.link, '127.0.0.1');
    const decoder = new Decoder();
    link.on('data', (chunk) => { for (const m of decoder.push(chunk)) got.push(m); });
    await new Promise((resolve) => link.once('connect', resolve));
    for (let t = T0; t < T0 + 200; t += 1) await feed(t);
    const state = () => new Promise((resolve) => require('http').get(`http://127.0.0.1:${service.ports.state}/state`, (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve(JSON.parse(Buffer.concat(c).toString()))); }));
    let st = await state();
    assert.strictEqual(st.networks[0].name, 'N3_VRS');
    assert.ok(st.nav.sats >= 50 && !st.nav.error);
    assert.ok(st.networks[0].baselines.every((b) => b.fixed >= 10), JSON.stringify(st.networks[0].baselines.map((b) => `${b.a}-${b.b} ${b.fixed}/${b.seen}`)));
    // Ровер сообщил положение: виртуальная база ставится туда
    const g = ecefToLlh(...ROVER.ecef);
    link.write(encode({ t: 'rover', id: 'r1', login: 'ivan', net: 'N3_VRS', lat: g.lat / D2R, lon: g.lon / D2R, h: g.h }));
    link.write(encode({ t: 'rover', id: 'r2', login: 'ivan', net: 'NOPE', lat: 56, lon: 60, h: 0 }));
    for (let t = T0 + 200; t < T0 + 206; t += 1) await feed(t);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(got.some((m) => m.header.t === 'end' && m.header.id === 'r2'), 'сеанс на несуществующую сеть снимается с объяснением');
    const data = got.filter((m) => m.header.t === 'data' && m.header.id === 'r1');
    assert.ok(data.length >= 5, `порций ${data.length}`);
    assert.strictEqual(data[0].header.master, 'AAAA');
    const frames = new StreamParser().push(Buffer.concat(data.map((m) => m.body))).filter((f) => f.kind === 'rtcm');
    const types = [...new Set(frames.map((f) => f.type))].sort();
    assert.deepStrictEqual(types, [1006, 1008, 1030, 1033, 1074, 1094]);
    // Остатки сети: по каждому спутнику GPS из потока, со станцией и числом станций сети
    const res = require('../modules/vrs/residuals').decode(frames.find((f) => f.type === 1030).payload);
    const gpsNow = obs.decode(1074, frames.filter((f) => f.type === 1074)[0].payload).sats.map((x) => x.prn);
    assert.strictEqual(res.stationId, 100);
    assert.ok(res.refs >= 3 && res.sats.length >= 8 && res.sats.every((x) => gpsNow.includes(x.prn) && x.sic > 0 && x.soc > 0), JSON.stringify(res));
    // Объявленные координаты базы — в системе сети: положение ровера плюс её сдвиг
    const pos = rtcm.decodePosition(frames.find((f) => f.type === 1006).payload);
    assert.strictEqual(pos.stationId, 100);
    assert.ok(ROVER.ecef.every((v, i) => Math.abs(pos.ecef[i] - v - SHIFT[i]) < 0.002), JSON.stringify(pos.ecef));
    assert.strictEqual(rtcm.decodeDescriptor(frames.find((f) => f.type === 1033).payload).antenna, 'ADVNULLANTENNA');
    // Наблюдения — как у настоящей базы в этой точке
    const last = frames.filter((f) => f.type === 1074).pop();
    const m = obs.decode(1074, last.payload);
    assert.ok(m.sats.length >= 8 && m.sats.every((x) => x.sigs.length === 2 && x.sigs.every((q) => q.ph !== null && q.pr !== null)));
    const t = obs.epochTime('G', m.epoch, T0 + 200);
    const truth = observe(ROVER, t, nav, null, { exact: true });
    const master = amb.get('AAAA');
    const diff = m.sats.map((x) => { const sat = `G${String(x.prn).padStart(2, '0')}`; return x.sigs[0].ph - (C / F.G[0]) * master.get(`${sat}.0`) - truth.get(sat).get(2).ph; });
    const mean = diff.reduce((a, b) => a + b, 0) / diff.length;
    assert.ok(Math.max(...diff.map((v) => Math.abs(v - mean))) < 0.005, `фаза расходится: ${diff.map((v) => ((v - mean) * 1000).toFixed(1))}`);
    // Самопроверка и состояние для панели
    service.selfCheck();
    st = await state();
    const n = st.networks[0];
    assert.deepStrictEqual([n.sessions.length, n.sessions[0].login, n.sessions[0].master, n.sessions[0].info.reach], [1, 'ivan', 'AAAA', 1]);
    assert.ok(n.stations.every((x) => x.live && x.check && x.check.now !== null && x.check.now < 60), JSON.stringify(n.stations.map((x) => x.check && x.check.now)));
    assert.ok(n.triangles >= 4);
    // Ровер ушёл дальше заданного — база переставляется, номер станции другой
    link.write(encode({ t: 'rover', id: 'r1', login: 'ivan', net: 'N3_VRS', lat: g.lat / D2R + 0.1, lon: g.lon / D2R, h: g.h }));
    got.length = 0;
    for (let t = T0 + 206; t < T0 + 213; t += 1) await feed(t);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const moved = new StreamParser().push(Buffer.concat(got.filter((x) => x.header.t === 'data').map((x) => x.body))).filter((f) => f.kind === 'rtcm' && f.type === 1006);
    assert.ok(moved.length >= 1);
    assert.strictEqual(rtcm.decodePosition(moved[0].payload).stationId, 101);
    link.write(encode({ t: 'close', id: 'r1' }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.strictEqual(service.sessions.size, 0);
    link.destroy();
  } finally {
    await service.stop();
    await bus.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('VRS: неровная ионосфера замечается, и сеть сама становится осторожнее', () => {
  const nav = constellation();
  const run = (rough, auto) => {
    const net = new Network({ stations: STATIONS.map((s) => ({ code: s.code, ecef: s.ecef })), nav, options: { maxKm: 120, auto }, baseline: { step: 5, auto } });
    const amb = new Map(STATIONS.map((s) => [s.code, new Map()]));
    for (let t = T0; t <= T0 + 400; t += 5) for (const s of STATIONS) net.push(s.code, t, observe(s, t, nav, amb.get(s.code), { clock: 2, rough }));
    return net;
  };
  // Гладкая ионосфера (только наклон): индекс около нуля, сеть ничего не меняет
  const calm = run(0, true);
  const a = calm.tune();
  assert.ok(a.index !== null && a.index < 0.5, `спокойная: ${a.index}`);
  assert.strictEqual(a.level, 0);
  assert.ok(calm.baselines.every((bl) => bl.ionoSigma === bl.ionoSigma0 && bl.smooth === bl.o.ionoSmooth));
  // Неровная: у каждой станции свой остаток в сантиметры на спутник
  const wild = run(0.03, true);
  const b = wild.tune();
  assert.ok(b.index > 0.8 && b.index > 3 * a.index, `неровная: ${b.index} против спокойной ${a.index}`);
  assert.ok(wild.baselines.some((bl) => bl.ionoSigma > bl.ionoSigma0), 'стороны расширили ожидаемый остаток');
  assert.ok(wild.baselines.every((bl) => bl.ionoSigma <= 4 * bl.ionoSigma0 + 1e-12));
  // Целые при этом по-прежнему настоящие
  for (const bl of wild.baselines) assert.strictEqual(bl.count.restart, 0, `${bl.a.code}-${bl.b.code} начиналась заново`);
  // Без самонастройки числа остаются как заданы
  const fixed = run(0.03, false);
  fixed.tune();
  assert.ok(fixed.baselines.every((bl) => bl.ionoSigma === bl.ionoSigma0 && bl.smooth === bl.o.ionoSmooth));
  // Уровень «неровная» поднимает маску для ровера и укорачивает сглаживание
  wild.level = 2;
  const low = wild.virtual(ROVER.ecef, { t: T0 + 400 });
  wild.level = 0;
  const all = wild.virtual(ROVER.ecef, { t: T0 + 400 });
  assert.ok(low.sats.length <= all.sats.length);
  assert.ok(low.sats.every((s) => s.el >= 15 * D2R - 1e-9), 'маска 10° поднята до 15°');
  wild.baselines.forEach((bl) => { bl.rough2 = (0.01 * bl.km) ** 2; });
  assert.strictEqual(wild.tune().level >= 2, true);
  assert.ok(wild.baselines.every((bl) => bl.smooth === bl.o.ionoSmooth / 2));
});

test('VRS: запасной источник эфемерид берёт почасовые файлы ближних станций и не качает дважды', async () => {
  const navsource = require('../modules/vrs/navsource');
  const names = ['WTZR00DEU_R_20262801600_01H_MN.rnx.gz', 'ARTU00RUS_R_20262801600_01H_MN.rnx.gz', 'ARTU00RUS_R_20262801600_01H_GN.rnx.gz', 'ZZZZ00XXX_R_20262801600_01H_MN.rnx.gz', 'KIT300UZB_R_20262801600_01H_MN.rnx.gz', 'MD5SUMS'];
  assert.deepStrictEqual(navsource.choose(names, 2), ['ARTU00RUS_R_20262801600_01H_MN.rnx.gz', 'KIT300UZB_R_20262801600_01H_MN.rnx.gz']);
  assert.deepStrictEqual(navsource.choose(['MD5SUMS']), []);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ural-nav-'));
  const calls = [];
  const body = require('zlib').gzipSync(Buffer.from(rinex(constellation(), 'G07')));
  const run = async (args) => {
    calls.push(args.join(' '));
    if (args.includes('-l')) return names.join('\n');
    fs.writeFileSync(args[args.indexOf('-o') + 1], body);
    return '';
  };
  try {
    const now = Date.UTC(2026, 9, 7, 17, 30);
    const a = await navsource.ensure(dir, now, { hours: 2, count: 3, run });
    assert.strictEqual(a.error, '');
    assert.strictEqual(a.files.length, 3);
    assert.strictEqual(navlib.parse(fs.readFileSync(a.files[0], 'latin1')).size, 1);
    const before = calls.length;
    const b = await navsource.ensure(dir, now, { hours: 2, count: 3, run });
    assert.strictEqual(calls.length, before, 'взятые часы заново не запрашиваются');
    assert.strictEqual(b.files.length, 3);
    // Архив молчит — остаётся скачанное раньше, причина названа
    const c = await navsource.ensure(dir, now + 3600000, { hours: 2, count: 3, run: async () => { throw new Error('CDDIS не ответил'); } });
    assert.strictEqual(c.error, 'CDDIS не ответил');
    assert.strictEqual(c.files.length, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('VRS: коллокация — веса по близости, точны на станции и не растут за краем', () => {
  const pts = [{ e: 40e3, n: 0 }, { e: 0, n: 40e3 }, { e: -30e3, n: -20e3 }];
  // В точке соседней станции поправка — её собственная; у ведущей поправки нет
  const at = weights('lsc', pts, pts[0], { corr: 100e3 }).w;
  assert.ok(Math.abs(at[0] - 1) < 0.01 && Math.abs(at[1]) < 0.01 && Math.abs(at[2]) < 0.01);
  assert.ok(weights('lsc', pts, { e: 0, n: 0 }, { corr: 100e3 }).w.every((v) => Math.abs(v) < 1e-9));
  // Ближняя станция весит больше дальней
  const near = weights('lsc', pts, { e: 30e3, n: 5e3 }, { corr: 100e3 }).w;
  assert.ok(near[0] > near[1] && near[0] > Math.abs(near[2]));
  // С наклоном линейное поле восстанавливается почти как плоскостью, без наклона — заметно хуже
  const field = (p) => 3e-6 * p.e - 2e-6 * p.n;
  const p = { e: 10e3, n: 15e3 };
  const err = (trend) => Math.abs(weights('lsc', pts, p, { corr: 100e3, trend }).w.reduce((s, v, i) => s + v * field(pts[i]), 0) - field(p));
  assert.ok(err(10) < err(0) && err(10) < 0.004, `${err(10)} и ${err(0)}`);
  // Далеко за краем сумма весов ограничена
  const far = weights('lsc', pts, { e: 500e3, n: 400e3 }, { corr: 100e3, trend: 3, limit: 1.5 });
  assert.ok(far.w.reduce((s, v) => s + Math.abs(v), 0) <= 1.5 + 1e-9 && far.w.every(Number.isFinite));
});

test('VRS: сообщение 1030 собирается и разбирается, оценки по спутникам копятся', () => {
  const residuals = require('../modules/vrs/residuals');
  const body = residuals.encode({ stationId: 77, tow: 345678.4, refs: 4, sats: [{ prn: 5, soc: 0.012, sod: 0, soh: 0, sic: 0.031, sid: 0.87 }, { prn: 31, soc: 9, sod: 99, soh: 99, sic: 9, sid: 99 }] });
  assert.strictEqual(body.length, Math.ceil((56 + 2 * 49) / 8));
  const m = residuals.decode(body);
  assert.deepStrictEqual([body.readUInt16BE(0) >> 4, m.tow, m.stationId, m.refs, m.sats.length], [1030, 345678, 77, 4, 2]);
  assert.deepStrictEqual(m.sats[0], { prn: 5, soc: 0.012, sod: 0, soh: 0, sic: 0.031, sid: 0.87 });
  // Значения сверх предела поля не переполняют его, а упираются в предел
  assert.deepStrictEqual(m.sats[1], { prn: 31, soc: 0.1275, sod: 5.11, soh: 6.3, sic: 0.5115, sid: 10.23 });
  const q = new residuals.Quality(600);
  assert.strictEqual(q.of('G05').known, false);
  q.add([{ sat: 'G05', iono: 0.04, geo: 0.01 }], 1000);
  q.add([{ sat: 'G05', iono: 0.0, geo: 0.01 }], 1030);
  const got = q.of('G05');
  assert.ok(got.known && got.iono > 0.02 && got.iono < 0.04 && Math.abs(got.geo - 0.01) < 1e-9, JSON.stringify(got));
  q.add([{ sat: 'G07', iono: 0.01, geo: 0.01 }], 1000 + 3700);
  assert.strictEqual(q.of('G05').known, false, 'давние оценки забываются');
});
