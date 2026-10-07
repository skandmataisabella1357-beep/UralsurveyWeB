'use strict';
// Модуль «VRS»: сеть станций целиком.
// Сеть принимает наблюдения станций, ведёт стороны (пары станций) и по закреплённым
// неоднозначностям знает разности ионосферы и тропосферы между станциями. Отсюда два дела:
//  - виртуальная база: наблюдения ближайшей станции переносятся в точку ровера, а поправки сети
//    туда интерполируются — ровер получает базу «рядом с собой»;
//  - самопроверка: станция по очереди считается ровером, сеть предсказывает её по соседям,
//    и разница с настоящими наблюдениями показывает точность сети в миллиметрах.

const { ecefToEnu } = require('../../core/geo');
const navlib = require('./nav');
const model = require('./model');
const { Baseline } = require('./baseline');
const { CLIGHT, frequency } = require('./obs');

const DEFAULTS = {
  maxKm: 90, // стороны длиннее не ведутся
  maxLinks: 6, // столько ближайших соседей у станции
  aux: 3, // сколько соседних станций помогают ведущей
  minAux: 2, // спутник отдаётся, если поправка есть хотя бы от стольких соседей
  method: 'plane', // plane — плоскость по соседям, idw — по обратным расстояниям, none — без поправок сети
  power: 2, // степень расстояния для idw
  limit: 1.5, // предел суммы весов соседей: дальше поправки за край сети не продолжаются
  maxAge: 30, // с, поправка старше не применяется
  bufferSec: 45, // с: столько станция может отставать от соседней, чтобы их эпохи ещё сошлись
  strict: true, // брать только спутники, прошедшие проверку замыканием треугольников
  closureIono: 0.04, // м, допустимое незамыкание ионосферы по треугольнику станций
  closureGeo: 0.05, // м, то же для геометрической части
  closureAge: 60, // с, сколько действует пройденная проверка
  mask: 10, // градусов, ниже спутник в виртуальную базу не идёт
  systems: ['G', 'E', 'C'],
  lockGapSec: 10,
};

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// Веса соседей: поправка в точке = сумма весов на поправки соседей (у ведущей поправка ноль).
// pts — соседи в плане относительно ведущей [{ e, n }], p — точка там же.
// За пределами сети поправки не продолжаются как попало: сумма весов ограничена limit, то есть
// точка как бы подтягивается к ведущей станции. Возвращает { w, reach }: reach < 1 — ограничение
// сработало (точка вне сети или соседи стоят неудачно).
function weights(method, pts, p, { power = 2, limit = 1.5 } = {}) {
  let w = pts.map(() => 0);
  if (method === 'none' || !pts.length) return { w, reach: 1 };
  if (method === 'idw') {
    const d0 = Math.hypot(p.e, p.n);
    if (d0 < 1) return { w, reach: 1 };
    const raw = pts.map((q) => Math.max(1, Math.hypot(p.e - q.e, p.n - q.n)) ** -power);
    const sum = raw.reduce((a, b) => a + b, d0 ** -power);
    return { w: raw.map((v) => v / sum), reach: 1 };
  }
  // Плоскость через ведущую: наклоны по наименьшим квадратам
  let a = 0; let b = 0; let c = 0;
  for (const q of pts) { a += q.e * q.e; b += q.e * q.n; c += q.n * q.n; }
  const half = Math.sqrt(((a - c) / 2) ** 2 + b * b);
  const big = (a + c) / 2 + half;
  const small = (a + c) / 2 - half;
  if (!(big > 0)) return { w, reach: 1 };
  if (small < 0.04 * big) {
    // Соседи лежат почти на одной прямой: наклон известен только вдоль неё
    let v = Math.abs(b) > 1e-9 * big ? [b, big - a] : (a >= c ? [1, 0] : [0, 1]);
    const len = Math.hypot(v[0], v[1]);
    v = [v[0] / len, v[1] / len];
    const along = (v[0] * p.e + v[1] * p.n) / big;
    w = pts.map((q) => along * (v[0] * q.e + v[1] * q.n));
  } else {
    const det = a * c - b * b;
    const ge = (c * p.e - b * p.n) / det;
    const gn = (a * p.n - b * p.e) / det;
    w = pts.map((q) => ge * q.e + gn * q.n);
  }
  const total = w.reduce((sum, v) => sum + Math.abs(v), 0);
  if (total <= limit) return { w, reach: 1 };
  return { w: w.map((v) => v * limit / total), reach: limit / total };
}

class Network {
  // stations: [{ code, ecef }] — координаты в одной согласованной системе, точность сантиметр
  constructor({ stations, nav = new Map(), options = {}, baseline = {} }) {
    this.o = { ...DEFAULTS, ...options };
    this.nav = nav;
    this.stations = new Map();
    for (const s of stations) {
      this.stations.set(s.code, { code: s.code, ...model.site(s.ecef), epoch: null, raw: null, recent: new Map(), track: new Map(), slipAt: new Map(), links: [] });
    }
    this.baselines = [];
    const list = [...this.stations.values()];
    const pairs = new Set();
    for (const s of list) {
      const near = list.filter((x) => x !== s).map((x) => ({ x, km: dist(s.ecef, x.ecef) / 1000 }))
        .filter((r) => r.km <= this.o.maxKm).sort((p, q) => p.km - q.km).slice(0, this.o.maxLinks);
      for (const r of near) pairs.add([s.code, r.x.code].sort().join('|'));
    }
    for (const key of [...pairs].sort()) {
      const [a, b] = key.split('|').map((c) => this.stations.get(c));
      const bl = new Baseline(a, b, baseline);
      this.baselines.push(bl);
      a.links.push(bl);
      b.links.push(bl);
    }
    // Треугольники: тройки станций, связанных сторонами попарно. По ним сеть проверяет сама себя:
    // сумма поправок по замкнутому кругу обязана быть нулём.
    this.triangles = [];
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) for (let k = j + 1; k < list.length; k++) {
      const [a, b, c] = [list[i], list[j], list[k]].sort((x, y) => (x.code < y.code ? -1 : 1));
      const ab = this.link(a.code, b.code); const bc = this.link(b.code, c.code); const ac = this.link(a.code, c.code);
      if (!ab || !bc || !ac) continue;
      this.triangles.push({ ab, bc, ac, codes: [a.code, b.code, c.code], at: 0 });
      ab.tri++; bc.tri++; ac.tri++;
    }
    for (const st of list) st.triangles = this.triangles.filter((tr) => tr.codes.includes(st.code));
  }

  // Проверка треугольника: поправки «b−a», «c−b» и «a−c» в сумме дают ноль у каждого спутника
  // (относительно остальных). Ошибка в целых на любой стороне нарушает это на 8 см и больше.
  // Стороны считаются в разное время, поэтому сверяется общая для трёх эпоха t из их недавних значений.
  closure(tr, t) {
    const { ab, bc, ac } = tr;
    const o = this.o;
    for (const sys of o.systems) {
      const rows = [];
      for (const [sat, x] of ab.sats) {
        if (x.sys !== sys || x.n1 === null) continue;
        const y = bc.sats.get(sat); const z = ac.sats.get(sat);
        if (!y || !z || y.n1 === null || z.n1 === null) continue;
        const hx = ab.past(x, t); const hy = bc.past(y, t); const hz = ac.past(z, t);
        if (!hx || !hy || !hz) continue;
        rows.push({ sat, x, y, z, iono: hx[1] + hy[1] - hz[1], geo: hx[2] + hy[2] - hz[2] });
      }
      if (rows.length < 3) continue;
      // Общие сдвиги системы у каждой стороны свои — убираются медианой по спутникам
      const mid = (key) => { const v = rows.map((r) => r[key]).sort((p, q) => p - q); return v[Math.floor(v.length / 2)]; };
      const mi = mid('iono'); const mg = mid('geo');
      for (const r of rows) {
        const bad = Math.abs(r.iono - mi) > o.closureIono || Math.abs(r.geo - mg) > o.closureGeo;
        if (!bad) { r.x.okAt = t; r.y.okAt = t; r.z.okAt = t; continue; }
        // Виновата, скорее всего, сторона, закрепившая этот спутник последней
        const who = [[ab, r.x], [bc, r.y], [ac, r.z]].sort((p, q) => q[1].fixAt - p[1].fixAt)[0];
        who[0].drop(r.sat, 'closure');
      }
    }
  }

  setNav(nav) { this.nav = nav; }

  // Наблюдения станции за эпоху t (секунды GPS). raw: Map 'G05' -> Map сигнал -> { sig, pr, ph, lock, half, cnr }
  push(code, t, raw) {
    const st = this.stations.get(code);
    if (!st) return null;
    t = Math.round(t * 1000) / 1000;
    if (st.epoch && t <= st.epoch.t) return null;
    // Срывы слежения по счётчику приёмника: счётчик уменьшился или был долгий пропуск
    for (const [sat, sigs] of raw) {
      let tr = st.track.get(sat);
      if (!tr) { tr = new Map(); st.track.set(sat, tr); }
      for (const [id, g] of sigs) {
        if (g.ph === null) continue;
        const prev = tr.get(id);
        // Срыв — это когда счётчик приёмника уменьшился и при этом показывает слежение короче,
        // чем прошло с прошлой эпохи. У части приёмников счётчик просто переполняется и
        // начинается с большого значения: это не срыв. После долгого пропуска (обрыв связи со
        // станцией) срыва тоже нет, если счётчик показывает слежение дольше самого пропуска:
        // приёмник спутник не терял, пропали только сообщения.
        const short = g.lock === 0 ? 0 : 0.032 * 2 ** (g.lock - 1);
        const gap = prev ? t - prev.t : 0;
        if (!prev || (g.lock < prev.lock && short <= gap + 0.5) || (gap > this.o.lockGapSec && short <= gap)) {
          tr.set(id, { lock: g.lock, t, since: t });
          const key = `${sat}.${id}`;
          const list = st.slipAt.get(key) || [];
          list.push(t);
          if (list.length > 8) list.shift();
          st.slipAt.set(key, list);
        } else { prev.lock = g.lock; prev.t = t; }
      }
    }
    const epoch = model.reduce(st, t, raw, this.nav, { mask: 5 * Math.PI / 180 });
    if (!epoch) return null;
    st.epoch = epoch;
    st.raw = raw;
    // Станции присылают одну и ту же эпоху в разное время (связь у всех своя), поэтому последние
    // эпохи хранятся: сторона считается, когда эпоху прислала вторая станция
    st.recent.set(t, epoch);
    for (const old of st.recent.keys()) { if (t - old > this.o.bufferSec) st.recent.delete(old); else break; }
    for (const bl of st.links) {
      const other = bl.a === st ? bl.b : bl.a;
      const pair = other.recent.get(t);
      if (!pair || bl.t >= t) continue;
      const ea = bl.a === st ? epoch : pair;
      const eb = bl.a === st ? pair : epoch;
      bl.update(t, ea, eb, { a: this.slipsOf(bl.a, bl, t), b: this.slipsOf(bl.b, bl, t) });
    }
    for (const tr of st.triangles) {
      const at = Math.min(tr.ab.t, tr.bc.t, tr.ac.t);
      if (at > tr.at) { tr.at = at; this.closure(tr, at); }
    }
    return epoch;
  }

  // Спутники станции, у которых между прошлой эпохой стороны и этой был срыв на опорных сигналах
  slipsOf(st, bl, t) {
    const out = new Set();
    const k = st === bl.a ? 0 : 1;
    for (const [sat, s] of bl.sats) {
      for (const id of [s.sig[0][k], s.sig[1][k]]) {
        const list = st.slipAt.get(`${sat}.${id}`);
        if (list && list.some((at) => at > s.t && at <= t)) { out.add(sat); break; }
      }
    }
    return out;
  }

  link(a, b) {
    return this.stations.get(a).links.find((bl) => bl.a.code === b || bl.b.code === b) || null;
  }

  // Ближайшая к точке станция, которая сейчас на связи
  nearest(pos, t, skip = []) {
    let best = null;
    for (const st of this.stations.values()) {
      if (skip.includes(st.code) || !st.epoch || t - st.epoch.t > this.o.maxAge) continue;
      const d = dist(st.ecef, pos);
      if (!best || d < best.d) best = { st, d };
    }
    return best ? best.st : null;
  }

  // Поправки сети в точке pos относительно ведущей станции master.
  // Возвращает { master, aux: [коды], sats: Map 'G05' -> { iono, geo, n, ref } }:
  // iono — разность ионосферы «точка минус ведущая» на первой частоте, geo — остальное
  // (остаток тропосферы и орбит), обе — относительно опорного спутника своей системы.
  interpolate(master, pos, t, { skip = [], aux = this.o.aux, method = this.o.method, minAux = this.o.minAux, power = this.o.power, strict = this.o.strict } = {}) {
    const M = this.stations.get(master);
    const rel = (ecef) => { const v = ecefToEnu(M.lat, M.lon, [ecef[0] - M.ecef[0], ecef[1] - M.ecef[1], ecef[2] - M.ecef[2]]); return { e: v[0], n: v[1] }; };
    const p = rel(pos);
    const fresh = (bl) => t - bl.t <= this.o.maxAge;
    const helpers = M.links.filter(fresh).map((bl) => ({ bl, st: bl.a === M ? bl.b : bl.a, sign: bl.a === M ? 1 : -1 }))
      .filter((h) => !skip.includes(h.st.code))
      .map((h) => ({ ...h, d: dist(h.st.ecef, pos), at: rel(h.st.ecef) }))
      .sort((x, y) => x.d - y.d).slice(0, method === 'none' ? 0 : aux);
    const out = new Map();
    let reach = 1;
    const value = (h, sat) => {
      const s = h.bl.sats.get(sat);
      if (!s || s.still === null || s.still === undefined || s.calm === null || s.calm === undefined || h.bl.t - s.t > 1e-3) return null;
      return !strict || !h.bl.tri || (s.okAt && h.bl.t - s.okAt <= this.o.closureAge) ? s : null;
    };
    for (const sys of this.o.systems) {
      const sats = new Map(); // спутник -> помощники, у которых он закреплён
      for (const h of helpers) for (const [sat, s] of h.bl.sats) if (s.sys === sys && value(h, sat)) (sats.get(sat) || sats.set(sat, []).get(sat)).push(h);
      if (!sats.size) continue;
      // Опорный спутник: закреплён у наибольшего числа помощников, из таких — самый высокий
      let ref = null;
      for (const [sat, hs] of sats) {
        const el = value(hs[0], sat).el;
        if (!ref || hs.length > ref.hs.length || (hs.length === ref.hs.length && el > ref.el)) ref = { sat, hs, el };
      }
      const need = Math.min(minAux, ref.hs.length);
      for (const [sat, hs] of sats) {
        const use = hs.filter((h) => ref.hs.includes(h));
        if (use.length < need) continue;
        const { w, reach: got } = weights(method, use.map((h) => h.at), p, { power, limit: this.o.limit });
        reach = Math.min(reach, got);
        let iono = 0; let geo = 0;
        use.forEach((h, i) => {
          const s = value(h, sat); const r = value(h, ref.sat);
          iono += w[i] * h.sign * (s.still - r.still);
          geo += w[i] * h.sign * (s.calm - r.calm);
        });
        out.set(sat, { iono, geo, n: use.length, ref: sat === ref.sat });
      }
    }
    return { master, aux: helpers.map((h) => h.st.code), sats: out, reach };
  }

  // Наблюдения виртуальной базы в точке pos по последней эпохе ведущей станции.
  // Возвращает { t, master, aux, sats: [{ sat, sys, prn, el, sigs: [{ sig, pr, ph, lock, half, cnr }] }] }
  virtual(pos, options = {}) {
    const now = options.t || Math.max(...[...this.stations.values()].map((s) => (s.epoch ? s.epoch.t : 0)));
    const M = options.master ? this.stations.get(options.master) : this.nearest(pos, now, options.skip);
    if (!M || !M.epoch) return null;
    const t = M.epoch.t;
    const net = this.interpolate(M.code, pos, t, options);
    const V = model.site(pos);
    const mask = (options.mask === undefined ? this.o.mask : options.mask) * Math.PI / 180;
    const sats = [];
    for (const [sat, e] of M.epoch.sats) {
      const c = net.sats.get(sat);
      if (!c || e.el < mask) continue;
      const eph = navlib.pick(this.nav, sat, t);
      if (!eph) continue;
      const clock = M.epoch.clock / CLIGHT;
      const gm = navlib.range(eph, t, M.ecef, clock);
      const gv = navlib.range(eph, t, pos, clock);
      const shift = (gv.rho - gv.clock + model.troposphere(V, model.look(V, gv.los).el)) - (gm.rho - gm.clock + model.troposphere(M, e.el));
      const f1 = frequency(e.sys, model.PAIRS[e.sys].a[0]);
      const sigs = [];
      for (const [id, g] of M.raw.get(sat)) {
        const f = frequency(e.sys, id);
        if (!f) continue;
        const k = (f1 / f) ** 2;
        const tr = M.track.get(sat) && M.track.get(sat).get(id);
        sigs.push({
          sig: id,
          pr: g.pr === null ? null : g.pr + shift + c.geo + k * c.iono,
          ph: g.ph === null || g.half ? null : g.ph + shift + c.geo - k * c.iono,
          lock: tr ? t - tr.since : 0, half: 0, cnr: g.cnr,
        });
      }
      if (sigs.length) sats.push({ sat, sys: e.sys, prn: Number(sat.slice(1)), el: e.el, n: c.n, sigs });
    }
    return { t, master: M.code, aux: net.aux, reach: net.reach, sats };
  }

  // Самопроверка: станция code считается ровером, которого сеть не знает. Сеть предсказывает
  // её поправки по соседям; правда известна по стороне «ведущая — эта станция».
  // Возвращает ошибки в метрах: iono, geo и их сумму на первой частоте (phase).
  check(code, options = {}) {
    const X = this.stations.get(code);
    if (!X || !X.epoch) return null;
    const t = X.epoch.t;
    const cand = X.links.filter((bl) => t - bl.t <= this.o.maxAge).map((bl) => ({ bl, st: bl.a === X ? bl.b : bl.a, sign: bl.b === X ? 1 : -1 }))
      .sort((p, q) => p.bl.km - q.bl.km);
    const truth = options.master ? cand.find((c) => c.st.code === options.master) : cand[0];
    if (!truth) return null;
    const net = this.interpolate(truth.st.code, X.ecef, t, { ...options, skip: [code] });
    const rows = [];
    for (const sys of this.o.systems) {
      const refSat = [...net.sats].find(([sat, c]) => sat[0] === sys && c.ref);
      if (!refSat) continue;
      const r = truth.bl.sats.get(refSat[0]);
      if (!r || r.iono === null || r.iono === undefined || r.calm === null || r.calm === undefined || truth.bl.t - r.t > 1e-3) continue;
      for (const [sat, c] of net.sats) {
        if (sat[0] !== sys || c.ref) continue;
        const s = truth.bl.sats.get(sat);
        if (!s || s.iono === null || s.iono === undefined || s.calm === null || s.calm === undefined || truth.bl.t - s.t > 1e-3) continue;
        const iono = c.iono - truth.sign * (s.still - r.still);
        const geo = c.geo - truth.sign * (s.calm - r.calm);
        // Без сети ровер получил бы всю разность целиком — это показывает, что сеть убрала
        rows.push({ sat, el: s.el, iono, geo, phase: geo - iono, rawIono: truth.sign * (s.still - r.still), rawGeo: truth.sign * (s.calm - r.calm) });
      }
    }
    const rms = (key) => (rows.length ? Math.sqrt(rows.reduce((a, r) => a + r[key] * r[key], 0) / rows.length) : null);
    return {
      code, master: truth.st.code, km: truth.bl.km, aux: net.aux, reach: net.reach, sats: rows.length, rows,
      iono: rms('iono'), geo: rms('geo'), phase: rms('phase'), rawIono: rms('rawIono'), rawGeo: rms('rawGeo'),
    };
  }

  summary() {
    return this.baselines.map((bl) => bl.summary());
  }
}

module.exports = { Network, weights, DEFAULTS };
