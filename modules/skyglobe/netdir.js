'use strict';
// Где находятся спутники — по одним наблюдениям сети, без эфемерид.
//
// Каждая станция меряет дальность до спутника. Координаты станций известны, поэтому
// разности дальностей между станциями показывают, с какой стороны пришёл сигнал.
// Расстояние до спутника из таких измерений не найти — берём известный радиус орбиты
// его системы. Часы станций и спутников — неизвестные, они находятся вместе с направлениями.
//
// Точность — для картинки на шаре: направление приближённое, не для расчётов.

const C = 299792458;

// Радиусы орбит от центра Земли, метры
const ORBIT = { GPS: 26559.7e3, GLO: 25508e3, GAL: 29600.3e3, BDS: 27906e3, QZS: 42164e3 };
// У BeiDou часть спутников на высоких орбитах (геостационарные и наклонные)
const BDS_HIGH = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 13, 16, 38, 39, 40, 59, 60, 61, 62, 63]);

// Дальность до навигационного спутника с Земли — от 19 до 45 тысяч километров.
// Всё остальное — сбойное значение в потоке, одно такое портит решение целиком.
function plausible(pr) {
  return Number.isFinite(pr) && pr > 1.5e7 && pr < 5e7;
}

function orbitRadius(sys, prn) {
  if (sys === 'BDS' && BDS_HIGH.has(prn)) return 42164e3;
  return ORBIT[sys] || null;
}

// stations: [{ ecef: [x, y, z], ranges: Map(метка спутника -> дальность, м) }]
// radiusOf(метка) -> радиус орбиты. Возвращает { sats: [{ label, ecef, az, el, stations }], rms }
// или null, если данных мало.
function solveDirections(stations, radiusOf, options = {}) {
  const minStations = options.minStations || 5;
  const R = stations.length;
  if (R < minStations) return null;

  // Местная система в центре сети: ось «вверх» — от центра Земли
  const r0 = [0, 1, 2].map((k) => stations.reduce((s, st) => s + st.ecef[k], 0) / R);
  const R0 = Math.hypot(...r0);
  const up = r0.map((v) => v / R0);
  let east = [-up[1], up[0], 0];
  const en = Math.hypot(...east);
  east = east.map((v) => v / en);
  const north = [
    up[1] * east[2] - up[2] * east[1],
    up[2] * east[0] - up[0] * east[2],
    up[0] * east[1] - up[1] * east[0],
  ];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const d = stations.map((st) => {
    const v = st.ecef.map((x, k) => x - r0[k]);
    return [dot(v, east), dot(v, north), dot(v, up)];
  });

  // Спутники, которые видит достаточно станций
  const seen = new Map();
  stations.forEach((st) => {
    for (const [label, pr] of st.ranges) if (plausible(pr)) seen.set(label, (seen.get(label) || 0) + 1);
  });
  const labels = [...seen.keys()].filter((l) => seen.get(l) >= minStations && radiusOf(l)).sort();
  const S = labels.length;
  if (!S) return null;
  const radius = labels.map(radiusOf);
  let obs = []; // { s, i, pr }
  labels.forEach((label, s) => {
    stations.forEach((st, i) => {
      const pr = st.ranges.get(label);
      if (plausible(pr)) obs.push({ s, i, pr });
    });
  });

  // Неизвестные: на спутник a, b (восточная и северная части единичного вектора) и сдвиг o;
  // на станцию — поправка часов c (у первой станции она принята за ноль)
  const n = 3 * S + (R - 1);
  const x = new Float64Array(n);
  const position = (s, a, b) => {
    const u = Math.sqrt(Math.max(1e-6, 1 - a * a - b * b));
    const D = -R0 * u + Math.sqrt((R0 * u) ** 2 + radius[s] ** 2 - R0 * R0);
    return [D * a, D * b, D * u];
  };
  const range = (s, i, a, b) => {
    const X = position(s, a, b);
    return Math.hypot(X[0] - d[i][0], X[1] - d[i][1], X[2] - d[i][2]);
  };
  const model = (o) => range(o.s, o.i, x[3 * o.s], x[3 * o.s + 1]) + x[3 * o.s + 2] + (o.i ? x[3 * S + o.i - 1] : 0);

  // Начало: все спутники в зените, сдвиги — по средней невязке
  for (let s = 0; s < S; s++) {
    const mine = obs.filter((o) => o.s === s);
    x[3 * s + 2] = mine.reduce((sum, o) => sum + o.pr - range(s, o.i, 0, 0), 0) / mine.length;
  }
  for (let i = 1; i < R; i++) {
    const mine = obs.filter((o) => o.i === i);
    if (mine.length) x[3 * S + i - 1] = mine.reduce((sum, o) => sum + o.pr - model(o), 0) / mine.length;
  }

  let rms = Infinity;
  for (let attempt = 0; attempt < 6; attempt++) {
  for (let iter = 0; iter < 30; iter++) {
    const N = Array.from({ length: n }, () => new Float64Array(n + 1));
    let sum = 0;
    for (const o of obs) {
      const f0 = model(o);
      const res = o.pr - f0;
      sum += res * res;
      const ia = 3 * o.s;
      const h = 1e-6;
      const ja = (range(o.s, o.i, x[ia] + h, x[ia + 1]) - range(o.s, o.i, x[ia], x[ia + 1])) / h;
      const jb = (range(o.s, o.i, x[ia], x[ia + 1] + h) - range(o.s, o.i, x[ia], x[ia + 1])) / h;
      const idx = [ia, ia + 1, ia + 2];
      const J = [ja, jb, 1];
      if (o.i) { idx.push(3 * S + o.i - 1); J.push(1); }
      for (let p = 0; p < idx.length; p++) {
        N[idx[p]][n] += J[p] * res;
        for (let q = 0; q < idx.length; q++) N[idx[p]][idx[q]] += J[p] * J[q];
      }
    }
    rms = Math.sqrt(sum / obs.length);
    for (let k = 0; k < n; k++) N[k][k] = N[k][k] * (1 + 1e-9) + 1e-12;

    // Решаем систему методом Гаусса с выбором ведущего элемента
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(N[r][c]) > Math.abs(N[p][c])) p = r;
      if (Math.abs(N[p][c]) < 1e-18) return null;
      [N[c], N[p]] = [N[p], N[c]];
      for (let r = c + 1; r < n; r++) {
        const f = N[r][c] / N[c][c];
        if (f) for (let k = c; k <= n; k++) N[r][k] -= f * N[c][k];
      }
    }
    const dx = new Float64Array(n);
    for (let c = n - 1; c >= 0; c--) {
      let v = N[c][n];
      for (let k = c + 1; k < n; k++) v -= N[c][k] * dx[k];
      dx[c] = v / N[c][c];
    }

    let step = 0;
    for (let k = 0; k < n; k++) {
      const direction = k < 3 * S && k % 3 !== 2;
      const dk = direction ? Math.max(-0.3, Math.min(0.3, dx[k])) : dx[k];
      x[k] += dk;
      if (direction) step = Math.max(step, Math.abs(dk));
    }
    // Спутник не может уйти под горизонт сети
    for (let s = 0; s < S; s++) {
      const hlen = Math.hypot(x[3 * s], x[3 * s + 1]);
      if (hlen > 0.999) { x[3 * s] *= 0.999 / hlen; x[3 * s + 1] *= 0.999 / hlen; }
    }
    if (step < 1e-7) break;
  }
    // Грубые промахи: убираем самое плохое измерение и подгоняем заново
    if (!(rms > 30)) break;
    let worst = -1;
    let worstRes = 0;
    obs.forEach((o, k) => {
      const res = Math.abs(o.pr - model(o));
      if (res > worstRes) { worstRes = res; worst = k; }
    });
    if (worst === -1 || obs.length <= n + 4) break;
    obs = obs.filter((o, k) => k !== worst);
  }
  if (!Number.isFinite(rms) || rms > 200) return null;

  const sats = labels.map((label, s) => {
    const a = x[3 * s];
    const b = x[3 * s + 1];
    const X = position(s, a, b);
    return {
      label,
      ecef: [0, 1, 2].map((k) => r0[k] + X[0] * east[k] + X[1] * north[k] + X[2] * up[k]),
      az: (Math.atan2(a, b) * 180 / Math.PI + 360) % 360,
      el: Math.asin(Math.sqrt(Math.max(0, 1 - a * a - b * b))) * 180 / Math.PI,
      stations: seen.get(label),
    };
  });
  return { sats, rms, center: r0 };
}

module.exports = { solveDirections, orbitRadius, C };
