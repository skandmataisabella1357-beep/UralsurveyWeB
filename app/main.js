'use strict';
// Главный процесс: окно, хранение настроек, связь окна с ядром.

const { app, BrowserWindow, ipcMain, safeStorage, Menu, nativeTheme } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { StationHub } = require('../core/station');
const { createSimulator, syntheticSource } = require('../core/simulator');

const ROOT = path.join(__dirname, '..');
const DEV = !app.isPackaged;

// Станция, с которой начинаем: база в Среднеуральске
const DEFAULT_STATIONS = [
  { id: 'sredneuralsk', name: 'Среднеуральск', mode: 'tcp', host: '185.41.162.156', port: 3238 },
];

const DEMO_STATIONS = [
  { name: 'Демо: Екатеринбург', lat: 56.8389, lon: 60.6057, h: 270, stationId: 901 },
  { name: 'Демо: Нижний Тагил', lat: 57.9101, lon: 59.9813, h: 220, stationId: 902 },
  { name: 'Демо: Каменск-Уральский', lat: 56.4149, lon: 61.9189, h: 170, stationId: 903 },
];

let win = null;
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

// ---------- Связь с окном ----------

function registerIpc() {
  ipcMain.handle('stations:list', () => config.stations.map(publicConfig));

  ipcMain.handle('stations:save', (event, input) => {
    const clean = validate(input);
    const existing = config.stations.find((s) => s.id === input.id);
    let password = existing ? existing.password : '';
    if (typeof input.password === 'string' && input.password !== '') password = encryptPassword(input.password);
    if (input.clearPassword) password = '';
    const station = { id: existing ? existing.id : crypto.randomUUID(), ...clean, password };
    if (existing) config.stations[config.stations.indexOf(existing)] = station;
    else config.stations.push(station);
    saveConfig();
    hub.set(sessionConfig(station));
    return publicConfig(station);
  });

  ipcMain.handle('stations:remove', (event, id) => {
    config.stations = config.stations.filter((s) => s.id !== id);
    saveConfig();
    hub.remove(id);
  });

  ipcMain.handle('stations:reconnect', (event, id) => hub.reconnect(id));

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
  watch(path.join(ROOT, 'app', 'renderer'), () => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => win && win.webContents.reloadIgnoringCache(), 400);
  });
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
  }, 5000);
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
    if (DEV) startDiagnostics();
    for (const s of config.stations) hub.set(sessionConfig(s));
    createWindow();
    if (DEV) watchSources();
  });

  app.on('window-all-closed', () => {
    if (hub) hub.stopAll();
    for (const d of demo) d.sim.close();
    app.quit();
  });
}
