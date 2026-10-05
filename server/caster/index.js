'use strict';
// Служба раздачи: отдаёт роверам потоки станций по NTRIP версий 1 и 2.
// Потоки приходят от службы приёма по внутренней шине; сюда же сходятся проверка доступа
// и правила сеанса из ТЗ. Наблюдения идут роверу теми же байтами, что выдал приёмник.
//
// Запуск отдельно: node server/caster/index.js

const net = require('net');
const crypto = require('crypto');
const { StreamParser } = require('../../core/stream');
const { ecefToLlh, R2D } = require('../../core/geo');
const { BusClient } = require('../shared/bus');
const { Directory } = require('../shared/directory');
const { jsonServer } = require('../shared/http');
const { loadConfig } = require('../shared/config');
const rtcm = require('../rtcm/messages');
const ntrip = require('./ntrip');
const { inside } = require('../../modules/layers/parse');

// Правила сеанса (ТЗ, раздел «Как пользователь работает с сервером»)
const RULES = {
  requestTimeoutMs: 10000, // запрос должен прийти за это время
  stationLiveMs: 10000, // станция «на связи», если данные были не раньше
  stationLostMs: 30000, // сеанс держится без данных столько, затем закрывается
  slowSeconds: 10, // в очереди на отправку не больше стольких секунд потока
  slowFloorBytes: 32 * 1024,
  maxPerAddress: 20,
  maxTotal: 2000,
  wrongPerMinute: 5, // неверных паролей с адреса за минуту до блокировки
  banMinutes: [1, 5, 15, 60],
  connectsPerMinute: 10, // подключений на логин
  areaGgaMs: 30000, // логин с областью работы обязан сообщить положение за это время
};

// Что из потока станции идёт пользователю. Эфемериды и фирменные сообщения остаются внутри сервера.
function forUsers(type) {
  return (type >= 1001 && type <= 1013) || type === 1029 || type === 1033 || type === 1230 || (type >= 1071 && type <= 1137);
}
const SERVICE_TYPES = new Set([1005, 1006, 1007, 1008, 1033, 1230]);

// В сообщении наблюдений MSM нет ни одного спутника: маска спутников (64 бита с 73-го) пустая
function emptyMsm(type, payload) {
  if (type < 1071 || type > 1137 || payload.length < 18) return false;
  if (payload[9] & 0x7f) return false;
  for (let i = 10; i < 17; i++) if (payload[i]) return false;
  return !(payload[17] & 0x80);
}

function sameText(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

// directoryUrl — адрес службы управления: тогда точки и логины берутся из базы и меняются на ходу,
// а сеансы и отказы уходят в её журнал. Без него раздача работает по файлам настроек.
async function start({ config, secrets = {}, log = console.log, rules = {}, directoryUrl = process.env.URAL_DIRECTORY || '', directoryKey }) {
  const R = { ...RULES, ...rules };
  const startedAt = Date.now();
  const cfg = config.caster;
  // Порт для роверов может слушать другой адрес, чем внутренние порты служб
  const publicBind = cfg.publicBind || config.bind;
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(publicBind);
  if (cfg.openAccess && !loopback) {
    throw new Error('Раздача без проверки логина (caster.openAccess) разрешена только на адресе 127.0.0.1.');
  }
  let users = secrets.users || {};

  // ---------- Потоки станций ----------

  const feeds = new Map(); // код станции -> поток
  function feedOf(code, name) {
    let feed = feeds.get(code);
    if (!feed) {
      feed = {
        code, name: name || code, parser: new StreamParser(), service: new Map(), types: new Map(),
        lastAt: 0, bytes: 0, rate: 0, rateBytes: 0, rateAt: Date.now(), lat: null, lon: null, receiver: '', points: [],
      };
      feeds.set(code, feed);
    }
    return feed;
  }

  // ---------- Точки подключения ----------

  const points = new Map(); // имя точки -> точка
  // Приводит набор точек к заданному. Точка с тем же именем сохраняет свои сеансы;
  // сеансы исчезнувших, выключенных и переведённых на другую станцию точек закрываются.
  function setPoints(defined, stations) {
    const next = new Map();
    for (const p of defined) {
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(p.name || '')) throw new Error(`Точка подключения «${p.name}»: имя — латинские буквы, цифры, «_» и «-», до 32 знаков.`);
      if (next.has(p.name)) throw new Error(`Точка подключения ${p.name} заведена дважды.`);
      const station = stations.find((st) => st.code === p.station);
      if (!station) throw new Error(`Точка подключения ${p.name}: станции ${p.station} нет в настройках.`);
      const old = points.get(p.name);
      const feed = feedOf(station.code, station.name);
      const keep = old && old.feed === feed && p.enabled !== false;
      if (old && !keep) {
        for (const session of [...old.sessions]) close(session, p.enabled === false ? 'точка подключения выключена' : 'точка подключения переведена на другую станцию');
      }
      next.set(p.name, {
        name: p.name,
        feed,
        stationId: Number.isInteger(p.stationId) ? p.stationId : null, // номер станции в потоке; null — как пришло
        // Свои координаты базы для этой точки (точка подсети); null — как пришло от станции
        position: Array.isArray(p.position) && p.position.length === 3 && p.position.every(Number.isFinite) ? p.position : null,
        positionFrame: null,
        listed: p.listed !== false,
        enabled: p.enabled !== false,
        access: Array.isArray(p.access) ? p.access : null, // null — все логины с доступом
        sessions: keep ? old.sessions : new Set(),
      });
    }
    for (const [name, old] of points) {
      if (!next.has(name)) for (const session of [...old.sessions]) close(session, 'точка подключения удалена');
    }
    points.clear();
    for (const feed of feeds.values()) feed.points = [];
    for (const [name, point] of next) {
      points.set(name, point);
      point.feed.points.push(point);
      for (const session of point.sessions) session.point = point;
    }
  }

  // ---------- Приём с шины и выдача ----------

  const sessions = new Set();
  const refusals = []; // последние отказы, для администратора
  let seq = 0;
  const bootId = Date.now().toString(36); // номера сеансов не повторяются после перезапуска службы
  const journal = []; // события для журнала сеансов в базе
  const record = (event) => {
    if (!directoryUrl) return;
    journal.push({ at: Date.now(), ...event });
    if (journal.length > 20000) journal.shift();
  };
  const where = (s) => (s.gga ? { lat: s.gga.lat, lon: s.gga.lon, kind: s.gga.kind } : null);
  setPoints(config.mountpoints || config.stations.map((st) => ({ name: st.code, station: st.code })), config.stations);

  function close(session, reason) {
    if (session.closed) return;
    session.closed = true;
    session.endReason = reason;
    session.point.sessions.delete(session);
    sessions.delete(session);
    session.socket.destroy();
    record({ t: 'close', id: session.id, login: session.login, bytes: session.bytes, reason, position: where(session), first: session.firstGga && { lat: session.firstGga.lat, lon: session.firstGga.lon } });
  }

  function send(session, plain, chunked) {
    const socket = session.socket;
    const limit = Math.max(R.slowFloorBytes, session.point.feed.rate * R.slowSeconds);
    // Устаревшие поправки роверу вреднее переподключения
    if (socket.writableLength > limit) {
      close(session, 'медленный клиент: поправки не успевают уходить');
      return;
    }
    const data = session.version === 2 ? chunked : plain;
    session.bytes += data.length;
    socket.write(data);
  }

  // Кадр в том виде, в каком его получает ровер этой точки: со своим номером станции и,
  // у точки подсети, со своими координатами базы. Наблюдения не меняются.
  function adapt(point, f) {
    let out = f;
    const type = rtcm.frameType(f);
    if (point.position && (type === 1005 || type === 1006)) {
      const cached = point.positionFrame;
      if (cached && cached.source.equals(f)) out = cached.frame;
      else {
        out = rtcm.encodePosition({ ...rtcm.decodePosition(f.subarray(3, f.length - 3)), ecef: point.position });
        point.positionFrame = { source: f, frame: out };
      }
    }
    if (point.stationId !== null) {
      out = Buffer.from(out);
      rtcm.restamp(out, point.stationId);
    }
    return out;
  }

  // Кадры одной порции отдаются одной записью на сеанс; для версии 2 обёртка строится один раз на точку
  function deliver(point, frames) {
    if (!point.sessions.size) return;
    const list = point.stationId !== null || point.position ? frames.map((f) => adapt(point, f)) : frames;
    const plain = list.length === 1 ? list[0] : Buffer.concat(list);
    let chunked = null;
    for (const session of point.sessions) {
      if (session.version === 2 && !chunked) chunked = ntrip.chunk(plain);
      send(session, plain, chunked);
    }
  }

  function onData(feed, body, now) {
    feed.lastAt = now;
    feed.bytes += body.length;
    feed.rateBytes += body.length;
    if (now - feed.rateAt >= 5000) {
      feed.rate = feed.rateBytes / ((now - feed.rateAt) / 1000);
      feed.rateBytes = 0;
      feed.rateAt = now;
    }
    const out = [];
    // Разбор проверяет контрольную сумму: повреждённый кадр дальше не уходит
    for (const fr of feed.parser.push(body)) {
      if (fr.kind !== 'rtcm' || !forUsers(fr.type) || emptyMsm(fr.type, fr.payload)) continue;
      const frame = rtcm.frame(fr.payload);
      const seen = feed.types.get(fr.type);
      if (seen) {
        seen.period = seen.period * 0.8 + (now - seen.at) * 0.2;
        seen.at = now;
      } else {
        feed.types.set(fr.type, { at: now, period: 1000 });
      }
      if (SERVICE_TYPES.has(fr.type)) {
        feed.service.set(fr.type, frame);
        try {
          if (fr.type === 1005 || fr.type === 1006) {
            const p = rtcm.decodePosition(fr.payload);
            const g = ecefToLlh(p.ecef[0], p.ecef[1], p.ecef[2]);
            feed.lat = g.lat * R2D;
            feed.lon = g.lon * R2D;
          } else if (fr.type === 1033) {
            feed.receiver = rtcm.decodeDescriptor(fr.payload).receiver.trim();
          }
        } catch (err) { /* нечитаемое служебное сообщение на выдачу не влияет */ }
      }
      out.push(frame);
    }
    if (out.length) for (const point of feed.points) deliver(point, out);
  }

  const bus = new BusClient({ host: config.bind, port: config.ingest.busPort });
  bus.on('message', (header, body) => {
    if (header.t === 'stations') for (const s of header.stations) feedOf(s.code, s.name).name = s.name;
    else if (header.t === 'data') onData(feedOf(header.station), body, Date.now());
  });
  bus.on('up', () => log('раздача: связь со службой приёма есть'));
  bus.on('down', () => log('раздача: связь со службой приёма потеряна, ждём её возвращения'));
  bus.on('fault', (text) => log(`раздача: сбой на шине — ${text}`));
  bus.start();

  // Станция замолчала: сеансы её точек держатся stationLostMs и закрываются
  const watchdog = setInterval(() => {
    const now = Date.now();
    for (const point of points.values()) {
      if (!point.sessions.size) continue;
      const quiet = now - Math.max(point.feed.lastAt, 0);
      if (quiet > R.stationLostMs) for (const s of [...point.sessions]) close(s, 'станция не на связи');
    }
    // Логин с областью работы обязан сообщать положение: иначе ограничение обходится молчанием
    for (const s of [...sessions]) if (s.area && !s.gga && now - s.startedAt > R.areaGgaMs) close(s, 'ровер не сообщил своё положение, а для логина задана область работы');
    for (const [key, list] of connects) if (!list.some((t) => now - t < 60000)) connects.delete(key);
    for (const [ip, b] of bans) if (b.until < now && now - b.lastAt > 3600000) bans.delete(ip);
  }, 1000);

  // ---------- Доступ ----------

  const bans = new Map(); // адрес -> { wrong: [время], level, until, lastAt }
  const connects = new Map(); // логин -> [время подключений]
  const perAddress = new Map();

  function wrongPassword(ip, now) {
    const b = bans.get(ip) || { wrong: [], level: 0, until: 0, lastAt: 0 };
    b.wrong = b.wrong.filter((t) => now - t < 60000);
    b.wrong.push(now);
    b.lastAt = now;
    if (b.wrong.length >= R.wrongPerMinute) {
      b.until = now + R.banMinutes[Math.min(b.level, R.banMinutes.length - 1)] * 60000;
      b.level++;
      b.wrong = [];
      log(`раздача: адрес ${ip} заблокирован за подбор пароля`);
    }
    bans.set(ip, b);
  }

  function refuse(socket, req, code, reason, login) {
    refusals.push({ at: Date.now(), login: login || null, point: req ? req.path : null, code, reason });
    if (refusals.length > 200) refusals.shift();
    record({ t: 'refusal', login: login || '', point: req ? req.path : '', code, reason, address: socket.remoteAddress || '' });
    if (code === null) socket.destroy();
    else socket.end(ntrip.refusal(req.version, code));
  }

  function liveTable() {
    const now = Date.now();
    const list = [];
    for (const point of points.values()) {
      const feed = point.feed;
      if (!point.enabled || !point.listed || now - feed.lastAt > R.stationLiveMs) continue;
      list.push({
        name: point.name,
        city: feed.name,
        messages: [...feed.types.entries()].sort((a, b) => a[0] - b[0]).map(([type, t]) => ({ type, period: Math.max(1, Math.round(t.period / 1000)) })),
        lat: feed.lat,
        lon: feed.lon,
        needsGga: false,
        receiver: feed.receiver,
        bitrate: Math.round(feed.rate * 8 / 100) * 100,
      });
    }
    return ntrip.sourcetable({ host: cfg.publicHost || publicBind, port: actualPort, points: list });
  }

  // Порядок проверок — как в ТЗ: разбор, блокировка, таблица, точка, пароль, запись, подписка, лимит, станция
  function admit(socket, req, ip) {
    const now = Date.now();
    if (req.path === '') {
      socket.end(ntrip.sourcetableResponse(req.version, liveTable()));
      return;
    }
    const point = points.get(req.path);
    if (!point || !point.enabled) {
      refusals.push({ at: now, login: req.user || null, point: req.path, code: 404, reason: 'такой точки нет' });
      record({ t: 'refusal', login: req.user || '', point: req.path, code: 404, reason: 'такой точки нет', address: ip });
      // Версия 1 в ответ на незнакомую точку получает таблицу источников
      socket.end(req.version === 2 ? ntrip.refusal(2, 404) : ntrip.sourcetableResponse(1, liveTable()));
      return;
    }

    let login = req.user;
    let user = null;
    if (cfg.openAccess) {
      login = login || 'без-логина';
      user = { maxSessions: 1000 };
    } else {
      user = Object.prototype.hasOwnProperty.call(users, login) ? users[login] : null;
      if (!user || !req.hasAuth || !sameText(req.password, user.password)) {
        wrongPassword(ip, now);
        refuse(socket, req, 401, 'неверный логин или пароль', login);
        return;
      }
      if (user.active === false) return refuse(socket, req, 403, 'учётная запись приостановлена', login);
      if (user.expires && Date.parse(user.expires) < now) return refuse(socket, req, 403, 'подписка истекла', login);
      const own = Array.isArray(user.mountpoints) ? user.mountpoints.includes(point.name) : true;
      const allowed = point.access ? point.access.includes(login) : true;
      if (!own || !allowed) return refuse(socket, req, 403, 'точка не входит в подписку', login);
    }

    // Область работы: ровер, который уже сообщил положение вне её, не допускается
    const area = Array.isArray(user.area) && user.area.length ? user.area : null;
    const at = area && req.gga ? ntrip.parseGga(req.gga) : null;
    if (at && !inside(at.lat, at.lon, area)) return refuse(socket, req, 403, 'ровер вне разрешённой области работы', login);

    const recent = (connects.get(login) || []).filter((t) => now - t < 60000);
    recent.push(now);
    connects.set(login, recent);
    if (recent.length > R.connectsPerMinute) return refuse(socket, req, 409, 'слишком частые переподключения', login);

    const mine = [...sessions].filter((s) => s.login === login);
    const max = user.maxSessions || 1;
    if (mine.length >= max) {
      if (user.onLimit === 'refuse') return refuse(socket, req, 409, 'превышено число одновременных сеансов', login);
      // По умолчанию новое подключение вытесняет самое старое: ровер после обрыва связи входит сразу
      mine.sort((a, b) => a.startedAt - b.startedAt);
      for (const old of mine.slice(0, mine.length - max + 1)) close(old, 'вытеснен новым подключением того же логина');
    }

    const feed = point.feed;
    if (now - feed.lastAt > R.stationLiveMs) return refuse(socket, req, 503, 'станция не на связи', login);

    const session = {
      id: `${bootId}-${++seq}`, socket, login, point, ip, version: req.version, agent: req.agent,
      startedAt: now, bytes: 0, gga: null, ggaAt: 0, firstGga: null, closed: false, endReason: null, text: '', area,
    };
    socket.setNoDelay(true); // кадр уходит сразу, без склейки пакетов
    socket.setKeepAlive(true, 30000);
    socket.setTimeout(0);
    socket.write(ntrip.streamHead(req.version));
    // Сначала координаты базы, оборудование и задержки ГЛОНАСС, затем наблюдения
    const service = [1005, 1006, 1007, 1008, 1033, 1230].map((t) => feed.service.get(t)).filter(Boolean);
    sessions.add(session);
    point.sessions.add(session);
    record({ t: 'open', id: session.id, login, point: point.name, station: feed.code, address: ip, agent: req.agent, version: req.version });
    if (service.length) {
      const list = service.map((f) => adapt(point, f));
      const plain = Buffer.concat(list);
      send(session, plain, req.version === 2 ? ntrip.chunk(plain) : null);
    }

    const takeGga = (text) => {
      const g = ntrip.parseGga(text);
      if (!g) return;
      session.gga = g;
      session.ggaAt = Date.now();
      if (!session.firstGga) session.firstGga = g;
      // Ровер вышел из своей области работы — сеанс закрывается
      if (session.area && !inside(g.lat, g.lon, session.area)) close(session, 'ровер вне разрешённой области работы');
    };
    if (req.gga) takeGga(req.gga);
    const onText = (data) => {
      // Ровер шлёт строки GGA; всё остальное не нужно, большой мусор не копим
      session.text = (session.text + data.toString('latin1')).slice(-512);
      let i;
      while ((i = session.text.indexOf('\n')) !== -1) {
        takeGga(session.text.slice(0, i));
        session.text = session.text.slice(i + 1);
      }
    };
    if (req.rest.length) onText(req.rest);
    socket.on('data', onText);
    socket.on('close', () => close(session, session.endReason || 'ровер отключился'));
  }

  // ---------- Справочник из базы и журнал сеансов ----------

  let directory = null;
  let flushTimer = null;
  let sending = false;
  function applyDirectory(dir) {
    try {
      // Сеансы логинов, которые удалены, отключены или сменили пароль, закрываются сразу
      for (const s of [...sessions]) {
        const now = dir.users[s.login];
        const was = users[s.login];
        if (!now || now.active === false) close(s, 'логин отключён или удалён');
        else if (was && was.password !== now.password) close(s, 'сменён пароль логина');
        else {
          // Область работы могли задать, сменить или снять на ходу
          s.area = Array.isArray(now.area) && now.area.length ? now.area : null;
          if (s.area && s.gga && !inside(s.gga.lat, s.gga.lon, s.area)) close(s, 'ровер вне разрешённой области работы');
        }
      }
      users = dir.users;
      if (dir.rules && Number.isFinite(dir.rules.stationLostMs)) R.stationLostMs = dir.rules.stationLostMs;
      setPoints(dir.mountpoints, dir.stations);
      log(`раздача: справочник из базы — точек ${dir.mountpoints.length}, логинов ${Object.keys(dir.users).length}`);
    } catch (err) {
      log(`раздача: справочник из базы не применён — ${err.message}`);
    }
  }
  async function flush() {
    if (sending) return;
    sending = true;
    try {
      // Раз в несколько секунд — объём и положение открытых сеансов, чтобы журнал не отставал
      const batch = journal.splice(0, 2000);
      for (const s of sessions) batch.push({ t: 'update', id: s.id, at: Date.now(), bytes: s.bytes, position: where(s), first: s.firstGga && { lat: s.firstGga.lat, lon: s.firstGga.lon } });
      const ok = await directory.send(batch, [...sessions].map((s) => s.id));
      // Управление недоступно: события не теряем, отправим в следующий раз
      if (!ok) journal.unshift(...batch.filter((e) => e.t !== 'update'));
    } finally {
      sending = false;
    }
  }
  if (directoryUrl) {
    directory = new Directory({ url: directoryUrl, key: directoryKey });
    directory.on('update', applyDirectory);
    directory.start();
    flushTimer = setInterval(flush, 3000);
    if (flushTimer.unref) flushTimer.unref();
  }

  // ---------- Порт для роверов ----------

  let actualPort = cfg.port;
  let server = null;
  const sockets = new Set(); // все открытые соединения, в том числе ещё не приславшие запрос
  if (cfg.enabled) {
    server = net.createServer((socket) => {
      const ip = socket.remoteAddress || '';
      socket.on('error', () => {});
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      const now = Date.now();
      const ban = bans.get(ip);
      // Заблокированный адрес и перегрузка: соединение закрывается без ответа
      if ((ban && ban.until > now) || server.connectionsCount > R.maxTotal || (perAddress.get(ip) || 0) >= R.maxPerAddress) {
        socket.destroy();
        return;
      }
      server.connectionsCount++;
      perAddress.set(ip, (perAddress.get(ip) || 0) + 1);
      socket.on('close', () => {
        server.connectionsCount--;
        const n = (perAddress.get(ip) || 1) - 1;
        if (n > 0) perAddress.set(ip, n);
        else perAddress.delete(ip);
      });

      let head = Buffer.alloc(0);
      socket.setTimeout(R.requestTimeoutMs, () => socket.destroy());
      const onHead = (data) => {
        head = Buffer.concat([head, data]);
        const req = ntrip.parseRequest(head);
        if (req.pending) return;
        socket.off('data', onHead);
        if (req.invalid) {
          socket.destroy();
          return;
        }
        admit(socket, req, ip);
      };
      socket.on('data', onHead);
    });
    server.connectionsCount = 0;
    actualPort = await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(cfg.port, publicBind, () => resolve(server.address().port));
    });
  }

  // ---------- Состояние для службы управления ----------

  const state = jsonServer({
    '/state': () => {
      const now = Date.now();
      return {
        service: 'caster',
        startedAt,
        ingestLink: bus.connected,
        listening: Boolean(server),
        openAccess: Boolean(cfg.openAccess),
        port: actualPort,
        sessions: sessions.size,
        feeds: [...feeds.values()].map((f) => ({ station: f.code, name: f.name, bytes: f.bytes, lastDataAgeMs: f.lastAt ? now - f.lastAt : null })),
        points: [...points.values()].map((p) => ({
          name: p.name, station: p.feed.code, enabled: p.enabled, listed: p.listed, ownPosition: Boolean(p.position),
          live: now - p.feed.lastAt <= R.stationLiveMs, sessions: p.sessions.size,
        })),
        clients: [...sessions].map((s) => ({
          id: s.id, login: s.login, point: s.point.name, version: s.version, agent: s.agent, address: s.ip,
          startedAt: s.startedAt, bytes: s.bytes, queued: s.socket.writableLength,
          position: s.gga ? { lat: s.gga.lat, lon: s.gga.lon, kind: s.gga.kind, sats: s.gga.sats, age: s.gga.age, at: s.ggaAt } : null,
        })),
        refusals: refusals.slice(-50),
        directory: directory ? { url: directoryUrl, lastOkAgeMs: directory.lastOkAt ? now - directory.lastOkAt : null, pending: journal.length } : null,
      };
    },
    // Закрыть сеанс по команде администратора
    'POST /kick': (url, body) => {
      const session = [...sessions].find((s) => s.id === String(body.id));
      if (!session) return { closed: false };
      close(session, String(body.reason || 'закрыт администратором').slice(0, 200));
      return { closed: true, login: session.login };
    },
  }, { host: config.bind, port: cfg.statePort });

  const ports = { state: await state.ready, ntrip: server ? actualPort : null };
  log(server
    ? `раздача: NTRIP на ${publicBind}:${actualPort}, точек ${points.size}${cfg.openAccess ? ', без проверки логина (только для проверки на своём компьютере)' : ''}`
    : 'раздача: порт для роверов выключен в настройках (caster.enabled)');

  return {
    ports,
    feeds,
    points,
    sessions,
    refusals,
    flush: () => (directory ? flush() : null),
    async stop() {
      clearInterval(watchdog);
      clearInterval(flushTimer);
      if (directory) directory.stop();
      bus.stop();
      for (const s of [...sessions]) close(s, 'служба раздачи остановлена');
      for (const socket of sockets) socket.destroy();
      await Promise.all([state.close(), server ? new Promise((resolve) => server.close(resolve)) : null]);
    },
  };
}

if (require.main === module) {
  // Запускающий процесс исчез — служба не остаётся сиротой и не держит порты
  process.on('disconnect', () => process.exit(0));
  const { config, secrets } = loadConfig();
  start({ config, secrets }).catch((err) => {
    console.error(`раздача не запустилась: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { start, RULES, forUsers, emptyMsm };
