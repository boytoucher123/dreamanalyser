'use strict';
/**
 * Speech to text via a local OpenAI Whisper install.
 *
 * Runs whisper_worker.py as a long-lived child process so the model is loaded
 * once (it's slow) and reused for every dictation. The worker shuts itself
 * down after a period of inactivity to give the memory back.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const IDLE_MS = 10 * 60 * 1000;

// Python can't read files inside app.asar, so a packaged build unpacks the script (see "asarUnpack").
const SCRIPT = path.join(__dirname, 'whisper_worker.py').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');

function defaultPython() {
  return process.platform === 'win32' ? 'python' : 'python3';
}

/** "C:\Program Files\Python\python.exe" stays whole; "py -3" becomes ["py", "-3"]. */
function pythonCommand(setting) {
  const cmd = String(setting || '').trim() || defaultPython();
  if (fs.existsSync(cmd)) return [cmd];
  const m = cmd.match(/^"([^"]+)"\s*(.*)$/);
  if (m) return [m[1], ...m[2].split(/\s+/).filter(Boolean)];
  return cmd.split(/\s+/);
}

class Transcriber {
  /**
   * @param {() => {pythonPath, whisperModel, ffmpegDir}} getConfig
   * @param {(status: {state, message?, progress?}) => void} onStatus
   */
  constructor(getConfig, onStatus = () => {}) {
    this.getConfig = getConfig;
    this.onStatus = onStatus;
    this.proc = null;
    this.ready = null; // Promise resolving once the model is loaded
    this.key = '';
    this.jobs = new Map();
    this.seq = 0;
    this.idleTimer = null;
  }

  configKey(c) {
    return JSON.stringify([c.pythonPath || '', c.whisperModel || 'medium', c.ffmpegDir || '']);
  }

  /** Start the worker (if needed) and wait until the model is loaded. */
  start() {
    const cfg = this.getConfig();
    const key = this.configKey(cfg);
    if (this.proc && this.key !== key) this.stop();
    if (this.ready) return this.ready;

    this.key = key;
    const [cmd, ...pre] = pythonCommand(cfg.pythonPath);
    const model = cfg.whisperModel || 'medium';
    const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' };
    if (cfg.ffmpegDir) {
      const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
      env[pathKey] = `${cfg.ffmpegDir}${path.delimiter}${env[pathKey] || ''}`;
    }

    this.onStatus({ state: 'loading', message: `Loading Whisper "${model}"…` });
    const proc = spawn(cmd, [...pre, SCRIPT, '--model', model], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    let stderrTail = '';
    let stdoutBuf = '';

    this.ready = new Promise((resolve, reject) => {
      const fail = (err) => {
        if (this.proc === proc) this.reset();
        reject(err);
      };

      proc.on('error', (err) => {
        fail(
          new Error(
            err.code === 'ENOENT'
              ? `Couldn't start Python ("${cmd}"). Install Python, or set the Python command in Settings → Speech to text.`
              : `Couldn't start the Whisper worker: ${err.message}`,
          ),
        );
      });

      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', (chunk) => {
        stderrTail = (stderrTail + chunk).slice(-4000);
        // Whisper's tqdm progress bar: " 42%|████      | 1234/2900 [00:05<00:07, ...]"
        const all = [...chunk.matchAll(/(\d{1,3})%\|/g)];
        if (all.length) this.onStatus({ state: 'transcribing', progress: Math.min(100, Number(all[all.length - 1][1])) });
      });

      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (chunk) => {
        stdoutBuf += chunk;
        let nl;
        while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
          const line = stdoutBuf.slice(0, nl).trim();
          stdoutBuf = stdoutBuf.slice(nl + 1);
          if (!line) continue;
          let msg;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          if (msg.type === 'ready') {
            this.onStatus({ state: 'ready', message: `Whisper "${msg.model}" ready (${msg.device})` });
            this.touch();
            resolve(msg);
          } else if (msg.type === 'fatal') {
            fail(new Error(msg.message));
          } else if (msg.type === 'result' || msg.type === 'error') {
            const job = this.jobs.get(msg.id);
            if (!job) continue;
            this.jobs.delete(msg.id);
            this.touch();
            if (msg.type === 'result') job.resolve({ text: msg.text, language: msg.language });
            else job.reject(new Error(`Whisper couldn't transcribe the audio: ${msg.message}`));
          }
        }
      });

      proc.on('exit', (code) => {
        const tail = stderrTail.trim().split(/\r?\n/).filter((l) => !/%\|/.test(l)).slice(-3).join(' ');
        const err = new Error(`The Whisper worker stopped (exit code ${code})${tail ? `: ${tail}` : ''}`);
        for (const job of this.jobs.values()) job.reject(err);
        this.jobs.clear();
        if (this.proc === proc) this.reset();
        reject(err); // no-op if already resolved
      });
    });
    // Avoid unhandled-rejection noise when nobody is awaiting a warm-up.
    this.ready.catch(() => {});
    return this.ready;
  }

  /** Transcribe an audio file (any format FFmpeg can read: m4a, mp3, wav, webm, ogg…). */
  async transcribe(file, { language } = {}) {
    if (!fs.existsSync(file)) throw new Error(`Audio file not found: ${file}`);
    await this.start();
    clearTimeout(this.idleTimer);
    const id = `t${++this.seq}`;
    this.onStatus({ state: 'transcribing', progress: 0 });
    return new Promise((resolve, reject) => {
      this.jobs.set(id, { resolve, reject });
      this.proc.stdin.write(`${JSON.stringify({ id, path: file, language: language || null })}\n`);
    });
  }

  /** Stop the worker; any in-flight transcription is rejected. */
  cancel() {
    const had = !!this.proc;
    for (const job of this.jobs.values()) job.reject(Object.assign(new Error('Transcription cancelled'), { cancelled: true }));
    this.jobs.clear();
    this.stop();
    return had;
  }

  touch() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (!this.jobs.size) this.stop();
    }, IDLE_MS);
  }

  reset() {
    clearTimeout(this.idleTimer);
    this.proc = null;
    this.ready = null;
    this.key = '';
    this.onStatus({ state: 'stopped' });
  }

  stop() {
    const proc = this.proc;
    this.reset();
    if (proc && proc.exitCode === null) {
      try {
        proc.stdin.end();
        proc.kill();
      } catch {
        /* already gone */
      }
    }
  }
}

module.exports = { Transcriber, pythonCommand, defaultPython, SCRIPT };
