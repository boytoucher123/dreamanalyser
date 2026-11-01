'use strict';
/** Persists app settings and per-dream analysis sessions in the user data folder. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULTS = {
  directories: [],
  saveDirectory: '',
  ollamaHost: 'http://127.0.0.1:11434',
  model: '',
  temperature: 0.7,
  secondPass: true,
  saveLayout: 'lightened', // 'lightened' = YYYY/MM/DD Title.ld3, 'flat' = YYYY-MM-DD Title.ld3
  categoriesDirectory: '',
  // Speech to text (local OpenAI Whisper, run through Python)
  pythonPath: '', // '' = "python" on Windows, "python3" elsewhere
  whisperModel: 'medium',
  ffmpegDir: '', // folder containing ffmpeg(.exe), added to PATH for Whisper, e.g. C:\ffmpeg\bin
  whisperLanguage: '', // '' = detect automatically
  tidyDictation: true, // reorder/de-duplicate the transcript with the Ollama model
};

class Store {
  constructor(userDataDir) {
    this.dir = userDataDir;
    this.settingsFile = path.join(userDataDir, 'settings.json');
    this.sessionDir = path.join(userDataDir, 'sessions');
    fs.mkdirSync(this.sessionDir, { recursive: true });
    this.settings = { ...DEFAULTS };
    try {
      Object.assign(this.settings, JSON.parse(fs.readFileSync(this.settingsFile, 'utf8')));
    } catch {
      /* first run */
    }
  }

  getSettings() {
    return { ...this.settings, directories: [...this.settings.directories] };
  }

  setSettings(patch) {
    Object.assign(this.settings, patch || {});
    this.settings.directories = [...new Set((this.settings.directories || []).filter(Boolean))];
    if (this.settings.saveDirectory && !this.settings.directories.includes(this.settings.saveDirectory)) {
      this.settings.saveDirectory = this.settings.directories[0] || '';
    }
    if (!this.settings.saveDirectory) this.settings.saveDirectory = this.settings.directories[0] || '';
    writeAtomic(this.settingsFile, JSON.stringify(this.settings, null, 2));
    return this.getSettings();
  }

  sessionFile(dreamPath) {
    const key = crypto.createHash('sha1').update(path.resolve(dreamPath)).digest('hex');
    return path.join(this.sessionDir, `${key}.json`);
  }

  getSession(dreamPath) {
    try {
      return JSON.parse(fs.readFileSync(this.sessionFile(dreamPath), 'utf8'));
    } catch {
      return null;
    }
  }

  saveSession(dreamPath, data) {
    writeAtomic(this.sessionFile(dreamPath), JSON.stringify({ ...data, dreamPath }, null, 1));
  }

  deleteSession(dreamPath) {
    try {
      fs.unlinkSync(this.sessionFile(dreamPath));
    } catch {
      /* none */
    }
  }
}

function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

module.exports = { Store, writeAtomic };
