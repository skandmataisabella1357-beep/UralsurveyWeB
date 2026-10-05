'use strict';
// Запуск сервера на своём компьютере одной командой: npm run server
// Три службы идут отдельными процессами, как на настоящем сервере; упавшая поднимается сама.
// На рабочей машине то же самое делает systemd, этот файл там не нужен.

const path = require('path');
const { fork } = require('child_process');
const { loadConfig } = require('./shared/config');

const SERVICES = [
  { name: 'приём', file: 'ingest/index.js' },
  { name: 'раздача', file: 'caster/index.js' },
  { name: 'управление', file: 'control/index.js' },
];
const BACKOFF_MS = [1000, 2000, 5000, 10000];

let stopping = false;
const children = new Map();

function launch(service, attempt = 0) {
  const startedAt = Date.now();
  const child = fork(path.join(__dirname, service.file), { stdio: 'inherit' });
  children.set(service.name, child);
  child.on('exit', (code) => {
    children.delete(service.name);
    if (stopping) return;
    // Проработала минуту — считаем запуск удачным и паузы начинаем заново
    const next = Date.now() - startedAt > 60000 ? 0 : attempt;
    const delay = BACKOFF_MS[Math.min(next, BACKOFF_MS.length - 1)];
    console.error(`служба «${service.name}» остановилась (код ${code}), перезапуск через ${delay / 1000} с`);
    setTimeout(() => launch(service, next + 1), delay);
  });
}

function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of children.values()) child.kill();
  setTimeout(() => process.exit(0), 300);
}

try {
  const { config, usingExample, file } = loadConfig();
  console.log(`Сервер Uralsurvey: настройки из ${path.basename(file)}, службы слушают ${config.bind}`);
  if (usingExample) console.log('Файла server/config.json нет — запуск на имитаторах станций из образца.');
} catch (err) {
  console.error(`Настройки не прочитаны: ${err.message}`);
  process.exit(1);
}

for (const service of SERVICES) launch(service);
// Если сервер запущен другим сценарием и тот исчез — останавливаемся вместе со службами
process.on('disconnect', stop);
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
