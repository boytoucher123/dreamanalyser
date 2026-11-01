'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Transcriber, pythonCommand } = require('../src/main/transcriber');

// Runs the real worker script against a stub "whisper" module, so no model or GPU is needed.
const python = process.platform === 'win32' ? 'python' : 'python3';
let hasPython = true;
try {
  execFileSync(python, ['--version'], { stdio: 'ignore' });
} catch {
  hasPython = false;
}
process.env.PYTHONPATH = path.join(__dirname, 'fixtures', 'fake-whisper');

function make(cfg = {}) {
  const statuses = [];
  const t = new Transcriber(() => ({ pythonPath: python, whisperModel: 'medium', ffmpegDir: '', ...cfg }), (s) => statuses.push(s));
  return { t, statuses };
}

test('pythonCommand splits launcher arguments but keeps quoted paths whole', () => {
  assert.deepEqual(pythonCommand('py -3'), ['py', '-3']);
  assert.deepEqual(pythonCommand('"C:\\Program Files\\Python\\python.exe"'), ['C:\\Program Files\\Python\\python.exe']);
  assert.equal(pythonCommand('').length, 1);
});

test('transcribes through the worker and reuses the loaded model', { skip: !hasPython }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stt-'));
  const a = path.join(dir, 'a.m4a');
  const b = path.join(dir, 'b.m4a');
  fs.writeFileSync(a, 'I was in a house… ünïcode');
  fs.writeFileSync(b, 'then a boat');
  const { t, statuses } = make();
  try {
    const ready = await t.start();
    assert.equal(ready.model, 'medium');
    const pid = t.proc.pid;
    assert.deepEqual(await t.transcribe(a), { text: 'I was in a house… ünïcode', language: 'en' });
    assert.deepEqual(await t.transcribe(b, { language: 'fr' }), { text: 'then a boat', language: 'fr' });
    assert.equal(t.proc.pid, pid, 'model should stay loaded between transcriptions');
    assert.ok(statuses.some((s) => s.state === 'transcribing' && s.progress === 100));
  } finally {
    t.stop();
  }
});

test('reports per-file errors without killing the worker', { skip: !hasPython }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stt-'));
  const bad = path.join(dir, 'x.broken');
  fs.writeFileSync(bad, '');
  const { t } = make();
  try {
    await assert.rejects(t.transcribe(bad), /Failed to load audio/);
    assert.ok(t.proc, 'worker still running');
  } finally {
    t.stop();
  }
});

test('surfaces model-loading and missing-Python errors', { skip: !hasPython }, async () => {
  await assert.rejects(make({ whisperModel: 'missing' }).t.start(), /Could not load Whisper model 'missing'/);
  await assert.rejects(make({ pythonPath: 'definitely-not-python-xyz' }).t.start(), /Couldn't start Python/);
});

test('cancel rejects the pending transcription', { skip: !hasPython }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stt-'));
  const a = path.join(dir, 'a.m4a');
  fs.writeFileSync(a, 'hello');
  const { t } = make();
  const p = t.transcribe(a);
  t.cancel();
  await assert.rejects(p);
  assert.equal(t.proc, null);
});
