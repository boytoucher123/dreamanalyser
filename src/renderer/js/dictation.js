'use strict';
/*
 * Dictation for the dream form: record from the microphone (or pick/drop an
 * audio file such as an .m4a voice memo) → transcribe locally with Whisper →
 * have the Ollama model put the rambling transcript in order and remove
 * repetition → put the result in the Recollection box for the user to edit.
 */
(function () {
  const D = {
    phase: 'idle', // idle | recording | transcribing | tidying
    recorder: null,
    stream: null,
    audioCtx: null,
    chunks: [],
    startedAt: 0,
    timer: null,
    source: null, // { path, temp, name } — kept until done so a failed transcription can be retried
    cancelled: false,
    result: null, // { before, sep, raw, tidy, showing: 'tidy' | 'raw' }
  };

  let A; // window.App, set in init()
  const $ = (sel) => document.querySelector(sel);
  const ta = () => $('#dreamText');
  const busy = () => D.phase !== 'idle';

  /* ---------------- Status bar ---------------- */

  function bar(state, html, actions = []) {
    const el = $('#dictationBar');
    el.className = `dictation-bar ${state}`;
    $('#dictationText').innerHTML = html;
    $('#dictationActions').innerHTML = actions.map(([a, label]) => `<button type="button" class="btn ghost small" data-dict="${a}">${label}</button>`).join('');
  }
  function hideBar() {
    $('#dictationBar').className = 'dictation-bar hidden';
  }
  function fail(msg, canRetry = !!D.source) {
    D.phase = 'idle';
    setLocked(false);
    bar('error', A.esc(msg), [...(canRetry ? [['retry', 'Try again']] : []), ['dismiss', 'Dismiss']]);
  }

  function setLocked(on) {
    const t = ta();
    t.readOnly = on;
    t.classList.toggle('busy', on);
    $('#dictateBtn').disabled = on && D.phase !== 'recording';
    $('#uploadAudioBtn').disabled = on;
    $('#formSubmitBtn').disabled = on;
    $('#formSaveOnlyBtn').disabled = on;
  }

  function renderRecordButton() {
    const b = $('#dictateBtn');
    const rec = D.phase === 'recording';
    b.classList.toggle('recording', rec);
    b.lastChild.textContent = rec ? 'Stop' : 'Dictate';
    b.firstChild.outerHTML = window.icon(rec ? 'stop' : 'mic');
  }

  const clock = (ms) => {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  /* ---------------- Recording ---------------- */

  async function startRecording() {
    if (busy()) return;
    discardSource();
    D.result = null;
    try {
      if (!(await A.api.micAccess())) throw new Error('Microphone access was denied. Allow it in your system privacy settings.');
      D.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      const msg = e?.name === 'NotFoundError' ? 'No microphone was found.' : e?.name === 'NotAllowedError' ? 'Microphone access was denied.' : A.cleanErr(e);
      fail(msg, false);
      return;
    }
    // Load the Whisper model in the background while the user is speaking.
    A.api.warmupWhisper().catch(() => {});

    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find((m) => window.MediaRecorder?.isTypeSupported(m));
    D.recorder = new MediaRecorder(D.stream, mime ? { mimeType: mime } : undefined);
    D.chunks = [];
    D.recorder.ondataavailable = (e) => e.data.size && D.chunks.push(e.data);
    D.recorder.start(1000);
    D.phase = 'recording';
    D.startedAt = Date.now();
    D.cancelled = false;
    setLocked(true);
    renderRecordButton();

    // Simple input-level meter so it's obvious the mic is picking you up.
    let level = null;
    try {
      D.audioCtx = new AudioContext();
      const analyser = D.audioCtx.createAnalyser();
      analyser.fftSize = 512;
      D.audioCtx.createMediaStreamSource(D.stream).connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);
      level = () => {
        analyser.getByteTimeDomainData(buf);
        let peak = 0;
        for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
        return Math.min(1, (peak / 128) * 2.2);
      };
    } catch {
      /* meter is optional */
    }

    bar('recording', 'Recording <b id="dictClock">0:00</b> — describe your dream, in any order <span class="dictation-level"><i id="dictLevel"></i></span>', [
      ['stop', 'Stop & transcribe'],
      ['discard', 'Discard'],
    ]);
    D.timer = setInterval(() => {
      const c = $('#dictClock');
      if (c) c.textContent = clock(Date.now() - D.startedAt);
      const l = $('#dictLevel');
      if (l && level) l.style.width = `${Math.round(level() * 100)}%`;
    }, 100);
  }

  async function stopRecording({ discard = false } = {}) {
    if (D.phase !== 'recording') return;
    clearInterval(D.timer);
    const rec = D.recorder;
    await new Promise((resolve) => {
      rec.onstop = resolve;
      rec.stop();
    });
    D.stream.getTracks().forEach((t) => t.stop());
    D.audioCtx?.close().catch(() => {});
    D.recorder = D.stream = D.audioCtx = null;
    D.phase = 'idle';
    renderRecordButton();
    setLocked(false);

    const blob = new Blob(D.chunks, { type: rec.mimeType || 'audio/webm' });
    D.chunks = [];
    if (discard) {
      hideBar();
      return;
    }
    if (Date.now() - D.startedAt < 1000 || blob.size < 2000) {
      fail('That recording was too short — press Dictate and try again.', false);
      return;
    }
    const ext = /ogg/.test(blob.type) ? 'ogg' : 'webm';
    const path = await A.api.saveRecording(await blob.arrayBuffer(), ext);
    D.source = { path, temp: true, name: 'your recording' };
    run();
  }

  /* ---------------- File upload / drop ---------------- */

  async function chooseFile() {
    if (busy()) return;
    const path = await A.api.chooseAudio();
    if (path) useFile(path);
  }

  function useFile(path) {
    if (busy()) return;
    discardSource();
    D.result = null;
    D.source = { path, temp: false, name: path.split(/[\\/]/).pop() };
    run();
  }

  function discardSource() {
    if (D.source?.temp) A.api.discardRecording(D.source.path).catch(() => {});
    D.source = null;
  }

  /* ---------------- Transcribe → tidy → insert ---------------- */

  async function run() {
    const src = D.source;
    if (!src) return;
    D.cancelled = false;
    D.phase = 'transcribing';
    setLocked(true);
    bar('working', `Transcribing ${A.esc(src.name)}…`, [['cancel', 'Cancel']]);

    let raw;
    try {
      raw = ((await A.api.transcribe(src.path)).text || '').trim();
    } catch (e) {
      if (D.cancelled) return;
      fail(A.cleanErr(e));
      return;
    }
    if (D.cancelled) return;
    if (!raw) {
      fail('No speech was found in that recording.');
      return;
    }
    discardSource();

    const t = ta();
    const before = t.value.replace(/\s+$/, '');
    const sep = before ? '\n\n' : '';
    D.result = { before, sep, raw, tidy: null, showing: 'raw' };

    const S = A.S;
    if (S.settings.tidyDictation === false || !S.settings.model) {
      t.value = before + sep + raw;
      D.phase = 'idle';
      setLocked(false);
      bar('done', S.settings.tidyDictation === false ? 'Transcript added — edit it as you like.' : 'Transcript added. Choose an Ollama model to have it tidied automatically.', [['dismiss', 'OK']]);
      t.focus();
      return;
    }

    D.phase = 'tidying';
    bar('working', 'Putting your dream in order with the AI…', [['stop-tidy', 'Stop']]);
    try {
      const r = await A.llm(A.P.tidyRecollection(raw), {
        temperature: 0.2,
        numCtx: 16384,
        onToken: (acc) => {
          t.value = before + sep + clean(acc);
          t.scrollTop = t.scrollHeight;
        },
      });
      const tidy = clean(r.text);
      if (r.aborted || !tidy) {
        t.value = before + sep + raw;
        bar('done', r.aborted ? 'Stopped — the raw transcript was added instead.' : "The AI didn't return anything — the raw transcript was added instead.", [['dismiss', 'OK']]);
      } else {
        D.result.tidy = tidy;
        D.result.showing = 'tidy';
        t.value = before + sep + tidy;
        bar('done', 'Added to your recollection, put in order by the AI. Check it and edit anything it got wrong.', [
          ['toggle', 'Show raw transcript'],
          ['dismiss', 'OK'],
        ]);
      }
    } catch (e) {
      t.value = before + sep + raw;
      bar('error', `Couldn't tidy the transcript (${A.esc(A.cleanErr(e))}). The raw transcript was added instead.`, [['dismiss', 'OK']]);
    } finally {
      D.phase = 'idle';
      setLocked(false);
      t.focus();
    }
  }

  /** Strip reasoning, code fences, quotes and "Here is…" preambles that small models like to add. */
  function clean(text) {
    let s = A.U.stripThinking(text || '').trim();
    s = s.replace(/^```[a-z]*\s*\n?/i, '').replace(/\n?```\s*$/, '');
    s = s.replace(/^(here is|here's|sure[,!]?)[^\n]*:\s*\n+/i, '');
    s = s.replace(/^"""\s*\n?|\n?"""\s*$/g, '');
    return s.trim();
  }

  function toggleVersion() {
    const r = D.result;
    if (!r?.tidy) return;
    const t = ta();
    const current = r.before + r.sep + (r.showing === 'tidy' ? r.tidy : r.raw);
    if (t.value !== current && !confirm('You have edited the recollection since it was added. Swap versions and lose those edits?')) return;
    r.showing = r.showing === 'tidy' ? 'raw' : 'tidy';
    t.value = r.before + r.sep + (r.showing === 'tidy' ? r.tidy : r.raw);
    bar('done', r.showing === 'tidy' ? 'Showing the version put in order by the AI.' : 'Showing the raw transcript, exactly as Whisper heard it.', [
      ['toggle', r.showing === 'tidy' ? 'Show raw transcript' : 'Show tidied version'],
      ['dismiss', 'OK'],
    ]);
  }

  async function cancel() {
    D.cancelled = true;
    D.phase = 'idle';
    setLocked(false);
    await A.api.cancelTranscription();
    bar('error', 'Transcription cancelled.', [['retry', 'Try again'], ['dismiss', 'Dismiss']]);
  }

  /** Stop everything (e.g. when leaving the form). */
  async function reset() {
    if (D.phase === 'recording') await stopRecording({ discard: true });
    else if (D.phase === 'transcribing') {
      D.cancelled = true;
      A.api.cancelTranscription();
    } else if (D.phase === 'tidying' && A.S.reqId) A.api.abort(A.S.reqId);
    D.phase = 'idle';
    discardSource();
    D.result = null;
    setLocked(false);
    hideBar();
  }

  /* ---------------- Events ---------------- */

  function init() {
    A = window.App;
    $('#dictateBtn').addEventListener('click', () => (D.phase === 'recording' ? stopRecording() : startRecording()));
    $('#uploadAudioBtn').addEventListener('click', chooseFile);
    $('#dictationBar').addEventListener('click', (e) => {
      const a = e.target.closest('[data-dict]')?.dataset.dict;
      if (a === 'stop') stopRecording();
      else if (a === 'discard') stopRecording({ discard: true });
      else if (a === 'cancel') cancel();
      else if (a === 'stop-tidy') A.S.reqId && A.api.abort(A.S.reqId);
      else if (a === 'retry') run();
      else if (a === 'toggle') toggleVersion();
      else if (a === 'dismiss') {
        discardSource();
        hideBar();
      }
    });

    A.api.onTranscribeStatus((st) => {
      if (D.phase !== 'transcribing') return;
      const name = A.esc(D.source?.name || 'recording');
      if (st.state === 'loading') bar('working', `${A.esc(st.message)} (the first time can take a minute)`, [['cancel', 'Cancel']]);
      else if (st.state === 'transcribing') bar('working', `Transcribing ${name}… <b>${st.progress || 0}%</b>`, [['cancel', 'Cancel']]);
    });

    // Drop an audio file onto the recollection box.
    const field = $('.dictation-field');
    const isFileDrag = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    field.addEventListener('dragover', (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      field.classList.add('dragover');
    });
    field.addEventListener('dragleave', (e) => {
      if (!field.contains(e.relatedTarget)) field.classList.remove('dragover');
    });
    field.addEventListener('drop', (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      field.classList.remove('dragover');
      const file = e.dataTransfer.files[0];
      if (!file) return;
      if (!/^(audio|video)\//.test(file.type) && !/\.(m4a|mp3|wav|ogg|oga|opus|webm|flac|aac|mp4|wma|amr|3gp)$/i.test(file.name)) {
        A.toast(`${file.name} doesn't look like an audio file.`, 'warn');
        return;
      }
      useFile(A.api.pathForFile(file));
    });
    // Don't let a file dropped elsewhere replace the page.
    document.addEventListener('dragover', (e) => isFileDrag(e) && e.preventDefault());
    document.addEventListener('drop', (e) => isFileDrag(e) && e.preventDefault());
  }

  window.Dictation = { init, reset, busy };
})();
