'use strict';
// Тестовая сеть: синтетические базовые станции, раскиданные по Свердловской области,
// и набор неисправностей связи, которые они изображают. Никаких настоящих станций
// и пользователей здесь нет.

const { pointInPolygon } = require('../../modules/subnets/geometry');

// Грубый контур Свердловской области, [широта, долгота]
const REGION = [
  [56.10, 57.40], [56.00, 59.20], [56.10, 60.20], [56.05, 61.20], [56.50, 62.90], [57.00, 64.00],
  [57.70, 65.00], [58.30, 65.90], [59.00, 66.10], [59.60, 65.30], [60.60, 64.80], [61.60, 63.00],
  [61.90, 60.50], [61.50, 59.40], [60.20, 59.50], [59.20, 58.50], [58.30, 58.00], [57.50, 57.90], [57.00, 57.30],
];

// Неисправности. У каждой — что делает станция и чего мы ждём от сервера.
const FAULTS = [
  { kind: 'clean', title: 'исправная', expect: 'всё время на связи' },
  { kind: 'drop', title: 'обрыв раз в минуту', expect: 'сервер ждёт и принимает станцию снова' },
  { kind: 'flap', title: 'частые отлёты', expect: 'станция мигает, остальные не страдают' },
  { kind: 'stall', title: 'молчит, не разрывая связь', expect: 'сторож рвёт зависшее соединение' },
  { kind: 'burst', title: 'данные пачками с задержкой', expect: 'поток идёт, но поправки стареют' },
  { kind: 'fragment', title: 'поток мелкими кусками', expect: 'кадры собираются без потерь' },
  { kind: 'corrupt', title: 'битые кадры', expect: 'битые кадры отброшены, счётчик сбоев растёт' },
  { kind: 'garbage', title: 'мусор между кадрами', expect: 'мусор пропущен, кадры целы' },
  { kind: 'duplicate', title: 'два подключения сразу', expect: 'новое подключение заменяет старое' },
  { kind: 'gaps', title: 'пропуски эпох', expect: 'поток с дырами, станция на связи' },
  { kind: 'fewsats', title: 'мало спутников', expect: 'три спутника GPS вместо полного набора' },
  { kind: 'nopos', title: 'без координат в потоке', expect: 'раздача без 1005: ровер не узнает положение базы' },
  { kind: 'moved', title: 'координаты сменились на ходу', expect: 'положение прыгает на полкилометра' },
  { kind: 'late', title: 'подключается с опозданием', expect: 'появляется через минуту' },
  { kind: 'halfopen', title: 'подключилась и молчит', expect: 'данных нет, сторож рвёт соединение' },
  { kind: 'dead', title: 'не подключается вовсе', expect: 'сервер ждёт на порту' },
];

// Повторяемый генератор случайных чисел: одна и та же сеть при каждом запуске
function random(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// count станций внутри контура области, не ближе minKm друг к другу.
// Исправных — 40 %, остальные делят неисправности поровну.
function makeStations({ count = 50, firstPort = 2110, seed = 2026, minKm = 35 } = {}) {
  const rnd = random(seed);
  const lats = REGION.map((p) => p[0]);
  const lons = REGION.map((p) => p[1]);
  const box = { lat0: Math.min(...lats), lat1: Math.max(...lats), lon0: Math.min(...lons), lon1: Math.max(...lons) };
  const places = [];
  let guard = 0;
  let gap = minKm;
  while (places.length < count) {
    if (++guard % 5000 === 0) gap *= 0.8; // область тесновата — ослабляем расстояние
    const lat = box.lat0 + rnd() * (box.lat1 - box.lat0);
    const lon = box.lon0 + rnd() * (box.lon1 - box.lon0);
    if (!pointInPolygon(lat, lon, REGION)) continue;
    const far = places.every((p) => Math.hypot((p.lat - lat) * 111.2, (p.lon - lon) * 111.2 * Math.cos(lat * Math.PI / 180)) >= gap);
    if (far) places.push({ lat, lon, h: 100 + Math.round(rnd() * 300) });
  }
  const clean = Math.round(count * 0.4);
  const broken = FAULTS.filter((f) => f.kind !== 'clean');
  return places.map((p, i) => ({
    code: `SV${String(i + 1).padStart(2, '0')}`,
    name: `Тестовая ${i + 1}`,
    port: firstPort + i,
    stationId: i + 1,
    lat: Number(p.lat.toFixed(5)),
    lon: Number(p.lon.toFixed(5)),
    h: p.h,
    fault: i < clean ? 'clean' : broken[(i - clean) % broken.length].kind,
  }));
}

// Настройки сервера для этой сети: каждая база шлёт поток на свой порт
function serverConfig(stations, { bind = '127.0.0.1' } = {}) {
  return {
    bind,
    caster: { port: 2101, enabled: true, openAccess: bind === '127.0.0.1' },
    stations: stations.map((s) => ({ code: s.code, name: `${s.name}: ${FAULTS.find((f) => f.kind === s.fault).title}`, source: { mode: 'listen', port: s.port } })),
  };
}

module.exports = { REGION, FAULTS, makeStations, serverConfig, random };
