'use strict';
// Точка входа службы uralsurvey-web на сервере (rtk.ntrip.host).
// Служба systemd запускает именно этот файл и задаёт адрес и порт страницы в переменных
// URAL_HOST и URAL_PORT; nginx отдаёт этот порт наружу по HTTPS.
//
// Поднимаются четыре части: приём и раздача потоков, расчёт подсетей (Node.js) и служба
// управления с базой (Python и PostgreSQL). Станции, точки подключения и логины приём и раздача берут из базы.
// Каждая часть — отдельный процесс; упавшая поднимается сама, остальные при этом работают.
//
// Тестовая сеть (50 синтетических баз на портах 2110–2159) включается переменной URAL_TESTNET=1;
// по умолчанию сервер работает только с тем, что заведено в базе.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { fork, spawn, execFileSync } = require('child_process');
const { llhToEcef, D2R } = require('../core/geo');
const { makeStations } = require('./testnet/stations');
const { TestBase } = require('./testnet/base');

const ROOT = path.join(__dirname, '..');
const HOST = process.env.URAL_HOST || '127.0.0.1';
const PORT = process.env.URAL_PORT || '8110';
const DATA = process.env.URAL_DATA || (process.env.URAL_CONFIG ? path.dirname(process.env.URAL_CONFIG) : path.join(ROOT, 'backend', 'data'));
const PYTHON = process.env.URAL_PYTHON || path.join(ROOT, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const TESTNET = process.env.URAL_TESTNET === '1';
const BACKOFF_MS = [1000, 2000, 5000, 10000];

if (HOST !== '127.0.0.1') {
  console.error('Страница отдаётся только через nginx: URAL_HOST должен быть 127.0.0.1.');
  process.exit(1);
}

// Настройки приёма и раздачи: станций здесь нет, они приходят из базы
const configFile = path.join(os.tmpdir(), `uralsurvey-${process.pid}.json`);
// Что открыто наружу, решает владелец сервера в файле server.json рядом с данными. Без файла
// раздача слушает только эту машину. ntripBind — адрес, на котором порт 2101 ждёт роверы
// (0.0.0.0 — все адреса сервера); ntripHost — имя сервера в таблице источников.
let site = {};
try { site = JSON.parse(fs.readFileSync(path.join(DATA, 'server.json'), 'utf8')); } catch (err) { /* файла нет — всё закрыто */ }
const caster = { port: 2101, enabled: true };
if (typeof site.ntripBind === 'string' && site.ntripBind) caster.publicBind = site.ntripBind;
if (typeof site.ntripHost === 'string' && site.ntripHost) caster.publicHost = site.ntripHost;
// stationsBind — адрес, на котором порты приёма (2110–2159) ждут станции, которые шлют поток сами
const ingest = typeof site.stationsBind === 'string' && site.stationsBind ? { publicBind: site.stationsBind } : {};
fs.writeFileSync(configFile, JSON.stringify({ bind: '127.0.0.1', caster, ingest, stations: [] }));
process.on('exit', () => { try { fs.unlinkSync(configFile); } catch (err) { /* уже убран */ } });

const env = {
  ...process.env,
  URALSURVEY_CONFIG: configFile,
  URAL_DATA: DATA,
  URAL_DIRECTORY: `http://127.0.0.1:${PORT}`,
  URAL_HOST: HOST,
  URAL_PORT: PORT,
  URAL_INGEST: 'http://127.0.0.1:7102',
  URAL_CASTER: 'http://127.0.0.1:7103',
  URAL_SOLVER: 'http://127.0.0.1:7104',
  PYTHONUNBUFFERED: '1',
};

let stopping = false;
const children = new Map();
function launch(name, start, attempt = 0) {
  const startedAt = Date.now();
  const child = start();
  children.set(name, child);
  child.on('exit', (code) => {
    children.delete(name);
    if (stopping) return;
    const next = Date.now() - startedAt > 60000 ? 0 : attempt;
    const delay = BACKOFF_MS[Math.min(next, BACKOFF_MS.length - 1)];
    console.error(`служба «${name}» остановилась (код ${code}), перезапуск через ${delay / 1000} с`);
    setTimeout(() => launch(name, start, next + 1), delay);
  });
}

console.log(`Сервер Uralsurvey: панель на http://${HOST}:${PORT}/admin.html, данные в ${DATA}`);
console.log(caster.publicBind ? `Раздача роверам открыта: ${caster.publicBind}:2101` : 'Раздача роверам закрыта: порт 2101 слушает только эту машину (см. server.json)');
// Управление стартует первым: оно создаёт ключи и применяет схему базы
launch('управление', () => spawn(PYTHON, ['-m', 'uralsurvey_admin', 'serve'], { cwd: path.join(ROOT, 'backend'), env, stdio: 'inherit' }));
setTimeout(() => {
  launch('приём', () => fork(path.join(__dirname, 'ingest', 'index.js'), { env, stdio: 'inherit' }));
  launch('раздача', () => fork(path.join(__dirname, 'caster', 'index.js'), { env, stdio: 'inherit' }));
  launch('расчёт', () => fork(path.join(__dirname, 'solver', 'index.js'), { env, stdio: 'inherit' }));
}, 2500);

// ---------- Тестовая сеть ----------

const bases = [];
if (TESTNET) {
  setTimeout(() => {
    const stations = makeStations();
    const file = path.join(os.tmpdir(), `uralsurvey-testnet-${process.pid}.json`);
    fs.writeFileSync(file, JSON.stringify(stations.map((s) => {
      const [x, y, z] = llhToEcef(s.lat * D2R, s.lon * D2R, s.h);
      return {
        code: s.code, name: s.name, source_mode: 'listen', source_port: s.port,
        x: Number(x.toFixed(4)), y: Number(y.toFixed(4)), z: Number(z.toFixed(4)), note: `тестовая сеть: ${s.fault}`,
      };
    })));
    try {
      const out = execFileSync(PYTHON, ['-m', 'uralsurvey_admin', 'import-stations', file], { cwd: path.join(ROOT, 'backend'), env, encoding: 'utf8' });
      console.log(`тестовая сеть: станции в базе — ${out.trim()}`);
    } catch (err) {
      console.error(`тестовая сеть: станции в базу не загружены — ${String(err.stderr || err.message).trim().split(/\r?\n/).pop()}`);
    } finally {
      try { fs.unlinkSync(file); } catch (err) { /* уже убран */ }
    }
    // Базам нужно время: приём должен получить справочник и открыть порты
    setTimeout(() => {
      for (const station of stations) {
        const base = new TestBase({ station, host: '127.0.0.1' });
        bases.push(base);
        base.start();
      }
      console.log(`тестовая сеть: ${stations.length} баз шлют потоки на порты ${stations[0].port}–${stations[stations.length - 1].port}`);
    }, 8000);
  }, 5000);
}

function stop() {
  if (stopping) return;
  stopping = true;
  bases.forEach((b) => b.stop());
  for (const child of children.values()) child.kill();
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
