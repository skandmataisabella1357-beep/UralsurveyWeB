'use strict';
// Модуль «VRS»: наблюдения спутников из сообщений MSM и обратно.
// В отличие от разбора в ядре (он нужен для карты неба) здесь берётся всё, что требует
// сетевой расчёт: псевдодальность, фаза несущей, счётчик непрерывного слежения, признак
// половины цикла. Сборка MSM4 нужна, чтобы отдать роверу наблюдения виртуальной базы.

const { BitReader, BitWriter } = require('../../core/bits');

const CLIGHT = 299792458.0;
const RANGE_MS = CLIGHT * 0.001;
const WEEK = 604800;
const SYS = ['G', 'R', 'E', 'S', 'J', 'C', 'I'];
const L1 = 1575.42e6; const L2 = 1227.6e6; const L5 = 1176.45e6; const E6 = 1278.75e6; const E5B = 1207.14e6;

// Частоты сигналов, Гц: по номеру сигнала MSM (1..32). У ГЛОНАСС частота зависит от канала.
const FREQ = {
  G: { 2: L1, 3: L1, 4: L1, 8: L2, 9: L2, 10: L2, 15: L2, 16: L2, 17: L2, 22: L5, 23: L5, 24: L5, 30: L1, 31: L1, 32: L1 },
  E: { 2: L1, 3: L1, 4: L1, 5: L1, 6: L1, 8: E6, 9: E6, 10: E6, 11: E6, 12: E6, 14: E5B, 15: E5B, 16: E5B, 18: 1191.795e6, 19: 1191.795e6, 20: 1191.795e6, 22: L5, 23: L5, 24: L5 },
  C: { 2: 1561.098e6, 3: 1561.098e6, 4: 1561.098e6, 8: 1268.52e6, 9: 1268.52e6, 10: 1268.52e6, 14: E5B, 15: E5B, 16: E5B, 22: L5, 23: L5, 24: L5, 25: E5B, 30: L1, 31: L1, 32: L1 },
  J: { 2: L1, 9: E6, 10: E6, 11: E6, 15: L2, 16: L2, 17: L2, 22: L5, 23: L5, 24: L5, 30: L1, 31: L1, 32: L1 },
};
// Обозначения сигналов по RINEX — для подписей в панели
const NAMES = {
  G: { 2: '1C', 3: '1P', 4: '1W', 8: '2C', 9: '2P', 10: '2W', 15: '2S', 16: '2L', 17: '2X', 22: '5I', 23: '5Q', 24: '5X', 30: '1S', 31: '1L', 32: '1X' },
  R: { 2: '1C', 3: '1P', 8: '2C', 9: '2P', 11: '3I', 12: '3Q', 13: '3X' },
  E: { 2: '1C', 3: '1A', 4: '1B', 5: '1X', 6: '1Z', 8: '6C', 9: '6A', 10: '6B', 11: '6X', 12: '6Z', 14: '7I', 15: '7Q', 16: '7X', 18: '8I', 19: '8Q', 20: '8X', 22: '5I', 23: '5Q', 24: '5X' },
  C: { 2: '2I', 3: '2Q', 4: '2X', 8: '6I', 9: '6Q', 10: '6X', 14: '7I', 15: '7Q', 16: '7X', 22: '5D', 23: '5P', 24: '5X', 25: '7D', 30: '1D', 31: '1P', 32: '1X' },
  J: { 2: '1C', 9: '6S', 10: '6L', 11: '6X', 15: '2S', 16: '2L', 17: '2X', 22: '5I', 23: '5Q', 24: '5X', 30: '1S', 31: '1L', 32: '1X' },
};

function frequency(sys, sig, channel = 0) {
  if (sys === 'R') {
    if (sig === 2 || sig === 3) return 1602e6 + channel * 0.5625e6;
    if (sig === 8 || sig === 9) return 1246e6 + channel * 0.4375e6;
    return 0;
  }
  return (FREQ[sys] && FREQ[sys][sig]) || 0;
}

function signalName(sys, sig) {
  return (NAMES[sys] && NAMES[sys][sig]) || `#${sig}`;
}

function isMsm(type) {
  return type >= 1071 && type <= 1137 && type % 10 >= 1 && type % 10 <= 7;
}

// Тело сообщения MSM -> { sys, level, stationId, epoch, multiple, sats: [{ prn, sigs: [{ sig, pr, ph, lock, half, cnr }] }] }
// pr и ph — в метрах (ph — фаза, умноженная на длину волны), null — измерения нет.
function decode(type, payload) {
  const level = type % 10;
  const sys = SYS[Math.floor((type - 1071) / 10)];
  const r = new BitReader(payload);
  r.skip(12);
  const stationId = r.u(12);
  const epoch = r.u(30);
  const multiple = r.u(1) === 1;
  r.skip(3 + 7 + 2 + 2 + 1 + 3);
  const prns = [];
  for (let i = 1; i <= 64; i++) if (r.u(1)) prns.push(i);
  const sigs = [];
  for (let i = 1; i <= 32; i++) if (r.u(1)) sigs.push(i);
  const nsat = prns.length;
  const nsig = sigs.length;
  if (nsat * nsig > 64) throw new RangeError('маска ячеек MSM больше 64 бит');
  const mask = [];
  let ncell = 0;
  for (let i = 0; i < nsat * nsig; i++) { const b = r.u(1); mask.push(b); ncell += b; }

  const rough = new Array(nsat).fill(null);
  const ext = level === 5 || level === 7;
  const ints = [];
  if (level >= 4) for (let i = 0; i < nsat; i++) ints.push(r.u(8));
  if (ext) r.skip(4 * nsat);
  for (let i = 0; i < nsat; i++) {
    const mod = r.u(10);
    if (level < 4) rough[i] = mod / 1024;
    else if (ints[i] !== 255) rough[i] = ints[i] + mod / 1024;
  }
  if (ext) r.skip(14 * nsat);

  const hi = level >= 6;
  const cell = () => new Array(ncell).fill(null);
  const pr = cell(); const ph = cell(); const lock = cell(); const half = cell(); const cnr = cell();
  if (level !== 2) {
    const bits = hi ? 20 : 15;
    for (let k = 0; k < ncell; k++) { const v = r.s(bits); pr[k] = v === -(2 ** (bits - 1)) ? null : v * (hi ? 2 ** -29 : 2 ** -24); }
  }
  if (level !== 1) {
    const bits = hi ? 24 : 22;
    for (let k = 0; k < ncell; k++) { const v = r.s(bits); ph[k] = v === -(2 ** (bits - 1)) ? null : v * (hi ? 2 ** -31 : 2 ** -29); }
    for (let k = 0; k < ncell; k++) lock[k] = r.u(hi ? 10 : 4);
    for (let k = 0; k < ncell; k++) half[k] = r.u(1);
  }
  if (level >= 4) for (let k = 0; k < ncell; k++) { const v = r.u(hi ? 10 : 6); cnr[k] = hi ? v * 0.0625 : v; }

  const sats = [];
  let k = 0;
  for (let i = 0; i < nsat; i++) {
    const list = [];
    for (let j = 0; j < nsig; j++) {
      if (!mask[i * nsig + j]) continue;
      const base = rough[i];
      list.push({
        sig: sigs[j],
        pr: base !== null && pr[k] !== null ? (base + pr[k]) * RANGE_MS : null,
        ph: base !== null && ph[k] !== null ? (base + ph[k]) * RANGE_MS : null,
        lock: lock[k], half: half[k], cnr: cnr[k],
      });
      k++;
    }
    if (list.length) sats.push({ prn: prns[i], sigs: list });
  }
  return { sys, level, stationId, epoch, multiple, sats };
}

// Разница шкал GPS и UTC, секунд. С 2017 года — 18; новая секунда вносится здесь.
function leapSeconds() {
  return 18;
}

// Время приёма в секундах шкалы GPS от её начала (6 января 1980). В сообщении только время
// внутри недели (у ГЛОНАСС — внутри суток по Москве), неделя берётся по приблизительному near.
function epochTime(sys, epoch, near) {
  if (sys === 'R') {
    const tod = (epoch % 2 ** 27) / 1000 - 3 * 3600 + leapSeconds(near);
    const day = Math.floor(near / 86400);
    let best = null;
    for (let d = day - 1; d <= day + 1; d++) {
      const t = d * 86400 + tod;
      if (best === null || Math.abs(t - near) < Math.abs(best - near)) best = t;
    }
    return best;
  }
  const sow = epoch / 1000 + (sys === 'C' ? 14 : 0);
  return Math.round((near - sow) / WEEK) * WEEK + sow;
}

const GPS_EPOCH_MS = Date.UTC(1980, 0, 6);
const gpsFromUnix = (ms) => (ms - GPS_EPOCH_MS) / 1000 + 18;
const unixFromGps = (t) => (t - 18) * 1000 + GPS_EPOCH_MS;

// Поле времени сообщения по времени GPS
function epochField(sys, t) {
  if (sys === 'R') {
    const utc3 = t - leapSeconds(t) + 3 * 3600;
    const days = Math.floor(utc3 / 86400);
    const dow = ((days % 7) + 7) % 7; // 6 января 1980 — воскресенье
    return dow * 2 ** 27 + Math.round((utc3 - days * 86400) * 1000);
  }
  const sow = t - (sys === 'C' ? 14 : 0);
  return Math.round((sow - Math.floor(sow / WEEK) * WEEK) * 1000) % (WEEK * 1000);
}

// Счётчик слежения MSM4 (4 бита) по времени непрерывного слежения в секундах
function lockIndicator(seconds) {
  const ms = seconds * 1000;
  if (ms < 32) return 0;
  return Math.min(15, Math.floor(Math.log2(ms / 32)) + 1);
}

// Сообщение MSM4 одной системы: тело без кадра.
// sats: [{ prn, sigs: [{ sig, pr, ph, lock (секунды), half, cnr }] }], pr и ph в метрах.
// Возвращает null, если отдавать нечего. Больше 64 ячеек формат не вмещает — тогда
// отбрасываются последние сигналы списка.
function encode({ sys, stationId, epoch, multiple, sats }) {
  const type = 1074 + SYS.indexOf(sys) * 10;
  const has = (g) => g.pr !== null || g.ph !== null;
  let list = sats.filter((s) => s.sigs.some(has)).sort((a, b) => a.prn - b.prn);
  if (!list.length) return null;
  let sigIds = [...new Set(list.flatMap((s) => s.sigs.filter(has).map((g) => g.sig)))].sort((a, b) => a - b);
  while (list.length * sigIds.length > 64 && sigIds.length > 2) sigIds = sigIds.slice(0, -1);
  if (list.length * sigIds.length > 64) list = list.slice(0, Math.floor(64 / sigIds.length));
  list = list.filter((s) => s.sigs.some((g) => has(g) && sigIds.includes(g.sig)));
  const w = new BitWriter();
  w.u(12, type).u(12, stationId).u(30, epoch).u(1, multiple ? 1 : 0);
  w.u(3, 0).u(7, 0).u(2, 0).u(2, 0).u(1, 0).u(3, 0);
  for (let i = 1; i <= 64; i++) w.u(1, list.some((s) => s.prn === i) ? 1 : 0);
  for (let i = 1; i <= 32; i++) w.u(1, sigIds.includes(i) ? 1 : 0);
  const cells = [];
  const roughs = [];
  for (const s of list) {
    // Грубая дальность — общая на спутник: от первой псевдодальности, иначе от фазы
    const mine = s.sigs.filter((g) => has(g) && sigIds.includes(g.sig));
    const first = mine.find((g) => g.pr !== null) || mine[0];
    const rough = Math.round(((first.pr !== null ? first.pr : first.ph) / RANGE_MS) * 1024) / 1024;
    roughs.push(rough);
    for (const id of sigIds) {
      const g = mine.find((x) => x.sig === id);
      w.u(1, g ? 1 : 0);
      if (g) cells.push({ rough, g });
    }
  }
  for (const rough of roughs) w.u(8, Math.floor(rough));
  for (const rough of roughs) w.u(10, Math.round((rough - Math.floor(rough)) * 1024));
  const fine = (value, rough, scale, bits) => {
    const none = -(2 ** (bits - 1));
    if (value === null) return none;
    const v = Math.round((value / RANGE_MS - rough) / scale);
    return Math.abs(v) >= 2 ** (bits - 1) ? none : v;
  };
  for (const c of cells) w.s(15, fine(c.g.pr, c.rough, 2 ** -24, 15));
  for (const c of cells) w.s(22, fine(c.g.ph, c.rough, 2 ** -29, 22));
  for (const c of cells) w.u(4, lockIndicator(c.g.lock || 0));
  for (const c of cells) w.u(1, c.g.half ? 1 : 0);
  for (const c of cells) w.u(6, Math.max(0, Math.min(63, Math.round(c.g.cnr || 0))));
  return w.toBuffer();
}

// Сборка эпохи из сообщений MSM одной станции: системы приходят отдельными сообщениями,
// последнее помечено признаком «продолжения нет». push возвращает готовую эпоху или null.
class Assembler {
  constructor() {
    this.t = null;
    this.raw = new Map();
  }

  // near — приблизительное время GPS в секундах (по часам сервера)
  push(type, payload, near) {
    let m;
    try { m = decode(type, payload); } catch (err) { return null; }
    const t = Math.round(epochTime(m.sys, m.epoch, near) * 1000) / 1000;
    let done = null;
    if (this.t !== null && Math.abs(t - this.t) > 1e-3) done = this.flush();
    this.t = t;
    for (const s of m.sats) {
      const sat = m.sys + String(s.prn).padStart(2, '0');
      const sigs = this.raw.get(sat) || new Map();
      for (const g of s.sigs) sigs.set(g.sig, g);
      this.raw.set(sat, sigs);
    }
    if (!m.multiple) return this.flush() || done;
    return done;
  }

  flush() {
    if (this.t === null || !this.raw.size) { this.t = null; return null; }
    const out = { t: this.t, raw: this.raw };
    this.t = null;
    this.raw = new Map();
    return out;
  }
}

module.exports = {
  Assembler,
  CLIGHT, RANGE_MS, WEEK, SYS, isMsm, decode, encode, epochTime, epochField, frequency, signalName, lockIndicator, gpsFromUnix, unixFromGps, leapSeconds,
};
