'use strict';
// Модуль «VRS»: сообщение RTCM 1030 — остатки сетевого решения по спутникам GPS.
// Им сеть говорит роверу, насколько можно верить поправкам по каждому спутнику: ровер, который
// это сообщение понимает, сам ослабляет вес ненадёжных спутников. Для Galileo и BeiDou такого
// сообщения в стандарте нет (1031 — то же для ГЛОНАСС, которого в VRS нет).
//
// Состав полей — по описанию RTCM 10403 (сообщение 1030): время, номер опорной станции, число
// станций сети, число спутников; по спутнику — номер и пять оценок разброса:
//   soc — геометрическая часть, постоянная, шаг 0,5 мм (до 127 мм);
//   sod — геометрическая, растущая с расстоянием, шаг 0,01 ppm (до 5,11);
//   soh — геометрическая, растущая с перепадом высот, шаг 0,1 ppm (до 5,1);
//   sic — ионосферная постоянная, шаг 0,5 мм (до 511 мм);
//   sid — ионосферная, растущая с расстоянием, шаг 0,01 ppm (до 10,23).

const { BitReader, BitWriter } = require('../../core/bits');

const clamp = (v, max) => Math.max(0, Math.min(max, Math.round(Number.isFinite(v) ? v : 0)));

// sats: [{ prn, soc, sod, soh, sic, sid }] — soc и sic в метрах, остальное в ppm.
// tow — секунды недели GPS, refs — сколько станций участвовало. Возвращает тело без кадра.
function encode({ stationId, tow, refs, sats }) {
  const list = sats.slice(0, 31);
  const w = new BitWriter();
  w.u(12, 1030).u(20, Math.floor(tow) % 604800).u(12, stationId).u(7, clamp(refs, 127)).u(5, list.length);
  for (const s of list) {
    w.u(6, s.prn % 64);
    w.u(8, clamp(s.soc * 2000, 255)).u(9, clamp(s.sod * 100, 511)).u(6, clamp(s.soh * 10, 63));
    w.u(10, clamp(s.sic * 2000, 1023)).u(10, clamp(s.sid * 100, 1023));
  }
  return w.toBuffer();
}

function decode(payload) {
  const r = new BitReader(payload);
  r.skip(12);
  const out = { tow: r.u(20), stationId: r.u(12), refs: r.u(7), sats: [] };
  const n = r.u(5);
  for (let i = 0; i < n; i++) out.sats.push({ prn: r.u(6), soc: r.u(8) / 2000, sod: r.u(9) / 100, soh: r.u(6) / 10, sic: r.u(10) / 2000, sid: r.u(10) / 100 });
  return out;
}

// Копилка ошибок сети по спутникам: самопроверка станций даёт по каждому спутнику, насколько сеть
// ошиблась в ионосфере и в геометрии. Свежее весит больше (половина веса — за halfSec секунд).
class Quality {
  constructor(halfSec = 600) {
    this.half = halfSec;
    this.sats = new Map(); // 'G05' -> { iono2, geo2, at }
  }

  // rows — строки самопроверки одной станции: [{ sat, iono, geo }], метры; t — время, секунды
  add(rows, t) {
    for (const r of rows) {
      const s = this.sats.get(r.sat);
      if (!s) { this.sats.set(r.sat, { iono2: r.iono ** 2, geo2: r.geo ** 2, at: t }); continue; }
      const keep = 0.5 ** (Math.max(0, t - s.at) / this.half) * 0.8;
      s.iono2 = keep * s.iono2 + (1 - keep) * r.iono ** 2;
      s.geo2 = keep * s.geo2 + (1 - keep) * r.geo ** 2;
      s.at = t;
    }
    for (const [sat, s] of this.sats) if (t - s.at > 6 * this.half) this.sats.delete(sat);
  }

  // Оценки для сообщения: по спутнику — из копилки, а нет данных — typical (метры)
  of(sat, typical = { iono: 0.02, geo: 0.015 }) {
    const s = this.sats.get(sat);
    return s ? { iono: Math.sqrt(s.iono2), geo: Math.sqrt(s.geo2), known: true } : { ...typical, known: false };
  }
}

module.exports = { encode, decode, Quality };
