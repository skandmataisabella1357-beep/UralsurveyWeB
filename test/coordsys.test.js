'use strict';
// Тесты модуля «Системы координат». Расчёт сверяется с независимыми формулами,
// а не с каталогом: параметры МСК-66 официально не подтверждены.

const test = require('node:test');
const assert = require('node:assert/strict');
const cs = require('../modules/coordsys/coordsys');
const { llhToEcef } = require('../core/geo');

const D2R = Math.PI / 180;
const KRASS = cs.ELLIPSOIDS.krass;

// Длина дуги меридиана от экватора — численным интегрированием
function meridianArc(lat, { a, f }) {
  const e2 = f * (2 - f);
  const steps = 20000;
  const h = lat / steps;
  const m = (b) => a * (1 - e2) / (1 - e2 * Math.sin(b) ** 2) ** 1.5;
  let sum = m(0) + m(lat);
  for (let i = 1; i < steps; i++) sum += m(i * h) * (i % 2 ? 4 : 2);
  return sum * h / 3;
}

// Классические формулы Гаусса — Крюгера рядом по степеням разности долгот
function classicGk(lat, l, ell) {
  const { a, f } = ell;
  const e2 = f * (2 - f);
  const ep2 = e2 / (1 - e2);
  const s = Math.sin(lat);
  const c = Math.cos(lat);
  const t = Math.tan(lat);
  const eta2 = ep2 * c * c;
  const N = a / Math.sqrt(1 - e2 * s * s);
  const north = meridianArc(lat, ell) + N * s * c * (l ** 2 / 2
    + l ** 4 * c * c * (5 - t * t + 9 * eta2 + 4 * eta2 * eta2) / 24
    + l ** 6 * c ** 4 * (61 - 58 * t * t + t ** 4 + 270 * eta2 - 330 * eta2 * t * t) / 720
    + l ** 8 * c ** 6 * (1385 - 3111 * t * t + 543 * t ** 4 - t ** 6) / 40320);
  const east = N * c * (l
    + l ** 3 * c * c * (1 - t * t + eta2) / 6
    + l ** 5 * c ** 4 * (5 - 18 * t * t + t ** 4 + 14 * eta2 - 58 * eta2 * t * t) / 120
    + l ** 7 * c ** 6 * (61 - 479 * t * t + 179 * t ** 4 - t ** 6) / 5040);
  return { north, east };
}

test('проекция Гаусса — Крюгера совпадает с классическими формулами', () => {
  for (const latDeg of [50, 56.84, 59.6]) {
    for (const dLonDeg of [0, 0.5, -1.2, 2.9]) {
      const a = cs.gaussKruger(latDeg * D2R, dLonDeg * D2R, KRASS);
      const b = classicGk(latDeg * D2R, dLonDeg * D2R, KRASS);
      assert.ok(Math.abs(a.north - b.north) < 0.002, `север ${latDeg} ${dLonDeg}: ${a.north - b.north}`);
      assert.ok(Math.abs(a.east - b.east) < 0.002, `восток ${latDeg} ${dLonDeg}: ${a.east - b.east}`);
    }
  }
});

test('переход на эллипсоид Красовского: сдвиг на Урале — десятки метров, на оси зоны восток равен смещению', () => {
  const wgs = llhToEcef(56.84 * D2R, 60.6 * D2R, 250);
  const local = cs.fromWgs84(wgs, cs.DATUMS.sk42);
  const shift = Math.hypot(local[0] - wgs[0], local[1] - wgs[1], local[2] - wgs[2]);
  assert.ok(shift > 100 && shift < 200, `сдвиг ${shift}`);

  // Точка на осевом меридиане зоны в системе Красовского даёт восток ровно 1 500 000
  const g = cs.toGeodetic(local, KRASS);
  const p = cs.gaussKruger(g.lat, 0, KRASS);
  assert.ok(Math.abs(p.east) < 1e-6);
  assert.ok(Math.abs(p.north - meridianArc(g.lat, KRASS)) < 0.002);
});

test('МСК-66: Екатеринбург попадает в зону 1 с ожидаемыми порядками координат', () => {
  const p = cs.convert('msk66', llhToEcef(56.8389 * D2R, 60.6057 * D2R, 270));
  assert.equal(p.zone, 1);
  assert.ok(p.north > 385000 && p.north < 395000, `север ${p.north}`);
  assert.ok(p.east > 1530000 && p.east < 1540000, `восток ${p.east}`);
  // Зона выбирается сама: дальний восток области уходит во вторую
  assert.equal(cs.convert('msk66', llhToEcef(57.09 * D2R, 61.68 * D2R, 190)).zone, 1);
  assert.equal(cs.convert('msk66', llhToEcef(58.0 * D2R, 65.0 * D2R, 60)).zone, 2);
});


test('МСК-66, зона 1: совпадение с каталогом заказчика', () => {
  // Координаты станции REFT из её потока (сообщение 1005) и её строка каталога в МСК-66
  const p = cs.convert('msk66', [1647585.2585, 3057841.8377, 5331652.6642]);
  assert.equal(p.zone, 1);
  assert.ok(Math.abs(p.east - 1599130.417) < 0.002, `восток ${p.east}`);
  assert.ok(Math.abs(p.north - 420391.321) < 0.002, `север ${p.north}`);
});
