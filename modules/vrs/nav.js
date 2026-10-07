'use strict';
// Модуль «VRS»: бортовые эфемериды из файла RINEX и положение спутника.
// Системы с кеплеровыми эфемеридами: GPS, Galileo, BeiDou (кроме геостационарных), QZSS.
// Точность метровая — этого достаточно: в сетевом расчёте всё идёт разностями между станциями,
// и ошибка орбиты в 1 м даёт на 50 км меньше 3 мм.

const CLIGHT = 299792458.0;
const WEEK = 604800;
const GPS_EPOCH_MS = Date.UTC(1980, 0, 6);
const CONST = {
  G: { mu: 3.986005e14, omge: 7.2921151467e-5, max: 7200, shift: 0 },
  J: { mu: 3.986005e14, omge: 7.2921151467e-5, max: 7200, shift: 0 },
  E: { mu: 3.986004418e14, omge: 7.2921151467e-5, max: 10800, shift: 0 },
  C: { mu: 3.986004418e14, omge: 7.292115e-5, max: 3900, shift: 14 },
};

const num = (s) => { const v = Number(String(s).trim().replace(/[dD]/, 'e')); return Number.isFinite(v) ? v : 0; };

// Текст файла RINEX 3 или 4 -> Map 'G01' -> [эфемериды по возрастанию времени]
function parse(text, into = new Map()) {
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && !lines[i].includes('END OF HEADER')) i++;
  let kind = '';
  for (i += 1; i < lines.length; i++) {
    const line = lines[i];
    if (line[0] === '>') { kind = line.slice(2, 5) === 'EPH' ? line.slice(10).trim() : 'skip'; continue; }
    if (!/^[A-Z]\d\d /.test(line)) continue;
    const sys = line[0];
    // В RINEX 4 новые виды сообщений (CNAV и подобные) устроены иначе — их пропускаем
    const legacy = !kind || ['LNAV', 'INAV', 'FNAV', 'D1', 'D2'].includes(kind);
    if (!CONST[sys] || !legacy) continue;
    const body = lines.slice(i + 1, i + 8);
    if (body.length < 7) break;
    i += 7;
    const f = [num(line.slice(23, 42)), num(line.slice(42, 61)), num(line.slice(61, 80))];
    for (const row of body) for (let c = 0; c < 4; c++) f.push(num(row.slice(4 + c * 19, 23 + c * 19)));
    const d = line.slice(4, 23).trim().split(/\s+/).map(Number);
    const c = CONST[sys];
    const toc = (Date.UTC(d[0], d[1] - 1, d[2], d[3], d[4], d[5]) - GPS_EPOCH_MS) / 1000 + c.shift;
    const tocSow = (((toc - c.shift) % WEEK) + WEEK) % WEEK;
    let dt = f[11] - tocSow;
    if (dt > WEEK / 2) dt -= WEEK; else if (dt < -WEEK / 2) dt += WEEK;
    const e = {
      sat: line.slice(0, 3), sys, toc, toe: toc + dt, af0: f[0], af1: f[1], af2: f[2],
      crs: f[4], deln: f[5], m0: f[6], cuc: f[7], ecc: f[8], cus: f[9], sqrtA: f[10],
      cic: f[12], omega0: f[13], cis: f[14], i0: f[15], crc: f[16], omega: f[17], omegaDot: f[18], idot: f[19],
      health: f[24], source: f[20],
    };
    if (!(e.sqrtA > 1000)) continue;
    // Геостационарные BeiDou считаются по особым формулам; на Урале они у горизонта — не берём
    if (sys === 'C' && Math.abs(e.i0) < 0.3) continue;
    // Galileo: I/NAV и F/NAV несут одну орбиту; берём I/NAV (бит 9 — часы для E1 и E5b)
    if (sys === 'E' && kind === 'FNAV') continue;
    if (sys === 'E' && !kind && !(Math.round(e.source) & 0x200)) continue;
    const list = into.get(e.sat) || [];
    if (!list.some((x) => x.toe === e.toe && x.toc === e.toc)) list.push(e);
    into.set(e.sat, list);
  }
  for (const list of into.values()) list.sort((a, b) => a.toe - b.toe);
  return into;
}

// Эфемериды спутника на время t (секунды GPS): ближайшие по времени из годных
function pick(nav, sat, t) {
  const list = nav.get(sat);
  if (!list) return null;
  let best = null;
  for (const e of list) {
    if (e.sys !== 'E' && e.health !== 0) continue;
    const d = Math.abs(t - e.toe);
    if (d <= CONST[e.sys].max && (!best || d < Math.abs(t - best.toe))) best = e;
  }
  return best;
}

// Положение спутника в ECEF на время t и уход его часов в секундах
function state(e, t) {
  const c = CONST[e.sys];
  const a = e.sqrtA * e.sqrtA;
  const tk = t - e.toe;
  const m = e.m0 + (Math.sqrt(c.mu / (a * a * a)) + e.deln) * tk;
  let ek = m;
  for (let i = 0; i < 30; i++) {
    const d = (ek - e.ecc * Math.sin(ek) - m) / (1 - e.ecc * Math.cos(ek));
    ek -= d;
    if (Math.abs(d) < 1e-13) break;
  }
  const sinE = Math.sin(ek); const cosE = Math.cos(ek);
  let u = Math.atan2(Math.sqrt(1 - e.ecc * e.ecc) * sinE, cosE - e.ecc) + e.omega;
  let r = a * (1 - e.ecc * cosE);
  let inc = e.i0 + e.idot * tk;
  const s2 = Math.sin(2 * u); const c2 = Math.cos(2 * u);
  u += e.cus * s2 + e.cuc * c2;
  r += e.crs * s2 + e.crc * c2;
  inc += e.cis * s2 + e.cic * c2;
  const x = r * Math.cos(u); const y = r * Math.sin(u);
  // Долгота узла отсчитывается от начала недели своей шкалы времени
  const toeSow = (((e.toe - c.shift) % WEEK) + WEEK) % WEEK;
  const om = e.omega0 + (e.omegaDot - c.omge) * tk - c.omge * toeSow;
  const so = Math.sin(om); const co = Math.cos(om); const ci = Math.cos(inc);
  const dt = t - e.toc;
  const clock = e.af0 + e.af1 * dt + e.af2 * dt * dt - 2 * Math.sqrt(c.mu * a) * e.ecc * sinE / (CLIGHT * CLIGHT);
  return { pos: [x * co - y * ci * so, x * so + y * ci * co, y * Math.sin(inc)], clock };
}

// Геометрия «спутник — приёмник» на время приёма t по часам приёмника (секунды GPS),
// clock — уход часов приёмника в секундах. Возвращает дальность с поправкой на вращение Земли,
// уход часов спутника в метрах и единичный вектор на спутник.
function range(e, t, rcv, clock = 0) {
  const omge = CONST[e.sys].omge;
  let tau = 0.075;
  let s = null;
  for (let i = 0; i < 3; i++) {
    s = state(e, t - clock - tau);
    tau = Math.hypot(s.pos[0] - rcv[0], s.pos[1] - rcv[1], s.pos[2] - rcv[2]) / CLIGHT;
  }
  const th = omge * tau;
  const sx = s.pos[0] * Math.cos(th) + s.pos[1] * Math.sin(th);
  const sy = -s.pos[0] * Math.sin(th) + s.pos[1] * Math.cos(th);
  const dx = sx - rcv[0]; const dy = sy - rcv[1]; const dz = s.pos[2] - rcv[2];
  const rho = Math.hypot(dx, dy, dz);
  return { rho, clock: s.clock * CLIGHT, los: [dx / rho, dy / rho, dz / rho], sat: [sx, sy, s.pos[2]] };
}

module.exports = { parse, pick, state, range, CONST, CLIGHT };
