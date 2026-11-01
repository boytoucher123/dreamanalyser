'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, session, systemPreferences } = require('electron');
const path = require('path');
const fs = require('fs');
const { Store } = require('./store');
const dreams = require('./dreams');
const ollama = require('./ollama');
const categories = require('./categories');
const { Transcriber } = require('./transcriber');

let win = null;
let store = null;
const activeRequests = new Map();
let transcriber = null;

const AUDIO_EXTENSIONS = ['m4a', 'mp3', 'wav', 'ogg', 'oga', 'opus', 'webm', 'flac', 'aac', 'mp4', 'wma', 'amr', '3gp'];

function recordingsDir() {
  const dir = path.join(app.getPath('temp'), 'dream-analyser-recordings');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

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

/* ---------- Categories (cached; invalidated whenever they change) ---------- */
let catCache = null;

async function categoriesRoot() {
  const s = store.getSettings();
  if (s.categoriesDirectory && fs.existsSync(s.categoriesDirectory)) return { root: s.categoriesDirectory, detected: false };
  const root = await categories.detectRoot(s.directories);
  return { root, detected: !!root };
}

async function getCategories() {
  if (catCache) return catCache;
  const { root, detected } = await categoriesRoot();
  if (!root) return (catCache = { root: null, groups: [], items: [], ignore: new Set(), matcher: categories.buildMatcher([]) });
  const data = await categories.load(root);
  return (catCache = { ...data, detected, matcher: categories.buildMatcher(data.items) });
}

const tagKey = (item) => `${item.group}\\${item.name}`;

function publicCategories(c) {
  return {
    root: c.root,
    detected: !!c.detected,
    ignoreFile: c.root ? categories.ignoreFileFor(c.root) : null,
    ignoreCount: c.ignore.size,
    groups: c.groups.map((g) => ({
      path: g.path,
      name: g.name,
      parent: g.parent,
      items: g.items.map((i) => ({ key: tagKey(i), file: i.file, name: i.name, description: i.description, names: i.names, group: i.group })),
    })),
  };
}

async function scanDreams() {
  const c = await getCategories();
  return dreams.scan(store.getSettings().directories, {
    skip: [c.root],
    tag: (text) => c.matcher.match(text).map(({ item }) => tagKey(item)),
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
  ipcMain.handle('settings:set', (_e, patch) => {
    catCache = null;
    return withDefaults(store.setSettings(patch));
  });

  ipcMain.handle('dirs:add', async () => {
    catCache = null;
    const r = await dialog.showOpenDialog(win, {
      title: 'Add a dream folder',
      properties: ['openDirectory', 'createDirectory', 'multiSelections'],
    });
    if (r.canceled) return withDefaults(store.getSettings());
    const s = store.getSettings();
    return withDefaults(store.setSettings({ directories: [...s.directories, ...r.filePaths] }));
  });
  ipcMain.handle('dirs:remove', (_e, dir) => {
    catCache = null;
    const s = store.getSettings();
    return withDefaults(store.setSettings({ directories: s.directories.filter((d) => d !== dir) }));
  });

  ipcMain.handle('dreams:list', () => scanDreams());
  ipcMain.handle('dream:read', async (_e, file) => ({ path: file, fields: await dreams.readDreamFile(file) }));
  ipcMain.handle('dream:save', async (_e, payload) => {
    const saveDir = payload.path ? null : ensureSaveDirectory();
    const c = await getCategories();
    const fields = { ...payload.fields };
    // Re-tag the dream like Lightened Dream does on save (only when a categories folder exists).
    if (c.root && typeof fields.Dream === 'string') {
      fields.SubCategories = categories.subCategoriesXml(c.matcher.match(`${fields.Title || ''} ${fields.Dream}`));
    }
    return dreams.saveDream({ ...payload, fields }, saveDir, { layout: store.getSettings().saveLayout });
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

  ipcMain.handle('categories:get', async () => publicCategories(await getCategories()));
  ipcMain.handle('categories:analyse', async (_e, text) => {
    const c = await getCategories();
    return {
      matches: c.matcher.match(text).map(({ item, keyword }) => ({ key: tagKey(item), group: item.group, name: item.name, file: item.file, keyword })),
      unassigned: c.root ? categories.unassignedWords(text, c.matcher, c.ignore) : [],
    };
  });
  ipcMain.handle('categories:saveItem', async (_e, item) => {
    const c = await getCategories();
    if (!c.root) throw new Error('No categories folder');
    // Rebuild the item's cached <Dreams> index, as Lightened Dream does when saving a category.
    const one = categories.buildMatcher([{ ...item, names: item.names || [] }]);
    const all = await dreams.scan(store.getSettings().directories, { skip: [c.root], tag: (t) => (one.match(t).length ? ['x'] : []) });
    const index = all.filter((d) => d.tags.length).map((d) => ({ date: d.date, title: d.title }));
    const file = await categories.saveItem(c.root, item, index);
    catCache = null;
    return file;
  });
  ipcMain.handle('categories:deleteItem', async (_e, file) => {
    const r = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Move to trash', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: `Delete the category item "${path.basename(file, '.ld3')}"?`,
      detail: 'Dreams are not changed; they just stop being tagged with it.',
    });
    if (r.response !== 0) return false;
    await shell.trashItem(file);
    catCache = null;
    return true;
  });
  ipcMain.handle('categories:createGroup', async (_e, name) => {
    const c = await getCategories();
    if (!c.root) throw new Error('No categories folder');
    const clean = String(name || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').trim();
    if (!clean) throw new Error('Enter a group name');
    fs.mkdirSync(path.join(c.root, clean), { recursive: true });
    catCache = null;
    return clean;
  });
  ipcMain.handle('categories:ignore', async (_e, word) => {
    const c = await getCategories();
    if (!c.root) throw new Error('No categories folder');
    await categories.addIgnore(c.root, word);
    catCache = null;
  });
  ipcMain.handle('categories:createRoot', async () => {
    const saveDir = ensureSaveDirectory();
    const base = path.basename(saveDir).toLowerCase() === 'dreams' ? path.dirname(saveDir) : saveDir;
    const root = await categories.createRoot(base);
    store.setSettings({ categoriesDirectory: root });
    catCache = null;
    return root;
  });
  ipcMain.handle('categories:choose', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Choose your Lightened Dream "Categories" folder', properties: ['openDirectory'] });
    if (r.canceled) return null;
    store.setSettings({ categoriesDirectory: r.filePaths[0] });
    catCache = null;
    return r.filePaths[0];
  });

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

  /* ---------- Speech to text ---------- */
  ipcMain.handle('audio:micAccess', async () => {
    if (process.platform !== 'darwin') return true;
    if (systemPreferences.getMediaAccessStatus('microphone') === 'granted') return true;
    return systemPreferences.askForMediaAccess('microphone');
  });
  ipcMain.handle('audio:choose', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Choose a recording of your dream',
      properties: ['openFile'],
      filters: [
        { name: 'Audio', extensions: AUDIO_EXTENSIONS },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('audio:saveRecording', async (_e, data, ext) => {
    const safeExt = /^[a-z0-9]{1,5}$/i.test(ext || '') ? ext : 'webm';
    const file = path.join(recordingsDir(), `dictation-${Date.now()}.${safeExt}`);
    await fs.promises.writeFile(file, Buffer.from(data));
    return file;
  });
  ipcMain.handle('audio:discardRecording', async (_e, file) => {
    // Only ever delete our own temporary recordings, never a file the user picked.
    if (file && path.dirname(path.resolve(file)) === recordingsDir()) await fs.promises.rm(file, { force: true });
  });
  ipcMain.handle('audio:warmup', () => {
    transcriber.start();
  });
  ipcMain.handle('audio:transcribe', async (_e, file) => {
    const s = store.getSettings();
    return transcriber.transcribe(file, { language: s.whisperLanguage });
  });
  ipcMain.handle('audio:cancel', () => transcriber.cancel());
  ipcMain.handle('audio:test', async () => {
    transcriber.stop();
    return transcriber.start();
  });
}

// Allows running with an isolated profile, e.g. for testing.
if (process.env.DREAM_ANALYSER_USER_DATA) app.setPath('userData', process.env.DREAM_ANALYSER_USER_DATA);

app.whenReady().then(() => {
  store = new Store(app.getPath('userData'));
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
  transcriber = new Transcriber(
    () => store.getSettings(),
    (status) => {
      if (win && !win.webContents.isDestroyed()) win.webContents.send('audio:status', status);
    },
  );
  // Microphone for dictation: allow audio capture for our own page only, never video.
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (permission === 'media') {
      const types = details.mediaTypes || [];
      return callback(types.length > 0 && types.every((t) => t === 'audio'));
    }
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media');
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => {
  transcriber?.stop();
  try {
    fs.rmSync(path.join(app.getPath('temp'), 'dream-analyser-recordings'), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
