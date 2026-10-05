'use strict';
// Тест расчёта положений спутников по наблюдениям сети: на выдуманной сети
// с известными спутниками расчёт должен вернуть их направления.

const test = require('node:test');
const assert = require('node:assert/strict');
const { solveDirections, orbitRadius } = require('../modules/skyglobe/netdir');
const { llhToEcef } = require('../core/geo');

const D = Math.PI / 180;

test('радиусы орбит: у BeiDou высокие и средние орбиты различаются', () => {
  assert.equal(orbitRadius('GPS', 5), 26559.7e3);
  assert.equal(orbitRadius('BDS', 3), 42164e3);
  assert.equal(orbitRadius('BDS', 23), 27906e3);
  assert.equal(orbitRadius('SBS', 1), null);
});

test('направления на спутники восстанавливаются по дальностям сети', () => {
  // Одиннадцать станций, как в сети заказчика: размах около 400 км
  const places = [[58.06, 63.69, 70], [56.81, 60.57, 270], [57.35, 61.87, 180], [56.62, 57.77, 220], [56.78, 62.05, 180],
    [56.86, 59.98, 350], [56.51, 60.84, 250], [56.43, 58.56, 250], [56.42, 61.91, 190], [57.09, 61.68, 200], [57.87, 61.79, 120]];
  const ecefs = places.map(([lat, lon, h]) => llhToEcef(lat * D, lon * D, h));

  // Спутники на орбите GPS в разных сторонах неба
  const A = orbitRadius('GPS', 1);
  const truth = [[57, 61], [40, 30], [70, 100], [30, 75], [60, 20], [45, 110], [75, 60], [35, 50]].map(([lat, lon], k) => ({
    label: `G${String(k + 1).padStart(2, '0')}`,
    ecef: [A * Math.cos(lat * D) * Math.cos(lon * D), A * Math.cos(lat * D) * Math.sin(lon * D), A * Math.sin(lat * D)],
    clock: (k - 3) * 40000, // часы спутников расходятся на десятки километров
  }));

  // Дальности с часами станций (до 150 км) и шумом около метра
  let seed = 7;
  const noise = () => { seed = (seed * 16807) % 2147483647; return (seed / 2147483647 - 0.5) * 2; };
  const stations = ecefs.map((ecef, i) => ({
    ecef,
    ranges: new Map(truth.map((s) => [s.label,
      Math.hypot(s.ecef[0] - ecef[0], s.ecef[1] - ecef[1], s.ecef[2] - ecef[2]) + s.clock + i * 15000 + noise()])),
  }));

  const res = solveDirections(stations, () => A);
  assert.ok(res, 'решение получено');
  assert.equal(res.sats.length, truth.length);
  assert.ok(res.rms < 2, `невязка ${res.rms}`);
  for (const s of truth) {
    const got = res.sats.find((x) => x.label === s.label);
    const cos = (got.ecef[0] * s.ecef[0] + got.ecef[1] * s.ecef[1] + got.ecef[2] * s.ecef[2]) / (A * Math.hypot(...got.ecef));
    const angle = Math.acos(Math.min(1, cos)) / D;
    assert.ok(angle < 1.5, `${s.label}: ошибка ${angle.toFixed(2)}°, высота ${got.el.toFixed(1)}°`);
  }
});

test('мало станций — решения нет', () => {
  const st = { ecef: llhToEcef(57 * D, 61 * D, 200), ranges: new Map([['G01', 2.2e7]]) };
  assert.equal(solveDirections([st, st, st], () => 26559.7e3), null);
});
