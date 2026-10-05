'use strict';
// Тесты работы служб по справочнику из базы: точки и логины меняются на ходу,
// сеансы и отказы уходят в журнал, станции приёма заводятся и убираются без перезапуска.
// Вместо службы управления — маленький сервер, который отдаёт справочник и копит события.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const { BusServer } = require('../server/shared/bus');
const { merge, DEFAULTS } = require('../server/shared/config');
const { getJson } = require('../server/shared/http');
const caster = require('../server/caster');
const ingest = require('../server/ingest');
const rtcm = require('../server/rtcm/messages');
const sim = require('../core/simulator');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (check, ms = 6000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > end) throw new Error('не дождались условия');
    await wait(25);
  }
};

// Поддельная служба управления: справочник можно менять, события складываются в список
async function control(initial) {
  const state = { directory: initial, events: [], alive: null, key: 'test-key', down: false };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (state.down || req.headers['x-ural-key'] !== state.key) {
        res.writeHead(404).end();
        return;
      }
      if (req.url === '/internal/directory') {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(state.directory));
      } else if (req.url === '/internal/events') {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        state.events.push(...body.events);
        state.alive = body.alive;
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"recorded":0}');
      } else {
        res.writeHead(404).end();
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.url = `http://127.0.0.1:${server.address().port}`;
  state.close = () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
  return state;
}

function rover(port, path, user, password) {
  const socket = net.connect({ port, host: '127.0.0.1' });
  const c = { socket, data: Buffer.alloc(0), closed: false };
  socket.on('error', () => {});
  socket.on('close', () => { c.closed = true; });
  socket.on('data', (d) => { c.data = Buffer.concat([c.data, d]); });
  socket.on('connect', () => socket.write(`GET /${path} HTTP/1.0\r\nUser-Agent: NTRIP Imitator\r\nAuthorization: Basic ${Buffer.from(`${user}:${password}`).toString('base64')}\r\n\r\n`));
  c.status = () => c.data.toString('latin1').split('\r\n')[0];
  c.end = () => socket.destroy();
  return c;
}

const dir = (extra = {}) => ({
  stations: [{ code: 'REFT', name: 'Reft', source: { mode: 'listen', port: 1 } }, { code: 'EKB2', name: 'Ekb', source: { mode: 'listen', port: 2 } }],
  mountpoints: [{ name: 'REFT', station: 'REFT', stationId: null, listed: true, enabled: true, access: null },
    { name: 'RAW', station: 'REFT', stationId: null, listed: false, enabled: true, access: ['staff'] }],
  users: {
    geo01: { password: 'p1', maxSessions: 1, onLimit: 'evict', active: true, mountpoints: ['REFT'], expires: '2099-01-01T00:00:00+05:00' },
    staff: { password: 'p2', maxSessions: 2, onLimit: 'evict', active: true, mountpoints: ['REFT', 'RAW'] },
    lapsed: { password: 'p3', maxSessions: 1, onLimit: 'evict', active: true, mountpoints: [], expires: '2000-01-01' },
  },
  rules: { stationLostMs: 30000 },
  ...extra,
});

test('раздача по справочнику из базы: права, изменения на ходу, журнал сеансов', async () => {
  const ctl = await control(dir());
  const bus = new BusServer({ port: 0 });
  const busPort = await bus.ready;
  const config = merge(DEFAULTS, { ingest: { busPort }, caster: { statePort: 0, port: 0, enabled: true }, stations: [] });
  const service = await caster.start({ config, secrets: {}, log: () => {}, directoryUrl: ctl.url, directoryKey: ctl.key });
  const port = service.ports.ntrip;
  const position = rtcm.encodePosition({ stationId: 1, ecef: [1647585.2585, 3057841.8377, 5331652.6642] });
  const obs = sim.encodeMsm4({ type: 1074, stationId: 1, epoch: 1000, multiple: false, sats: [{ prn: 3, rangeMs: 70.2, signals: [{ id: 2, cnr: 45 }] }] });
  const pump = setInterval(() => bus.publish({ t: 'data', station: 'REFT' }, Buffer.concat([position, obs])), 100);
  try {
    await until(() => service.points.size === 2 && service.feeds.get('REFT') && service.feeds.get('REFT').lastAt > 0);

    // Права из справочника: обычный логин — свои точки, служебный — и служебную, истёкшая подписка — отказ
    const a = rover(port, 'REFT', 'geo01', 'p1');
    await until(() => a.data.length > 20);
    assert.equal(a.status(), 'ICY 200 OK');
    for (const [path, user, pass, code] of [['RAW', 'geo01', 'p1', 403], ['REFT', 'lapsed', 'p3', 403], ['REFT', 'geo01', 'wrong', 401]]) {
      const c = rover(port, path, user, pass);
      await until(() => c.closed);
      assert.match(c.status(), new RegExp(` ${code} `), `${user} на ${path}`);
    }
    const s = rover(port, 'RAW', 'staff', 'p2');
    await until(() => s.data.length > 20);
    assert.equal(s.status(), 'ICY 200 OK');

    // Журнал: открытия и отказы дошли до службы управления, сеансы числятся живыми
    await service.flush();
    const kinds = (t) => ctl.events.filter((e) => e.t === t);
    assert.deepEqual(kinds('open').map((e) => [e.login, e.point, e.station]), [['geo01', 'REFT', 'REFT'], ['staff', 'RAW', 'REFT']]);
    assert.deepEqual(kinds('refusal').map((e) => `${e.code} ${e.reason}`),
      ['403 точка не входит в подписку', '403 подписка истекла', '401 неверный логин или пароль']);
    assert.equal(ctl.alive.length, 2);
    assert.match(ctl.alive[0], /^[0-9a-z]+-\d+$/, 'номер сеанса не повторится после перезапуска службы');

    // Администратор закрыл сеанс
    const state = await getJson(`http://127.0.0.1:${service.ports.state}/state`);
    const mine = state.clients.find((c) => c.login === 'staff');
    const kicked = await fetch(`http://127.0.0.1:${service.ports.state}/kick`, { method: 'POST', body: JSON.stringify({ id: mine.id, reason: 'закрыт администратором root' }) });
    assert.deepEqual(await kicked.json(), { closed: true, login: 'staff' });
    await until(() => s.closed);
    const again = await fetch(`http://127.0.0.1:${service.ports.state}/kick`, { method: 'POST', body: JSON.stringify({ id: mine.id }) });
    assert.equal((await again.json()).closed, false);

    // Смена пароля в базе закрывает открытый сеанс логина; новый пароль работает
    ctl.directory = dir({ users: { ...dir().users, geo01: { ...dir().users.geo01, password: 'new-pass' } } });
    await until(() => a.closed, 8000);
    const b = rover(port, 'REFT', 'geo01', 'new-pass');
    await until(() => b.data.length > 20);
    assert.equal(b.status(), 'ICY 200 OK');

    // Точку удалили: её сеанс закрыт, новое подключение получает таблицу источников
    ctl.directory = dir({ users: ctl.directory.users, mountpoints: [dir().mountpoints[1]] });
    await until(() => b.closed, 8000);
    const gone = rover(port, 'REFT', 'geo01', 'new-pass');
    await until(() => gone.closed);
    assert.equal(gone.status(), 'SOURCETABLE 200 OK');

    await service.flush();
    const reasons = kinds('close').map((e) => e.reason);
    for (const r of ['закрыт администратором root', 'сменён пароль логина', 'точка подключения удалена']) assert.ok(reasons.includes(r), `нет закрытия «${r}»`);
    assert.ok(kinds('close').every((e) => e.bytes > 0));

    // Служба управления недоступна: раздача работает по последней копии, события ждут
    ctl.down = true;
    const before = ctl.events.length;
    const c = rover(port, 'RAW', 'staff', 'p2');
    await until(() => c.data.length > 20);
    assert.equal(c.status(), 'ICY 200 OK');
    await service.flush();
    assert.equal(ctl.events.length, before);
    ctl.down = false;
    await service.flush();
    assert.ok(ctl.events.slice(before).some((e) => e.t === 'open' && e.login === 'staff'), 'событие дошло, когда управление вернулось');
    c.end();
  } finally {
    clearInterval(pump);
    await service.stop();
    await bus.close();
    await ctl.close();
  }
});

test('приём по справочнику из базы: станции заводятся, меняются и убираются на ходу', async () => {
  const ecef = [1647585.2585, 3057841.8377, 5331652.6642];
  const one = { code: 'SIM1', name: 'Первая', source: { mode: 'sim', ecef, stationId: 901 } };
  const two = { code: 'GATE', name: 'Со шлюзом', source: { mode: 'listen', port: 0, allow: ['127.0.0.1'], stationPassword: 'pw' } };
  const ctl = await control({ stations: [one], mountpoints: [], users: {}, rules: {} });
  const config = merge(DEFAULTS, { ingest: { busPort: 0, statePort: 0 }, stations: [] });
  const service = await ingest.start({ config, secrets: {}, log: () => {}, directoryUrl: ctl.url, directoryKey: ctl.key });
  const snap = (code) => service.hub.snapshots().find((s) => s.id === code);
  try {
    await until(() => snap('SIM1') && snap('SIM1').link.state === 'online' && snap('SIM1').position);
    // Имитатор встал туда, где станция записана в базе
    assert.ok(Math.abs(snap('SIM1').position.ecef[0] - ecef[0]) < 1);
    const session = service.hub.sessions.get('SIM1');

    // Добавили станцию со шлюзом: первая продолжает работать без перезапуска
    ctl.directory = { ...ctl.directory, stations: [one, two] };
    await until(() => service.gates.has('GATE'), 8000);
    assert.equal(service.hub.sessions.get('SIM1'), session, 'неизменённая станция не перезапускалась');
    assert.equal(service.gates.get('GATE').snapshot().protectedByPassword, true);
    assert.equal(service.gates.get('GATE').snapshot().protectedByAddress, true);

    // Изменили первую и убрали вторую
    ctl.directory = { ...ctl.directory, stations: [{ ...one, name: 'Переименована' }] };
    await until(() => !service.gates.has('GATE') && snap('SIM1') && snap('SIM1').name === 'Переименована', 8000);
    assert.notEqual(service.hub.sessions.get('SIM1'), session, 'изменённая станция перезапущена');
    assert.equal(service.hub.snapshots().length, 1);

    // Убрали все
    ctl.directory = { ...ctl.directory, stations: [] };
    await until(() => service.hub.snapshots().length === 0, 8000);
  } finally {
    await service.stop();
    await ctl.close();
  }
});
