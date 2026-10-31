'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  addDirectory: () => ipcRenderer.invoke('dirs:add'),
  removeDirectory: (dir) => ipcRenderer.invoke('dirs:remove', dir),

  listDreams: () => ipcRenderer.invoke('dreams:list'),
  readDream: (file) => ipcRenderer.invoke('dream:read', file),
  saveDream: (payload) => ipcRenderer.invoke('dream:save', payload),
  deleteDream: (file) => ipcRenderer.invoke('dream:delete', file),
  revealDream: (file) => ipcRenderer.invoke('dream:reveal', file),

  getSession: (file) => ipcRenderer.invoke('session:get', file),
  saveSession: (file, data) => ipcRenderer.invoke('session:save', file, data),

  listModels: (host) => ipcRenderer.invoke('ollama:models', host),
  chat: (id, request) => ipcRenderer.invoke('ollama:chat', id, request),
  abort: (id) => ipcRenderer.send('ollama:abort', id),
  onToken: (cb) => {
    const handler = (_e, id, token) => cb(id, token);
    ipcRenderer.on('ollama:token', handler);
    return () => ipcRenderer.removeListener('ollama:token', handler);
  },
});
