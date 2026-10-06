'use strict';
// Тесты раздачи NTRIP: каждая строка таблицы ответов и каждое правило сеанса из ТЗ.
// Вместо службы приёма здесь своя шина: тест сам решает, что и когда «пришло со станции».
// Клиенты — имитатор ровера, настоящих пользователей в тестах нет.

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const { BusServer } = require('../server/shared/bus');
const { merge, DEFAULTS } = require('../server/shared/config');
const { getJson } = require('../server/shared/http');
const caster = require('../server/caster');
const ntrip = require('../server/caster/ntrip');
const rtcm = require('../server/rtcm/messages');
const sim = require('../core/simulator');
const { StreamParser } = require('../core/stream');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (check, ms = 5000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > end) throw new Error('не дождались условия');
    await wait(20);
  }
};

// Кадры «станции»: координаты, оборудование, наблюдения
const POSITION = rtcm.encodePosition({ stationId: 6, ecef: [1499264.8225, 3031597.7404, 5389560.6973] });
const RECEIVER = rtcm.encodeDescriptor({ type: 1033, stationId: 6, receiver: 'TRIMBLE BD970', firmware: '5.37', receiverSerial: 'X1' });
const BIASES = rtcm.encodeGlonassBiases({ stationId: 6, aligned: 0, biases: {} });
const obs = (epoch, sats = [{ prn: 3, rangeMs: 70.2, signals: [{ id: 2, cnr: 45 }] }, { prn: 9, rangeMs: 75.9, signals: [{ id: 2, cnr: 41 }] }]) => sim.encodeMsm4({ type: 1074, stationId: 6, epoch, multiple: false, sats });
const EPHEMERIS = rtcm.frame(Buffer.concat([Buffer.from([0x3f, 0xb0]), Buffer.alloc(59)])); // сообщение 1019
const types = (buf) => new StreamParser().push(buf).filter((f) => f.kind === 'rtcm').map((f) => f.type);

// Имитатор ровера: запрос, затем всё, что пришло в ответ
function rover(port, { path = '/TOUR', user, password, version = 1, raw, gga, read = true } = {}) {
  const socket = net.connect({ port, host: '127.0.0.1' });
  const client = { socket, data: Buffer.alloc(0), closed: false };
  socket.on('error', () => {});
  socket.on('close', () => { client.closed = true; });
  socket.on('connect', () => {
    if (raw !== undefined) { if (raw) socket.write(raw); return; }
    const lines = [`GET ${path} HTTP/1.${version === 2 ? 1 : 0}`, 'User-Agent: NTRIP ImitatorRover/1.0'];
    if (version === 2) lines.push('Host: 127.0.0.1', 'Ntrip-Version: Ntrip/2.0');
    if (user !== undefined) lines.push(`Authorization: Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`);
    if (gga) lines.push(`Ntrip-GGA: ${gga}`);
    socket.write(`${lines.join('\r\n')}\r\n\r\n`);
  });
  if (read) socket.on('data', (d) => { client.data = Buffer.concat([client.data, d]); });
  else socket.pause();
  client.text = () => client.data.toString('latin1');
  client.status = () => client.text().split('\r\n')[0];
  // Тело ответа после заголовков; для версии 2 — со снятой нарезкой на порции
  client.body = () => {
    const i = client.data.indexOf('\r\n\r\n');
    if (i === -1) return Buffer.alloc(0);
    let rest = client.data.subarray(i + 4);
    if (!/chunked/i.test(client.data.toString('latin1', 0, i))) return rest;
    const parts = [];
    for (;;) {
      const eol = rest.indexOf('\r\n');
      if (eol === -1) break;
      const size = parseInt(rest.toString('latin1', 0, eol), 16);
      if (!Number.isFinite(size) || rest.length < eol + 2 + size + 2) break;
      parts.push(rest.subarray(eol + 2, eol + 2 + size));
      rest = rest.subarray(eol + 2 + size + 2);
    }
    return Buffer.concat(parts);
  };
  client.end = () => socket.destroy();
  return client;
}

// Стенд: шина вместо приёма, служба раздачи с тестовыми логинами
async function bench({ rules, casterConfig = {}, mountpoints, users, bind } = {}) {
  const bus = new BusServer({ port: 0 });
  const busPort = await bus.ready;
  const config = merge(DEFAULTS, {
    ...(bind ? { bind } : {}),
    ingest: { busPort },
    caster: { statePort: 0, port: 0, enabled: true, ...casterConfig },
    stations: [{ code: 'TOUR', name: 'Turinsk', source: { mode: 'listen', port: 1 } }, { code: 'DEAD', name: 'Silent', source: { mode: 'listen', port: 2 } }],
    mountpoints: mountpoints || [
      { name: 'TOUR', station: 'TOUR' },
      { name: 'TOUR_19', station: 'TOUR', stationId: 19 },
      { name: 'HIDDEN', station: 'TOUR', listed: false },
      { name: 'OFF', station: 'TOUR', enabled: false },
      { name: 'DEAD', station: 'DEAD' },
      { name: 'STAFF', station: 'TOUR', access: ['staff'] },
    ],
  });
  const secrets = {
    users: users || {
      ivan: { password: 'pass-ivan' },
      two: { password: 'p2', maxSessions: 2 },
      strict: { password: 'p3', onLimit: 'refuse' },
      paused: { password: 'p4', active: false },
      expired: { password: 'p5', expires: '2020-01-01' },
      narrow: { password: 'p6', mountpoints: ['TOUR_19'] },
      staff: { password: 'p7' },
    },
  };
  const service = await caster.start({ config, secrets, log: () => {}, rules });
  await until(() => bus.clients.size === 1);
  const feed = (station, ...frames) => bus.publish({ t: 'data', station }, Buffer.concat(frames));
  feed('TOUR', POSITION, RECEIVER, BIASES, obs(1000));
  await until(() => service.feeds.get('TOUR') && service.feeds.get('TOUR').lastAt > 0);
  return {
    port: service.ports.ntrip,
    service,
    feed,
    state: () => getJson(`http://127.0.0.1:${service.ports.state}/state`),
    async stop() {
      await service.stop();
      await bus.close();
    },
  };
}

test('протокол: разбор запроса и строки GGA', () => {
  const v1 = ntrip.parseRequest(Buffer.from('GET /REFT_MSM4 HTTP/1.0\r\nUser-Agent: NTRIP X\r\nAuthorization: Basic aXZhbjpwYXNz\r\n\r\n$GPGGA'));
  assert.deepEqual([v1.path, v1.version, v1.user, v1.password, v1.agent, v1.rest.toString()], ['REFT_MSM4', 1, 'ivan', 'pass', 'NTRIP X', '$GPGGA']);
  const v2 = ntrip.parseRequest(Buffer.from('GET http://host:2101/EKB2 HTTP/1.1\r\nNtrip-Version: Ntrip/2.0\r\n\r\n'));
  assert.deepEqual([v2.path, v2.version, v2.hasAuth], ['EKB2', 2, false]);
  assert.equal(ntrip.parseRequest(Buffer.from('GET / HTTP/1.0\r\n\r\n')).path, '');
  assert.equal(ntrip.parseRequest(Buffer.from('GET /X HTTP/1.0\r\n')).pending, true);
  assert.ok(ntrip.parseRequest(Buffer.from('POST /X HTTP/1.0\r\n\r\n')).invalid);
  assert.ok(ntrip.parseRequest(Buffer.alloc(5000, 65)).invalid);

  const g = ntrip.parseGga('$GPGGA,092750.000,5651.1234,N,06036.5678,E,4,14,0.8,270.5,M,-6.4,M,1.2,0006*65');
  assert.equal(g.kind, 'fixed');
  assert.ok(Math.abs(g.lat - 56.852057) < 1e-6 && Math.abs(g.lon - 60.609463) < 1e-6);
  assert.equal(g.sats, 14);
  assert.equal(g.age, 1.2);
  assert.equal(ntrip.parseGga('$GPGGA,092750.000,5651.1234,N,06036.5678,E,4,14,0.8,270.5,M,-6.4,M,1.2,0006*00'), null, 'неверная контрольная сумма');
  assert.equal(ntrip.parseGga('$GPGGA,092750.000,,,,,0,00,,,M,,M,,*71'), null, 'нулевое решение');
});

test('доступ разрешён: версия 1 и версия 2 получают служебные сообщения, затем наблюдения', async () => {
  const b = await bench();
  try {
    const a = rover(b.port, { user: 'ivan', password: 'pass-ivan' });
    await until(() => a.body().length > 0);
    assert.equal(a.status(), 'ICY 200 OK');
    assert.deepEqual(types(a.body()), [1005, 1033, 1230], 'сразу после ответа — координаты базы, оборудование, задержки');

    const c = rover(b.port, { user: 'two', password: 'p2', version: 2 });
    await until(() => c.body().length > 0);
    assert.equal(c.status(), 'HTTP/1.1 200 OK');
    assert.match(c.text(), /Ntrip-Version: Ntrip\/2\.0\r\n/);
    assert.match(c.text(), /Content-Type: gnss\/data\r\n/);
    assert.match(c.text(), /Transfer-Encoding: chunked\r\n/);

    const frame = obs(2000);
    b.feed('TOUR', frame);
    await until(() => types(a.body()).length === 4 && types(c.body()).length === 4);
    // Наблюдения дошли байт в байт в обеих версиях
    assert.ok(a.body().subarray(a.body().length - frame.length).equals(frame));
    assert.ok(c.body().subarray(c.body().length - frame.length).equals(frame));
    const state = await b.state();
    assert.equal(state.sessions, 2);
    assert.deepEqual(state.clients.map((s) => [s.login, s.point, s.version]).sort(), [['ivan', 'TOUR', 1], ['two', 'TOUR', 2]]);
    assert.equal(state.clients[0].agent, 'NTRIP ImitatorRover/1.0');
    a.end();
    c.end();
  } finally {
    await b.stop();
  }
});

test('подготовка потока: эфемериды, пустые наблюдения и битые кадры пользователю не идут', async () => {
  const b = await bench();
  try {
    const a = rover(b.port, { user: 'ivan', password: 'pass-ivan' });
    await until(() => a.body().length > 0);
    const before = a.body().length;
    const broken = Buffer.from(obs(3000));
    broken[10] ^= 0xff; // повреждён в пути: контрольная сумма не сойдётся
    const good = obs(4000);
    b.feed('TOUR', EPHEMERIS, obs(3500, []), broken, good);
    await until(() => a.body().length > before);
    await wait(100);
    assert.ok(a.body().subarray(before).equals(good), 'дошёл только исправный кадр наблюдений');
    a.end();
  } finally {
    await b.stop();
  }
});

test('номер станции на точке: меняется только он, наблюдения те же', async () => {
  const b = await bench();
  try {
    const a = rover(b.port, { path: '/TOUR_19', user: 'ivan', password: 'pass-ivan' });
    const plain = rover(b.port, { path: '/TOUR', user: 'two', password: 'p2' });
    await until(() => a.body().length > 0 && plain.body().length > 0);
    const frame = obs(5000);
    b.feed('TOUR', frame);
    await until(() => types(a.body()).length === 4 && types(plain.body()).length === 4);
    const got = new StreamParser().push(a.body()).filter((f) => f.kind === 'rtcm');
    assert.deepEqual(got.map((f) => rtcm.frameStationId(rtcm.frame(f.payload))), [19, 19, 19, 19]);
    assert.deepEqual(rtcm.decodePosition(got[0].payload).ecef, [1499264.8225, 3031597.7404, 5389560.6973]);
    const mine = a.body().subarray(a.body().length - frame.length);
    const diff = [];
    for (let i = 0; i < frame.length; i++) if (mine[i] !== frame[i]) diff.push(i);
    assert.ok(diff.length > 0 && diff.every((i) => i === 4 || i === 5 || i >= frame.length - 3));
    // Обычная точка той же станции отдаёт кадр как пришёл
    assert.ok(plain.body().subarray(plain.body().length - frame.length).equals(frame));
    a.end();
    plain.end();
  } finally {
    await b.stop();
  }
});

test('таблица источников: только живые и видимые точки, обе версии', async () => {
  const b = await bench();
  try {
    const v1 = rover(b.port, { path: '/' });
    const v2 = rover(b.port, { path: '/', version: 2 });
    await until(() => v1.closed && v2.closed);
    assert.equal(v1.status(), 'SOURCETABLE 200 OK');
    assert.equal(v2.status(), 'HTTP/1.1 200 OK');
    assert.match(v2.text(), /Content-Type: gnss\/sourcetable\r\n/);
    for (const c of [v1, v2]) {
      const table = c.body().toString('latin1');
      const names = table.split('\r\n').filter((l) => l.startsWith('STR;')).map((l) => l.split(';')[1]);
      assert.deepEqual(names.sort(), ['STAFF', 'TOUR', 'TOUR_19'], 'скрытая, выключенная и молчащая точки в таблицу не попали');
      const row = table.split('\r\n').find((l) => l.startsWith('STR;TOUR;')).split(';');
      assert.equal(row[3], 'RTCM 3.2');
      assert.match(row[4], /1005\(\d+\),1033\(\d+\),1074\(\d+\),1230\(\d+\)/);
      assert.equal(row[6], 'GPS');
      assert.deepEqual([row[9], row[10], row[11]], ['58.06', '63.69', '0']);
      assert.equal(row[13], 'TRIMBLE BD970');
      assert.match(table, /^CAS;/);
      assert.match(table, /ENDSOURCETABLE\r\n$/);
      assert.equal(Number(/Content-Length: (\d+)/.exec(c.text())[1]), c.body().length);
    }
    // Скрытая точка работает, хотя в списке её нет
    const h = rover(b.port, { path: '/HIDDEN', user: 'ivan', password: 'pass-ivan' });
    await until(() => h.body().length > 0);
    assert.equal(h.status(), 'ICY 200 OK');
    h.end();
  } finally {
    await b.stop();
  }
});

test('отказы: каждая строка таблицы ответов', async () => {
  const b = await bench();
  try {
    const ask = async (options) => {
      const c = rover(b.port, options);
      await until(() => c.closed);
      return c;
    };
    // Такой точки нет: версия 1 получает таблицу источников, версия 2 — 404
    assert.equal((await ask({ path: '/NOPE', user: 'ivan', password: 'pass-ivan' })).status(), 'SOURCETABLE 200 OK');
    assert.equal((await ask({ path: '/NOPE', user: 'ivan', password: 'pass-ivan', version: 2 })).status(), 'HTTP/1.1 404 Not Found');
    assert.equal((await ask({ path: '/OFF', user: 'ivan', password: 'pass-ivan', version: 2 })).status(), 'HTTP/1.1 404 Not Found', 'выключенная точка отвечает как несуществующая');
    // Неверный логин или пароль
    assert.equal((await ask({ user: 'ivan', password: 'wrong' })).status(), 'HTTP/1.0 401 Unauthorized');
    const v2 = await ask({ user: 'nobody', password: 'x', version: 2 });
    assert.equal(v2.status(), 'HTTP/1.1 401 Unauthorized');
    assert.match(v2.text(), /WWW-Authenticate: Basic/);
    assert.equal((await ask({})).status(), 'HTTP/1.0 401 Unauthorized', 'запрос без логина');
    // Приостановлена, истекла, точка не входит в подписку
    assert.equal((await ask({ user: 'paused', password: 'p4' })).status(), 'HTTP/1.0 403 Forbidden');
    assert.equal((await ask({ user: 'expired', password: 'p5', version: 2 })).status(), 'HTTP/1.1 403 Forbidden');
    assert.equal((await ask({ user: 'narrow', password: 'p6' })).status(), 'HTTP/1.0 403 Forbidden');
    assert.equal((await ask({ path: '/STAFF', user: 'ivan', password: 'pass-ivan' })).status(), 'HTTP/1.0 403 Forbidden', 'служебная точка закрыта обычному логину');
    // Станция не на связи
    assert.equal((await ask({ path: '/DEAD', user: 'ivan', password: 'pass-ivan' })).status(), 'HTTP/1.0 503 Service Unavailable');
    assert.equal((await ask({ path: '/DEAD', user: 'ivan', password: 'pass-ivan', version: 2 })).status(), 'HTTP/1.1 503 Service Unavailable');

    // Причина каждого отказа записана для администратора
    const reasons = (await b.state()).refusals.map((r) => `${r.code} ${r.reason}`);
    for (const text of ['404 такой точки нет', '401 неверный логин или пароль', '403 учётная запись приостановлена', '403 подписка истекла', '403 точка не входит в подписку', '503 станция не на связи']) {
      assert.ok(reasons.includes(text), `нет записи «${text}»`);
    }
    // Служебный логин на служебную точку проходит
    const staff = rover(b.port, { path: '/STAFF', user: 'staff', password: 'p7' });
    await until(() => staff.body().length > 0);
    assert.equal(staff.status(), 'ICY 200 OK');
    staff.end();
  } finally {
    await b.stop();
  }
});

test('одновременные сеансы: вытеснение по умолчанию, отказ 409 по настройке логина', async () => {
  const b = await bench();
  try {
    const first = rover(b.port, { user: 'ivan', password: 'pass-ivan' });
    await until(() => first.body().length > 0);
    const second = rover(b.port, { user: 'ivan', password: 'pass-ivan' });
    await until(() => second.body().length > 0 && first.closed);
    assert.equal(second.status(), 'ICY 200 OK');
    assert.equal((await b.state()).sessions, 1, 'старый сеанс вытеснен новым');

    const s1 = rover(b.port, { user: 'strict', password: 'p3' });
    await until(() => s1.body().length > 0);
    const s2 = rover(b.port, { user: 'strict', password: 'p3', version: 2 });
    await until(() => s2.closed);
    assert.equal(s2.status(), 'HTTP/1.1 409 Conflict');
    assert.equal(s1.closed, false, 'действующий сеанс не тронут');

    // Логину с двумя сеансами разрешены два, третий вытесняет самый старый
    const t = [rover(b.port, { user: 'two', password: 'p2' }), rover(b.port, { user: 'two', password: 'p2' })];
    await until(() => t.every((c) => c.body().length > 0));
    t.push(rover(b.port, { user: 'two', password: 'p2' }));
    await until(() => t[2].body().length > 0 && t[0].closed);
    assert.equal(t[1].closed, false);
    for (const c of [second, s1, ...t]) c.end();
  } finally {
    await b.stop();
  }
});

test('защита: подбор пароля блокирует адрес, мусор и молчание закрывают соединение', async () => {
  const b = await bench({ rules: { requestTimeoutMs: 300 } });
  try {
    for (let i = 0; i < 5; i++) {
      const c = rover(b.port, { user: 'ivan', password: `wrong${i}` });
      await until(() => c.closed);
      assert.equal(c.status(), 'HTTP/1.0 401 Unauthorized');
    }
    // Адрес заблокирован: даже верный пароль не получает никакого ответа
    const blocked = rover(b.port, { user: 'ivan', password: 'pass-ivan' });
    await until(() => blocked.closed);
    assert.equal(blocked.data.length, 0);
  } finally {
    await b.stop();
  }
  const c = await bench({ rules: { requestTimeoutMs: 300 } });
  try {
    const garbage = rover(c.port, { raw: 'HELLO WORLD\r\n\r\n' });
    const silent = rover(c.port, { raw: '' });
    await until(() => garbage.closed && silent.closed, 3000);
    assert.equal(garbage.data.length, 0);
    assert.equal(silent.data.length, 0);
  } finally {
    await c.stop();
  }
});

test('частые переподключения одного логина получают отказ', async () => {
  const b = await bench({ rules: { connectsPerMinute: 3 } });
  try {
    for (let i = 0; i < 3; i++) {
      const c = rover(b.port, { user: 'ivan', password: 'pass-ivan' });
      await until(() => c.body().length > 0);
      c.end();
    }
    const extra = rover(b.port, { user: 'ivan', password: 'pass-ivan' });
    await until(() => extra.closed);
    assert.equal(extra.status(), 'HTTP/1.0 409 Conflict');
    assert.ok((await b.state()).refusals.some((r) => r.reason === 'слишком частые переподключения'));
  } finally {
    await b.stop();
  }
});

test('станция пропала во время сеанса: соединение держится заданное время и закрывается', async () => {
  const b = await bench({ rules: { stationLostMs: 400, stationLiveMs: 5000 } });
  try {
    const a = rover(b.port, { user: 'ivan', password: 'pass-ivan' });
    await until(() => a.body().length > 0);
    const started = Date.now();
    await until(() => a.closed, 4000);
    assert.ok(Date.now() - started >= 300, 'сеанс не закрыт раньше срока');
    assert.equal((await b.state()).sessions, 0);
  } finally {
    await b.stop();
  }
});

test('медленный клиент: отстал больше допустимого — сеанс закрыт, остальные работают', async () => {
  const b = await bench({ rules: { slowFloorBytes: 2048, slowSeconds: 0 } });
  try {
    const slow = rover(b.port, { user: 'ivan', password: 'pass-ivan', read: false }); // не читает ответ
    const fast = rover(b.port, { user: 'two', password: 'p2' });
    await until(() => fast.body().length > 0);
    await until(async () => (await b.state()).sessions === 2);
    const big = obs(6000, Array.from({ length: 30 }, (_, i) => ({ prn: i + 1, rangeMs: 70 + i * 0.3, signals: [{ id: 2, cnr: 40 }, { id: 15, cnr: 38 }] })));
    // Сокет сам вмещает сколько-то данных; шлём, пока очередь на отправку не перерастёт предел
    for (let i = 0; i < 4000 && b.service.sessions.size === 2; i++) {
      b.feed('TOUR', big, big, big, big, big, big, big, big);
      if (i % 20 === 0) await wait(5);
    }
    await until(() => b.service.sessions.size === 1, 8000);
    assert.equal([...b.service.sessions][0].login, 'two', 'быстрый клиент остался на связи');
    assert.equal(fast.closed, false);
    slow.end();
    fast.end();
  } finally {
    await b.stop();
  }
});

test('координаты ровера: из заголовка и из потока, негодные строки отбрасываются', async () => {
  const b = await bench();
  try {
    const gga1 = '$GPGGA,092750.000,5651.1234,N,06036.5678,E,5,10,0.8,270.5,M,-6.4,M,2.0,0006*61';
    const a = rover(b.port, { user: 'ivan', password: 'pass-ivan', version: 2, gga: gga1 });
    await until(() => a.body().length > 0);
    let pos = (await b.state()).clients[0].position;
    assert.equal(pos.kind, 'float');
    assert.equal(pos.sats, 10);
    a.socket.write('$GPGGA,092750.000,5651.1234,N,06036.5678,E,4,14,0.8,270.5,M,-6.4,M,1.2,0006*00\r\n'); // неверная сумма
    a.socket.write('$GPGGA,092750.000,5651.1234,N,06036.5678,E,4,14,0.8,270.5,M,-6.4,M,1.2,0006*65\r\n');
    await until(async () => (await b.state()).clients[0].position.kind === 'fixed');
    pos = (await b.state()).clients[0].position;
    assert.ok(Math.abs(pos.lat - 56.852057) < 1e-6);
    assert.equal(pos.age, 1.2);
    a.end();
  } finally {
    await b.stop();
  }
});

test('раздача без логина разрешена только на своём компьютере', async () => {
  const bus = new BusServer({ port: 0 });
  const busPort = await bus.ready;
  try {
    const config = merge(DEFAULTS, { bind: '0.0.0.0', ingest: { busPort }, caster: { statePort: 0, port: 0, enabled: true, openAccess: true }, stations: [] });
    await assert.rejects(() => caster.start({ config, log: () => {} }), /только на адресе 127\.0\.0\.1/);
  } finally {
    await bus.close();
  }
  const b = await bench({ casterConfig: { openAccess: true } });
  try {
    const a = rover(b.port, {});
    await until(() => a.body().length > 0);
    assert.equal(a.status(), 'ICY 200 OK');
    a.end();
  } finally {
    await b.stop();
  }
});

test('точка подсети: координаты базы свои, наблюдения и обычная точка не меняются', async () => {
  const own = [1499265.1234, 3031598.5678, 5389561.0001];
  const b = await bench({ mountpoints: [{ name: 'TOUR', station: 'TOUR' }, { name: 'EKB_TOUR', station: 'TOUR', position: own, stationId: 21 }] });
  try {
    const plain = rover(b.port, { path: '/TOUR', user: 'ivan', password: 'pass-ivan' });
    const subnet = rover(b.port, { path: '/EKB_TOUR', user: 'two', password: 'p2' });
    await until(() => b.service.sessions.size === 2);
    const next = obs(2000);
    b.feed('TOUR', POSITION, next);
    const frames = (c) => new StreamParser().push(c.body()).filter((f) => f.kind === 'rtcm');
    await until(() => frames(plain).filter((f) => f.type === 1074).length >= 1 && frames(subnet).filter((f) => f.type === 1005).length >= 2);
    const positions = (c) => frames(c).filter((f) => f.type === 1005).map((f) => rtcm.decodePosition(f.payload));
    for (const p of positions(plain)) assert.deepEqual(p.ecef, [1499264.8225, 3031597.7404, 5389560.6973]);
    for (const p of positions(subnet)) {
      assert.deepEqual(p.ecef, own);
      assert.equal(p.stationId, 21);
    }
    // Наблюдения у точки подсети — те же байты, отличается только номер станции
    const mine = frames(subnet).filter((f) => f.type === 1074).pop();
    const copy = Buffer.from(next);
    rtcm.restamp(copy, 21);
    assert.deepEqual(rtcm.frame(mine.payload), copy);
    assert.equal((await b.state()).points.find((p) => p.name === 'EKB_TOUR').ownPosition, true);
    plain.end();
    subnet.end();
  } finally {
    await b.stop();
  }
});

test('область работы логина: вне контура ровер не допускается, вышедший — отключается, молчащий — тоже', async () => {
  // Контур вокруг Екатеринбурга: [широта, долгота]
  const area = [[[56.6, 60.3], [56.6, 60.9], [57.0, 60.9], [57.0, 60.3]]];
  const b = await bench({ rules: { areaGgaMs: 400 }, users: { fenced: { password: 'p1', maxSessions: 5, area }, free: { password: 'p2' } } });
  const gga = (lat, lon) => {
    const part = (v, d) => { const deg = Math.floor(v); return `${String(deg).padStart(d, '0')}${((v - deg) * 60).toFixed(5).padStart(8, '0')}`; };
    const body = `GPGGA,120000.00,${part(lat, 2)},N,${part(lon, 3)},E,4,12,0.8,250.0,M,-10.0,M,1.0,0001`;
    return `$${body}*${[...body].reduce((x, ch) => x ^ ch.charCodeAt(0), 0).toString(16).toUpperCase().padStart(2, '0')}`;
  };
  try {
    // Снаружи — отказ 403 ещё при подключении
    const outside = rover(b.port, { user: 'fenced', password: 'p1', version: 2, gga: gga(57.9, 60.6) });
    await until(() => outside.closed);
    assert.match(outside.status(), /403/);
    assert.equal(b.service.refusals.pop().reason, 'ровер вне разрешённой области работы');
    // Внутри — работает; выехал за контур — сеанс закрыт
    const inside = rover(b.port, { user: 'fenced', password: 'p1', version: 2, gga: gga(56.84, 60.6) });
    await until(() => b.service.sessions.size === 1);
    inside.socket.write(`${gga(56.85, 60.61)}\r\n`);
    await wait(150);
    assert.equal(b.service.sessions.size, 1);
    inside.socket.write(`${gga(57.5, 60.6)}\r\n`);
    await until(() => inside.closed);
    // Положение не сообщил — ограничение молчанием не обойти
    const silent = rover(b.port, { user: 'fenced', password: 'p1' });
    await until(() => b.service.sessions.size === 1);
    await until(() => silent.closed, 3000);
    // Логин без области работает где угодно и без положения
    const free = rover(b.port, { user: 'free', password: 'p2', version: 2, gga: gga(57.9, 60.6) });
    await until(() => b.service.sessions.size === 1);
    await wait(900);
    assert.equal(free.closed, false);
    free.end();
  } finally {
    await b.stop();
  }
});

test('сеть с пересчётом в потоке: ровер получает 1021 и 1025 своей зоны, обычная точка — нет', async () => {
  const link = { tx: 1.7143, ty: -3.7758, tz: 1.4522, rx: 0, ry: 0, rz: 0, m: 0 };
  const b = await bench({ rules: { transformMs: 150 }, mountpoints: [{ name: 'TOUR', station: 'TOUR' },
    { name: 'N3_TOUR', station: 'TOUR', position: [1499263.1082, 3031601.5162, 5389559.2451], transform: { system: 'msk66', link, area: { lat: 57.5, lon: 61, dLat: 2, dLon: 4 } } }] });
  try {
    const plain = rover(b.port, { path: '/TOUR', user: 'ivan', password: 'pass-ivan' });
    const auto = rover(b.port, { path: '/N3_TOUR', user: 'two', password: 'p2' });
    await until(() => b.service.sessions.size === 2);
    b.feed('TOUR', POSITION, obs(2000));
    const frames = (c) => new StreamParser().push(c.body()).filter((f) => f.kind === 'rtcm');
    await until(() => frames(auto).filter((f) => f.type === 1025).length >= 2 && frames(plain).some((f) => f.type === 1074));
    const helmert = rtcm.decodeHelmert(frames(auto).find((f) => f.type === 1021).payload);
    const proj = rtcm.decodeProjection(frames(auto).find((f) => f.type === 1025).payload);
    assert.deepEqual([helmert.sourceName, helmert.targetName, helmert.dx, helmert.dy, helmert.dz, helmert.ry, helmert.rz, helmert.scale], ['ITRF2014', 'SK42', -21.855, 137.174, 81.252, 0.35, 0.79, 0.22]);
    assert.equal(helmert.systemId, proj.systemId);
    // Станция TOUR стоит восточнее 63°03′ — её зона вторая, пока ровер не сообщил своё положение
    assert.deepEqual([proj.systemId, proj.falseEasting, proj.falseNorthing], [2, 2500000, -5911057.63]);
    assert.ok(Math.abs(proj.lon0 - 66.05) < 1e-8);
    assert.equal(frames(plain).filter((f) => f.type === 1021 || f.type === 1025).length, 0);
    const point = (await b.state()).points.find((p) => p.name === 'N3_TOUR');
    assert.deepEqual([point.ownPosition, point.transform], [true, true]);
    plain.end();
    auto.end();
  } finally {
    await b.stop();
  }
});

test('свой порт сети раздачи: на нём видны и доступны только её точки', async () => {
  // Свободный порт: занять случайный, запомнить номер и отпустить
  const free = await new Promise((resolve) => { const srv = net.createServer(); srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); }); });
  const b = await bench({ mountpoints: [{ name: 'TOUR', station: 'TOUR' }, { name: 'N3_TOUR', station: 'TOUR', port: free }] });
  try {
    b.feed('TOUR', POSITION, obs(1000));
    await until(async () => (await b.state()).points.find((p) => p.name === 'N3_TOUR').port === free);
    const table = async (port) => { const c = rover(port, { path: '/', user: 'ivan', password: 'pass-ivan' }); await until(() => c.closed); return c.text(); };
    await until(async () => /N3_TOUR/.test(await table(free).catch(() => '')));
    const own = await table(free);
    const common = await table(b.port);
    assert.ok(/STR;N3_TOUR;/.test(own) && !/STR;TOUR;/.test(own), 'на порту сети — только её точки');
    assert.ok(/STR;TOUR;/.test(common) && !/STR;N3_TOUR;/.test(common), 'на общем порту точек сети нет');
    // Точка сети на общем порту не отдаётся, на своём — отдаётся
    const wrong = rover(b.port, { path: '/N3_TOUR', user: 'two', password: 'p2', version: 2 });
    await until(() => wrong.closed);
    assert.match(wrong.text(), /404/);
    const right = rover(free, { path: '/N3_TOUR', user: 'two', password: 'p2' });
    await until(() => b.service.sessions.size === 1);
    b.feed('TOUR', obs(2000));
    await until(() => new StreamParser().push(right.body()).some((f) => f.kind === 'rtcm' && f.type === 1074));
    right.end();
  } finally {
    await b.stop();
  }
});
