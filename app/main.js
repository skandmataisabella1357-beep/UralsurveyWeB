'use strict';
// Главный процесс: окно, хранение настроек, связь окна с ядром.

const { app, BrowserWindow, ipcMain, safeStorage, Menu, nativeTheme, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { StationHub } = require('../core/station');
const { probePort } = require('../core/transport');
const { parseCasterFile } = require('../core/casterfile');
const skyglobe = require('../modules/skyglobe/main');
const { createSimulator, syntheticSource } = require('../core/simulator');

const ROOT = path.join(__dirname, '..');
const DEV = !app.isPackaged;

// Станция, с которой начинаем: база в Среднеуральске
const DEFAULT_STATIONS = [
  { id: 'sredneuralsk', name: 'Среднеуральск', mode: 'tcp', host: '185.41.162.156', port: 3238 },
];

// Кастер сети: подставляется в форму «Точки с кастера», логин и пароль оператор вводит сам
const DEFAULT_CASTER = { host: '212.220.202.105', port: 2101, filter: 'MSM4' };

const DEMO_STATIONS = [
  { name: 'Демо: Екатеринбург', lat: 56.8389, lon: 60.6057, h: 270, stationId: 901 },
  { name: 'Демо: Нижний Тагил', lat: 57.9101, lon: 59.9813, h: 220, stationId: 902 },
  { name: 'Демо: Каменск-Уральский', lat: 56.4149, lon: 61.9189, h: 170, stationId: 903 },
];

let win = null;
let sky = null; // модуль «Спутники на шаре»
let hub = null;
let config = null;
const demo = []; // запущенные имитаторы

// ---------- Настройки ----------

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function loadConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    if (Array.isArray(c.stations)) return c;
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('Не удалось прочитать настройки:', err.message);
  }
  return { stations: DEFAULT_STATIONS.map((s) => ({ ...s })), bounds: null };
}

function saveConfig() {
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(config, null, 2));
  } catch (err) {
    console.error('Не удалось сохранить настройки:', err.message);
  }
}

// Пароль лежит в настройках зашифрованным средствами операционной системы
function encryptPassword(plain) {
  if (!plain) return '';
  if (safeStorage.isEncryptionAvailable()) return `enc:${safeStorage.encryptString(plain).toString('base64')}`;
  return `raw:${plain}`;
}

function decryptPassword(stored) {
  if (!stored) return '';
  try {
    if (stored.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'));
    if (stored.startsWith('raw:')) return stored.slice(4);
  } catch (err) {
    console.error('Не удалось расшифровать пароль:', err.message);
  }
  return '';
}

function sessionConfig(s) {
  return { ...s, password: decryptPassword(s.password) };
}

// Запуск сеанса станции. Остановленная оператором станция заводится, но не подключается.
function launch(station) {
  const session = hub.set(sessionConfig(station));
  if (station.paused) session.stop();
  return session;
}

function publicConfig(s) {
  const { password, ...rest } = s;
  return { ...rest, hasPassword: Boolean(password) };
}

function validate(input) {
  const mode = ['tcp', 'ntrip', 'listen'].includes(input.mode) ? input.mode : 'tcp';
  const port = Number(input.port);
  const name = String(input.name || '').trim().slice(0, 60);
  const host = String(input.host || '').trim();
  if (!name) throw new Error('Укажите название станции.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Порт — число от 1 до 65535.');
  if (mode !== 'listen' && !host) throw new Error('Укажите адрес.');
  const mountpoint = String(input.mountpoint || '').trim();
  if (mode === 'ntrip' && !mountpoint) throw new Error('Укажите точку подключения NTRIP.');
  let relayPort = null;
  if (String(input.relayPort || '').trim() !== '') {
    relayPort = Number(input.relayPort);
    if (!Number.isInteger(relayPort) || relayPort < 1024 || relayPort > 65535) {
      throw new Error('Порт раздачи — число от 1024 до 65535.');
    }
    if (mode === 'listen' && relayPort === port) throw new Error('Порт раздачи должен отличаться от порта приёма.');
  }
  return { name, mode, host, port, mountpoint, username: String(input.username || '').trim(), relayPort };
}

// Точки ближе этого порога по широте и долготе считаем одной станцией:
// в таблице кастера координаты даны до 0,01°
const DUP_DEG = 0.006;

// Где стоят уже заведённые станции: точные координаты из потока, а если станция молчит —
// примерные из таблицы её кастера
async function knownPlaces(stations) {
  const places = [];
  const live = new Map(hub.snapshots().map((s) => [s.id, s.position]));
  const tables = new Map(); // «адрес:порт» -> точки подключения
  for (const station of stations) {
    const p = live.get(station.id);
    if (p) {
      places.push({ station, lat: p.lat, lon: p.lon });
      continue;
    }
    const key = `${station.host}:${station.port}`;
    if (!tables.has(key)) {
      const res = await probePort(station.host, station.port, 8000);
      tables.set(key, res.kind === 'caster' ? res.mountpoints : []);
    }
    const m = tables.get(key).find((x) => x.name === station.mountpoint);
    if (m && m.lat !== null && m.lon !== null) places.push({ station, lat: m.lat, lon: m.lon });
  }
  return places;
}

// Берём у кастера список точек подключения и заводим станцию на каждую подходящую
async function importCaster(input) {
  const host = String(input.host || '').trim();
  const port = Number(input.port);
  const filter = String(input.filter || '').trim();
  const username = String(input.username || '').trim();
  if (!host) throw new Error('Укажите адрес кастера.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Порт — число от 1 до 65535.');

  const res = await probePort(host, port, 8000);
  if (res.kind === 'error') throw new Error(`Кастер недоступен: ${res.text}.`);
  if (res.kind !== 'caster') throw new Error('По этому адресу и порту список точек подключения не отдаётся: похоже, это не NTRIP-кастер.');
  const wanted = res.mountpoints.filter((m) => m.name && (!filter || m.name.toLowerCase().includes(filter.toLowerCase())));
  if (!wanted.length) {
    throw new Error(filter
      ? `На кастере нет точек подключения с «${filter}» в названии. Всего точек: ${res.mountpoints.length}.`
      : 'Кастер прислал пустой список точек подключения.');
  }

  // Одна и та же станция бывает заведена на нескольких кастерах. Что уже есть в списке
  // с другого кастера, второй раз не добавляем: приоритет у добавленного раньше.
  const others = config.stations.filter((s) => s.mode === 'ntrip' && !(s.host === host && s.port === port));
  const known = await knownPlaces(others);
  const sameCaster = (s) => s.mode === 'ntrip' && s.host === host && s.port === port;
  const duplicateOf = (m) => {
    const byName = others.find((s) => s.mountpoint === m.name);
    if (byName) return byName;
    if (m.lat === null || m.lon === null) return null;
    const near = known.find((k) => Math.abs(k.lat - m.lat) < DUP_DEG && Math.abs(k.lon - m.lon) < DUP_DEG);
    return near ? near.station : null;
  };

  const password = typeof input.password === 'string' && input.password !== '' ? encryptPassword(input.password) : '';
  let added = 0;
  let updated = 0;
  const skipped = [];
  for (const m of wanted) {
    const existing = config.stations.find((s) => sameCaster(s) && s.mountpoint === m.name);
    const dup = existing ? null : duplicateOf(m);
    if (dup) {
      skipped.push({ name: m.name, same: dup.name });
      continue;
    }
    if (existing) {
      // Точка уже заведена: обновляем только логин и пароль, если их ввели
      const plain = typeof input.password === 'string' ? input.password : '';
      const changed = (username && username !== existing.username)
        || (plain && plain !== decryptPassword(existing.password));
      if (!changed) continue;
      if (username) existing.username = username;
      if (password) existing.password = password;
      launch(existing);
      updated++;
      continue;
    }
    const station = {
      id: crypto.randomUUID(), name: m.name, mode: 'ntrip', host, port, mountpoint: m.name, username, relayPort: null, password,
    };
    config.stations.push(station);
    launch(station);
    added++;
  }
  config.caster = { host, port, filter };
  saveConfig();
  return { added, updated, skipped, total: res.mountpoints.length };
}

// Загрузка станций из текстового списка кастеров. Файл выбирает оператор.
async function importCasterFile() {
  const pick = await dialog.showOpenDialog(win, {
    title: 'Список кастеров',
    defaultPath: config.casterFile || path.join(DEV ? ROOT : app.getPath('documents'), 'casters.txt'),
    filters: [{ name: 'Текстовые файлы', extensions: ['txt', 'csv'] }, { name: 'Все файлы', extensions: ['*'] }],
    properties: ['openFile'],
  });
  if (pick.canceled || !pick.filePaths.length) return null;
  const file = pick.filePaths[0];
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`Не удалось прочитать файл: ${err.message}.`);
  }
  const parsed = parseCasterFile(text, DEFAULT_CASTER.filter);
  if (!parsed.casters.length && !parsed.errors.length) {
    throw new Error('В файле нет ни одного кастера. Строка выглядит так: адрес:порт логин пароль.');
  }
  const result = { file: path.basename(file), casters: 0, added: 0, updated: 0, skipped: [], problems: parsed.errors.map((e) => e.text) };
  for (const c of parsed.casters) {
    try {
      const r = await importCaster(c);
      result.casters++;
      result.added += r.added;
      result.updated += r.updated;
      result.skipped.push(...r.skipped);
    } catch (err) {
      result.problems.push(`${c.host}:${c.port} — ${err.message}`);
    }
  }
  config.casterFile = file;
  saveConfig();
  return result;
}

// ---------- Связь с окном ----------

function registerIpc() {
  ipcMain.handle('stations:list', () => config.stations.map(publicConfig));

  ipcMain.handle('stations:save', (event, input) => {
    const clean = validate(input);
    const existing = config.stations.find((s) => s.id === input.id);
    let password = existing ? existing.password : '';
    if (typeof input.password === 'string' && input.password !== '') password = encryptPassword(input.password);
    if (input.clearPassword) password = '';
    const station = { id: existing ? existing.id : crypto.randomUUID(), ...clean, password, paused: Boolean(existing && existing.paused) };
    if (existing) config.stations[config.stations.indexOf(existing)] = station;
    else config.stations.push(station);
    saveConfig();
    launch(station);
    return publicConfig(station);
  });

  ipcMain.handle('stations:remove', (event, id) => {
    config.stations = config.stations.filter((s) => s.id !== id);
    saveConfig();
    hub.remove(id);
  });

  ipcMain.handle('stations:reconnect', (event, id) => {
    // Переподключение запускает и остановленную станцию
    const station = config.stations.find((s) => s.id === id);
    if (station && station.paused) {
      station.paused = false;
      saveConfig();
    }
    hub.reconnect(id);
  });

  // Остановить или снова запустить станцию; выбор сохраняется между запусками
  ipcMain.handle('stations:pause', (event, id, paused) => {
    const station = config.stations.find((s) => s.id === id);
    const session = hub.sessions.get(id);
    if (!station || !session) return;
    station.paused = Boolean(paused);
    saveConfig();
    if (station.paused) {
      session.stop();
      session.addLog('info', 'Остановлено оператором');
    } else {
      session.addLog('info', 'Запущено оператором');
      session.start();
    }
  });

  ipcMain.handle('caster:defaults', () => ({ ...DEFAULT_CASTER, ...(config.caster || {}) }));

  ipcMain.handle('caster:import', (event, input) => importCaster(input));
  ipcMain.handle('caster:importFile', () => importCasterFile());

  // Подсети: контур на карте и станции внутри него. Хранятся рядом с настройками станций.
  ipcMain.handle('subnets:list', () => config.subnets || []);

  ipcMain.handle('subnets:save', (event, input) => {
    const name = String(input.name || '').trim().slice(0, 60);
    if (!name) throw new Error('Укажите название подсети.');
    const polygon = Array.isArray(input.polygon)
      ? input.polygon.filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])).map((p) => [p[0], p[1]])
      : [];
    if (polygon.length < 3) throw new Error('У контура подсети должно быть не меньше трёх вершин.');
    const ids = new Set(config.stations.map((s) => s.id));
    const stationIds = Array.isArray(input.stationIds) ? [...new Set(input.stationIds.filter((id) => ids.has(id)))] : [];
    if (stationIds.length < 3) throw new Error('В подсети должно быть не меньше трёх станций.');
    if (!config.subnets) config.subnets = [];
    const existing = config.subnets.find((s) => s.id === input.id);
    const subnet = { id: existing ? existing.id : crypto.randomUUID(), name, polygon, stationIds };
    if (existing) config.subnets[config.subnets.indexOf(existing)] = subnet;
    else config.subnets.push(subnet);
    saveConfig();
    return subnet;
  });

  ipcMain.handle('subnets:remove', (event, id) => {
    config.subnets = (config.subnets || []).filter((s) => s.id !== id);
    saveConfig();
  });

  ipcMain.handle('demo:set', async (event, on) => {
    if (on && !demo.length) {
      for (const d of DEMO_STATIONS) {
        const sim = createSimulator({ source: syntheticSource(d) });
        const port = await sim.ready;
        const id = `demo-${d.stationId}`;
        demo.push({ sim, id });
        hub.set({ id, name: d.name, mode: 'tcp', host: '127.0.0.1', port, demo: true });
      }
    } else if (!on) {
      for (const d of demo.splice(0)) {
        hub.remove(d.id);
        d.sim.close();
      }
    }
    return demo.length > 0;
  });

  // Тема окна: рамка и фон до загрузки страницы должны совпадать с интерфейсом
  ipcMain.handle('theme:set', (event, theme) => {
    if (theme !== 'light' && theme !== 'dark') return;
    nativeTheme.themeSource = theme;
    if (win) win.setBackgroundColor(theme === 'dark' ? '#16142c' : '#f4f2fb');
    if (sky) sky.setTheme(theme);
    if (config.theme !== theme) {
      config.theme = theme;
      saveConfig();
    }
  });

  ipcMain.handle('app:info', () => ({ version: app.getVersion(), dev: DEV, demo: demo.length > 0 }));
}

// ---------- Окно ----------

function createWindow() {
  const b = config.bounds || { width: 1440, height: 900 };
  win = new BrowserWindow({
    ...b,
    minWidth: 1080,
    minHeight: 680,
    backgroundColor: (config.theme || (nativeTheme.shouldUseDarkColors ? 'dark' : 'light')) === 'dark' ? '#16142c' : '#f4f2fb',
    title: 'Uralsurvey — станции сети',
    icon: path.join(__dirname, 'icon.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('close', () => {
    config.bounds = win.getBounds();
    saveConfig();
  });
  win.on('closed', () => {
    win = null;
  });
  // Внешние ссылки в окне не открываем
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

// В режиме разработки окно само подхватывает правки файлов проекта:
// правки интерфейса — перезагрузкой страницы, правки ядра — перезапуском программы.
function watchSources() {
  let reloadTimer = null;
  let restartTimer = null;
  const watch = (dir, onChange) => {
    try {
      fs.watch(dir, { recursive: true }, (type, file) => {
        if (file && !/\.(js|css|html|json|svg|woff2)$/.test(file)) return;
        onChange();
      });
    } catch (err) {
      console.error(`Слежение за ${dir} недоступно:`, err.message);
    }
  };
  const reload = () => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      if (win) win.webContents.reloadIgnoringCache();
      if (sky) sky.reload();
    }, 400);
  };
  watch(path.join(ROOT, 'app', 'renderer'), reload);
  watch(path.join(ROOT, 'modules'), reload); // модули работают в окне
  const restart = () => {
    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      if (win) config.bounds = win.getBounds();
      saveConfig();
      app.relaunch();
      app.exit(0);
    }, 1500);
  };
  watch(path.join(ROOT, 'core'), restart);
  // Части модулей, работающие в главном процессе, требуют перезапуска
  for (const f of ['main.js', 'netdir.js', 'preload.js']) {
    try {
      fs.watch(path.join(ROOT, 'modules', 'skyglobe', f), restart);
    } catch (err) {
      console.error(`Слежение за модулем ${f} недоступно:`, err.message);
    }
  }
  for (const f of ['main.js', 'preload.js']) {
    try {
      fs.watch(path.join(__dirname, f), restart);
    } catch (err) {
      console.error(`Слежение за ${f} недоступно:`, err.message);
    }
  }
}

// Отладка при запуске из папки проекта: состояние станций и начало сырого потока
// пишутся в папку samples, чтобы результат можно было проверить по реальным данным.
function startDiagnostics() {
  const dir = path.join(ROOT, 'samples');
  const LIMIT = 1024 * 1024;
  const captures = new Map(); // id станции -> { fd, bytes }
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    console.error('Папка samples недоступна:', err.message);
    return;
  }
  hub.on('raw', (cfg, chunk) => {
    if (cfg.demo) return;
    let c = captures.get(cfg.id);
    if (!c) {
      const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
      try {
        c = { fd: fs.openSync(path.join(dir, `${cfg.id}-${stamp}.bin`), 'w'), bytes: 0 };
      } catch (err) {
        c = { fd: null, bytes: LIMIT };
      }
      captures.set(cfg.id, c);
    }
    if (c.fd === null) return;
    try {
      fs.writeSync(c.fd, chunk);
      c.bytes += chunk.length;
      if (c.bytes >= LIMIT) {
        fs.closeSync(c.fd);
        c.fd = null;
      }
    } catch (err) {
      c.fd = null;
    }
  });
  setInterval(() => {
    const body = JSON.stringify({ at: new Date().toISOString(), stations: hub.snapshots() }, null, 1);
    fs.writeFile(path.join(dir, 'status.json'), body, () => {});
    // Снимок окна: по нему видно, как правки интерфейса выглядят на самом деле
    if (win && !win.isDestroyed() && !win.isMinimized()) {
      win.webContents.capturePage().then((img) => {
        fs.writeFile(path.join(dir, 'window.png'), img.toPNG(), () => {});
      }).catch(() => {});
    }
  }, 5000);
  // Окно спутников: снимок рядом, а открыть его можно файлом-меткой samples/open-sky
  setInterval(() => {
    const flag = path.join(dir, 'open-sky');
    if (fs.existsSync(flag)) {
      fs.unlink(flag, () => {});
      if (sky) sky.open();
    }
    const w = sky && sky.window();
    if (w && !w.isDestroyed() && !w.isMinimized()) {
      w.webContents.capturePage().then((img) => {
        fs.writeFile(path.join(dir, 'sky.png'), img.toPNG(), () => {});
      }).catch(() => {});
    }
  }, 3000);
  // Ошибки окна — в файл, чтобы сбой в интерфейсе не остался незамеченным
  app.on('web-contents-created', (event, contents) => {
    contents.on('console-message', (e, level, message, line, source) => {
      if (level < 2) return;
      const row = `${new Date().toISOString()} ${message} (${path.basename(String(source))}:${line})\n`;
      fs.appendFile(path.join(dir, 'renderer.log'), row, () => {});
    });
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    config = loadConfig();
    if (config.theme) nativeTheme.themeSource = config.theme;
    hub = new StationHub();
    hub.on('snapshot', (list) => {
      if (win && !win.isDestroyed()) win.webContents.send('snapshot', list);
    });
    registerIpc();
    sky = skyglobe.register({
      ipcMain,
      BrowserWindow,
      getHub: () => hub,
      getTheme: () => config.theme || (nativeTheme.shouldUseDarkColors ? 'dark' : 'light'),
      icon: path.join(__dirname, 'icon.png'),
    });
    if (DEV) startDiagnostics();
    for (const s of config.stations) launch(s);
    createWindow();
    if (DEV) watchSources();
  });

  app.on('window-all-closed', () => {
    if (hub) hub.stopAll();
    for (const d of demo) d.sim.close();
    app.quit();
  });
}
