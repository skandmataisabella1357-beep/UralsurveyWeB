'use strict';
// Тестовая сеть из синтетических баз. Каждая база сама шлёт поток на свой порт сервера
// и изображает одну из неисправностей связи; раз в полминуты печатается сводка:
// что делали базы и что при этом увидел сервер.
//
//   npm run testnet                      — сервер и 50 баз на своём компьютере
//   npm run testnet -- --target АДРЕС    — только базы, поток уходит на указанный сервер
//   npm run testnet -- --config          — напечатать настройки сервера под эту сеть
//
// Ещё: --count 50, --first-port 2110, --seed 2026, --control-port 8080, --state http://127.0.0.1:8080

const fs = require('fs');
const os = require('os');
const path = require('path');
const { fork } = require('child_process');
const { makeStations, serverConfig, FAULTS } = require('./stations');
const { TestBase } = require('./base');
const { getJson } = require('../shared/http');

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else out[key] = argv[++i];
  }
  return out;
}

const pad = (text, n) => String(text).padEnd(n);

// Сводка по неисправностям: что увидел сервер у станций каждого вида
function report(stations, bases, state) {
  const byCode = new Map(((state && state.stations) || []).map((s) => [s.id, s]));
  const lines = [];
  lines.push(`${pad('неисправность', 32)}${pad('баз', 5)}${pad('на связи', 10)}${pad('у раздачи', 11)}${pad('обрывов', 9)}${pad('сбоев CRC', 11)}${pad('спутн.', 8)}чего ждём`);
  for (const fault of FAULTS) {
    const mine = stations.filter((s) => s.fault === fault.kind);
    if (!mine.length) continue;
    const seen = mine.map((s) => byCode.get(s.code)).filter(Boolean);
    const online = seen.filter((s) => s.link.state === 'online').length;
    const live = seen.filter((s) => s.feed && s.feed.lastDataAgeMs !== null && s.feed.lastDataAgeMs < 10000).length;
    const sum = (f) => seen.reduce((a, s) => a + f(s), 0);
    const sats = seen.length ? Math.round(sum((s) => s.satTotal) / seen.length) : 0;
    lines.push(`${pad(fault.title, 32)}${pad(mine.length, 5)}${pad(`${online}/${mine.length}`, 10)}${pad(`${live}/${mine.length}`, 11)}${pad(sum((s) => s.link.reconnects), 9)}${pad(sum((s) => s.crcErrors), 11)}${pad(sats, 8)}${fault.expect}`);
  }
  const total = bases.reduce((a, b) => a + b.stats.bytes, 0);
  lines.push(`базы отправили ${(total / 1048576).toFixed(1)} МБ; сервер: ${state ? `${state.stations.filter((s) => s.link.state === 'online').length} из ${state.stations.length} станций на связи` : 'сводка недоступна'}`);
  return lines.join('\n');
}

function main(argv = process.argv.slice(2)) {
  const a = args(argv);
  const stations = makeStations({
    count: Number(a.count) || 50,
    firstPort: Number(a['first-port']) || 2110,
    seed: Number(a.seed) || 2026,
  });

  if (a.config) {
    // Настройки для сервера, на который базы будут слать поток
    process.stdout.write(`${JSON.stringify(serverConfig(stations, { bind: typeof a.bind === 'string' ? a.bind : '127.0.0.1' }), null, 2)}\n`);
    return;
  }

  const local = !a.target;
  const controlPort = Number(a['control-port']) || 0;
  const host = local ? '127.0.0.1' : String(a.target);
  let server = null;
  if (local) {
    const file = path.join(os.tmpdir(), `uralsurvey-testnet-${process.pid}.json`);
    const config = serverConfig(stations);
    if (controlPort) config.control = { port: controlPort };
    fs.writeFileSync(file, JSON.stringify(config));
    server = fork(path.join(__dirname, '..', 'run.js'), { stdio: 'inherit', env: { ...process.env, URALSURVEY_CONFIG: file } });
    process.on('exit', () => { try { fs.unlinkSync(file); } catch (err) { /* уже убран */ } });
  }

  console.log(`Тестовая сеть: ${stations.length} баз, порты ${stations[0].port}–${stations[stations.length - 1].port}, поток на ${host}`);
  const bases = stations.map((station) => new TestBase({ station, host }));
  // Локальному серверу нужно время открыть порты
  setTimeout(() => bases.forEach((b) => b.start()), local ? 2500 : 0);

  const stateUrl = typeof a.state === 'string' ? a.state : (local ? `http://127.0.0.1:${controlPort || 8080}` : null);
  const timer = setInterval(async () => {
    const state = stateUrl ? await getJson(`${stateUrl}/api/state`, 3000) : null;
    console.log(`\n${new Date().toLocaleTimeString('ru-RU')}\n${report(stations, bases, state)}`);
  }, 30000);

  const stop = () => {
    clearInterval(timer);
    bases.forEach((b) => b.stop());
    if (server) server.kill();
    setTimeout(() => process.exit(0), 300);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (require.main === module) main();

module.exports = { report, args, main };
