'use strict';
// Модуль «Расчёт подсети»: сеть векторов.
// Станции связываются взаимными треугольниками (триангуляция Делоне), считаются все стороны,
// а не одна цепочка. Лишние векторы дают контроль: треугольник из трёх векторов обязан замкнуться,
// а уравнивание по наименьшим квадратам показывает, какой вектор выбивается.

const { ecefToLlh, R2D } = require('../../core/geo');
const geometry = require('../subnets/geometry');

const key = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

// Стороны сети по приближённым координатам станций: [{ a, b, length }], length в метрах.
// Очень длинные стороны по краю сети (длиннее 2,5 медианы) убираются, если сеть без них не рвётся.
function edges(positions) {
  const codes = Object.keys(positions).sort();
  if (codes.length < 2) return [];
  const stations = codes.map((code) => {
    const g = ecefToLlh(...positions[code]);
    return { code, lat: g.lat * R2D, lon: g.lon * R2D, ecef: positions[code] };
  });
  let list = geometry.baselines(stations).map((e) => ({ a: codes[e.a], b: codes[e.b], length: e.length }));
  const sorted = list.map((e) => e.length).sort((x, y) => x - y);
  const limit = sorted[Math.floor(sorted.length / 2)] * 2.5;
  for (const long of list.filter((e) => e.length > limit).sort((x, y) => y.length - x.length)) {
    const rest = list.filter((e) => e !== long);
    if (connected(codes, rest)) list = rest;
  }
  return list;
}

function connected(codes, list) {
  const seen = new Set([codes[0]]);
  const queue = [codes[0]];
  while (queue.length) {
    const cur = queue.pop();
    for (const e of list) {
      const next = e.a === cur ? e.b : (e.b === cur ? e.a : null);
      if (next && !seen.has(next)) { seen.add(next); queue.push(next); }
    }
  }
  return seen.size === codes.length;
}

// Порядок расчёта: сначала дерево от опорной станции (кратчайшими сторонами), затем остальные
// стороны. Каждая сторона получает направление: from — конец, координаты которого уже известны.
function order(reference, list) {
  const reached = new Set([reference]);
  const tree = [];
  const left = new Set(list);
  for (;;) {
    let best = null;
    for (const e of left) {
      const inA = reached.has(e.a);
      const inB = reached.has(e.b);
      if (inA !== inB && (!best || e.length < best.e.length)) best = { e, from: inA ? e.a : e.b, to: inA ? e.b : e.a };
    }
    if (!best) break;
    reached.add(best.to);
    left.delete(best.e);
    tree.push({ from: best.from, to: best.to, length: best.e.length });
  }
  // Оставшиеся стороны: оба конца достижимы; станции вне сети (не связаны с опорной) пропускаются
  const extra = [...left].filter((e) => reached.has(e.a) && reached.has(e.b)).map((e) => ({ from: e.a, to: e.b, length: e.length }));
  return { tree, extra };
}

// Решение системы N·x = b методом Гаусса с выбором главного элемента. Возвращает обратную матрицу.
function invert(N) {
  const n = N.length;
  const A = N.map((row, i) => [...row, ...row.map((_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-12) return null;
    [A[c], A[p]] = [A[p], A[c]];
    const d = A[c][c];
    for (let j = c; j < 2 * n; j++) A[c][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === c || !A[r][c]) continue;
      const f = A[r][c];
      for (let j = c; j < 2 * n; j++) A[r][j] -= f * A[c][j];
    }
  }
  return A.map((row) => row.slice(n));
}

// Уравнивание сети. reference и ecef — опорная станция и её координаты (не меняются).
// vectors: [{ from, to, d: [dx, dy, dz], sigma }] — вектор от from к to и его оценка точности (м).
// Возвращает { coords: { КОД: [x, y, z] }, sd: { КОД: [sx, sy, sz] }, residuals: [м по каждому вектору], sigma0 }.
function adjust(reference, ecef, vectors) {
  const codes = [...new Set(vectors.flatMap((v) => [v.from, v.to]))].filter((c) => c !== reference).sort();
  const index = new Map(codes.map((c, i) => [c, i]));
  const n = codes.length;
  if (!n) return { coords: { [reference]: ecef }, sd: {}, residuals: [], sigma0: null };
  const N = Array.from({ length: n }, () => new Array(n).fill(0));
  const rhs = [0, 1, 2].map(() => new Array(n).fill(0));
  for (const v of vectors) {
    const w = 1 / (v.sigma * v.sigma);
    const i = index.get(v.to);
    const j = index.get(v.from);
    // Уравнение: X(to) − X(from) = d
    if (i !== undefined) N[i][i] += w;
    if (j !== undefined) N[j][j] += w;
    if (i !== undefined && j !== undefined) { N[i][j] -= w; N[j][i] -= w; }
    for (let k = 0; k < 3; k++) {
      const known = (i === undefined ? -ecef[k] : 0) + (j === undefined ? ecef[k] : 0);
      if (i !== undefined) rhs[k][i] += w * (v.d[k] + known);
      if (j !== undefined) rhs[k][j] -= w * (v.d[k] + known);
    }
  }
  const Q = invert(N);
  if (!Q) return null; // сеть не связана с опорной станцией
  const coords = { [reference]: ecef };
  codes.forEach((c, i) => { coords[c] = [0, 1, 2].map((k) => Q[i].reduce((sum, q, j) => sum + q * rhs[k][j], 0)); });
  const residuals = vectors.map((v) => Math.hypot(...[0, 1, 2].map((k) => coords[v.to][k] - coords[v.from][k] - v.d[k])));
  const spare = vectors.length - n;
  // Ошибка единицы веса: около 1 — оценки точности векторов правдивы, больше — занижены
  const sigma0 = spare > 0 ? Math.sqrt(vectors.reduce((sum, v, i) => sum + (residuals[i] / v.sigma) ** 2, 0) / (3 * spare)) : null;
  const scale = sigma0 && sigma0 > 1 ? sigma0 : 1;
  const sd = {};
  codes.forEach((c, i) => { const s = Math.sqrt(Math.max(Q[i][i], 0)) * scale; sd[c] = [s, s, s]; });
  return { coords, sd, residuals, sigma0 };
}

// Незамыкания треугольников: сумма трёх векторов по кругу должна быть нулём.
// Возвращает { triangles: [{ codes, closure }], worst: { 'A|B': наибольшее незамыкание с этим вектором } }.
function closures(vectors) {
  const by = new Map();
  for (const v of vectors) by.set(key(v.from, v.to), v);
  const d = (a, b) => { const v = by.get(key(a, b)); return v.from === a ? v.d : v.d.map((x) => -x); };
  const codes = [...new Set(vectors.flatMap((v) => [v.from, v.to]))].sort();
  const triangles = [];
  const worst = {};
  for (let i = 0; i < codes.length; i++) {
    for (let j = i + 1; j < codes.length; j++) {
      if (!by.has(key(codes[i], codes[j]))) continue;
      for (let k = j + 1; k < codes.length; k++) {
        if (!by.has(key(codes[j], codes[k])) || !by.has(key(codes[i], codes[k]))) continue;
        const [a, b, c] = [codes[i], codes[j], codes[k]];
        const sum = [0, 1, 2].map((x) => d(a, b)[x] + d(b, c)[x] + d(c, a)[x]);
        const closure = Math.hypot(...sum);
        triangles.push({ codes: [a, b, c], closure });
        for (const e of [key(a, b), key(b, c), key(a, c)]) worst[e] = Math.max(worst[e] || 0, closure);
      }
    }
  }
  return { triangles, worst };
}

module.exports = { edges, order, adjust, closures, key };
