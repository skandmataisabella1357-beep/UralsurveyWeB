'use strict';
// Тесты геометрии подсетей.

const test = require('node:test');
const assert = require('node:assert/strict');
const g = require('../modules/subnets/geometry');
const { llhToEcef } = require('../core/geo');

test('попадание точки в контур', () => {
  const poly = [[56, 60], [58, 60], [58, 63], [56, 63]];
  assert.equal(g.pointInPolygon(57, 61, poly), true);
  assert.equal(g.pointInPolygon(57, 64, poly), false);
  assert.equal(g.pointInPolygon(55.9, 61, poly), false);
  // Вогнутый контур: выемка сверху
  const notch = [[0, 0], [4, 0], [4, 2], [1, 2], [1, 3], [4, 3], [4, 5], [0, 5]];
  assert.equal(g.pointInPolygon(3, 2.5, notch), false);
  assert.equal(g.pointInPolygon(0.5, 2.5, notch), true);
});

test('триангуляция: квадрат с центром даёт восемь сторон', () => {
  const pts = [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }, { x: 1, y: 1 }];
  const edges = g.triangulate(pts).map((e) => e.join('-'));
  assert.equal(edges.length, 8);
  for (const e of ['0-1', '1-2', '2-3', '0-3', '0-4', '1-4', '2-4', '3-4']) assert.ok(edges.includes(e), e);
});

test('триангуляция: вырожденные случаи', () => {
  assert.deepEqual(g.triangulate([]), []);
  assert.deepEqual(g.triangulate([{ x: 0, y: 0 }]), []);
  assert.deepEqual(g.triangulate([{ x: 0, y: 0 }, { x: 1, y: 1 }]), [[0, 1]]);
  assert.deepEqual(g.triangulate([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0.5, y: 1 }]), [[0, 1], [0, 2], [1, 2]]);
  // Три точки на одной прямой соединяются цепочкой
  assert.deepEqual(g.triangulate([{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 0 }]), [[0, 2], [1, 2]]);
});

test('длины сторон подсети считаются по прямой между станциями', () => {
  const D = Math.PI / 180;
  const mk = (lat, lon, h) => ({ lat, lon, ecef: llhToEcef(lat * D, lon * D, h) });
  const sts = [mk(56.84, 60.57, 245), mk(56.98, 60.47, 260), mk(56.70, 60.55, 275)];
  const lines = g.baselines(sts);
  assert.equal(lines.length, 3);
  const ab = lines.find((l) => l.a === 0 && l.b === 1);
  assert.ok(ab.length > 16000 && ab.length < 17500, `длина ${ab.length}`);
});
