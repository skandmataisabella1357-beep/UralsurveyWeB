'use strict';
// Сеанс одной станции: канал связи + разбор потока + текущее состояние.
// Состояние отдаётся наружу снимком (snapshot) — простым объектом без ссылок
// на внутренности, его можно передавать в окно или писать в журнал.

const { EventEmitter } = require('events');
const { Transport, STATES, probePort } = require('./transport');
const { StreamParser } = require('./stream');
const rtcm = require('./rtcm3');
const { parseGga } = require('./nmea');
const { ecefToLlh, llhToEcef, R2D } = require('./geo');
const { solveEpoch, PositionAverager } = require('./spp');
const { Relay } = require('./relay');

const OBS_TTL_MS = 10000; // сколько помним наблюдения системы без обновления
const RTCM_POS_TTL_MS = 120000; // сообщения 1005/1006 приходят редко
const LOG_LIMIT = 200;

class StationSession extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.createdAt = Date.now();
    this.transport = new Transport(cfg);
    this.parser = new StreamParser();
    this.log = [];
    this.resetData();

    this.bytesTotal = 0;
    this.rate = []; // посекундные счётчики байтов
    this.stateSince = Date.now();
    this.formatLabel = '';

    this.relay = cfg.relayPort ? new Relay(cfg.relayPort) : null;
    if (this.relay) this.relay.on('log', (level, text) => this.addLog(level, text));

    this.transport.on('data', (chunk) => this.onData(chunk));
    this.transport.on('log', (level, text) => this.addLog(level, text));
    this.transport.on('state', (state, detail) => this.onState(state, detail));
  }

  resetData() {
    this.stationId = null;
    this.messages = new Map();
    this.decodeErrors = 0;
    this.rtcmPos = null;
    this.gga = null;
    this.descriptors = {};
    this.obs = new Map(); // система -> { at, sats, level }
    this.ephGps = new Map(); // номер спутника -> эфемериды
    this.ephSeen = new Map(); // система -> Set обозначений спутников
    this.averager = new PositionAverager();
    this.lastFix = null;
    this.fixIssue = null;
    this.solvedEpoch = null;
  }

  start() {
    this.probe = null;
    this.probeStarted = false;
    if (this.relay) this.relay.start();
    this.transport.start();
  }

  stop() {
    clearTimeout(this.probeTimer);
    this.transport.stop();
    if (this.relay) this.relay.stop();
  }

  // Порт принял соединение и молчит: один раз за запуск выясняем, что это за порт
  scheduleProbe() {
    if (this.cfg.mode !== 'tcp' || this.probeStarted) return;
    clearTimeout(this.probeTimer);
    this.probeTimer = setTimeout(async () => {
      if (this.transport.state !== 'waiting' || this.probeStarted) return;
      this.probeStarted = true;
      const res = await probePort(this.cfg.host, this.cfg.port);
      if (this.bytesTotal > 0) return; // данные пошли сами, проверка уже не нужна
      this.probe = res;
      this.addLog('warn', `Проверка порта: ${probeSummary(res)}`);
    }, 4000);
    if (this.probeTimer.unref) this.probeTimer.unref();
  }

  addLog(level, text) {
    // Одинаковые записи подряд (например, повторные неудачные попытки) сворачиваем в одну
    const last = this.log[this.log.length - 1];
    if (last && last.text === text) {
      last.t = Date.now();
      last.repeat = (last.repeat || 1) + 1;
      return;
    }
    this.log.push({ t: Date.now(), level, text });
    if (this.log.length > LOG_LIMIT) this.log.shift();
  }

  onState(state, detail) {
    this.stateSince = Date.now();
    if (state === 'waiting') this.scheduleProbe();
    if (state === 'online') {
      this.probe = null;
      this.addLog('info', 'Данные идут');
    }
    else if (state === 'connecting') this.parser.reset();
    else if (state === 'error') this.addLog('error', `Остановлено: ${detail}`);
    else if (state === 'listening') this.addLog('info', `Ждём подключения приёмника, ${detail}`);
    this.emit('state', state);
  }

  onData(chunk) {
    const now = Date.now();
    if (this.relay) this.relay.write(chunk); // раздаём дальше раньше любого разбора
    this.emit('raw', chunk);
    this.bytesTotal += chunk.length;
    const sec = Math.floor(now / 1000);
    const last = this.rate[this.rate.length - 1];
    if (last && last.sec === sec) last.bytes += chunk.length;
    else this.rate.push({ sec, bytes: chunk.length });
    while (this.rate.length && this.rate[0].sec < sec - 10) this.rate.shift();

    for (const frame of this.parser.push(chunk)) {
      if (frame.kind === 'rtcm') this.onRtcm(frame, now);
      else this.onNmea(frame.line, now);
    }

    const label = this.parser.format().label;
    if (label !== this.formatLabel) {
      if (this.parser.format().known || this.parser.stats.bytes > 4096) {
        this.addLog('info', `Формат потока: ${label}`);
      }
      this.formatLabel = label;
    }
  }

  onRtcm(frame, now) {
    const { type, payload } = frame;
    let m = this.messages.get(type);
    if (!m) {
      m = { count: 0, lastAt: 0, interval: null };
      this.messages.set(type, m);
    }
    if (m.lastAt) {
      const d = now - m.lastAt;
      m.interval = m.interval === null ? d : m.interval * 0.8 + d * 0.2;
    }
    m.count++;
    m.lastAt = now;

    try {
      if (type === 1005 || type === 1006) {
        const p = rtcm.decodeStationPosition(type, payload);
        this.stationId = p.stationId;
        if (Math.hypot(...p.ecef) > 6.0e6) {
          if (!this.rtcmPos) this.addLog('info', `Координаты станции получены из сообщения ${type}`);
          this.rtcmPos = { ...p, type, at: now };
        }
      } else if (type === 1007 || type === 1008 || type === 1033) {
        const d = rtcm.decodeDescriptors(type, payload);
        this.stationId = d.stationId;
        for (const key of ['antenna', 'antennaSerial', 'receiver', 'firmware', 'receiverSerial']) {
          if (d[key]) this.descriptors[key] = d[key];
        }
      } else if (rtcm.isMsm(type)) {
        const obs = rtcm.decodeMsm(type, payload);
        this.stationId = obs.stationId;
        // Наблюдения одной системы за эпоху могут прийти несколькими сообщениями — склеиваем их
        const prev = this.obs.get(obs.sys);
        let sats = obs.sats;
        if (prev && prev.epoch === obs.epoch && now - prev.at < 3000) sats = mergeSats(prev.sats, obs.sats);
        this.obs.set(obs.sys, { at: now, level: obs.level, epoch: obs.epoch, sats });
        // Считаем положение, когда эпоха GPS собрана: по признаку последнего сообщения эпохи
        // либо когда пришла уже следующая эпоха GPS
        const gps = this.obs.get('GPS');
        if (obs.sys === 'GPS' && prev && prev.epoch !== obs.epoch && prev.epoch !== this.solvedEpoch) {
          this.solve(prev, now);
        }
        if (!obs.multiple && gps && gps.epoch !== this.solvedEpoch) this.solve(gps, now);
      } else if ((type >= 1001 && type <= 1004) || (type >= 1009 && type <= 1012)) {
        const h = rtcm.decodeLegacyObsHeader(type, payload);
        this.stationId = h.stationId;
        this.obs.set(h.sys, { at: now, level: 0, legacyCount: h.satCount, sats: [] });
      } else if (rtcm.EPHEMERIS_TYPES[type]) {
        const s = rtcm.ephemerisSat(type, payload);
        if (!this.ephSeen.has(s.sys)) this.ephSeen.set(s.sys, new Set());
        this.ephSeen.get(s.sys).add(s.label);
        if (type === 1019) {
          const eph = rtcm.decodeGpsEphemeris(payload);
          this.ephGps.set(eph.prn, eph);
        }
      }
    } catch (err) {
      this.decodeErrors++;
      if (this.decodeErrors <= 5) this.addLog('warn', `Сообщение ${type} не разобрано: ${err.message}`);
    }
  }

  onNmea(line, now) {
    const g = parseGga(line);
    if (g) this.gga = { ...g, at: now };
  }

  // Координат в потоке нет — считаем их сами по наблюдениям и эфемеридам GPS
  solve(obs, now) {
    this.solvedEpoch = obs.epoch;
    if (this.rtcmPos && now - this.rtcmPos.at < RTCM_POS_TTL_MS) return;
    if (obs.level < 4) {
      this.fixIssue = { reason: 'format' };
      return;
    }
    const res = solveEpoch(obs.epoch / 1000, obs.sats, this.ephGps);
    if (!res.ok) {
      this.fixIssue = { reason: res.reason, available: res.available, visible: obs.sats.length };
      return;
    }
    this.fixIssue = null;
    const first = this.averager.count === 0;
    if (this.averager.add(res.ecef, res.gdop)) {
      this.lastFix = { at: now, satsUsed: res.satsUsed, mode: res.mode, gdop: res.gdop };
      if (first) {
        this.addLog('info', `Координаты вычислены по наблюдениям GPS, спутников в решении: ${res.satsUsed}`);
      }
    }
  }

  position(now) {
    const make = (ecef, extra) => {
      const g = ecefToLlh(ecef[0], ecef[1], ecef[2]);
      return { ecef, lat: g.lat * R2D, lon: g.lon * R2D, h: g.h, ...extra };
    };
    if (this.rtcmPos && now - this.rtcmPos.at < RTCM_POS_TTL_MS) {
      return make(this.rtcmPos.ecef, {
        source: 'rtcm',
        messageType: this.rtcmPos.type,
        antennaHeight: this.rtcmPos.antennaHeight,
      });
    }
    if (this.averager.count > 0) {
      return make(this.averager.mean.slice(), {
        source: 'computed',
        epochs: this.averager.count,
        sigma: this.averager.sigma(),
        satsUsed: this.lastFix.satsUsed,
        dualFrequency: this.lastFix.mode === 'dual',
      });
    }
    if (this.gga) {
      return make(llhToEcef(this.gga.lat, this.gga.lon, this.gga.h), { source: 'nmea' });
    }
    return null;
  }

  // Почему точки ещё нет на карте
  positionNote() {
    const st = this.transport.state;
    if (st !== 'online') return null;
    const fmt = this.parser.format();
    if (!fmt.known) {
      return this.parser.stats.bytes > 4096
        ? 'Формат потока не распознан: координаты получить нельзя.'
        : null;
    }
    const issue = this.fixIssue;
    if (!issue) return 'Ждём координаты станции или наблюдения GPS.';
    switch (issue.reason) {
      case 'ephemeris':
        return `Координат в потоке нет, считаем по наблюдениям. Эфемериды GPS есть для ${issue.available} из ${issue.visible} спутников, нужно не меньше 4.`;
      case 'format':
        return 'Координат в потоке нет, а наблюдения идут в сокращённом формате (MSM1–3): вычислить положение по ним нельзя.';
      default:
        return 'Координат в потоке нет, считаем по наблюдениям. Решение пока неустойчиво.';
    }
  }

  constellations(now) {
    const out = [];
    for (const sys of rtcm.SYSTEMS) {
      const o = this.obs.get(sys.key);
      if (!o || now - o.at > OBS_TTL_MS) continue;
      const seen = this.ephSeen.get(sys.key);
      const codes = new Set();
      const sats = o.sats.map((s) => {
        let best = null;
        for (const sig of s.signals) {
          codes.add(sig.code);
          if (sig.cnr !== null && (best === null || sig.cnr > best)) best = sig.cnr;
        }
        let eph = Boolean(seen && seen.has(s.label));
        if (sys.key === 'GPS' && eph) {
          const e = this.ephGps.get(s.prn);
          eph = Boolean(e) && e.health === 0;
        }
        return { label: s.label, cnr: best, eph };
      });
      out.push({
        key: sys.key,
        name: sys.name,
        count: o.legacyCount !== undefined ? o.legacyCount : sats.length,
        signals: [...codes].sort(),
        sats,
      });
    }
    return out;
  }

  snapshot() {
    const now = Date.now();
    const t = this.transport;
    const sec = Math.floor(now / 1000);
    const recent = this.rate.filter((r) => r.sec < sec && r.sec >= sec - 5);
    const bytesPerSec = recent.reduce((s, r) => s + r.bytes, 0) / 5;
    const fmt = this.parser.format();
    const constellations = this.constellations(now);
    const position = this.position(now);

    const ephemeris = {};
    for (const [sys, set] of this.ephSeen) ephemeris[sys] = set.size;

    return {
      id: this.cfg.id,
      name: this.cfg.name,
      demo: Boolean(this.cfg.demo),
      mode: this.cfg.mode,
      endpoint: endpointLabel(this.cfg),
      link: {
        state: t.state,
        stateLabel: STATES[t.state],
        detail: t.detail,
        stateSince: this.stateSince,
        bytesTotal: this.bytesTotal,
        bitsPerSec: t.state === 'online' ? bytesPerSec * 8 : 0,
        lastDataAgeMs: t.lastDataAt ? now - t.lastDataAt : null,
        reconnects: t.reconnects,
      },
      probe: this.probe,
      relay: this.relay ? this.relay.status() : null,
      format: { known: fmt.known, label: fmt.label },
      stationId: this.stationId,
      position,
      positionNote: position ? null : this.positionNote(),
      descriptors: { ...this.descriptors },
      constellations,
      satTotal: constellations.reduce((s, c) => s + c.count, 0),
      ephemeris,
      messages: [...this.messages.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([type, m]) => ({
          type,
          name: rtcm.messageName(type),
          count: m.count,
          intervalSec: m.interval === null ? null : m.interval / 1000,
          ageSec: (now - m.lastAt) / 1000,
        })),
      frames: this.parser.stats.rtcmFrames,
      crcErrors: this.parser.stats.crcErrors,
      log: this.log.slice(-60),
    };
  }
}

function mergeSats(a, b) {
  const byPrn = new Map(a.map((s) => [s.prn, { ...s, signals: [...s.signals] }]));
  for (const s of b) {
    const have = byPrn.get(s.prn);
    if (!have) {
      byPrn.set(s.prn, s);
      continue;
    }
    for (const sig of s.signals) {
      if (!have.signals.some((x) => x.id === sig.id)) have.signals.push(sig);
    }
  }
  return [...byPrn.values()].sort((x, y) => x.prn - y.prn);
}

function probeSummary(res) {
  if (res.tunnel && res.kind === 'silent') {
    return `соединение идёт через VPN (${res.tunnel}) и до станции, похоже, не доходит: данных нет`;
  }
  switch (res.kind) {
    case 'caster': return `это NTRIP-кастер, точек подключения: ${res.mountpoints.length}`;
    case 'stream': return 'после запроса порт начал отдавать двоичный поток';
    case 'text': return `порт ответил текстом: ${res.text}`;
    case 'silent': return 'порт принимает соединение, но ничего не передаёт и на запрос NTRIP не отвечает';
    default: return `проверить не удалось: ${res.text}`;
  }
}

function endpointLabel(cfg) {
  if (cfg.mode === 'listen') return `ждём на порту ${cfg.port}`;
  if (cfg.mode === 'ntrip') return `ntrip://${cfg.host}:${cfg.port}/${cfg.mountpoint || ''}`;
  return `tcp://${cfg.host}:${cfg.port}`;
}

// Набор станций. Раз в секунду отдаёт снимки всех сеансов.
class StationHub extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();
    this.timer = setInterval(() => this.emit('snapshot', this.snapshots()), 1000);
    if (this.timer.unref) this.timer.unref();
  }

  set(cfg) {
    const old = this.sessions.get(cfg.id);
    if (old) old.stop();
    const session = new StationSession(cfg);
    session.on('raw', (chunk) => this.emit('raw', cfg, chunk));
    this.sessions.set(cfg.id, session);
    session.start();
    return session;
  }

  remove(id) {
    const s = this.sessions.get(id);
    if (!s) return;
    s.stop();
    this.sessions.delete(id);
  }

  reconnect(id) {
    const s = this.sessions.get(id);
    if (!s) return;
    s.addLog('info', 'Переподключение по команде оператора');
    s.stop();
    s.start();
  }

  snapshots() {
    return [...this.sessions.values()].map((s) => s.snapshot());
  }

  stopAll() {
    clearInterval(this.timer);
    for (const s of this.sessions.values()) s.stop();
    this.sessions.clear();
  }
}

module.exports = { StationSession, StationHub };
