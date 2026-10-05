'use strict';
// Модуль «Спутники на шаре», часть главного процесса: отдельное окно и расчёт положений
// спутников по наблюдениям сети. Ядро не меняет — читает у станций последние наблюдения.

const path = require('path');
const { solveDirections, orbitRadius } = require('./netdir');

const SYSTEMS = ['GPS', 'GLO', 'GAL', 'BDS'];
const PERIOD_MS = 3000;

function register({ ipcMain, BrowserWindow, getHub, getTheme, icon }) {
  let win = null;
  let timer = null;

  // Дальности одной системы со всех станций на общую эпоху
  function collect(sys) {
    const now = Date.now();
    const fresh = [];
    for (const session of getHub().sessions.values()) {
      if (session.cfg.demo || !session.rtcmPos) continue;
      const obs = session.obs.get(sys);
      if (!obs || !obs.sats || now - obs.at > 6000) continue;
      fresh.push({ session, obs });
    }
    // Станции шлют эпохи не одновременно: берём эпоху, которая есть у большинства
    const count = new Map();
    for (const f of fresh) count.set(f.obs.epoch, (count.get(f.obs.epoch) || 0) + 1);
    let epoch = null;
    for (const [e, c] of count) if (epoch === null || c > count.get(epoch)) epoch = e;
    const cnr = new Map(); // метка -> [сумма, число]
    const stations = fresh.filter((f) => f.obs.epoch === epoch).map((f) => {
      const ranges = new Map();
      for (const sat of f.obs.sats) {
        const sig = sat.signals && sat.signals.find((s) => Number.isFinite(s.pr));
        if (!sig) continue;
        ranges.set(sat.label, sig.pr);
        if (Number.isFinite(sig.cnr)) {
          const acc = cnr.get(sat.label) || [0, 0];
          acc[0] += sig.cnr;
          acc[1]++;
          cnr.set(sat.label, acc);
        }
      }
      return { ecef: f.session.rtcmPos.ecef, ranges };
    });
    return { stations, cnr };
  }

  function compute() {
    const sats = [];
    const quality = {};
    for (const sys of SYSTEMS) {
      const { stations, cnr } = collect(sys);
      let res = null;
      try {
        res = solveDirections(stations, (label) => orbitRadius(sys, Number(label.slice(1))));
      } catch (err) {
        res = null;
      }
      if (!res) continue;
      quality[sys] = { rms: res.rms, stations: stations.length };
      for (const s of res.sats) {
        const acc = cnr.get(s.label);
        sats.push({ label: s.label, sys, ecef: s.ecef, az: s.az, el: s.el, cnr: acc ? acc[0] / acc[1] : null, stations: s.stations });
      }
    }
    const stations = [];
    const now = Date.now();
    for (const session of getHub().sessions.values()) {
      if (session.cfg.demo || !session.rtcmPos) continue;
      const online = session.transport.state === 'online';
      const labels = [];
      if (online) {
        for (const obs of session.obs.values()) {
          if (!obs.sats || now - obs.at > 6000) continue;
          for (const sat of obs.sats) labels.push(sat.label);
        }
      }
      stations.push({ name: session.cfg.name, ecef: session.rtcmPos.ecef, online, sats: labels });
    }
    return { at: Date.now(), sats, stations, quality };
  }

  function tick() {
    if (!win || win.isDestroyed()) return;
    win.webContents.send('sky:data', compute());
  }

  function open() {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.focus();
      return;
    }
    win = new BrowserWindow({
      width: 720,
      height: 620,
      minWidth: 460,
      minHeight: 400,
      backgroundColor: getTheme() === 'dark' ? '#16142c' : '#f4f2fb',
      title: 'Uralsurvey — спутники',
      icon,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    win.setMenuBarVisibility(false);
    win.once('ready-to-show', () => win.show());
    win.loadFile(path.join(__dirname, 'globe.html'));
    win.webContents.on('did-finish-load', tick);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.on('closed', () => {
      win = null;
      clearInterval(timer);
      timer = null;
    });
    timer = setInterval(tick, PERIOD_MS);
  }

  ipcMain.handle('sky:open', () => open());
  // В главном окне выбрали станцию — показываем её спутники и здесь
  ipcMain.handle('sky:select', (event, name) => {
    if (win && !win.isDestroyed()) win.webContents.send('sky:select', name);
  });

  return {
    open,
    compute,
    window: () => win,
    // Тема меняется в главном окне — передаём её и сюда
    setTheme(theme) {
      if (win && !win.isDestroyed()) win.webContents.send('sky:theme', theme);
    },
    reload() {
      if (win && !win.isDestroyed()) win.webContents.reloadIgnoringCache();
    },
  };
}

module.exports = { register };
