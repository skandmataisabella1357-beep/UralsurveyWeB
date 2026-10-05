'use strict';
// Служба приёма: держит по одному соединению с каждой станцией, проверяет и разбирает поток
// общим ядром и отдаёт его потребителям внутри сервера по шине.
//
// Запуск отдельно: node server/ingest/index.js

const { StationHub } = require('../../core/station');
const { createSimulator, syntheticSource } = require('../../core/simulator');
const { BusServer } = require('../shared/bus');
const { StationGate } = require('./gate');
const { Directory } = require('../shared/directory');
const { ecefToLlh, R2D } = require('../../core/geo');
const { jsonServer } = require('../shared/http');
const { loadConfig, credentials } = require('../shared/config');

// Настройки сеанса ядра для станции из config.json
function sessionConfig(station, secrets) {
  const src = station.source;
  const base = { id: station.code, name: station.name || station.code };
  if (src.mode === 'listen') return { ...base, mode: 'listen', port: src.port };
  if (src.mode === 'tcp') return { ...base, mode: 'tcp', host: src.host, port: src.port };
  const { username, password } = credentials(secrets, src.credentials);
  return { ...base, mode: 'ntrip', host: src.host, port: src.port, mountpoint: src.mountpoint, username, password };
}

// directoryUrl — адрес службы управления: тогда станции берутся из базы и меняются на ходу.
async function start({ config, secrets, log = console.log, directoryUrl = process.env.URAL_DIRECTORY || '', directoryKey }) {
  const startedAt = Date.now();
  const hub = new StationHub();
  const bus = new BusServer({ host: config.bind, port: config.ingest.busPort });
  const running = new Map(); // код станции -> { key, sim, gate }
  const gates = new Map(); // код станции -> шлюз перед ядром
  let stations = config.stations;

  // Потребитель при подключении и при каждой смене состава узнаёт список станций
  const roster = () => ({ t: 'stations', stations: stations.map((s) => ({ code: s.code, name: s.name || s.code })) });
  bus.on('client', (socket) => bus.send(socket, roster()));
  hub.on('raw', (cfg, chunk) => bus.publish({ t: 'data', station: cfg.id, at: Date.now() }, chunk));

  async function stopStation(code) {
    const item = running.get(code);
    if (!item) return;
    running.delete(code);
    hub.remove(code);
    if (item.sim) await item.sim.close();
    if (item.gate) {
      gates.delete(code);
      await item.gate.close();
    }
  }

  async function startStation(station, passwords) {
    const src = station.source;
    const base = { id: station.code, name: station.name || station.code };
    const item = { key: JSON.stringify(station), sim: null, gate: null };
    running.set(station.code, item);
    if (src.mode === 'sim') {
      // Имитатор: станция без настоящего приёмника, для проверки сервера
      let { lat, lon, h } = src;
      if (src.ecef) {
        const g = ecefToLlh(src.ecef[0], src.ecef[1], src.ecef[2]);
        lat = g.lat * R2D;
        lon = g.lon * R2D;
        h = g.h;
      }
      item.sim = createSimulator({ source: syntheticSource({ name: station.code, lat, lon, h: h || 200, stationId: src.stationId || 1 }) });
      const port = await item.sim.ready;
      hub.set({ ...base, mode: 'tcp', host: '127.0.0.1', port, simulated: true });
    } else if (src.mode === 'listen') {
      // База сама шлёт поток на свой порт. Перед ядром стоит шлюз: адрес, пароль станции
      // и правило «живое соединение молчащим не заменяется». Ядро читает шлюз как обычный порт.
      item.gate = await new StationGate({
        code: station.code,
        host: config.ingest.publicBind || config.bind,
        port: src.port,
        allow: src.allow || [],
        password: src.stationPassword || (passwords && passwords[station.code]) || '',
        log,
      }).ready;
      gates.set(station.code, item.gate);
      hub.set({ ...base, mode: 'tcp', host: '127.0.0.1', port: item.gate.pipePort });
    } else if (src.password !== undefined || src.username !== undefined) {
      // Источник из базы: логин и пароль пришли вместе со справочником
      hub.set({ ...base, mode: src.mode, host: src.host, port: src.port, mountpoint: src.mountpoint, username: src.username || '', password: src.password || '' });
    } else {
      hub.set(sessionConfig(station, secrets));
    }
  }

  // Приводит набор станций к заданному: новые заводятся, исчезнувшие останавливаются,
  // изменённые перезапускаются. Остальные продолжают работать без перерыва.
  let applying = Promise.resolve();
  function setStations(list, passwords) {
    applying = applying.then(async () => {
      const wanted = new Map(list.map((s) => [s.code, s]));
      for (const code of [...running.keys()]) {
        const next = wanted.get(code);
        if (!next || JSON.stringify(next) !== running.get(code).key) await stopStation(code);
      }
      for (const station of list) {
        if (running.has(station.code)) continue;
        try {
          await startStation(station, passwords);
        } catch (err) {
          running.delete(station.code);
          log(`приём: станция ${station.code} не запущена — ${err.message}`);
        }
      }
      stations = list;
      bus.publish(roster());
    });
    return applying;
  }

  await setStations(config.stations, secrets && secrets.stationPasswords);

  let directory = null;
  if (directoryUrl) {
    directory = new Directory({ url: directoryUrl, key: directoryKey });
    directory.on('update', (dir) => {
      setStations(dir.stations).then(() => log(`приём: справочник из базы — станций ${dir.stations.length}`));
    });
    directory.start();
  }

  const state = jsonServer({
    '/state': () => ({
      service: 'ingest',
      startedAt,
      consumers: bus.clients.size,
      stations: hub.snapshots(),
      gates: [...gates.values()].map((g) => g.snapshot()),
    }),
  }, { host: config.bind, port: config.ingest.statePort });

  const ports = { bus: await bus.ready, state: await state.ready };
  log(`приём: станций ${stations.length}, шина на ${config.bind}:${ports.bus}, состояние на ${config.bind}:${ports.state}`);

  return {
    ports,
    hub,
    gates,
    setStations,
    async stop() {
      if (directory) directory.stop();
      await applying;
      for (const code of [...running.keys()]) await stopStation(code);
      hub.stopAll();
      await Promise.all([bus.close(), state.close()]);
    },
  };
}

if (require.main === module) {
  // Запускающий процесс исчез — служба не остаётся сиротой и не держит порты
  process.on('disconnect', () => process.exit(0));
  const { config, secrets } = loadConfig();
  start({ config, secrets }).catch((err) => {
    console.error(`приём не запустился: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { start, sessionConfig };
