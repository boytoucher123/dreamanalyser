'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

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

  getCategories: () => ipcRenderer.invoke('categories:get'),
  analyseCategories: (text) => ipcRenderer.invoke('categories:analyse', text),
  saveCategoryItem: (item) => ipcRenderer.invoke('categories:saveItem', item),
  deleteCategoryItem: (file) => ipcRenderer.invoke('categories:deleteItem', file),
  createCategoryGroup: (name) => ipcRenderer.invoke('categories:createGroup', name),
  ignoreWord: (word) => ipcRenderer.invoke('categories:ignore', word),
  createCategoriesRoot: () => ipcRenderer.invoke('categories:createRoot'),
  chooseCategoriesRoot: () => ipcRenderer.invoke('categories:choose'),

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

  // Speech to text (local Whisper)
  micAccess: () => ipcRenderer.invoke('audio:micAccess'),
  chooseAudio: () => ipcRenderer.invoke('audio:choose'),
  saveRecording: (data, ext) => ipcRenderer.invoke('audio:saveRecording', data, ext),
  discardRecording: (file) => ipcRenderer.invoke('audio:discardRecording', file),
  warmupWhisper: () => ipcRenderer.invoke('audio:warmup'),
  transcribe: (file) => ipcRenderer.invoke('audio:transcribe', file),
  cancelTranscription: () => ipcRenderer.invoke('audio:cancel'),
  testWhisper: () => ipcRenderer.invoke('audio:test'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  onTranscribeStatus: (cb) => {
    const handler = (_e, status) => cb(status);
    ipcRenderer.on('audio:status', handler);
    return () => ipcRenderer.removeListener('audio:status', handler);
  },
});
