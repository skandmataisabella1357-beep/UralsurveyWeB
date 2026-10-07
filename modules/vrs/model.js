'use strict';
// Модуль «VRS»: приведение наблюдений станции с известными координатами.
// Из каждого измерения вычитается всё, что можно посчитать: дальность до спутника, уход часов
// спутника и приёмника, тропосфера по модели. Остаётся то, что сеть и должна узнать: ионосфера,
// остаток тропосферы и целое число длин волн (неоднозначность фазы).

const { ecefToLlh, ecefToEnu } = require('../../core/geo');
const navlib = require('./nav');
const { frequency, CLIGHT } = require('./obs');

// Опорная пара частот каждой системы: по ней сеть находит неоднозначности и ионосферу.
// В списках — номера сигналов MSM в порядке предпочтения.
const PAIRS = {
  G: { a: [2, 3, 4, 30, 31, 32], b: [10, 9, 8, 16, 17, 15] }, // L1 и L2
  E: { a: [2, 5, 4, 3, 6], b: [15, 16, 14] }, // E1 и E5b
  C: { a: [2, 3, 4], b: [8, 9, 10] }, // B1I и B3I
};
const SYSTEMS = Object.keys(PAIRS);

function site(ecef) {
  const g = ecefToLlh(ecef[0], ecef[1], ecef[2]);
  return { ecef, lat: g.lat, lon: g.lon, h: g.h };
}

// Задержка в тропосфере по модели Саастамойнена для стандартной атмосферы: сухая и влажная
// части в зените. Высота станции учитывается, погода — нет: её остаток оценивает сеть.
function zenithDelay(lat, h) {
  const hh = Math.max(-100, Math.min(h, 9000));
  const p = 1013.25 * (1 - 2.2557e-5 * hh) ** 5.2568;
  const temp = 15 - 6.5e-3 * hh + 273.15;
  const e = 6.108 * Math.exp((17.15 * temp - 4684) / (temp - 38.45)) * 0.5;
  const dry = 0.0022768 * p / (1 - 0.00266 * Math.cos(2 * lat) - 0.00028 * hh / 1000);
  const wet = 0.002277 * (1255 / temp + 0.05) * e;
  return { dry, wet };
}

// Во сколько раз задержка на угле места el больше зенитной (функции Чао)
const mapDry = (el) => 1 / (Math.sin(el) + 0.00143 / (Math.tan(el) + 0.0445));
const mapWet = (el) => 1 / (Math.sin(el) + 0.00035 / (Math.tan(el) + 0.017));

function troposphere(st, el) {
  const z = st.zenith || (st.zenith = zenithDelay(st.lat, st.h));
  return z.dry * mapDry(el) + z.wet * mapWet(el);
}

// Угол места и азимут спутника по единичному вектору на него
function look(st, los) {
  const enu = ecefToEnu(st.lat, st.lon, los);
  return { el: Math.asin(enu[2]), az: Math.atan2(enu[0], enu[1]) };
}

const median = (list) => {
  const s = [...list].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

// Наблюдения станции за одну эпоху -> приведённые.
// raw: Map 'G05' -> Map номер сигнала -> { sig, pr, ph, lock, half, cnr }
// Возвращает { t, clock, sats: Map 'G05' -> { sys, el, az, mw, eph, sig: Map -> { ..., f, P, L } } }:
// P и L — остатки кода и фазы в метрах после вычитания дальности, часов и тропосферы.
function reduce(st, t, raw, nav, { mask = 5 * Math.PI / 180 } = {}) {
  const geo = (clock) => {
    const out = new Map();
    for (const [sat, sigs] of raw) {
      const sys = sat[0];
      if (!PAIRS[sys]) continue;
      const eph = navlib.pick(nav, sat, t);
      if (!eph) continue;
      const g = navlib.range(eph, t, st.ecef, clock);
      const dir = look(st, g.los);
      if (dir.el < mask) continue;
      out.set(sat, { sys, el: dir.el, az: dir.az, rho: g.rho, sclk: g.clock, trop: troposphere(st, dir.el), mw: mapWet(dir.el), sigs });
    }
    return out;
  };
  // Уход часов приёмника — по коду первой частоты: сначала грубо, затем геометрия уточняется
  const clockOf = (sats) => {
    const bySys = {};
    for (const [, s] of sats) {
      const want = PAIRS[s.sys].a;
      let g = null;
      for (const id of want) { const x = s.sigs.get(id); if (x && x.pr !== null) { g = x; break; } }
      if (g && s.el > 10 * Math.PI / 180) (bySys[s.sys] = bySys[s.sys] || []).push(g.pr - s.rho + s.sclk - s.trop);
    }
    const sys = SYSTEMS.find((k) => bySys[k] && bySys[k].length >= 4);
    return sys ? median(bySys[sys]) : null;
  };
  let sats = geo(0);
  let clock = clockOf(sats);
  if (clock === null) return null;
  if (Math.abs(clock) > 30) { sats = geo(clock / CLIGHT); clock = clockOf(sats); }
  if (clock === null) return null;
  const out = new Map();
  for (const [sat, s] of sats) {
    const sig = new Map();
    for (const [id, g] of s.sigs) {
      const f = frequency(s.sys, id);
      if (!f) continue;
      const model = s.rho - s.sclk + s.trop + clock;
      sig.set(id, { ...g, f, P: g.pr === null ? null : g.pr - model, L: g.ph === null ? null : g.ph - model });
    }
    out.set(sat, { sys: s.sys, el: s.el, az: s.az, mw: s.mw, sig });
  }
  return { t, clock, sats: out };
}

module.exports = { PAIRS, SYSTEMS, site, zenithDelay, mapDry, mapWet, troposphere, look, reduce, median };
