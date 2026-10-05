'use strict';
// Тесты тестовой сети: состав станций и то, что сервер переживает её неисправности.

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeStations, serverConfig, FAULTS, REGION } = require('../server/testnet/stations');
const { TestBase } = require('../server/testnet/base');
const { pointInPolygon } = require('../modules/subnets/geometry');
const { validate, merge, DEFAULTS } = require('../server/shared/config');
const ingest = require('../server/ingest');

const until = async (check, ms = 12000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > end) throw new Error('не дождались условия');
    await new Promise((r) => setTimeout(r, 50));
  }
};

test('тестовая сеть: 50 баз внутри области, свои порты, сеть повторяется от запуска к запуску', () => {
  const stations = makeStations();
  assert.equal(stations.length, 50);
  assert.deepEqual(stations.map((s) => s.port), Array.from({ length: 50 }, (_, i) => 2110 + i));
  assert.equal(new Set(stations.map((s) => s.code)).size, 50);
  for (const s of stations) assert.ok(pointInPolygon(s.lat, s.lon, REGION), `${s.code} вне области`);
  // Станции не слипаются
  for (let i = 0; i < stations.length; i++) {
    for (let j = i + 1; j < stations.length; j++) {
      const km = Math.hypot((stations[i].lat - stations[j].lat) * 111.2, (stations[i].lon - stations[j].lon) * 111.2 * Math.cos(stations[i].lat * Math.PI / 180));
      assert.ok(km > 15, `${stations[i].code} и ${stations[j].code} в ${km.toFixed(0)} км`);
    }
  }
  assert.deepEqual(makeStations(), stations);
  assert.equal(stations.filter((s) => s.fault === 'clean').length, 20);
  // Каждая неисправность представлена хотя бы одной базой
  for (const f of FAULTS) assert.ok(stations.some((s) => s.fault === f.kind), `нет базы с неисправностью «${f.title}»`);
  // Настройки сервера под эту сеть проходят проверку
  const config = validate(merge(DEFAULTS, serverConfig(stations)));
  assert.equal(config.stations.length, 50);
  assert.equal(config.bind, '127.0.0.1');
});

test('сервер принимает базы с неисправностями: битые кадры и мусор не проходят, станции на связи', async () => {
  const picked = ['clean', 'fragment', 'corrupt', 'garbage', 'nopos', 'fewsats', 'halfopen'];
  const all = makeStations();
  const stations = picked.map((kind, i) => ({ ...all.find((s) => s.fault === kind), port: 0, code: `T${i}` }));
  const config = merge(DEFAULTS, {
    ingest: { busPort: 0, statePort: 0 },
    stations: stations.map((s) => ({ code: s.code, source: { mode: 'listen', port: 0 } })),
  });
  // Порт 0 — «любой свободный»: узнаём настоящие номера у запущенной службы
  const service = await ingest.start({ config, secrets: {}, log: () => {} });
  const bases = [];
  try {
    for (const s of stations) {
      const session = service.hub.sessions.get(s.code);
      const port = await until(() => session.transport.server && session.transport.server.address() && session.transport.server.address().port);
      const base = new TestBase({ station: { ...s, port }, host: '127.0.0.1' });
      bases.push(base);
      base.start();
    }
    const snap = (code) => service.hub.snapshots().find((x) => x.id === code);
    const of = (kind) => snap(stations.find((s) => s.fault === kind).code);
    await until(() => ['clean', 'fragment', 'corrupt', 'garbage', 'nopos', 'fewsats'].every((k) => of(k).link.state === 'online' && of(k).satTotal > 0));

    assert.equal(of('clean').satTotal, 28);
    // Поток кусками приходит не разом: ждём, пока соберутся все четыре системы
    await until(() => of('fragment').satTotal === 28);
    assert.equal(of('fragment').crcErrors, 0);
    assert.equal(of('fewsats').satTotal, 3);
    assert.equal(of('clean').position.source, 'rtcm');
    assert.equal(of('nopos').position, null, 'без 1005/1006 и без эфемерид положение взять неоткуда');
    assert.equal(of('garbage').format.label, 'RTCM 3');
    // Молчащая база подключилась, но данных нет
    assert.equal(of('halfopen').link.bytesTotal, 0);

    // Битые кадры: сервер их считает и не разбирает
    const base = bases.find((b) => b.fault === 'corrupt');
    await until(() => base.stats.corrupted > 0 && of('corrupt').crcErrors > 0, 60000);
    assert.equal(of('corrupt').link.state, 'online');
  } finally {
    bases.forEach((b) => b.stop());
    await service.stop();
  }
});
