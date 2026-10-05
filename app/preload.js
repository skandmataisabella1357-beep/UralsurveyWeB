'use strict';
// Мост между окном и главным процессом. Окно видит только эти функции.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('core', {
  onSnapshot(callback) {
    ipcRenderer.on('snapshot', (event, list) => callback(list));
  },
  listStations: () => ipcRenderer.invoke('stations:list'),
  saveStation: (station) => ipcRenderer.invoke('stations:save', station),
  removeStation: (id) => ipcRenderer.invoke('stations:remove', id),
  reconnect: (id) => ipcRenderer.invoke('stations:reconnect', id),
  pauseStation: (id, paused) => ipcRenderer.invoke('stations:pause', id, paused),
  casterDefaults: () => ipcRenderer.invoke('caster:defaults'),
  importCaster: (caster) => ipcRenderer.invoke('caster:import', caster),
  importCasterFile: () => ipcRenderer.invoke('caster:importFile'),
  listSubnets: () => ipcRenderer.invoke('subnets:list'),
  saveSubnet: (subnet) => ipcRenderer.invoke('subnets:save', subnet),
  removeSubnet: (id) => ipcRenderer.invoke('subnets:remove', id),
  openSky: () => ipcRenderer.invoke('sky:open'),
  selectSky: (name) => ipcRenderer.invoke('sky:select', name),
  setDemo: (on) => ipcRenderer.invoke('demo:set', on),
  setTheme: (theme) => ipcRenderer.invoke('theme:set', theme),
  info: () => ipcRenderer.invoke('app:info'),
});
