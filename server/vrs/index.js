'use strict';
// Служба виртуальных баз (VRS). Слушает потоки всех станций, ведёт сетевой расчёт
// (modules/vrs) и по положению ровера собирает ему наблюдения базы «рядом с ним»: наблюдения
// ближайшей станции, перенесённые в точку ровера, с поправками сети на ионосферу и тропосферу.
//
// Что считать, задаёт управление: сети раздачи с включённым блоком «VRS» — их станции, координаты
// и настройки. Ровера приводит служба раздачи: она держит с этой службой внутреннее соединение,
// сообщает положение ровера и получает готовые кадры RTCM. Если служба VRS остановлена, обычные
// точки подключения работают как прежде.
//
// Эфемериды спутников берутся из открытого архива BKG (в потоках станций их нет).
//
// Запуск отдельно: node server/vrs/index.js

const fs = require('fs');
const net = require('net');
const path = require('path');
const { StreamParser } = require('../../core/stream');
const { llhToEcef, ecefToLlh, D2R, R2D } = require('../../core/geo');
const { BusClient, Decoder, encode } = require('../shared/bus');
const { request, readKey } = require('../shared/directory');
const { jsonServer } = require('../shared/http');
const { loadConfig } = require('../shared/config');
const rtcm = require('../rtcm/messages');
const ephemeris = require('../../modules/rtknet/ephemeris');
const obs = require('../../modules/vrs/obs');
const navlib = require('../../modules/vrs/nav');
const { Network } = require('../../modules/vrs/network');
const { PAIRS } = require('../../modules/vrs/model');
const { OPTIONS, clean } = require('../../modules/vrs/options');

const RULES = {
  pollMs: 5000, // как часто спрашивать у управления список сетей
  navMs: 10 * 60 * 1000, // как часто обновлять эфемериды
  navHours: 6, // эфемериды за столько последних часов
  checkMs: 30000, // как часто сеть проверяет сама себя
  history: 120, // сколько последних проверок хранится на станцию (час)
  masterLostSec: 10, // ведущая станция молчит дольше — виртуальная база переходит на другую
  keepKm: 3, // с работающей ведущей база уходит, только если другая станция ближе на столько
  keepShare: 0.15, // и не меньше чем на такую долю расстояния
  positionSec: 5, // как часто повторять координаты виртуальной базы
  descriptorSec: 10, // и описание оборудования
  minSats: 5, // меньше спутников — эпоха роверу не отдаётся
};

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// По одному сигналу на каждой из двух основных частот системы
function pairOf(sys, sigs) {
  const want = PAIRS[sys];
  const pick = (ids) => { for (const id of ids) { const g = sigs.find((x) => x.sig === id && x.ph !== null); if (g) return g; } return null; };
  return [pick(want.a), pick(want.b)].filter(Boolean);
}

async function start({ config, log = console.log, rules = {}, directoryUrl = process.env.URAL_DIRECTORY || '', directoryKey,
  dataDir = process.env.URAL_DATA || path.join(__dirname, '..', '..', 'backend', 'data'), statePort = Number(process.env.URAL_VRS_PORT || 7105),
  tasksFile = process.env.URAL_VRS_TASKS || '', fetchNav = ephemeris.ensure, clock = () => Date.now() }) {
  const R = { ...RULES, ...rules };
  const startedAt = Date.now();
  const navDir = path.join(dataDir, 'vrs', 'brdc');
  let key = directoryKey;
  let nav = new Map();
  const navState = { at: 0, sats: 0, error: 'ещё не загружены' };
  const engines = new Map(); // номер сети -> расчёт
  const sessions = new Map(); // номер сеанса раздачи -> виртуальная база ровера
  const feeds = new Map(); // код станции -> разбор потока
  let work = { ms: 0, at: Date.now(), last: 0 };
  let faults = 0;
  let lastFault = '';

  // ---------- Эфемериды ----------

  async function loadNav() {
    try {
      const now = clock();
      const got = await fetchNav(navDir, now - R.navHours * 3600000, now);
      if (!got.files.length) { navState.error = got.error || 'архив эфемерид недоступен'; return; }
      const next = new Map();
      for (const file of got.files) navlib.parse(fs.readFileSync(file, 'latin1'), next);
      if (!next.size) { navState.error = 'в файле эфемерид нет спутников'; return; }
      nav = next;
      navState.at = Date.now();
      navState.sats = next.size;
      navState.error = got.error || '';
      for (const e of engines.values()) e.net.setNav(nav);
    } catch (err) {
      navState.error = err.message;
    }
  }

  // ---------- Сети ----------

  // Расчёт заводится заново, только если изменилось то, от чего зависят стороны сети:
  // станции, их координаты или настройки поиска неоднозначностей
  const coreOf = (task, o) => JSON.stringify([task.stations.map((s) => [s.code, s.ecef]), OPTIONS.filter((x) => x.core).map((x) => o[x.key])]);

  function applyTasks(list) {
    const seen = new Set();
    for (const task of list) {
      if (!task || !Number.isInteger(task.id) || !Array.isArray(task.stations)) continue;
      seen.add(task.id);
      const o = clean(task.options || {});
      const stations = task.stations.filter((s) => s && typeof s.code === 'string' && Array.isArray(s.ecef) && s.ecef.length === 3 && s.ecef.every(Number.isFinite));
      const core = coreOf({ stations }, o);
      let e = engines.get(task.id);
      if (!e || e.core !== core) {
        if (e) log(`VRS: сеть ${task.name} — изменились станции или настройки расчёта, поиск неоднозначностей начат заново`);
        e = { id: task.id, core, net: null, checks: new Map(), builtAt: Date.now() };
        e.net = new Network({
          stations: stations.map((s) => ({ code: s.code, ecef: s.ecef })), nav,
          options: { maxKm: o.maxKm, maxLinks: o.maxLinks },
          baseline: { mask: o.arMask, ionoPpm: o.ionoPpm, gradPpm: o.gradPpm, ztdSigma: o.ztdMm / 1000, coordSigma: o.coordMm / 1000, holdSec: o.holdSec, geoSmooth: o.geoSmooth, ionoSmooth: o.ionoSmooth },
        });
        engines.set(task.id, e);
        for (const s of sessions.values()) if (s.engine && s.engine.id === task.id) { s.engine = e; s.master = null; }
      }
      e.name = String(task.name || `VRS${task.id}`);
      e.title = String(task.title || '');
      e.options = o;
      e.stations = stations;
      // На выдачу: настройки, которые действуют сразу
      Object.assign(e.net.o, { aux: o.aux, minAux: o.minAux, method: o.method, strict: o.strict, mask: o.mask, systems: o.systems, limit: o.limit, maxAge: o.maxAge, power: o.power });
      // Сдвиг из системы расчёта в систему, в которой сеть объявляет координаты базы
      e.shifts = stations.filter((s) => Array.isArray(s.out) && s.out.length === 3 && s.out.every(Number.isFinite)).map((s) => ({ ecef: s.ecef, d: [s.out[0] - s.ecef[0], s.out[1] - s.ecef[1], s.out[2] - s.ecef[2]] }));
    }
    for (const [id, e] of engines) {
      if (seen.has(id)) continue;
      engines.delete(id);
      for (const s of [...sessions.values()]) if (s.engine === e) end(s, 'сеть больше не выдаёт виртуальные базы');
      log(`VRS: сеть ${e.name} снята`);
    }
  }

  // Координаты точки в системе, которую объявляет сеть: сдвиг берётся с ближайших станций
  function announce(e, pos) {
    if (!e.shifts.length) return pos;
    let sw = 0; const d = [0, 0, 0];
    for (const s of e.shifts) {
      const w = 1 / Math.max(1000, dist(s.ecef, pos)) ** 2;
      sw += w;
      for (let i = 0; i < 3; i++) d[i] += w * s.d[i];
    }
    return [pos[0] + d[0] / sw, pos[1] + d[1] / sw, pos[2] + d[2] / sw];
  }

  let pollBusy = false;
  async function poll() {
    if (pollBusy) return;
    pollBusy = true;
    try {
      if (tasksFile) {
        applyTasks(JSON.parse(fs.readFileSync(tasksFile, 'utf8')).networks || []);
      } else if (directoryUrl) {
        if (!key) key = readKey();
        const res = await request('GET', `${directoryUrl}/internal/vrs`, key);
        if (res.ok && Array.isArray(res.body.networks)) applyTasks(res.body.networks);
      }
    } catch (err) {
      log(`VRS: список сетей не прочитан — ${err.message}`);
    } finally {
      pollBusy = false;
    }
  }

  // ---------- Потоки станций ----------

  function onData(code, body) {
    if (!engines.size) return;
    let feed = feeds.get(code);
    if (!feed) { feed = { parser: new StreamParser(), asm: new obs.Assembler(), lastAt: 0, epochs: 0 }; feeds.set(code, feed); }
    const t0 = process.hrtime.bigint();
    const near = obs.gpsFromUnix(clock());
    for (const fr of feed.parser.push(body)) {
      if (fr.kind !== 'rtcm' || !obs.isMsm(fr.type)) continue;
      const epoch = feed.asm.push(fr.type, fr.payload, near);
      if (!epoch) continue;
      feed.lastAt = Date.now();
      feed.epochs += 1;
      for (const e of engines.values()) {
        if (!e.net.stations.has(code)) continue;
        try {
          if (e.net.push(code, epoch.t, epoch.raw)) for (const s of sessions.values()) if (s.engine === e && s.master === code) emit(s);
        } catch (err) {
          e.fault = err.message;
        }
      }
    }
    work.ms += Number(process.hrtime.bigint() - t0) / 1e6;
  }

  // ---------- Виртуальные базы роверов ----------

  let link = null; // соединение службы раздачи
  const tell = (header, body) => { if (link && !link.destroyed) link.write(encode(header, body)); };

  function end(s, reason) {
    sessions.delete(s.id);
    tell({ t: 'end', id: s.id, reason });
  }

  // Положение ровера. Виртуальная база ставится в первое присланное положение и остаётся там,
  // пока ровер не уйдёт дальше заданного: смена базы для ровера — новый поиск решения.
  function onRover(m) {
    const e = [...engines.values()].find((x) => x.name === m.net);
    if (!e) { tell({ t: 'end', id: m.id, reason: 'сеть не выдаёт виртуальные базы' }); return; }
    if (!Number.isFinite(m.lat) || !Number.isFinite(m.lon)) return;
    let s = sessions.get(m.id);
    if (!s) {
      s = { id: m.id, login: String(m.login || ''), engine: e, pos: null, master: null, seq: 0, startedAt: Date.now(), sent: 0, lastSentAt: 0, positionAt: 0, descriptorAt: 0, info: null, moves: 0 };
      sessions.set(m.id, s);
    }
    s.engine = e;
    const h = Number.isFinite(m.h) ? m.h : 0;
    const at = llhToEcef(m.lat * D2R, m.lon * D2R, h);
    s.rover = { lat: m.lat, lon: m.lon, h, at: Date.now() };
    if (!s.pos || dist(at, s.pos) > e.options.moveKm * 1000) {
      if (s.pos) { s.seq += 1; s.moves += 1; }
      s.pos = at;
      s.master = null;
      s.positionAt = 0;
    }
    choose(s);
  }

  // Ведущая станция: ближайшая из тех, что на связи. Ушедший ровер переходит на другую, только
  // если она заметно ближе; замолчавшая ведущая заменяется сразу.
  function choose(s) {
    const e = s.engine;
    const now = obs.gpsFromUnix(clock());
    const live = [...e.net.stations.values()].filter((st) => st.epoch && now - st.epoch.t <= R.masterLostSec);
    if (!live.length) return;
    const far = (st) => dist(st.ecef, s.pos);
    const best = live.reduce((a, b) => (far(b) < far(a) ? b : a));
    const cur = s.master ? e.net.stations.get(s.master) : null;
    if (cur && live.includes(cur) && (best === cur || far(cur) - far(best) < Math.max(R.keepKm * 1000, far(cur) * R.keepShare))) return;
    if (cur) s.seq += 1; // для ровера это другая база: номер станции меняется, решение ищется заново
    s.master = best.code;
    s.masterAt = Date.now();
    s.positionAt = 0;
  }

  function emit(s) {
    const e = s.engine;
    const o = e.options;
    const st = e.net.stations.get(s.master);
    const t = st.epoch.t;
    if (o.rate > 1 && Math.round(t) % o.rate !== 0) return;
    const v = e.net.virtual(s.pos, { master: s.master, t });
    const used = v ? v.sats.filter((x) => o.systems.includes(x.sys)) : [];
    s.info = { master: s.master, aux: v ? v.aux : [], sats: used.length, reach: v ? v.reach : 1, at: Date.now() };
    if (used.length < R.minSats) return;
    const stationId = (o.stationId + s.seq) % 4096;
    const out = [];
    const now = Date.now();
    if (now - s.positionAt >= R.positionSec * 1000) {
      s.positionAt = now;
      out.push(rtcm.encodePosition({ stationId, ecef: announce(e, s.pos), antennaHeight: 0 }));
    }
    if (now - s.descriptorAt >= R.descriptorSec * 1000) {
      s.descriptorAt = now;
      out.push(rtcm.encodeDescriptor({ type: 1008, stationId, antenna: o.antenna, antennaSerial: '' }));
      out.push(rtcm.encodeDescriptor({ type: 1033, stationId, antenna: o.antenna, receiver: 'URALSURVEY VRS', firmware: '1', receiverSerial: '' }));
    }
    const systems = [...new Set(used.map((x) => x.sys))];
    systems.forEach((sys, i) => {
      let sats = used.filter((x) => x.sys === sys);
      if (o.signals === 'pair') sats = sats.map((x) => ({ ...x, sigs: pairOf(sys, x.sigs) }));
      const body = obs.encode({ sys, stationId, epoch: obs.epochField(sys, t), multiple: i < systems.length - 1, sats });
      if (body) out.push(rtcm.frame(body));
    });
    s.sent += 1;
    s.lastSentAt = now;
    tell({ t: 'data', id: s.id, master: s.master, sats: used.length }, Buffer.concat(out));
  }

  const server = net.createServer((socket) => {
    // Служба раздачи одна: новое соединение заменяет прежнее, сеансы прежнего снимаются
    if (link && link !== socket) link.destroy();
    link = socket;
    sessions.clear();
    socket.setNoDelay(true);
    const decoder = new Decoder();
    socket.on('data', (chunk) => {
      try {
        for (const m of decoder.push(chunk)) {
          const h = m.header;
          if (h.t === 'rover') onRover(h);
          else if (h.t === 'close') sessions.delete(h.id);
        }
      } catch (err) {
        socket.destroy();
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => { if (link === socket) { link = null; sessions.clear(); } });
  });
  const linkPort = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.vrs.port, config.bind, () => resolve(server.address().port));
  });

  // ---------- Самопроверка и присмотр ----------

  function selfCheck() {
    for (const e of engines.values()) {
      for (const st of e.net.stations.values()) {
        let c = null;
        try { c = e.net.check(st.code); } catch (err) { e.fault = err.message; }
        const list = e.checks.get(st.code) || [];
        list.push(c && c.sats >= 4 ? { at: Date.now(), master: c.master, km: c.km, aux: c.aux, reach: c.reach, sats: c.sats, phase: c.phase, iono: c.iono, geo: c.geo, rawIono: c.rawIono, rawGeo: c.rawGeo } : { at: Date.now(), sats: c ? c.sats : 0 });
        while (list.length > R.history) list.shift();
        e.checks.set(st.code, list);
      }
    }
  }

  const watch = setInterval(() => {
    try { guard(); } catch (err) { faults += 1; lastFault = err.message; }
  }, 1000);
  function guard() {
    const now = Date.now();
    if (now - work.at >= 5000) { work = { ms: 0, at: now, last: work.ms / ((now - work.at) / 1000) }; }
    for (const s of [...sessions.values()]) {
      const e = s.engine;
      if (!engines.has(e.id)) { end(s, 'сеть больше не выдаёт виртуальные базы'); continue; }
      choose(s);
      const quiet = now - Math.max(s.lastSentAt, s.startedAt);
      if (quiet > e.options.waitSec * 1000) end(s, s.sent ? 'сеть перестала давать поправки для этого места' : 'сеть ещё не готова: неоднозначности между станциями не найдены');
    }
  }
  const checkTimer = setInterval(() => { try { selfCheck(); } catch (err) { faults += 1; lastFault = err.message; } }, R.checkMs);
  const pollTimer = setInterval(poll, R.pollMs);
  const navTimer = setInterval(loadNav, R.navMs);
  for (const tm of [watch, checkTimer, pollTimer, navTimer]) if (tm.unref) tm.unref();

  const bus = new BusClient({ host: config.bind, port: config.ingest.busPort });
  // Сбой в расчёте одной порции не должен останавливать службу
  bus.on('message', (header, body) => {
    if (header.t !== 'data') return;
    try { onData(header.station, body); } catch (err) { faults += 1; lastFault = err.message; }
  });
  bus.start();
  await loadNav();
  await poll();

  // ---------- Состояние для панели ----------

  const mm = (v) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 1000));
  function describe(e) {
    const now = Date.now();
    const gps = obs.gpsFromUnix(clock());
    const rms = (list, k) => { const v = list.filter((c) => Number.isFinite(c[k])); return v.length ? Math.sqrt(v.reduce((a, c) => a + c[k] * c[k], 0) / v.length) : null; };
    return {
      id: e.id, name: e.name, title: e.title, options: e.options, builtAt: e.builtAt, fault: e.fault || '',
      stations: [...e.net.stations.values()].map((st) => {
        const list = (e.checks.get(st.code) || []).filter((c) => c.phase !== undefined);
        const last = list[list.length - 1] || null;
        const g = ecefToLlh(st.ecef[0], st.ecef[1], st.ecef[2]);
        return {
          code: st.code, lat: g.lat * R2D, lon: g.lon * R2D, live: Boolean(st.epoch) && gps - st.epoch.t <= e.options.maxAge, ageSec: st.epoch ? Math.round(gps - st.epoch.t) : null,
          sats: st.epoch ? st.epoch.sats.size : 0, links: st.links.length,
          // Самопроверка: ошибка сети в точке этой станции за последний час и сейчас, миллиметры
          check: last ? { master: last.master, km: Math.round(last.km), aux: last.aux, reach: last.reach, sats: last.sats, now: mm(last.phase), hour: mm(rms(list, 'phase')), iono: mm(rms(list, 'iono')), geo: mm(rms(list, 'geo')), rawIono: mm(rms(list, 'rawIono')), rawGeo: mm(rms(list, 'rawGeo')), series: list.slice(-60).map((c) => mm(c.phase)) } : null,
        };
      }),
      baselines: e.net.baselines.map((bl) => {
        const s = bl.summary();
        return { a: s.a, b: s.b, km: Math.round(s.km * 10) / 10, ageSec: s.t ? Math.round(gps - s.t) : null, seen: s.seen, fixed: s.fixed, by: s.by, ztd: mm(s.ztd), shift: s.shift.map(mm), grad: s.grad.map(mm), count: s.count, triangles: bl.tri, sinceSec: bl.started ? Math.round(gps - bl.started) : null };
      }),
      triangles: e.net.triangles.length,
      sessions: [...sessions.values()].filter((s) => s.engine === e).map((s) => ({
        id: s.id, login: s.login, startedAt: s.startedAt, master: s.master, sent: s.sent, quietSec: Math.round((now - Math.max(s.lastSentAt, s.startedAt)) / 1000), moves: s.moves,
        rover: s.rover, base: s.pos ? (() => { const g = ecefToLlh(s.pos[0], s.pos[1], s.pos[2]); return { lat: g.lat * R2D, lon: g.lon * R2D }; })() : null,
        info: s.info,
      })),
    };
  }

  const state = jsonServer({
    '/state': () => ({
      service: 'vrs', startedAt, ingestLink: bus.connected, casterLink: Boolean(link), linkPort,
      nav: { sats: navState.sats, ageSec: navState.at ? Math.round((Date.now() - navState.at) / 1000) : null, error: navState.error },
      load: Math.round(work.last), // миллисекунд работы на секунду времени
      faults, lastFault,
      networks: [...engines.values()].map(describe),
    }),
    // Проба: какие наблюдения получил бы ровер в этой точке (для проверки из панели и тестов)
    '/probe': (url) => {
      const e = engines.get(Number(url.searchParams.get('net')));
      if (!e) return { error: 'нет такой сети' };
      const pos = llhToEcef(Number(url.searchParams.get('lat')) * D2R, Number(url.searchParams.get('lon')) * D2R, Number(url.searchParams.get('h') || 0));
      const v = e.net.virtual(pos, {});
      return v ? { t: v.t, master: v.master, aux: v.aux, reach: v.reach, sats: v.sats.map((x) => ({ sat: x.sat, el: Math.round(x.el * R2D), helpers: x.n, signals: x.sigs.length })) } : { error: 'сеть ещё не готова' };
    },
  }, { host: config.bind, port: statePort });
  const ports = { state: await state.ready, link: linkPort };
  log(`VRS: служба запущена, сетей ${engines.size}, эфемериды: ${navState.error || `${navState.sats} спутников`}`);

  return {
    ports, engines, sessions, poll, selfCheck, loadNav, onData,
    async stop() {
      for (const tm of [watch, checkTimer, pollTimer, navTimer]) clearInterval(tm);
      bus.stop();
      if (link) link.destroy();
      await Promise.all([state.close(), new Promise((resolve) => server.close(resolve))]);
    },
  };
}

if (require.main === module) {
  process.on('disconnect', () => process.exit(0));
  const { config } = loadConfig();
  start({ config }).catch((err) => {
    console.error(`служба VRS не запустилась: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { start, RULES };
