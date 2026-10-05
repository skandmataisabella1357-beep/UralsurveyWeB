'use strict';
// Тесты шлюза станции: список разрешённых адресов, пароль станции и правило
// «живое соединение молчащим не заменяется».

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const { StationGate, rule, parseSource } = require('../server/ingest/gate');
const { validate, merge, DEFAULTS } = require('../server/shared/config');
const ingest = require('../server/ingest');
const rtcm = require('../server/rtcm/messages');
const sim = require('../core/simulator');

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

const frame = (epoch) => sim.encodeMsm4({ type: 1074, stationId: 6, epoch, multiple: false, sats: [{ prn: 3, rangeMs: 70.2, signals: [{ id: 2, cnr: 45 }] }] });
const TIMING = { liveMs: 300, candidateMs: 700, handshakeMs: 500 };

// Шлюз и «ядро» за ним: всё, что шлюз пропустил, копится в received
async function setup(options = {}) {
  const gate = await new StationGate({ code: 'REFT', port: 0, timing: TIMING, ...options }).ready;
  const core = net.connect({ port: gate.pipePort, host: '127.0.0.1' });
  const received = [];
  core.on('data', (d) => received.push(d));
  core.on('error', () => {});
  await until(() => gate.core);
  return {
    gate,
    received: () => Buffer.concat(received),
    async close() {
      core.destroy();
      await gate.close();
    },
  };
}

// «База»: подключается к внешнему порту шлюза
function base(port, hello) {
  const socket = net.connect({ port, host: '127.0.0.1' });
  const b = { socket, closed: false, reply: Buffer.alloc(0) };
  socket.on('error', () => {});
  socket.on('close', () => { b.closed = true; });
  socket.on('data', (d) => { b.reply = Buffer.concat([b.reply, d]); });
  socket.on('connect', () => { if (hello) socket.write(hello); });
  b.send = (...frames) => socket.write(Buffer.concat(frames));
  b.end = () => socket.destroy();
  return b;
}

test('правила адресов и представление базы', () => {
  assert.equal(rule('10.0.0.0/8')('10.20.30.40'), true);
  assert.equal(rule('10.0.0.0/8')('11.0.0.1'), false);
  assert.equal(rule('185.41.162.156')('::ffff:185.41.162.156'), true);
  assert.equal(rule('185.41.162.156')('185.41.162.157'), false);
  assert.equal(rule('0.0.0.0/0')('8.8.8.8'), true);
  assert.equal(rule('192.168.0.0/16')('не адрес'), false);
  assert.throws(() => rule('10.0.0/8'), /не адрес IPv4/);
  assert.throws(() => rule('10.0.0.0/33'), /не адрес IPv4/);

  const v1 = parseSource(Buffer.from('SOURCE secret /REFT\r\nSource-Agent: NTRIP X\r\n\r\n\xd3'), 2048);
  assert.deepEqual([v1.version, v1.password, v1.mount, v1.rest.length], [1, 'secret', 'REFT', 2]);
  const v2 = parseSource(Buffer.from(`POST /REFT HTTP/1.1\r\nAuthorization: Basic ${Buffer.from('any:secret').toString('base64')}\r\n\r\n`), 2048);
  assert.deepEqual([v2.version, v2.password, v2.mount], [2, 'secret', 'REFT']);
  assert.equal(parseSource(Buffer.from('SOURCE secret /REFT\r\n'), 2048).pending, true);
  assert.ok(parseSource(Buffer.from('GET /REFT HTTP/1.0\r\n\r\n'), 2048).invalid);

  // Настройки: список адресов проверяется при чтении
  const ok = (allow) => validate(merge(DEFAULTS, { stations: [{ code: 'A', source: { mode: 'listen', port: 2110, allow } }] }));
  ok(['1.2.3.4', '10.0.0.0/8']);
  assert.throws(() => ok('1.2.3.4'), /список разрешённых адресов/);
});

test('список разрешённых адресов: чужой адрес не проходит', async () => {
  const closed = await setup({ allow: ['10.0.0.0/8'] });
  try {
    const b = base(closed.gate.port);
    await until(() => b.closed);
    await wait(50);
    assert.equal(closed.received().length, 0);
    assert.equal(closed.gate.snapshot().refusedAddress, 1);
    assert.equal(closed.gate.snapshot().protectedByAddress, true);
  } finally {
    await closed.close();
  }
  const open = await setup({ allow: ['10.0.0.0/8', '127.0.0.0/8'] });
  try {
    const b = base(open.gate.port);
    const f = frame(1000);
    await until(() => b.socket.readyState === 'open');
    b.send(f);
    await until(() => open.received().length === f.length);
    assert.ok(open.received().equals(f));
    assert.equal(open.gate.snapshot().current.address, '127.0.0.1');
    b.end();
  } finally {
    await open.close();
  }
});

test('пароль станции: без представления и с неверным паролем поток не принимается', async () => {
  const s = await setup({ password: 'station-secret' });
  try {
    // Голый поток на порт с паролем
    const raw = base(s.gate.port);
    await until(() => raw.socket.readyState === 'open');
    raw.send(frame(1000));
    await until(() => raw.closed);
    // Неверный пароль, версия 1
    const bad = base(s.gate.port, 'SOURCE wrong /REFT\r\n\r\n');
    await until(() => bad.closed);
    assert.equal(bad.reply.toString(), 'ERROR - Bad Password\r\n');
    // Верный пароль, но чужая точка
    const other = base(s.gate.port, 'SOURCE station-secret /EKB2\r\n\r\n');
    await until(() => other.closed);
    // Неверный пароль, версия 2
    const bad2 = base(s.gate.port, `POST /REFT HTTP/1.1\r\nAuthorization: Basic ${Buffer.from('x:nope').toString('base64')}\r\n\r\n`);
    await until(() => bad2.closed);
    assert.match(bad2.reply.toString(), /^HTTP\/1\.1 401 Unauthorized/);
    // База, которая подключилась и не представилась
    const mute = base(s.gate.port);
    await until(() => mute.closed, 3000);
    await wait(50);
    assert.equal(s.received().length, 0, 'ни один байт не дошёл до ядра');
    assert.equal(s.gate.snapshot().refusedPassword, 5);

    // Верный пароль: ответ и поток
    const good = base(s.gate.port, 'SOURCE station-secret /REFT\r\nSource-Agent: NTRIP Receiver\r\n\r\n');
    await until(() => good.reply.length > 0);
    assert.equal(good.reply.toString(), 'ICY 200 OK\r\n\r\n');
    const f = frame(2000);
    good.send(f);
    await until(() => s.received().length === f.length);
    assert.ok(s.received().equals(f));
    good.end();
    await until(() => !s.gate.current);

    // Версия 2 с паролем в Basic, первый кадр приходит в одном пакете с представлением
    const f2 = frame(3000);
    const v2 = base(s.gate.port, Buffer.concat([Buffer.from(`POST /reft HTTP/1.1\r\nAuthorization: Basic ${Buffer.from('reft:station-secret').toString('base64')}\r\n\r\n`), f2]));
    await until(() => s.received().length === f.length + f2.length);
    assert.match(v2.reply.toString(), /^HTTP\/1\.1 200 OK/);
    v2.end();
  } finally {
    await s.close();
  }
});

test('живое соединение молчащим не заменяется', async () => {
  const s = await setup();
  try {
    const live = base(s.gate.port);
    await until(() => live.socket.readyState === 'open');
    let n = 0;
    const pump = setInterval(() => live.send(frame(1000 + n++)), 50);
    try {
      await until(() => s.gate.current);
      // Чужое молчащее подключение и подключение с одним мусором
      const silent = base(s.gate.port);
      const junk = base(s.gate.port);
      await until(() => junk.socket.readyState === 'open');
      junk.socket.write(Buffer.alloc(300, 0x55));
      await until(() => silent.closed && junk.closed, 4000);
      assert.equal(live.closed, false, 'живая база осталась на связи');
      assert.equal(s.gate.snapshot().refusedSilent, 2);
      assert.equal(s.gate.snapshot().switched, 0);
      // Поток ядру не прерывался и мусор в него не попал
      const before = s.received().length;
      await wait(200);
      assert.ok(s.received().length > before);
      assert.equal(s.received().includes(Buffer.alloc(20, 0x55)), false);

      // Вторая живая база на том же порту: первая работает — вторая ждёт и получает отказ
      const second = base(s.gate.port);
      await until(() => second.socket.readyState === 'open');
      const pump2 = setInterval(() => second.send(frame(900000)), 50);
      await until(() => second.closed, 4000);
      clearInterval(pump2);
      assert.equal(live.closed, false);
      assert.equal(s.gate.snapshot().refusedBusy, 1);
      assert.equal(s.gate.snapshot().switched, 0);
    } finally {
      clearInterval(pump);
    }
    live.end();
  } finally {
    await s.close();
  }
});

test('замолчавшее соединение уступает место новому, приславшему верный кадр', async () => {
  const s = await setup();
  try {
    const old = base(s.gate.port);
    await until(() => old.socket.readyState === 'open');
    const first = frame(1000);
    old.send(first);
    await until(() => s.received().length === first.length);
    // Старое соединение зависло: связь есть, данных нет. Приёмник переподключился.
    await wait(TIMING.liveMs + 100);
    const fresh = base(s.gate.port);
    await until(() => fresh.socket.readyState === 'open');
    const second = frame(2000);
    fresh.send(second);
    await until(() => old.closed);
    await until(() => s.received().length === first.length + second.length);
    assert.ok(s.received().subarray(first.length).equals(second), 'кадр, которым новое подключение доказало себя, не потерян');
    assert.equal(s.gate.snapshot().switched, 1);
    assert.equal(fresh.closed, false);
    fresh.end();
  } finally {
    await s.close();
  }
});

test('служба приёма: база с паролем и разрешённым адресом доходит до ядра', async () => {
  const config = merge(DEFAULTS, {
    ingest: { busPort: 0, statePort: 0 },
    stations: [{ code: 'REFT', name: 'Reft', source: { mode: 'listen', port: 0, allow: ['127.0.0.1'] } }],
  });
  const service = await ingest.start({ config, secrets: { stationPasswords: { REFT: 'pw' } }, log: () => {} });
  try {
    const gate = service.gates.get('REFT');
    const b = base(gate.port, 'SOURCE pw /REFT\r\n\r\n');
    await until(() => b.reply.length > 0);
    const position = rtcm.encodePosition({ stationId: 1, ecef: [1647585.2585, 3057841.8377, 5331652.6642] });
    const pump = setInterval(() => b.send(position, frame(Date.now() % 600000)), 100);
    try {
      const snap = await until(() => {
        const st = service.hub.snapshots()[0];
        return st.link.state === 'online' && st.position ? st : null;
      }, 8000);
      assert.equal(snap.position.source, 'rtcm');
      assert.equal(snap.crcErrors, 0);
      assert.equal(gate.snapshot().protectedByPassword, true);
      assert.equal(gate.snapshot().current.address, '127.0.0.1');
    } finally {
      clearInterval(pump);
    }
    b.end();
  } finally {
    await service.stop();
  }
});
