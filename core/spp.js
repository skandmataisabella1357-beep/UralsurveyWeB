'use strict';
// Автономное определение координат станции по кодовым наблюдениям GPS
// и бортовым эфемеридам. Используется, когда в потоке нет сообщений
// 1005/1006 с координатами. Точность метровая: это оценка положения
// для карты и контроля, а не каталожные координаты пункта.

const { CLIGHT } = require('./rtcm3');
const { ecefToLlh, ecefToEnu, D2R } = require('./geo');

const MU = 3.986005e14; // гравитационная постоянная Земли, GPS ICD
const OMGE = 7.2921151467e-5; // угловая скорость вращения Земли, рад/с
const WEEK = 604800;
const MAX_DTOE = 7201; // допустимый возраст эфемерид GPS, с
const EL_MASK = 10 * D2R;
const MAX_GDOP = 30;
const MAX_RMS = 15; // м, предел невязок при избыточных измерениях

const F1 = 1575.42e6;
const F2 = 1227.6e6;
const GAMMA = (F1 / F2) ** 2;

// Какой сигнал брать на каждой частоте, в порядке предпочтения
const L1_CODES = ['1C', '1W', '1P', '1X', '1L', '1S'];
const L2_CODES = ['2W', '2L', '2X', '2S', '2P', '2C'];

function wrapWeek(dt) {
  if (dt > WEEK / 2) return dt - WEEK;
  if (dt < -WEEK / 2) return dt + WEEK;
  return dt;
}

function ephemerisUsable(eph, tow) {
  return eph.health === 0 && Math.abs(wrapWeek(tow - eph.toe)) <= MAX_DTOE;
}

// Положение спутника в ECEF и поправка его часов на момент t (секунды недели GPS)
function satelliteState(eph, t) {
  const a = eph.sqrtA * eph.sqrtA;
  const tk = wrapWeek(t - eph.toe);
  const m = eph.m0 + (Math.sqrt(MU / (a * a * a)) + eph.deln) * tk;

  let ek = m;
  for (let i = 0; i < 30; i++) {
    const d = (ek - eph.ecc * Math.sin(ek) - m) / (1 - eph.ecc * Math.cos(ek));
    ek -= d;
    if (Math.abs(d) < 1e-13) break;
  }
  const sinE = Math.sin(ek);
  const cosE = Math.cos(ek);

  let u = Math.atan2(Math.sqrt(1 - eph.ecc * eph.ecc) * sinE, cosE - eph.ecc) + eph.omega;
  let r = a * (1 - eph.ecc * cosE);
  let i = eph.i0 + eph.idot * tk;
  const sin2u = Math.sin(2 * u);
  const cos2u = Math.cos(2 * u);
  u += eph.cus * sin2u + eph.cuc * cos2u;
  r += eph.crs * sin2u + eph.crc * cos2u;
  i += eph.cis * sin2u + eph.cic * cos2u;

  const x = r * Math.cos(u);
  const y = r * Math.sin(u);
  const cosi = Math.cos(i);
  const o = eph.omega0 + (eph.omegaDot - OMGE) * tk - OMGE * eph.toe;
  const sinO = Math.sin(o);
  const cosO = Math.cos(o);

  const tc = wrapWeek(t - eph.toc);
  const clock = eph.af0 + eph.af1 * tc + eph.af2 * tc * tc
    - 2 * Math.sqrt(MU * a) * eph.ecc * sinE / (CLIGHT * CLIGHT); // релятивистская поправка

  return {
    pos: [x * cosO - y * cosi * sinO, x * sinO + y * cosi * cosO, y * Math.sin(i)],
    clock,
  };
}

// Тропосферная задержка, модель Саастамойнена для стандартной атмосферы
function troposphere(lat, h, el) {
  if (h < -100 || h > 1e4 || el <= 0) return 0;
  const hgt = Math.max(h, 0);
  const pres = 1013.25 * (1 - 2.2557e-5 * hgt) ** 5.2568;
  const temp = 15 - 6.5e-3 * hgt + 273.16;
  const e = 6.108 * 0.7 * Math.exp((17.15 * temp - 4684) / (temp - 38.45));
  const cosz = Math.cos(Math.PI / 2 - el);
  const dry = 0.0022768 * pres / (1 - 0.00266 * Math.cos(2 * lat) - 0.00028 * hgt / 1e3) / cosz;
  const wet = 0.002277 * (1255 / temp + 0.05) * e / cosz;
  return dry + wet;
}

// Решение A·x = b методом Гаусса с выбором главного элемента (A — n×n)
function solve(a, b) {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[piv][c])) piv = r;
    if (Math.abs(m[piv][c]) < 1e-12) return null;
    [m[c], m[piv]] = [m[piv], m[c]];
    for (let r = c + 1; r < n; r++) {
      const f = m[r][c] / m[c][c];
      for (let k = c; k <= n; k++) m[r][k] -= f * m[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = m[r][n];
    for (let k = r + 1; k < n; k++) s -= m[r][k] * x[k];
    x[r] = s / m[r][r];
  }
  return x;
}

function pickSignal(signals, codes) {
  for (const code of codes) {
    const s = signals.find((sig) => sig.code === code && sig.pr !== null);
    if (s) return s.pr;
  }
  return null;
}

// Подготовка измерений эпохи: псевдодальность и состояние спутника на момент излучения
function prepare(tow, sats, ephemerides) {
  const all = [];
  for (const sat of sats) {
    const eph = ephemerides.get(sat.prn);
    if (!eph || !ephemerisUsable(eph, tow)) continue;
    const p1 = pickSignal(sat.signals, L1_CODES);
    if (p1 === null) continue;
    all.push({ sat, eph, p1, p2: pickSignal(sat.signals, L2_CODES) });
  }
  // Двухчастотная комбинация убирает ионосферу; берём её, если хватает спутников
  const dual = all.filter((o) => o.p2 !== null);
  const useDual = dual.length >= 4;
  const list = useDual ? dual : all;

  const obs = list.map((o) => {
    const range = useDual ? (GAMMA * o.p1 - o.p2) / (GAMMA - 1) : o.p1;
    let t = tow - range / CLIGHT;
    t -= satelliteState(o.eph, t).clock;
    const state = satelliteState(o.eph, t);
    return {
      label: o.sat.label,
      range,
      pos: state.pos,
      // Бортовые часы привязаны к двухчастотной комбинации; для L1 нужна групповая задержка
      clock: useDual ? state.clock : state.clock - o.eph.tgd,
    };
  });
  return { obs, mode: useDual ? 'dual' : 'single' };
}

function estimate(obs) {
  const x = [0, 0, 0, 0];
  let rows = [];
  for (let iter = 0; iter < 12; iter++) {
    const known = Math.hypot(x[0], x[1], x[2]) > 1e6;
    const llh = known ? ecefToLlh(x[0], x[1], x[2]) : null;
    rows = [];
    for (const o of obs) {
      const d = [o.pos[0] - x[0], o.pos[1] - x[1], o.pos[2] - x[2]];
      const rho = Math.hypot(d[0], d[1], d[2]);
      const e = [d[0] / rho, d[1] / rho, d[2] / rho];
      let el = Math.PI / 2;
      if (known) {
        el = Math.asin(ecefToEnu(llh.lat, llh.lon, e)[2]);
        if (el < EL_MASK) continue;
      }
      const sagnac = OMGE * (o.pos[0] * x[1] - o.pos[1] * x[0]) / CLIGHT;
      const trop = known ? troposphere(llh.lat, llh.h, el) : 0;
      rows.push({
        label: o.label,
        h: [-e[0], -e[1], -e[2], 1],
        v: o.range - (rho + sagnac + x[3] - CLIGHT * o.clock + trop),
        w: known ? Math.sin(el) ** 2 : 1,
      });
    }
    if (rows.length < 4) return { ok: false, reason: 'geometry', rows };

    const n = [0, 1, 2, 3].map(() => [0, 0, 0, 0]);
    const b = [0, 0, 0, 0];
    for (const r of rows) {
      for (let i = 0; i < 4; i++) {
        b[i] += r.h[i] * r.w * r.v;
        for (let j = 0; j < 4; j++) n[i][j] += r.h[i] * r.w * r.h[j];
      }
    }
    const dx = solve(n, b);
    if (!dx) return { ok: false, reason: 'geometry', rows };
    for (let i = 0; i < 4; i++) x[i] += dx[i];

    if (Math.hypot(dx[0], dx[1], dx[2], dx[3]) < 1e-4 && known) {
      // Геометрический фактор по невзвешенной матрице
      const g = [0, 1, 2, 3].map(() => [0, 0, 0, 0]);
      for (const r of rows) for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) g[i][j] += r.h[i] * r.h[j];
      let trace = 0;
      for (let i = 0; i < 4; i++) {
        const col = solve(g, [0, 1, 2, 3].map((k) => (k === i ? 1 : 0)));
        if (!col) return { ok: false, reason: 'geometry', rows };
        trace += col[i];
      }
      const rms = Math.sqrt(rows.reduce((s, r) => s + r.v * r.v, 0) / rows.length);
      return { ok: true, x, rows, gdop: Math.sqrt(trace), rms };
    }
  }
  return { ok: false, reason: 'diverged', rows };
}

// Решение одной эпохи.
// tow — время приёма, секунды недели GPS; sats — спутники GPS из MSM;
// ephemerides — Map «номер спутника → эфемериды из сообщения 1019».
function solveEpoch(tow, sats, ephemerides) {
  let { obs, mode } = prepare(tow, sats, ephemerides);
  const available = obs.length;
  if (available < 4) return { ok: false, reason: 'ephemeris', available };

  // До двух попыток отбросить спутник с наибольшей невязкой
  for (let attempt = 0; attempt < 3; attempt++) {
    const est = estimate(obs);
    if (!est.ok) return { ok: false, reason: est.reason, available };
    if (est.gdop > MAX_GDOP) return { ok: false, reason: 'geometry', available };
    if (est.rows.length === 4 || est.rms <= MAX_RMS) {
      return {
        ok: true,
        ecef: est.x.slice(0, 3),
        mode,
        gdop: est.gdop,
        rms: est.rms,
        satsUsed: est.rows.length,
        used: est.rows.map((r) => r.label),
        available,
      };
    }
    if (est.rows.length < 6) break;
    const worst = est.rows.reduce((a, r) => (Math.abs(r.v) > Math.abs(a.v) ? r : a));
    obs = obs.filter((o) => o.label !== worst.label);
  }
  return { ok: false, reason: 'residuals', available };
}

// Накопление среднего по эпохам с весом 1/GDOP²
class PositionAverager {
  constructor() {
    this.reset();
  }

  reset() {
    this.count = 0;
    this.weight = 0;
    this.mean = [0, 0, 0];
    this.spread = [0, 0, 0];
    this.outliers = 0;
  }

  add(ecef, gdop) {
    // Резкий уход от накопленного среднего: либо выброс, либо станцию переставили
    if (this.count >= 30) {
      const d = Math.hypot(ecef[0] - this.mean[0], ecef[1] - this.mean[1], ecef[2] - this.mean[2]);
      if (d > 100) {
        if (++this.outliers < 30) return false;
        this.reset();
      } else {
        this.outliers = 0;
      }
    }
    const w = 1 / (gdop * gdop);
    this.count++;
    this.weight += w;
    for (let i = 0; i < 3; i++) {
      const d = ecef[i] - this.mean[i];
      this.mean[i] += (w / this.weight) * d;
      this.spread[i] += w * d * (ecef[i] - this.mean[i]);
    }
    return true;
  }

  // Разброс одиночных решений вокруг среднего, м (3D)
  sigma() {
    if (this.count < 2) return null;
    return Math.sqrt((this.spread[0] + this.spread[1] + this.spread[2]) / this.weight);
  }
}

module.exports = { solveEpoch, satelliteState, ephemerisUsable, PositionAverager, troposphere };
