'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { Store } = require('./store');
const dreams = require('./dreams');
const ollama = require('./ollama');

let win = null;
let store = null;
const activeRequests = new Map();

function defaultDreamFolder() {
  return path.join(app.getPath('documents'), 'Dreams');
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 680,
    title: 'Dream Analyser',
    backgroundColor: '#07051a',
    autoHideMenuBar: true,
    show: false,
    icon: path.join(__dirname, '..', 'renderer', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('closed', () => {
    win = null;
  });
}

function ensureSaveDirectory() {
  const s = store.getSettings();
  if (s.saveDirectory) return s.saveDirectory;
  const dir = defaultDreamFolder();
  fs.mkdirSync(dir, { recursive: true });
  store.setSettings({ directories: [...s.directories, dir], saveDirectory: dir });
  return dir;
}

function registerIpc() {
  const withDefaults = (s) => ({ ...s, defaultFolder: defaultDreamFolder() });
  ipcMain.handle('settings:get', () => withDefaults(store.getSettings()));
  ipcMain.handle('settings:set', (_e, patch) => withDefaults(store.setSettings(patch)));

  ipcMain.handle('dirs:add', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Add a dream folder',
      properties: ['openDirectory', 'createDirectory', 'multiSelections'],
    });
    if (r.canceled) return withDefaults(store.getSettings());
    const s = store.getSettings();
    return withDefaults(store.setSettings({ directories: [...s.directories, ...r.filePaths] }));
  });
  ipcMain.handle('dirs:remove', (_e, dir) => {
    const s = store.getSettings();
    return withDefaults(store.setSettings({ directories: s.directories.filter((d) => d !== dir) }));
  });

  ipcMain.handle('dreams:list', () => dreams.scan(store.getSettings().directories));
  ipcMain.handle('dream:read', async (_e, file) => ({ path: file, fields: await dreams.readDreamFile(file) }));
  ipcMain.handle('dream:save', async (_e, payload) => {
    const saveDir = payload.path ? null : ensureSaveDirectory();
    return dreams.saveDream(payload, saveDir);
  });
  ipcMain.handle('dream:delete', async (_e, file) => {
    const r = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Move to trash', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: 'Delete this dream?',
      detail: `${path.basename(file)} will be moved to the trash.`,
    });
    if (r.response !== 0) return false;
    await shell.trashItem(file);
    store.deleteSession(file);
    return true;
  });
  ipcMain.handle('dream:reveal', (_e, file) => shell.showItemInFolder(file));

  ipcMain.handle('session:get', (_e, file) => store.getSession(file));
  ipcMain.handle('session:save', (_e, file, data) => store.saveSession(file, data));

  ipcMain.handle('ollama:models', (_e, host) => ollama.listModels(host || store.getSettings().ollamaHost));
  ipcMain.handle('ollama:chat', async (e, id, request) => {
    const controller = new AbortController();
    activeRequests.set(id, controller);
    try {
      return await ollama.chat(
        store.getSettings().ollamaHost,
        request,
        (token) => {
          if (!e.sender.isDestroyed()) e.sender.send('ollama:token', id, token);
        },
        controller.signal,
      );
    } finally {
      activeRequests.delete(id);
    }
  });
  ipcMain.on('ollama:abort', (_e, id) => activeRequests.get(id)?.abort());
}

// Allows running with an isolated profile, e.g. for testing.
if (process.env.DREAM_ANALYSER_USER_DATA) app.setPath('userData', process.env.DREAM_ANALYSER_USER_DATA);

app.whenReady().then(() => {
  store = new Store(app.getPath('userData'));
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
