'use strict';
// Мост окна «Спутники на шаре»: окно только получает данные.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sky', {
  onData(callback) {
    ipcRenderer.on('sky:data', (event, data) => callback(data));
  },
  onSelect(callback) {
    ipcRenderer.on('sky:select', (event, name) => callback(name));
  },
  onTheme(callback) {
    ipcRenderer.on('sky:theme', (event, theme) => callback(theme));
  },
});
