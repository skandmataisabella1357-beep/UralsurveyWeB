'use strict';
// Служба приёма: держит по одному соединению с каждой станцией, проверяет и разбирает поток
// общим ядром и отдаёт его потребителям внутри сервера по шине.
//
// Запуск отдельно: node server/ingest/index.js

const { StationHub } = require('../../core/station');
const { createSimulator, syntheticSource } = require('../../core/simulator');
const { BusServer } = require('../shared/bus');
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

async function start({ config, secrets, log = console.log }) {
  const startedAt = Date.now();
  const hub = new StationHub();
  const sims = [];
  const bus = new BusServer({ host: config.bind, port: config.ingest.busPort });

  // Потребитель при подключении сразу узнаёт состав станций
  const roster = () => ({ t: 'stations', stations: config.stations.map((s) => ({ code: s.code, name: s.name || s.code })) });
  bus.on('client', (socket) => bus.send(socket, roster()));
  hub.on('raw', (cfg, chunk) => bus.publish({ t: 'data', station: cfg.id, at: Date.now() }, chunk));

  for (const station of config.stations) {
    if (station.source.mode === 'sim') {
      // Имитатор: станция без настоящего приёмника, для проверки сервера на своём компьютере
      const s = station.source;
      const sim = createSimulator({ source: syntheticSource({ name: station.code, lat: s.lat, lon: s.lon, h: s.h || 200, stationId: s.stationId || 1 }) });
      const port = await sim.ready;
      sims.push(sim);
      hub.set({ id: station.code, name: station.name || station.code, mode: 'tcp', host: '127.0.0.1', port, simulated: true });
    } else {
      hub.set(sessionConfig(station, secrets));
    }
  }

  const state = jsonServer({
    '/state': () => ({
      service: 'ingest',
      startedAt,
      consumers: bus.clients.size,
      stations: hub.snapshots(),
    }),
  }, { host: config.bind, port: config.ingest.statePort });

  const ports = { bus: await bus.ready, state: await state.ready };
  log(`приём: станций ${config.stations.length}, шина на ${config.bind}:${ports.bus}, состояние на ${config.bind}:${ports.state}`);

  return {
    ports,
    hub,
    async stop() {
      hub.stopAll();
      await Promise.all([bus.close(), state.close(), ...sims.map((s) => s.close())]);
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
