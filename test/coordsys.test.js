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

const layers = require('../modules/layers/parse');

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
  // Зоны шестиградусные: граница первой и второй — 63°03′, осевой второй — 66°03′
  assert.equal(cs.convert('msk66', llhToEcef(58.0 * D2R, 63.0 * D2R, 60)).zone, 1);
  const second = cs.convert('msk66', llhToEcef(58.0 * D2R, 66.05 * D2R, 60));
  assert.equal(second.zone, 2);
  assert.ok(Math.abs(second.east - 2500000) < 200, String(second.east)); // на осевом меридиане восток ≈ 2 500 000
  assert.equal(second.verified, false);
  assert.equal(cs.convert('msk66', llhToEcef(58.0 * D2R, 65.0 * D2R, 60)).zone, 2);
});


test('МСК-66, зона 1: совпадение с каталогом заказчика', () => {
  // Координаты станции REFT из её потока (сообщение 1005) и её строка каталога в МСК-66
  const p = cs.convert('msk66', [1647585.2585, 3057841.8377, 5331652.6642]);
  assert.equal(p.zone, 1);
  assert.ok(Math.abs(p.east - 1599130.417) < 0.002, `восток ${p.east}`);
  assert.ok(Math.abs(p.north - 420391.321) < 0.002, `север ${p.north}`);
});

test('обратный пересчёт: плоские МСК-66 возвращаются в ту же широту и долготу', () => {
  // Туда и обратно по области: расхождение — миллиметры (1e-7° ≈ 1 см): высота при обратном ходе неизвестна
  for (const [lat, lon, h] of [[56.8389, 60.6057, 270], [57.0923, 61.6840, 190], [59.6, 57.4, 150], [56.1, 62.9, 120], [58.0, 66.05, 60], [57.5, 64.0, 100]]) {
    const flat = cs.convert('msk66', llhToEcef(lat * D2R, lon * D2R, h));
    const back = cs.inverse('msk66', flat.north, flat.east, flat.zone);
    // Высота при обратном ходе неизвестна и принята нулевой: в плане это меньше миллиметра
    assert.ok(Math.abs(back.lat - lat) < 2e-7 && Math.abs(back.lon - lon) < 2e-7, `${lat} ${lon} -> ${back.lat} ${back.lon}`);
  }
  assert.equal(cs.inverse('msk66', 385000, 1530000, 9), null);
  assert.equal(cs.inverse('нет такой', 1, 2, 1), null);
});

test('слои: контуры и линии из KML', () => {
  const kml = `<?xml version="1.0"?><kml><Document>
    <Placemark><name>Участок 1</name><Polygon><outerBoundaryIs><LinearRing><coordinates>
      60.5,56.8,0 60.7,56.8,0 60.7,56.9,0 60.5,56.9,0 60.5,56.8,0
    </coordinates></LinearRing></outerBoundaryIs><innerBoundaryIs><LinearRing><coordinates>60.55,56.82 60.6,56.82 60.6,56.85 60.55,56.82</coordinates></LinearRing></innerBoundaryIs></Polygon></Placemark>
    <Placemark><name><![CDATA[Трасса]]></name><LineString><coordinates>60.1,56.5 60.2,56.6 60.3,56.7</coordinates></LineString></Placemark>
    <Placemark><name>Точка</name><Point><coordinates>60,56</coordinates></Point></Placemark>
  </Document></kml>`;
  const got = layers.parseKml(kml);
  assert.deepEqual([got.polygons, got.lines, got.points], [1, 1, 7]);
  // Контур: внешняя граница, без повтора первой точки; широта идёт первой
  assert.deepEqual(got.features[0], { kind: 'polygon', name: 'Участок 1', points: [[56.8, 60.5], [56.8, 60.7], [56.9, 60.7], [56.9, 60.5]] });
  assert.deepEqual([got.features[1].kind, got.features[1].name, got.features[1].points.length], ['line', 'Трасса', 3]);
  assert.deepEqual(layers.parseKml('<kml></kml>').features, []);
});

test('слои: полилинии и отрезки из DXF, пересчёт из МСК-66', () => {
  const entity = (...pairs) => pairs.map(([c, v]) => `${c}\n${v}`).join('\n');
  // Квадрат 2×2 км в МСК-66 (зона 1) полилинией нового вида, отрезок и полилиния старого вида с вершинами
  const dxf = [entity([0, 'SECTION'], [2, 'HEADER'], [9, '$ACADVER'], [1, 'AC1015'], [0, 'ENDSEC']),
    entity([0, 'SECTION'], [2, 'ENTITIES']),
    entity([0, 'LWPOLYLINE'], [8, 'Граница'], [90, 4], [70, 1], [10, 1530000], [20, 385000], [10, 1532000], [20, 385000], [10, 1532000], [20, 387000], [10, 1530000], [20, 387000]),
    entity([0, 'LINE'], [8, 'Ось'], [10, 1530000], [20, 385000], [11, 1532000], [21, 387000]),
    entity([0, 'POLYLINE'], [8, 'Старая'], [66, 1], [70, 0], [0, 'VERTEX'], [8, 'Старая'], [10, 1530500], [20, 385500], [0, 'VERTEX'], [8, 'Старая'], [10, 1531500], [20, 386500], [0, 'SEQEND']),
    entity([0, 'CIRCLE'], [8, 'Лишнее'], [10, 1531000], [20, 386000], [40, 50]),
    entity([0, 'ENDSEC'], [0, 'EOF'])].join('\n');
  const toLatLon = (x, y) => { const g = cs.inverse('msk66', y, x, 1); return [g.lat, g.lon]; };
  const got = layers.parseDxf(dxf, toLatLon);
  assert.deepEqual([got.polygons, got.lines], [1, 2]);
  assert.deepEqual(got.features.map((f) => [f.kind, f.name, f.points.length]), [['polygon', 'Граница', 4], ['line', 'Ось', 2], ['line', 'Старая', 2]]);
  // Юго-западный угол квадрата возвращается в те же плоские координаты
  const [lat, lon] = got.features[0].points[0];
  const back = cs.convert('msk66', llhToEcef(lat * D2R, lon * D2R, 0));
  assert.ok(Math.abs(back.east - 1530000) < 0.2 && Math.abs(back.north - 385000) < 0.2, `${back.east} ${back.north}`);
  // Не та система координат: объекты не попадают на карту и отбрасываются
  assert.deepEqual(layers.parseDxf(dxf, (x, y) => [y, x]).features, []);
  // Точка внутри контура и снаружи
  const ring = got.features[0].points;
  assert.equal(layers.inside(lat + 0.005, lon + 0.01, [ring]), true);
  assert.equal(layers.inside(lat - 0.005, lon + 0.01, [ring]), false);
});
