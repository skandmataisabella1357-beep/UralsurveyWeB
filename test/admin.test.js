'use strict';
// Тесты входа в панель администратора и того, что открытая сводка не выдаёт лишнего.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const auth = require('../server/control/auth');
const control = require('../server/control');
const ingest = require('../server/ingest');
const { merge, DEFAULTS } = require('../server/shared/config');

const until = async (check, ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > end) throw new Error('не дождались условия');
    await new Promise((r) => setTimeout(r, 50));
  }
};

test('пароль администратора: хранится хешем, короткий не принимается', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ural-admin-'));
  try {
    const file = path.join(dir, 'admin.json');
    assert.equal(auth.loadAdmin(file), null);
    assert.throws(() => auth.saveAdmin('short', file), /не короче/);
    auth.saveAdmin('correct horse battery', file);
    const text = fs.readFileSync(file, 'utf8');
    assert.equal(text.includes('correct horse'), false, 'пароля в файле нет');
    const record = auth.loadAdmin(file);
    assert.equal(auth.verifyPassword('correct horse battery', record), true);
    assert.equal(auth.verifyPassword('correct horse batterx', record), false);
    assert.equal(auth.verifyPassword('', record), false);
    assert.equal(auth.verifyPassword('x', null), false);
    // Один и тот же пароль даёт разные хеши: соль своя у каждой записи
    assert.notEqual(auth.hashPassword('same password').hash, auth.hashPassword('same password').hash);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('сеансы и счётчик попыток', () => {
  const s = new auth.Sessions();
  const token = s.create();
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(s.has(token), true);
  assert.equal(s.has('0'.repeat(64)), false);
  s.map.set(token, Date.now() - 1);
  assert.equal(s.has(token), false, 'просроченный сеанс не действует');
  const a = new auth.Attempts(3);
  for (let i = 0; i < 3; i++) { assert.equal(a.allowed('1.1.1.1'), true); a.failed('1.1.1.1'); }
  assert.equal(a.allowed('1.1.1.1'), false);
  assert.equal(a.allowed('2.2.2.2'), true);
});

test('панель: без входа закрыта, вход по паролю, открытая сводка без лишнего', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ural-admin-'));
  const adminFile = path.join(dir, 'admin.json');
  const config = merge(DEFAULTS, {
    ingest: { busPort: 0, statePort: 0 },
    caster: { statePort: 1 },
    control: { port: 0 },
    stations: [{ code: 'SIM1', name: 'Имитатор', source: { mode: 'sim', lat: 56.84, lon: 60.6, h: 270, stationId: 901 } }],
  });
  const a = await ingest.start({ config, secrets: {}, log: () => {} });
  config.ingest.statePort = a.ports.state;
  const c = await control.start({ config, log: () => {}, adminFile });
  const base = `http://127.0.0.1:${c.ports.web}`;
  const call = async (p, options = {}) => {
    const res = await fetch(base + p, options);
    return { status: res.status, body: await res.json().catch(() => null), cookie: res.headers.get('set-cookie') };
  };
  const login = (password, headers = {}) => call('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ password }) });
  try {
    // Пароль не задан: панель закрыта и объясняет почему
    assert.deepEqual((await call('/api/me')).body, { signedIn: false, configured: false });
    assert.equal((await login('anything long enough')).status, 409);
    assert.equal((await call('/api/admin/state')).status, 401);

    auth.saveAdmin('correct horse battery', adminFile);
    assert.equal((await call('/api/me')).body.configured, true);
    assert.equal((await login('wrong password!')).status, 401);
    const ok = await login('correct horse battery', { 'X-Forwarded-Proto': 'https' });
    assert.equal(ok.status, 200);
    assert.match(ok.cookie, /^ural_session=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=43200; Secure$/);
    const cookie = ok.cookie.split(';')[0];

    // С входом — полная сводка: журнал станции, адрес источника
    const full = await until(async () => {
      const r = await call('/api/admin/state', { headers: { Cookie: cookie } });
      return r.status === 200 && r.body.stations[0] && r.body.stations[0].link.state === 'online' ? r.body : null;
    });
    assert.ok(Array.isArray(full.stations[0].log));
    assert.ok(full.stations[0].endpoint);
    assert.deepEqual(Object.keys(full).sort(), ['at', 'clients', 'points', 'refusals', 'services', 'stations', 'usingExample']);
    assert.equal((await call('/api/me', { headers: { Cookie: cookie } })).body.signedIn, true);

    // Открытая сводка: ни журнала, ни адресов, ни сведений о шлюзе и роверах
    const open = (await call('/api/state')).body;
    assert.deepEqual(Object.keys(open.stations[0]).sort(), ['crcErrors', 'feed', 'format', 'id', 'link', 'name', 'satTotal']);
    assert.deepEqual(Object.keys(open.stations[0].link).sort(), ['bitsPerSec', 'reconnects', 'state']);
    assert.equal(open.clients, undefined);
    assert.equal(open.refusals, undefined);

    // Чужой и испорченный cookie не проходят; выход закрывает сеанс
    assert.equal((await call('/api/admin/state', { headers: { Cookie: `ural_session=${'a'.repeat(64)}` } })).status, 401);
    assert.equal((await call('/api/logout', { method: 'POST', headers: { Cookie: cookie } })).status, 200);
    assert.equal((await call('/api/admin/state', { headers: { Cookie: cookie } })).status, 401);

    // Страницу панели собирает служба управления на Python; здесь её нет
    assert.equal((await fetch(`${base}/admin.html`)).status, 404);
    assert.equal((await fetch(`${base}/modules/coordsys/coordsys.js`)).status, 200);
    assert.equal((await call('/api/nope')).status, 404);

    // Подбор: после пяти неверных попыток с адреса вход закрыт на минуту даже с верным паролем
    for (let i = 0; i < 4; i++) assert.equal((await login(`wrong attempt ${i}`)).status, 401);
    assert.equal((await login('correct horse battery')).status, 429);
  } finally {
    await c.stop();
    await a.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
