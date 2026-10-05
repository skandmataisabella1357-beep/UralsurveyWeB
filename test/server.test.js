'use strict';
// Тесты каркаса сервера: шина между службами, настройки, три службы вместе на имитаторе станции.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { encode, Decoder, BusServer, BusClient } = require('../server/shared/bus');
const { validate, merge, credentials, loadConfig, DEFAULTS } = require('../server/shared/config');
const { getJson } = require('../server/shared/http');
const ingest = require('../server/ingest');
const caster = require('../server/caster');
const control = require('../server/control');

const until = async (check, ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error('не дождались условия');
    await new Promise((r) => setTimeout(r, 50));
  }
};

test('шина: сообщения собираются из любых кусков потока', () => {
  const a = encode({ t: 'data', station: 'A' }, Buffer.from([1, 2, 3]));
  const b = encode({ t: 'stations', stations: [] });
  const c = encode({ t: 'data', station: 'Б' }, Buffer.alloc(5000, 7));
  const all = Buffer.concat([a, b, c]);
  const decoder = new Decoder();
  const got = [];
  for (let i = 0; i < all.length; i += 7) got.push(...decoder.push(all.subarray(i, i + 7)));
  assert.equal(got.length, 3);
  assert.deepEqual(got[0].header, { t: 'data', station: 'A' });
  assert.deepEqual([...got[0].body], [1, 2, 3]);
  assert.equal(got[1].body.length, 0);
  assert.equal(got[2].header.station, 'Б');
  assert.equal(got[2].body.length, 5000);
  assert.throws(() => new Decoder().push(Buffer.from([0xff, 0xff, 0xff, 0xff, 0, 0])), /повреждённое/);
});

test('шина: потребитель получает сообщения и сам возвращается после обрыва', async () => {
  const server = new BusServer({ port: 0 });
  const port = await server.ready;
  const client = new BusClient({ port, retryMs: 50 });
  const got = [];
  client.on('message', (header, body) => got.push([header.n, body.toString()]));
  client.start();
  try {
    await until(() => server.clients.size === 1);
    server.publish({ n: 1 }, Buffer.from('раз'));
    await until(() => got.length === 1);
    for (const socket of server.clients) socket.destroy();
    // Сначала потребитель должен заметить обрыв, затем — вернуться сам
    await until(() => !client.connected);
    await until(() => server.clients.size === 1 && client.connected);
    server.publish({ n: 2 }, Buffer.from('два'));
    await until(() => got.length === 2);
    assert.deepEqual(got, [[1, 'раз'], [2, 'два']]);
  } finally {
    client.stop();
    await server.close();
  }
});

test('настройки: проверка объясняет, что не так', () => {
  const ok = (stations) => validate(merge(DEFAULTS, { stations }));
  ok([{ code: 'REFT', source: { mode: 'ntrip', host: 'h', port: 2101, mountpoint: 'REFT_MSM4', credentials: 'c' } }]);
  assert.throws(() => ok([{ code: 'плохой код', source: { mode: 'sim', lat: 1, lon: 1 } }]), /код станции/);
  assert.throws(() => ok([{ code: 'A', source: { mode: 'ntrip', host: 'h', port: 2101 } }]), /точка подключения/);
  assert.throws(() => ok([{ code: 'A', source: { mode: 'tcp', port: 1 } }]), /адрес/);
  assert.throws(() => ok([{ code: 'A', source: { mode: 'sim', lat: 1, lon: 1 } }, { code: 'A', source: { mode: 'sim', lat: 1, lon: 1 } }]), /повторяется/);
  assert.throws(() => validate(merge(DEFAULTS, { control: { port: 70000 } })), /порт/);
  // Службы по умолчанию слушают только свою машину
  assert.equal(DEFAULTS.bind, '127.0.0.1');
  assert.equal(DEFAULTS.caster.enabled, false);
});

test('настройки: пароли берутся из отдельного файла по имени записи', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uralsurvey-'));
  try {
    const file = path.join(dir, 'config.json');
    const secrets = path.join(dir, 'secrets.json');
    fs.writeFileSync(file, JSON.stringify({ control: { port: 9000 }, stations: [] }));
    fs.writeFileSync(secrets, JSON.stringify({ credentials: { main: { username: 'u', password: 'p' } } }));
    const loaded = loadConfig({ file, secrets });
    assert.equal(loaded.usingExample, false);
    assert.equal(loaded.config.control.port, 9000);
    assert.equal(loaded.config.ingest.busPort, DEFAULTS.ingest.busPort);
    assert.deepEqual(credentials(loaded.secrets, 'main'), { username: 'u', password: 'p' });
    assert.deepEqual(credentials(loaded.secrets, undefined), { username: '', password: '' });
    assert.throws(() => credentials(loaded.secrets, 'нет-такой'), /secrets\.json/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('три службы вместе: поток имитатора доходит от приёма до раздачи и виден в сводке', async () => {
  const config = merge(DEFAULTS, {
    ingest: { busPort: 0, statePort: 0 },
    caster: { statePort: 0 },
    control: { port: 0 },
    stations: [{ code: 'SIM1', name: 'Имитатор', source: { mode: 'sim', lat: 56.84, lon: 60.6, h: 270, stationId: 901 } }],
  });
  const quiet = () => {};
  const a = await ingest.start({ config, secrets: {}, log: quiet });
  config.ingest.busPort = a.ports.bus;
  config.ingest.statePort = a.ports.state;
  const b = await caster.start({ config, log: quiet });
  config.caster.statePort = b.ports.state;
  const c = await control.start({ config, log: quiet, usingExample: true });
  const base = `http://127.0.0.1:${c.ports.web}`;
  try {
    const state = await until(async () => {
      const s = await getJson(`${base}/api/state`);
      const st = s && s.stations[0];
      return st && st.link.state === 'online' && st.satTotal > 0 && st.feed && st.feed.bytes > 0 ? s : null;
    });
    assert.equal(state.services.ingest.up, true);
    assert.equal(state.services.ingest.consumers, 1);
    assert.equal(state.services.caster.ingestLink, true);
    // Раздача роверам не открыта, пока NTRIP не написан
    assert.equal(state.services.caster.listening, false);
    assert.equal(state.usingExample, true);
    assert.equal(state.stations[0].id, 'SIM1');
    assert.equal(state.stations[0].format.label, 'RTCM 3');

    // Страница и общий визуал отдаются, чужие файлы — нет
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Uralsurvey — сервер/);
    assert.equal((await fetch(`${base}/ui/styles.css`)).status, 200);
    assert.equal((await fetch(`${base}/ui/..%2F..%2Fpackage.json`)).status, 404);
    assert.equal((await fetch(`${base}/..%2Fconfig.example.json`)).status, 404);

    // Управление пережило остановку раздачи: сводка отвечает и говорит, что служба не работает
    await b.stop();
    const after = await getJson(`${base}/api/state`);
    assert.equal(after.services.caster.up, false);
    assert.equal(after.services.ingest.up, true);
  } finally {
    await c.stop();
    await b.stop().catch(() => {});
    await a.stop();
  }
});
