'use strict';
/* Dream Analyser — renderer: journal, dream form and the guided interpretation workflow. */
(function () {
  const api = window.api;
  const U = window.Util;
  const P = window.Prompts;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = U.escapeHtml;

  const S = {
    settings: null,
    dreams: [],
    unsupported: [], // .ld3 files that aren't <Dream> documents
    models: [],
    ollamaOk: false,
    expanded: new Set(),
    search: '',
    cur: null, // { path, fields, session, notes, interpretation }
    busy: false,
    reqId: null,
    form: { mode: 'new', returnTo: 'home' },
    interpEditing: false,
  };

  const els = new WeakMap(); // transcript entry -> DOM element

  /* ------------------------------------------------------------------ */
  /* Ollama                                                              */
  /* ------------------------------------------------------------------ */
  let reqCounter = 0;
  const tokenHandlers = new Map();
  api.onToken((id, token) => tokenHandlers.get(id)?.(token));

  const cleanErr = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');

  async function llm(messages, { onToken, format, temperature } = {}) {
    const model = S.settings.model;
    if (!model) throw new Error('No model selected — choose an Ollama model in the top bar.');
    const id = `req${++reqCounter}`;
    S.reqId = id;
    let acc = '';
    tokenHandlers.set(id, (t) => {
      acc += t;
      onToken?.(acc);
    });
    try {
      const request = {
        model,
        messages,
        options: { temperature: temperature ?? S.settings.temperature ?? 0.7, num_ctx: 8192 },
      };
      if (format) request.format = format;
      const r = await api.chat(id, request);
      return { text: r.content, aborted: r.aborted };
    } catch (e) {
      throw new Error(cleanErr(e));
    } finally {
      tokenHandlers.delete(id);
      if (S.reqId === id) S.reqId = null;
    }
  }

  function stopGeneration() {
    if (S.reqId) api.abort(S.reqId);
  }

  async function loadModels() {
    try {
      S.models = await api.listModels();
      S.ollamaOk = true;
    } catch {
      S.models = [];
      S.ollamaOk = false;
    }
    const names = S.models.map((m) => m.name);
    if ((!S.settings.model || !names.includes(S.settings.model)) && names.length) {
      if (!S.settings.model) {
        const pick = names.find((n) => !/embed/i.test(n)) || names[0];
        S.settings = await api.setSettings({ model: pick });
      }
    }
    renderModelSelects();
  }

  function renderModelSelects() {
    const names = S.models.map((m) => m.name);
    const current = S.settings.model;
    let opts = S.models
      .map((m) => `<option value="${esc(m.name)}">${esc(m.name)}${m.parameters ? ` · ${esc(m.parameters)}` : ''}</option>`)
      .join('');
    if (current && !names.includes(current)) opts = `<option value="${esc(current)}">${esc(current)} (unavailable)</option>${opts}`;
    if (!opts) opts = '<option value="">No models found</option>';
    for (const sel of [$('#modelSelect'), $('#settingsModel')]) {
      sel.innerHTML = opts;
      sel.value = current || '';
    }
    const dot = $('#ollamaDot');
    dot.className = `status-dot ${S.ollamaOk ? 'ok' : 'bad'}`;
    dot.title = S.ollamaOk ? `Connected to Ollama (${S.models.length} models)` : 'Cannot reach Ollama';
  }

  async function setModel(name) {
    S.settings = await api.setSettings({ model: name });
    renderModelSelects();
  }

  function ensureModel() {
    if (S.settings.model) return true;
    toast(S.ollamaOk ? 'Choose an Ollama model first.' : "Can't reach Ollama — is it running?", 'warn');
    openSettings();
    return false;
  }

  /* ------------------------------------------------------------------ */
  /* UI helpers                                                          */
  /* ------------------------------------------------------------------ */
  function toast(msg, type = 'info', ms = 4200) {
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.textContent = msg;
    $('#toasts').appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => {
      t.classList.remove('show');
      setTimeout(() => t.remove(), 400);
    }, ms);
  }

  function showView(name) {
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
    document.body.dataset.view = name;
  }

  /* ------------------------------------------------------------------ */
  /* Journal (home)                                                      */
  /* ------------------------------------------------------------------ */
  const sortKey = (d) => {
    const p = U.parseDate(d.date);
    const t = /^(\d{1,2}):(\d{2})/.exec(d.time || '');
    return (p ? p.y * 10000 + p.m * 100 + p.d : 0) * 10000 + (t ? +t[1] * 100 + +t[2] : 0);
  };

  async function refreshDreams() {
    try {
      const all = await api.listDreams();
      // .ld3 files that aren't dreams (checks, readings, REM cycles, ignore lists…) are hidden and flagged.
      S.unsupported = all.filter((d) => d.unsupported).sort((a, b) => a.path.localeCompare(b.path));
      S.dreams = all.filter((d) => !d.unsupported).sort((a, b) => sortKey(b) - sortKey(a) || b.mtime - a.mtime);
    } catch (e) {
      toast(`Couldn't scan dream folders: ${cleanErr(e)}`, 'error');
    }
    renderTree();
    renderUnsupported();
    renderHome();
  }

  function renderUnsupported() {
    const box = $('#unsupported');
    const list = S.unsupported;
    box.classList.toggle('hidden', !list.length);
    if (!list.length) return;
    const kinds = [...new Set(list.map((d) => d.kind))];
    box.innerHTML = `<details>
      <summary>${icon('alert')}<span>${list.length} unsupported .ld3 file${list.length > 1 ? 's' : ''} hidden</span></summary>
      <p class="muted small">These aren't dreams (${kinds.map((k) => `&lt;${esc(k)}&gt;`).join(', ')}) — support may come later.</p>
      <ul>${list
        .map((d) => `<li title="${esc(d.reason || '')}\n${esc(d.path)}"><span class="kind">${esc(d.kind)}</span><span class="name">${esc(d.relDir ? `${d.relDir}/` : '')}${esc(d.title)}</span></li>`)
        .join('')}</ul>
    </details>`;
  }

  function renderTree() {
    const tree = $('#tree');
    const q = S.search.trim().toLowerCase();
    const list = S.dreams.filter((d) => !q || `${d.title} ${d.excerpt || ''} ${d.date}`.toLowerCase().includes(q));

    if (!S.dreams.length) {
      tree.innerHTML = `<div class="tree-empty">${icon('moon')}<p>${
        S.settings.directories.length
          ? 'No <code>.ld3</code> dreams found in your folders yet.'
          : 'Add a folder containing your <code>.ld3</code> dream files, or record a new dream — it will be saved to <b>Documents/Dreams</b>.'
      }</p></div>`;
      return;
    }
    if (!list.length) {
      tree.innerHTML = '<div class="tree-empty"><p>No dreams match your search.</p></div>';
      return;
    }

    const years = new Map();
    for (const d of list) {
      const p = U.parseDate(d.date);
      const y = p ? String(p.y) : 'Undated';
      const m = p ? String(p.m).padStart(2, '0') : '00';
      if (!years.has(y)) years.set(y, new Map());
      const months = years.get(y);
      if (!months.has(m)) months.set(m, []);
      months.get(m).push({ ...d, _day: p ? p.d : '' });
    }

    if (!S.expanded.size && years.size) {
      const [y, months] = years.entries().next().value;
      S.expanded.add(y);
      S.expanded.add(`${y}-${months.keys().next().value}`);
    }

    const activePath = S.cur?.path;
    let html = '';
    for (const [y, months] of years) {
      const count = [...months.values()].reduce((n, a) => n + a.length, 0);
      html += `<details class="tree-year" data-key="${esc(y)}" ${q || S.expanded.has(y) ? 'open' : ''}>
        <summary>${icon('chevron')}<span class="label">${esc(y)}</span><span class="count">${count}</span></summary>`;
      for (const [m, items] of months) {
        const key = `${y}-${m}`;
        const name = m === '00' ? 'Unknown month' : U.MONTHS[+m - 1];
        html += `<details class="tree-month" data-key="${esc(key)}" ${q || S.expanded.has(key) ? 'open' : ''}>
          <summary>${icon('chevron')}<span class="label">${esc(name)}</span><span class="count">${items.length}</span></summary>
          <div class="tree-items">`;
        for (const d of items) {
          html += `<button class="tree-dream ${d.path === activePath ? 'active' : ''} " data-path="${esc(d.path)}" title="${esc(d.path)}">
            <span class="day">${esc(d._day)}</span>
            <span class="title">${esc(d.title || 'Untitled')}</span>
            ${d.hasInterpretation ? `<span class="interp-mark" title="Interpreted">${icon('sparkle')}</span>` : ''}
          </button>`;
        }
        html += '</div></details>';
      }
      html += '</details>';
    }
    tree.innerHTML = html;
  }

  function renderHome() {
    const now = new Date();
    const thisMonth = S.dreams.filter((d) => {
      const p = U.parseDate(d.date);
      return p && p.y === now.getFullYear() && p.m === now.getMonth() + 1;
    }).length;
    const interpreted = S.dreams.filter((d) => d.hasInterpretation).length;
    $('#stats').innerHTML = [
      [S.dreams.length, 'dreams recorded'],
      [thisMonth, 'this month'],
      [interpreted, 'interpreted'],
    ]
      .map(([n, l]) => `<div class="stat glass"><b>${n}</b><span>${l}</span></div>`)
      .join('');

    const recent = S.dreams.slice(0, 6);
    $('#recent').innerHTML = recent.length
      ? recent
          .map(
            (d) => `<button class="dream-card glass" data-path="${esc(d.path)}">
              <div class="dc-date">${esc(U.prettyDate(d.date))}${d.hasInterpretation ? `<span class="interp-mark">${icon('sparkle')}</span>` : ''}</div>
              <div class="dc-title">${esc(d.title || 'Untitled')}</div>
              <div class="dc-excerpt">${esc(d.excerpt || '')}</div>
            </button>`,
          )
          .join('')
      : '<p class="muted">Your most recent dreams will appear here.</p>';
    $('.recent-wrap').classList.toggle('hidden', !recent.length && !S.dreams.length);
  }

  /* ------------------------------------------------------------------ */
  /* Dream form                                                          */
  /* ------------------------------------------------------------------ */
  function setupRatings() {
    $$('.rating').forEach((r) => {
      r.innerHTML = [1, 2, 3, 4, 5].map((n) => `<button type="button" data-v="${n}" title="${n}">${icon('star')}</button>`).join('');
      r.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        const v = b.dataset.v === r.dataset.value ? '' : b.dataset.v;
        setRating(r, v);
      });
    });
  }

  function setRating(r, v) {
    r.dataset.value = v || '';
    $$('button', r).forEach((b) => b.classList.toggle('on', v && +b.dataset.v <= +v));
  }

  function openForm(mode = 'new', returnTo = 'home') {
    S.form = { mode, returnTo };
    const f = $('#dreamForm');
    f.reset();
    const fields = mode === 'edit' && S.cur ? S.cur.fields : {};
    f.Title.value = fields.Title || '';
    // Non-ISO dates from other apps are edited as plain text so they aren't lost.
    const isoDate = /^\d{4}-\d{2}-\d{2}$/.test(fields.Date || '');
    f.Date.type = mode === 'edit' && fields.Date && !isoDate ? 'text' : 'date';
    f.Date.value = mode === 'edit' ? fields.Date || '' : U.todayIso();
    f.Dream.value = fields.Dream || '';
    f.Time.value = mode === 'edit' ? fields.Time || '' : U.nowTime();
    f.Sleep.value = fields.Sleep || '';
    f.Awake.value = fields.Awake || '';
    setRating($('.rating[data-name="Lucidity"]'), fields.Lucidity || '');
    setRating($('.rating[data-name="Clarity"]'), fields.Clarity || '');
    $('#formHeading').textContent = mode === 'edit' ? 'Edit dream' : 'A new dream';
    $('#formSubmitBtn').lastChild.textContent = mode === 'edit' ? 'Save changes' : 'Interpret this dream';
    $('#formSaveOnlyBtn').classList.toggle('hidden', mode === 'edit');
    $('.more').open = mode === 'edit';
    showView('form');
    setTimeout(() => (mode === 'edit' ? f.Dream : f.Title).focus(), 50);
  }

  function readForm() {
    const f = $('#dreamForm');
    return {
      Title: f.Title.value.trim(),
      Date: f.Date.value.trim(),
      Dream: f.Dream.value.replace(/\s+$/, ''),
      Time: f.Time.value,
      Sleep: f.Sleep.value,
      Awake: f.Awake.value,
      Lucidity: $('.rating[data-name="Lucidity"]').dataset.value || '',
      Clarity: $('.rating[data-name="Clarity"]').dataset.value || '',
    };
  }

  async function submitForm(startAfter) {
    const f = $('#dreamForm');
    if (!f.reportValidity()) return;
    const values = readForm();
    const buttons = $$('.form-actions button');
    buttons.forEach((b) => (b.disabled = true));
    try {
      if (S.form.mode === 'edit' && S.cur) {
        Object.assign(S.cur.fields, values);
        await saveNow();
        renderSessionHeader();
        renderDreamPanel();
        showView('session');
        toast('Dream updated', 'success');
        refreshDreams();
        return;
      }
      if (startAfter && !ensureModel()) return;
      const fields = { ...values, Comments: '', SubCategories: '', Image: '' };
      const path = await api.saveDream({ path: null, fields });
      S.settings = await api.getSettings();
      await refreshDreams();
      await openDream(path, { autostart: startAfter });
    } catch (e) {
      toast(`Couldn't save dream: ${cleanErr(e)}`, 'error');
    } finally {
      buttons.forEach((b) => (b.disabled = false));
    }
  }

  /* ------------------------------------------------------------------ */
  /* Session: loading & saving                                           */
  /* ------------------------------------------------------------------ */
  /*
   * Workflow phases:
   *   new        – nothing started
   *   extract    – AI is listing the dream's details (or new leads from the notes), then a JSON-structuring thread
   *   ask        – fresh thread, given ONLY the current detail, is writing a question
   *   answer     – waiting for the dreamer's answer (the AI does not reply to it)
   *   summarise  – fresh thread is structuring the answer into notes
   *   analyse    – fresh threads each build one analysis document from the notes
   *   interpret  – fresh thread writes the interpretation from the analysis documents only
   *   chat       – ordinary conversation about the interpretation (with compaction)
   */
  const SESSION_VERSION = 2;
  const newSession = () => ({
    version: SESSION_VERSION,
    phase: 'new',
    round: 1,
    details: [], // { title, description, round, status: pending|done|skipped, question, asked[], answer }
    index: 0,
    transcript: [], // everything shown in the chat pane
    analysis: {}, // analysis document key -> markdown
    chat: { from: 0, summary: '' }, // model sees: interpretation + summary + transcript[from..]
    interpHistory: [],
  });

  const alive = (cur) => S.cur === cur;
  const dreamCtx = (cur) => ({ title: cur.fields.Title, date: cur.fields.Date, text: cur.fields.Dream });
  const WALK_PHASES = ['ask', 'answer', 'summarise'];

  async function openDream(path, { autostart = false } = {}) {
    if (S.cur) await leaveSession();
    let data;
    try {
      data = await api.readDream(path);
    } catch (e) {
      toast(`Couldn't open dream: ${cleanErr(e)}`, 'error');
      refreshDreams();
      return;
    }
    let session = await api.getSession(path);
    if (!session || session.version !== SESSION_VERSION) session = newSession();
    session.interpHistory ||= [];
    session.analysis ||= {};
    session.chat ||= { from: session.transcript.length, summary: '' };
    const { notes, interpretation } = U.splitComments(data.fields.Comments);
    S.cur = { path, fields: data.fields, session, notes, interpretation };
    S.interpEditing = false;
    showView('session');
    renderSession();
    switchTab(interpretation && (session.phase === 'chat' || session.phase === 'new') ? 'interp' : 'notes');
    setSaveState('');
    renderTree();
    if (autostart) startAnalysis();
    else $('#chatInput').focus();
  }

  async function leaveSession() {
    if (S.busy) stopGeneration();
    await saveNow();
    S.cur = null;
  }

  async function goHome() {
    await leaveSession();
    showView('home');
    refreshDreams();
  }

  let saveTimer = null;
  function setSaveState(text) {
    $('#saveState').textContent = text;
  }
  function scheduleSave() {
    setSaveState('Unsaved changes');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 1000);
  }
  async function saveNow() {
    clearTimeout(saveTimer);
    const cur = S.cur;
    if (!cur) return;
    cur.fields.Comments = U.composeComments(cur.notes, cur.interpretation);
    try {
      await api.saveDream({ path: cur.path, fields: cur.fields });
      await api.saveSession(cur.path, cur.session);
      if (alive(cur)) setSaveState('Saved');
    } catch (e) {
      setSaveState('Save failed');
      toast(`Couldn't save: ${cleanErr(e)}`, 'error');
    }
  }

  /* ------------------------------------------------------------------ */
  /* Session: rendering                                                  */
  /* ------------------------------------------------------------------ */
  function renderSession() {
    renderSessionHeader();
    renderMessages();
    renderStrip();
    renderActions();
    renderDreamPanel();
    $('#notesInput').value = S.cur.notes;
    renderAnalysis();
    renderInterp();
  }

  function renderSessionHeader() {
    const f = S.cur.fields;
    $('#sTitle').textContent = f.Title || 'Untitled dream';
    $('#sMeta').textContent = [U.prettyDate(f.Date), f.Time].filter(Boolean).join(' · ');
    renderPill();
  }

  const PHASES = {
    new: 'Not started',
    extract: 'Finding details',
    ask: 'Exploring details',
    answer: 'Exploring details',
    summarise: 'Exploring details',
    analyse: 'Analysing',
    interpret: 'Interpreting',
    chat: 'Discussing',
  };

  function renderPill() {
    if (!S.cur) return;
    const s = S.cur.session;
    let label = PHASES[s.phase] || s.phase;
    if (WALK_PHASES.includes(s.phase) && s.round > 1) label = 'Exploring new leads';
    const pill = $('#phasePill');
    pill.textContent = label;
    pill.className = `phase-pill ${s.phase} ${S.busy ? 'busy' : ''}`;
  }

  function renderDreamPanel() {
    const f = S.cur.fields;
    const chips = [
      f.Time && ['Recorded', f.Time],
      (f.Sleep || f.Awake) && ['Slept', `${f.Sleep || '?'} → ${f.Awake || '?'}`],
      f.Lucidity && ['Lucidity', `${f.Lucidity}/5`],
      f.Clarity && ['Clarity', `${f.Clarity}/5`],
    ].filter(Boolean);
    $('#dreamPanel').innerHTML = `
      <div class="dp-date">${esc(U.prettyDate(f.Date))}</div>
      <h2 class="dp-title">${esc(f.Title || 'Untitled dream')}</h2>
      ${chips.length ? `<div class="dp-chips">${chips.map(([k, v]) => `<span><small>${esc(k)}</small>${esc(v)}</span>`).join('')}</div>` : ''}
      <div class="dp-text">${
        esc(f.Dream || '')
          .split(/\n{2,}/)
          .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
          .join('') || '<p class="muted">No recollection recorded.</p>'
      }</div>
      <button class="btn ghost small" data-action="edit-dream">${icon('edit')}Edit dream</button>`;
  }

  const typingDots = '<span class="typing"><i></i><i></i><i></i></span>';

  function entryHtml(e) {
    const dim = e.compacted ? ' compacted' : '';
    switch (e.role) {
      case 'user': // chat message
      case 'answer': // answer to a detail question
        return `<div class="msg user${dim}"><div class="bubble">${esc(e.content).replace(/\n/g, '<br>')}</div></div>`;
      case 'assistant': // chat reply
      case 'question': // per-detail question
      case 'notice': // app message styled as the guide; never sent to the model
        return `<div class="msg ai${dim}"><div class="avatar">${icon('moon')}</div><div class="bubble markdown">${
          e.content ? U.markdown(e.content) : typingDots
        }</div></div>`;
      case 'event':
        return `<div class="event"><span>${icon(e.icon || 'sparkle')}${esc(e.content)}</span></div>`;
      case 'error':
        return `<div class="event error"><span>${esc(e.content)}</span></div>`;
      case 'work':
        return `<div class="work-card ${e.pending ? 'pending' : ''}">
          <div class="work-head">${icon(e.icon || 'feather')}<span>${esc(e.title || '')}</span>${e.pending ? typingDots : ''}</div>
          <div class="work-body markdown">${U.markdown(e.content || '')}</div></div>`;
      default:
        return '';
    }
  }

  function startCardHtml() {
    const hasInterp = !!S.cur.interpretation;
    return `<div class="start-card">
      <div class="moon mini"><div class="moon-glow"></div></div>
      <h3>Ready when you are</h3>
      <p>Your dream will be broken into its details. For each one you'll get a single question — just answer with whatever comes to mind, and your answer is tidied into your notes.
      Afterwards your notes are analysed for themes, emotions, symbols and waking-life links, and woven into an interpretation you can discuss.</p>
      <div class="start-actions">
        <button class="btn primary" data-action="start">${icon('sparkle')}Begin dream-work</button>
        ${hasInterp ? `<button class="btn ghost" data-action="discuss">Discuss saved interpretation</button>` : ''}
      </div>
    </div>`;
  }

  function renderMessages() {
    const box = $('#messages');
    box.innerHTML = '';
    const s = S.cur.session;
    for (const e of s.transcript) mountEntry(e, box);
    if (s.phase === 'new' && !S.busy) box.insertAdjacentHTML('beforeend', startCardHtml());
    scrollMessages(true);
  }

  function mountEntry(e, box = $('#messages')) {
    const html = entryHtml(e);
    if (!html) return;
    const tpl = document.createElement('template');
    tpl.innerHTML = html.trim();
    const el = tpl.content.firstChild;
    box.appendChild(el);
    els.set(e, el);
  }

  function refreshEntry(e) {
    const old = els.get(e);
    if (!old || !old.isConnected) return;
    const tpl = document.createElement('template');
    tpl.innerHTML = entryHtml(e).trim();
    const el = tpl.content.firstChild;
    old.replaceWith(el);
    els.set(e, el);
  }

  function scrollMessages(force = false) {
    const box = $('#messages');
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 160;
    if (force || nearBottom) box.scrollTop = box.scrollHeight;
  }

  function addEntry(entry) {
    const cur = S.cur;
    entry.ts = Date.now();
    cur.session.transcript.push(entry);
    $('.start-card')?.remove();
    mountEntry(entry);
    scrollMessages(true);
    scheduleSave();
    return entry;
  }

  function removeEntry(entry) {
    const t = S.cur.session.transcript;
    const i = t.indexOf(entry);
    if (i >= 0) t.splice(i, 1);
    els.get(entry)?.remove();
  }

  function streamInto(entry, text) {
    const el = els.get(entry);
    if (!el) return;
    const target = entry.role === 'work' ? $('.work-body', el) : $('.bubble', el);
    target.innerHTML = text ? U.markdown(text) : typingDots;
    scrollMessages();
  }

  function renderStrip() {
    const strip = $('#detailStrip');
    const s = S.cur.session;
    if (!s.details.length) {
      strip.innerHTML = '';
      strip.classList.add('empty');
      return;
    }
    strip.classList.remove('empty');
    let html = '';
    s.details.forEach((d, i) => {
      if (d.round > 1 && (i === 0 || s.details[i - 1].round !== d.round)) html += '<span class="strip-divider">new leads</span>';
      const current = i === s.index && WALK_PHASES.includes(s.phase);
      const done = d.status === 'done';
      html += `<div class="chip ${done ? 'done' : ''} ${d.status === 'skipped' ? 'skipped' : ''} ${current ? 'current' : ''}" title="${esc(d.description)}">
        <span class="n">${done ? icon('check') : i + 1}</span><span class="t">${esc(d.title)}</span></div>`;
    });
    strip.innerHTML = html;
    $('.chip.current', strip)?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }

  /** Chat entries the model will see (everything after the last compaction point). */
  function chatEntries(s) {
    return s.transcript.slice(s.chat.from).filter((e) => (e.role === 'user' || e.role === 'assistant') && e.content);
  }

  function needsResume(s) {
    if (['extract', 'ask', 'summarise', 'analyse', 'interpret'].includes(s.phase)) return true;
    if (s.phase === 'chat') {
      const msgs = chatEntries(s);
      return msgs.length > 0 && msgs[msgs.length - 1].role === 'user';
    }
    return false;
  }

  function renderActions() {
    if (!S.cur) return;
    const s = S.cur.session;
    const b = (action, label, ic, cls = 'ghost', title = '') =>
      `<button class="btn ${cls} small" data-action="${action}"${title ? ` title="${esc(title)}"` : ''}>${icon(ic)}${label}</button>`;
    let html = '';
    if (S.busy) {
      html = `<span class="working">${typingDots}Dreaming…</span>${b('stop', 'Stop', 'stop')}`;
    } else {
      if (needsResume(s)) html += b('resume', 'Resume', 'play', 'primary');
      if (s.phase === 'answer') {
        const d = s.details[s.index];
        html += `<span class="current-detail">${d ? `${icon('star')}${esc(d.title)}` : ''}</span>`;
        html += b('reask', 'Different question', 'refresh', 'ghost', 'Ask about this detail in a different way');
        html += b('skip', 'Skip', 'skip');
      } else if (s.phase === 'chat') {
        const n = chatEntries(s).length;
        html += `<span class="current-detail muted">${s.chat.summary ? 'Conversation compacted · ' : ''}${n} message${n === 1 ? '' : 's'} in context</span>`;
        html += b('compact', 'Compact', 'feather', 'ghost', 'Summarise the conversation before the last reply to keep the context small');
        html += b('rewrite', 'Rewrite interpretation', 'refresh', 'soft');
      }
    }
    $('#composerActions').innerHTML = html;
    const canType = !S.busy && (s.phase === 'answer' || s.phase === 'chat');
    const input = $('#chatInput');
    input.disabled = !canType;
    $('#sendBtn').disabled = !canType;
    input.placeholder =
      s.phase === 'answer'
        ? 'Your answer — whatever comes to mind…'
        : s.phase === 'chat'
          ? 'What resonates? What feels off?'
          : s.phase === 'new'
            ? 'Begin dream-work to start'
            : 'Please wait…';
    renderPill();
  }

  function setBusy(b) {
    S.busy = b;
    renderActions();
  }

  /** Clear the busy flag at the end of a flow, even if the user has since navigated elsewhere. */
  function doneBusy(cur) {
    if (alive(cur)) setBusy(false);
    else {
      S.busy = false;
      if (S.cur) renderActions();
    }
  }

  /* ---------- Side panels ---------- */
  function switchTab(name) {
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === name));
    if (name === 'interp') $('#interpBadge').classList.add('hidden');
  }

  function flashTab(name) {
    const tab = $(`.tab[data-tab="${name}"]`);
    if (tab.classList.contains('active')) return;
    tab.classList.remove('flash');
    void tab.offsetWidth;
    tab.classList.add('flash');
    if (name === 'interp') $('#interpBadge').classList.remove('hidden');
  }

  function appendNotes(text) {
    const cur = S.cur;
    const base = cur.notes.replace(/\s+$/, '');
    cur.notes = `${base}${base ? '\n\n' : ''}${text}`;
    const ta = $('#notesInput');
    const { selectionStart, selectionEnd } = ta;
    const focused = document.activeElement === ta;
    ta.value = cur.notes;
    if (focused) ta.setSelectionRange(selectionStart, selectionEnd);
    else ta.scrollTop = ta.scrollHeight;
    flashTab('notes');
    scheduleSave();
  }

  function renderAnalysis(streaming = null) {
    const s = S.cur.session;
    const view = $('#analysisView');
    const any = P.ANALYSES.some((a) => s.analysis[a.key]) || streaming;
    if (!any) {
      view.innerHTML = `<div class="interp-empty">${icon('feather')}<p>Once every detail has been explored, your notes are analysed here — themes, emotions, key symbols and waking-life connections — and those feed the interpretation.</p></div>`;
      return;
    }
    view.innerHTML = P.ANALYSES.map((a) => {
      const live = streaming && streaming.key === a.key;
      const text = live ? streaming.text : s.analysis[a.key];
      return `<section class="an-card ${live ? 'live' : ''} ${text ? '' : 'empty'}">
        <h3>${esc(a.title)}</h3>
        <div class="markdown">${text ? U.markdown(text) : live ? typingDots : '<p class="muted">Not yet analysed.</p>'}</div>
      </section>`;
    }).join('');
    if (streaming) $('.an-card.live', view)?.scrollIntoView({ block: 'nearest' });
  }

  function renderInterp() {
    const cur = S.cur;
    const view = $('#interpView');
    const input = $('#interpInput');
    view.classList.toggle('hidden', S.interpEditing);
    input.classList.toggle('hidden', !S.interpEditing);
    $('#interpEditBtn').lastChild.textContent = S.interpEditing ? 'Done editing' : 'Edit';
    if (S.interpEditing) input.value = cur.interpretation;
    view.innerHTML = cur.interpretation
      ? U.markdown(cur.interpretation)
      : `<div class="interp-empty">${icon('sparkle')}<p>Your interpretation will appear here once your notes have been analysed.</p></div>`;
    const n = cur.session.interpHistory.length;
    $('#interpUndoBtn').disabled = !n;
    $('#interpVersion').textContent = n ? `${n} earlier version${n > 1 ? 's' : ''}` : '';
  }

  function streamInterp(text) {
    const view = $('#interpView');
    S.interpEditing = false;
    view.classList.remove('hidden');
    $('#interpInput').classList.add('hidden');
    view.innerHTML = `${U.markdown(text)}<span class="cursor"></span>`;
    view.scrollTop = view.scrollHeight;
  }

  function setInterpretation(text) {
    const cur = S.cur;
    if (cur.interpretation && cur.interpretation !== text) {
      cur.session.interpHistory.push(cur.interpretation);
      if (cur.session.interpHistory.length > 15) cur.session.interpHistory.shift();
    }
    cur.interpretation = text;
    renderInterp();
    flashTab('interp');
    scheduleSave();
  }

  /* ------------------------------------------------------------------ */
  /* Workflow — every AI step below is a fresh, single-purpose thread    */
  /* ------------------------------------------------------------------ */
  function handleError(e) {
    const msg = cleanErr(e);
    let hint = '';
    if (/model .*not found|pull/i.test(msg)) hint = ' — choose an installed model in the top bar.';
    else if (/reach Ollama|ECONNREFUSED|fetch failed/i.test(msg)) hint = ' — make sure Ollama is running.';
    if (S.cur) addEntry({ role: 'error', content: `${msg}${hint}` });
    toast(msg, 'error');
  }

  async function startAnalysis() {
    const cur = S.cur;
    if (!cur || S.busy || !ensureModel()) return;
    if (!cur.fields.Dream.trim()) {
      toast('This dream has no recollection to analyse yet — edit the dream first.', 'warn');
      return;
    }
    cur.session = Object.assign(newSession(), { interpHistory: cur.session.interpHistory });
    cur.session.phase = 'extract';
    renderSession();
    await runExtraction();
  }

  async function restartAnalysis() {
    const cur = S.cur;
    if (!cur) return;
    if (!window.confirm('Restart the analysis? This clears the conversation, notes, analysis and interpretation for this dream.')) return;
    if (S.busy) stopGeneration();
    while (S.busy) await sleep(50);
    cur.session = newSession();
    cur.notes = '';
    cur.interpretation = '';
    renderSession();
    scheduleSave();
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function detailsMarkdown(details, plain = false) {
    return details.map((d, i) => (plain ? `${i + 1}. ${d.title} — ${d.description}` : `${i + 1}. **${d.title}** — ${d.description}`)).join('\n');
  }

  function normaliseBullets(text) {
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    const bullets = lines.filter((l) => /^[-*•]\s+/.test(l)).map((l) => l.replace(/^[-*•]\s+/, '- '));
    if (bullets.length) return bullets.join('\n');
    return lines.filter((l) => !/^(here|notes?)\b.*:$/i.test(l)).map((l) => `- ${l}`).join('\n');
  }

  /** Step 1: list the details (thread A), convert to strict JSON (thread B), parse in code. */
  async function runExtraction() {
    const cur = S.cur;
    if (!cur || S.busy) return;
    const s = cur.session;
    const round = s.round;
    let next = null;
    s.phase = 'extract';
    setBusy(true);
    try {
      addEntry({
        role: 'event',
        icon: 'feather',
        content: round === 1 ? 'Reading your dream and picking out its details…' : 'Looking through your notes for new leads…',
      });
      const work = addEntry({ role: 'work', title: round === 1 ? 'Dream details' : 'New leads', content: '', pending: true });
      const listMsgs = round === 1 ? P.listDetails(dreamCtx(cur)) : P.listNewLeads(cur.notes, s.details.map((d) => d.title));
      const r1 = await llm(listMsgs, { onToken: (acc) => streamInto(work, U.stripThinking(acc)) });
      if (!alive(cur)) return;
      if (r1.aborted) {
        removeEntry(work);
        return;
      }
      const list = U.stripThinking(r1.text).trim();
      work.content = list;

      let details = [];
      if (list && !/^\W*NONE\W*$/i.test(list)) {
        work.title += ' · structuring…';
        refreshEntry(work);
        const r2 = await llm(P.strictify(list), { format: P.DETAIL_SCHEMA, temperature: 0 });
        if (!alive(cur)) return;
        if (r2.aborted) {
          removeEntry(work);
          return;
        }
        details = U.parseDetailsJson(U.stripThinking(r2.text)) || [];
        if (!details.length) details = U.parseNumberedList(list);
      }
      details = round > 1 ? U.filterNewDetails(details, s.details, 6) : details.slice(0, 20);

      if (round === 1 && !details.length) {
        removeEntry(work);
        throw new Error("Couldn't pick out any details from the dream. Try again, or choose a different model.");
      }

      work.pending = false;
      work.title = round === 1 ? `Dream details · ${details.length}` : `New leads · ${details.length}`;
      work.content = details.length ? detailsMarkdown(details) : '_Nothing new surfaced — moving on to the analysis._';
      refreshEntry(work);

      if (!details.length) {
        s.phase = 'analyse';
        next = 'analyse';
      } else {
        details.forEach((d) => Object.assign(d, { round, status: 'pending' }));
        s.index = s.details.length;
        s.details.push(...details);
        appendNotes(
          round === 1
            ? `# Dream details\n${detailsMarkdown(details, true)}\n\n# Reflections`
            : `# New leads\n${detailsMarkdown(details, true)}\n\n# Reflections on new leads`,
        );
        s.phase = 'ask';
        next = 'ask';
      }
      scheduleSave();
      renderStrip();
    } catch (e) {
      handleError(e);
    } finally {
      doneBusy(cur);
    }
    if (!alive(cur)) return;
    if (next === 'ask') await askCurrent();
    else if (next === 'analyse') await runAnalysis({ fresh: true });
  }

  /** Step 2: a fresh thread that sees ONLY the current detail writes one question. */
  async function askCurrent({ intro = true, different = false } = {}) {
    const cur = S.cur;
    if (!cur || S.busy) return;
    const s = cur.session;
    const d = s.details[s.index];
    if (!d) return;
    s.phase = 'ask';
    if (intro) {
      const group = s.details.filter((x) => x.round === d.round);
      addEntry({ role: 'event', icon: 'star', content: `${d.round > 1 ? 'New lead' : 'Detail'} ${group.indexOf(d) + 1} of ${group.length} · ${d.title}` });
    }
    renderStrip();
    setBusy(true);
    const avoid = different ? [...(d.asked || []), d.question].filter(Boolean) : [];
    const entry = addEntry({ role: 'question', content: '' });
    try {
      const r = await llm(P.askAboutDetail(d, { lead: d.round > 1, avoid }), {
        onToken: (acc) => streamInto(entry, U.stripThinking(acc)),
        temperature: different ? 0.9 : undefined,
      });
      if (!alive(cur)) return;
      const q = U.stripThinking(r.text).trim();
      if (r.aborted || !q) {
        removeEntry(entry);
        if (different && d.question) s.phase = 'answer';
        return;
      }
      if (d.question) (d.asked ||= []).push(d.question);
      d.question = q;
      entry.content = q;
      refreshEntry(entry);
      s.phase = 'answer';
      scheduleSave();
    } catch (e) {
      if (!entry.content) removeEntry(entry);
      if (different && d.question) s.phase = 'answer';
      handleError(e);
    } finally {
      doneBusy(cur);
    }
    if (alive(cur) && s.phase === 'answer') $('#chatInput').focus();
  }

  /** The dreamer answers. The AI does not reply — the answer goes to a structuring thread. */
  async function submitAnswer(text) {
    const cur = S.cur;
    const s = cur.session;
    const d = s.details[s.index];
    if (!d) return;
    addEntry({ role: 'answer', content: text });
    d.answer = text;
    s.phase = 'summarise';
    scheduleSave();
    await summariseCurrent();
  }

  /** Step 3: a fresh thread, given the detail, question and answer, structures it into notes. */
  async function summariseCurrent() {
    const cur = S.cur;
    if (!cur || S.busy) return;
    const s = cur.session;
    const d = s.details[s.index];
    if (!d) return;
    setBusy(true);
    const status = addEntry({ role: 'event', icon: 'feather', content: `Writing notes on “${d.title}”…` });
    let ok = false;
    try {
      const r = await llm(P.structureAnswer(d, d.question || '', d.answer || ''), { temperature: 0.3 });
      if (!alive(cur)) return;
      if (r.aborted) {
        removeEntry(status);
        return;
      }
      const bullets = normaliseBullets(U.stripThinking(r.text)) || `- ${d.answer}`;
      appendNotes(`## ${d.title}\n${bullets}`);
      status.content = `Added to notes · ${d.title}`;
      refreshEntry(status);
      d.status = 'done';
      ok = true;
    } catch (e) {
      handleError(e);
    } finally {
      doneBusy(cur);
    }
    if (ok && alive(cur)) await nextDetail();
  }

  async function skipDetail() {
    const cur = S.cur;
    if (!cur || S.busy || cur.session.phase !== 'answer') return;
    const d = cur.session.details[cur.session.index];
    d.status = 'skipped';
    addEntry({ role: 'event', icon: 'skip', content: `Skipped · ${d.title}` });
    await nextDetail();
  }

  /** Rinse and repeat; then the optional second pass over new leads; then analysis. */
  async function nextDetail() {
    const cur = S.cur;
    const s = cur.session;
    s.index += 1;
    scheduleSave();
    renderStrip();
    if (s.index < s.details.length) return askCurrent();
    if (s.round === 1 && S.settings.secondPass !== false) {
      s.round = 2;
      s.phase = 'extract';
      return runExtraction();
    }
    s.phase = 'analyse';
    return runAnalysis({ fresh: true });
  }

  /** Step 4: one fresh thread per analysis document, each built from the notes. */
  async function runAnalysis({ fresh = true } = {}) {
    const cur = S.cur;
    if (!cur || S.busy) return;
    const s = cur.session;
    if (!cur.notes.trim()) {
      toast('There are no notes to analyse yet.', 'warn');
      return;
    }
    s.phase = 'analyse';
    if (fresh) s.analysis = {};
    setBusy(true);
    switchTab('analysis');
    renderAnalysis();
    let ok = true;
    try {
      for (const spec of P.ANALYSES) {
        if (s.analysis[spec.key]) continue;
        const ev = addEntry({ role: 'event', icon: 'feather', content: `Analysing ${spec.title.toLowerCase()}…` });
        const r = await llm(P.analysis(spec, dreamCtx(cur), cur.notes), {
          temperature: 0.4,
          onToken: (acc) => renderAnalysis({ key: spec.key, text: U.stripThinking(acc) }),
        });
        if (!alive(cur)) return;
        if (r.aborted) {
          removeEntry(ev);
          ok = false;
          break;
        }
        s.analysis[spec.key] = U.stripThinking(r.text).trim() || '_Nothing found._';
        ev.content = `${spec.title} analysed`;
        refreshEntry(ev);
        renderAnalysis();
        scheduleSave();
      }
    } catch (e) {
      ok = false;
      handleError(e);
    } finally {
      doneBusy(cur);
      if (alive(cur)) renderAnalysis();
    }
    if (ok && alive(cur)) {
      s.phase = 'interpret';
      await runInterpretation();
    }
  }

  /** Step 5: a fresh thread given ONLY the dream and the analysis documents (not the raw notes). */
  async function runInterpretation() {
    const cur = S.cur;
    if (!cur || S.busy) return;
    const s = cur.session;
    s.phase = 'interpret';
    setBusy(true);
    addEntry({ role: 'event', icon: 'sparkle', content: 'Weaving the analysis into an interpretation…' });
    switchTab('interp');
    try {
      const r = await llm(P.interpret(dreamCtx(cur), s.analysis), { onToken: (acc) => streamInterp(U.stripThinking(acc)) });
      if (!alive(cur) || r.aborted) return;
      const text = U.stripThinking(r.text).trim();
      if (!text) throw new Error('The model returned an empty interpretation.');
      setInterpretation(text);
      startChat("Your interpretation is ready in the **Interpretation** tab, built from the analysis of your notes.\n\nTell me what resonates and what doesn't — challenge anything, or add context I'm missing. When you're happy with where the discussion has landed, press **Rewrite interpretation**.");
    } catch (e) {
      handleError(e);
    } finally {
      doneBusy(cur);
      if (alive(cur)) renderInterp();
    }
  }

  function startChat(noticeText) {
    const s = S.cur.session;
    s.phase = 'chat';
    s.chat = { from: s.transcript.length, summary: '' };
    addEntry({ role: 'notice', content: noticeText });
    renderActions();
    scheduleSave();
  }

  function discussExisting() {
    const cur = S.cur;
    if (!cur || S.busy || !ensureModel()) return;
    startChat("Here's the interpretation saved with this dream. What would you like to explore, question or add?");
    switchTab('interp');
    $('#chatInput').focus();
  }

  /** Step 6: regular chat. Context = interpretation (+ compacted summary) + messages since compaction. */
  async function chatTurn() {
    const cur = S.cur;
    if (!cur || S.busy) return;
    const s = cur.session;
    const messages = [
      { role: 'system', content: P.chatSystem(dreamCtx(cur), cur.interpretation, s.chat.summary) },
      ...chatEntries(s).map((e) => ({ role: e.role, content: e.content })),
    ];
    setBusy(true);
    const entry = addEntry({ role: 'assistant', content: '' });
    try {
      const r = await llm(messages, { onToken: (acc) => streamInto(entry, U.stripThinking(acc)) });
      if (!alive(cur)) return;
      entry.content = U.stripThinking(r.text).trim();
      if (!entry.content) removeEntry(entry);
      else refreshEntry(entry);
      scheduleSave();
    } catch (e) {
      if (!entry.content) removeEntry(entry);
      handleError(e);
    } finally {
      doneBusy(cur);
    }
  }

  /**
   * Compaction: summarise everything before the last user/assistant exchange in a fresh thread.
   * Afterwards the model sees: interpretation, summary, last user message, last reply.
   */
  async function compactChat() {
    const cur = S.cur;
    if (!cur || S.busy || cur.session.phase !== 'chat') return;
    const s = cur.session;
    const msgs = chatEntries(s);
    let lastAi = -1;
    for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'assistant') { lastAi = i; break; }
    let keepFrom = lastAi;
    for (let i = lastAi - 1; i >= 0; i--) if (msgs[i].role === 'user') { keepFrom = i; break; }
    const older = keepFrom > 0 ? msgs.slice(0, keepFrom) : [];
    if (!older.length) {
      toast('Nothing to compact yet — the conversation is already as short as it gets.', 'info', 2600);
      return;
    }
    setBusy(true);
    try {
      const r = await llm(P.compactChat(s.chat.summary, older.map((e) => ({ role: e.role, content: e.content }))), { temperature: 0.2 });
      if (!alive(cur) || r.aborted) return;
      const summary = U.stripThinking(r.text).trim();
      if (!summary) throw new Error('The model returned an empty summary.');
      s.transcript.slice(s.chat.from).forEach((e) => {
        if (older.includes(e) || e.role === 'notice') e.compacted = true;
      });
      const keepIndex = s.transcript.indexOf(msgs[keepFrom]);
      s.transcript.splice(keepIndex, 0, { role: 'work', icon: 'feather', title: 'Conversation compacted · summary', content: summary, ts: Date.now() });
      s.chat = { from: keepIndex + 1, summary };
      renderMessages();
      scheduleSave();
      toast('Conversation compacted', 'success', 1800);
    } catch (e) {
      handleError(e);
    } finally {
      doneBusy(cur);
    }
  }

  /** Rewrite the interpretation (fresh thread) from the analysis, the current version and the discussion. */
  async function rewriteInterpretation() {
    const cur = S.cur;
    if (!cur || S.busy || cur.session.phase !== 'chat') return;
    const s = cur.session;
    const recent = chatEntries(s).map((e) => ({ role: e.role, content: e.content }));
    if (!recent.length && !s.chat.summary) {
      toast('Discuss the interpretation first, then rewrite it.', 'info', 2600);
      return;
    }
    setBusy(true);
    switchTab('interp');
    try {
      const r = await llm(P.rewriteInterpretation(dreamCtx(cur), s.analysis, cur.interpretation, s.chat.summary, recent), {
        onToken: (acc) => streamInterp(U.stripThinking(acc)),
      });
      if (!alive(cur)) return;
      const text = U.stripThinking(r.text).trim();
      if (r.aborted || !text) return;
      setInterpretation(text);
      addEntry({ role: 'event', icon: 'feather', content: 'Interpretation rewritten from our discussion' });
    } catch (e) {
      handleError(e);
    } finally {
      doneBusy(cur);
      if (alive(cur)) renderInterp();
    }
  }

  function rerunAnalysis() {
    const cur = S.cur;
    if (!cur || S.busy || !ensureModel()) return;
    const phase = cur.session.phase;
    if (['extract', 'ask', 'answer', 'summarise'].includes(phase)) {
      toast('Finish exploring the details first.', 'info', 2600);
      return;
    }
    if (cur.interpretation && !window.confirm('Re-analyse your notes and write a new interpretation? The current one is kept as a previous version.')) return;
    runAnalysis({ fresh: true });
  }

  function resume() {
    const cur = S.cur;
    if (!cur || S.busy || !ensureModel()) return;
    const s = cur.session;
    if (s.phase === 'extract') return runExtraction();
    if (s.phase === 'ask') return askCurrent({ intro: false });
    if (s.phase === 'summarise') return summariseCurrent();
    if (s.phase === 'analyse') return runAnalysis({ fresh: false });
    if (s.phase === 'interpret') return runInterpretation();
    if (s.phase === 'chat') return chatTurn();
  }

  async function sendMessage() {
    const cur = S.cur;
    const input = $('#chatInput');
    const text = input.value.trim();
    if (!cur || !text || S.busy) return;
    const phase = cur.session.phase;
    if (phase !== 'answer' && phase !== 'chat') return;
    if (!ensureModel()) return;
    input.value = '';
    autosize(input);
    if (phase === 'answer') return submitAnswer(text);
    addEntry({ role: 'user', content: text });
    await chatTurn();
  }

  function autosize(ta) {
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }

  /* ------------------------------------------------------------------ */
  /* Settings                                                            */
  /* ------------------------------------------------------------------ */
  function openSettings() {
    $('#hostInput').value = S.settings.ollamaHost;
    $('#tempInput').value = S.settings.temperature;
    $('#tempValue').textContent = Number(S.settings.temperature).toFixed(2);
    $('#secondPassInput').checked = S.settings.secondPass !== false;
    $('#hostStatus').textContent = S.ollamaOk ? `Connected · ${S.models.length} models available` : 'Not connected';
    renderDirList();
    renderModelSelects();
    $('#settingsModal').classList.remove('hidden');
  }

  async function closeSettings() {
    $('#settingsModal').classList.add('hidden');
    const host = $('#hostInput').value.trim();
    if (host && host !== S.settings.ollamaHost) {
      S.settings = await api.setSettings({ ollamaHost: host });
      await loadModels();
    }
    refreshDreams();
  }

  function renderDirList() {
    const s = S.settings;
    const ul = $('#dirList');
    const dirs = s.directories;
    ul.innerHTML = dirs.length
      ? dirs
          .map(
            (d) => `<li class="${d === s.saveDirectory ? 'save' : ''}">
              <button class="icon-btn small star-btn" data-dir-save="${esc(d)}" title="Save new dreams here">${icon('star')}</button>
              <span class="path" title="${esc(d)}"><bdi dir="ltr">${esc(d)}</bdi></span>
              <button class="icon-btn small" data-dir-remove="${esc(d)}" title="Remove from journal (files are not deleted)">${icon('close')}</button>
            </li>`,
          )
          .join('')
      : `<li class="muted small">No folders yet. New dreams will be saved to <code>${esc(s.defaultFolder || 'Documents/Dreams')}</code>.</li>`;
  }

  /* ------------------------------------------------------------------ */
  /* Events                                                              */
  /* ------------------------------------------------------------------ */
  function bindEvents() {
    $('#homeBtn').addEventListener('click', () => goHome());
    $('#newDreamBtn').addEventListener('click', () => openForm('new', 'home'));
    $('#rescanBtn').addEventListener('click', () => refreshDreams().then(() => toast('Journal refreshed', 'success', 1800)));
    $('#addDirBtn').addEventListener('click', async () => {
      S.settings = { ...S.settings, ...(await api.addDirectory()) };
      refreshDreams();
    });
    $('#searchInput').addEventListener('input', (e) => {
      S.search = e.target.value;
      renderTree();
    });
    $('#tree').addEventListener(
      'toggle',
      (e) => {
        const d = e.target;
        if (!(d instanceof HTMLDetailsElement) || S.search) return;
        if (d.open) S.expanded.add(d.dataset.key);
        else S.expanded.delete(d.dataset.key);
      },
      true,
    );
    const openFromList = (e) => {
      const b = e.target.closest('[data-path]');
      if (b) openDream(b.dataset.path);
    };
    $('#tree').addEventListener('click', openFromList);
    $('#recent').addEventListener('click', openFromList);

    // Model picker
    $('#modelSelect').addEventListener('change', (e) => setModel(e.target.value));
    $('#settingsModel').addEventListener('change', (e) => setModel(e.target.value));
    $('#refreshModelsBtn').addEventListener('click', async () => {
      await loadModels();
      toast(S.ollamaOk ? `Found ${S.models.length} models` : "Can't reach Ollama", S.ollamaOk ? 'success' : 'error', 2200);
    });

    // Form
    const form = $('#dreamForm');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      submitForm(true);
    });
    form.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        submitForm(true);
      }
    });
    $('#formSaveOnlyBtn').addEventListener('click', () => submitForm(false));
    $('#formBackBtn').addEventListener('click', () => {
      if (S.form.returnTo === 'session' && S.cur) showView('session');
      else showView('home');
    });

    // Session header
    $('#sessionBackBtn').addEventListener('click', () => goHome());
    $('#editDreamBtn').addEventListener('click', () => openForm('edit', 'session'));
    $('#restartBtn').addEventListener('click', () => restartAnalysis());
    $('#revealBtn').addEventListener('click', () => S.cur && api.revealDream(S.cur.path));
    $('#deleteBtn').addEventListener('click', async () => {
      if (!S.cur) return;
      const path = S.cur.path;
      if (S.busy) stopGeneration();
      clearTimeout(saveTimer);
      if (await api.deleteDream(path)) {
        S.cur = null;
        showView('home');
        refreshDreams();
        toast('Dream moved to trash', 'success');
      }
    });

    // Actions (delegated)
    document.addEventListener('click', (e) => {
      const b = e.target.closest('[data-action]');
      if (!b || b.disabled) return;
      const a = b.dataset.action;
      if (a === 'start') startAnalysis();
      else if (a === 'discuss') discussExisting();
      else if (a === 'stop') stopGeneration();
      else if (a === 'skip') skipDetail();
      else if (a === 'reask') askCurrent({ intro: false, different: true });
      else if (a === 'resume') resume();
      else if (a === 'compact') compactChat();
      else if (a === 'rewrite') rewriteInterpretation();
      else if (a === 'reanalyse') rerunAnalysis();
      else if (a === 'edit-dream') openForm('edit', 'session');
    });

    // Composer
    const input = $('#chatInput');
    input.addEventListener('input', () => autosize(input));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        sendMessage();
      }
    });
    $('#sendBtn').addEventListener('click', () => sendMessage());

    // Tabs & panels
    $$('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));
    $$('.tab').forEach((t) => t.addEventListener('animationend', () => t.classList.remove('flash')));
    $('#notesInput').addEventListener('input', (e) => {
      if (!S.cur) return;
      S.cur.notes = e.target.value;
      scheduleSave();
    });
    $('#interpInput').addEventListener('input', (e) => {
      if (!S.cur) return;
      S.cur.interpretation = e.target.value;
      scheduleSave();
    });
    $('#interpEditBtn').addEventListener('click', () => {
      if (!S.cur || S.busy) return;
      S.interpEditing = !S.interpEditing;
      renderInterp();
      if (S.interpEditing) $('#interpInput').focus();
    });
    $('#interpUndoBtn').addEventListener('click', () => {
      const cur = S.cur;
      if (!cur || S.busy || !cur.session.interpHistory.length) return;
      cur.interpretation = cur.session.interpHistory.pop();
      renderInterp();
      scheduleSave();
      toast('Restored the previous version', 'success', 1800);
    });

    // Resizable split
    const body = $('#sessionBody');
    const savedSplit = Number(localStorage.getItem('split') || 0);
    if (savedSplit) body.style.setProperty('--chat-width', `${savedSplit}%`);
    $('#splitter').addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const rect = body.getBoundingClientRect();
      document.body.classList.add('resizing');
      const move = (ev) => {
        const pct = Math.min(75, Math.max(30, ((ev.clientX - rect.left) / rect.width) * 100));
        body.style.setProperty('--chat-width', `${pct}%`);
        localStorage.setItem('split', pct.toFixed(1));
      };
      const up = () => {
        document.body.classList.remove('resizing');
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });

    // Settings
    $('#settingsBtn').addEventListener('click', openSettings);
    $$('#settingsModal [data-close]').forEach((b) => b.addEventListener('click', closeSettings));
    $('#settingsModal').addEventListener('click', (e) => {
      if (e.target.id === 'settingsModal') closeSettings();
    });
    $('#testHostBtn').addEventListener('click', async () => {
      const host = $('#hostInput').value.trim();
      $('#hostStatus').textContent = 'Testing…';
      try {
        const models = await api.listModels(host);
        S.settings = await api.setSettings({ ollamaHost: host });
        await loadModels();
        $('#hostStatus').textContent = `Connected · ${models.length} models available`;
      } catch (e) {
        $('#hostStatus').textContent = `Couldn't connect: ${cleanErr(e)}`;
      }
    });
    $('#tempInput').addEventListener('input', (e) => {
      $('#tempValue').textContent = Number(e.target.value).toFixed(2);
    });
    $('#tempInput').addEventListener('change', async (e) => {
      S.settings = await api.setSettings({ temperature: Number(e.target.value) });
    });
    $('#secondPassInput').addEventListener('change', async (e) => {
      S.settings = await api.setSettings({ secondPass: e.target.checked });
    });
    $('#settingsAddDirBtn').addEventListener('click', async () => {
      S.settings = { ...S.settings, ...(await api.addDirectory()) };
      renderDirList();
    });
    $('#dirList').addEventListener('click', async (e) => {
      const save = e.target.closest('[data-dir-save]');
      const rm = e.target.closest('[data-dir-remove]');
      if (save) S.settings = { ...S.settings, ...(await api.setSettings({ saveDirectory: save.dataset.dirSave })) };
      if (rm) S.settings = { ...S.settings, ...(await api.removeDirectory(rm.dataset.dirRemove)) };
      renderDirList();
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (S.cur) saveNow();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n' && document.body.dataset.view === 'home') {
        e.preventDefault();
        openForm('new', 'home');
      } else if (e.key === 'Escape' && !$('#settingsModal').classList.contains('hidden')) {
        closeSettings();
      }
    });

    window.addEventListener('beforeunload', () => {
      if (S.cur) saveNow();
    });
  }

  async function init() {
    window.hydrateIcons();
    setupRatings();
    S.settings = await api.getSettings();
    bindEvents();
    document.body.dataset.view = 'home';
    await Promise.all([refreshDreams(), loadModels()]);
    if (!S.ollamaOk) toast("Can't reach Ollama — start it, then press ↻ next to the model picker.", 'warn', 7000);
    else if (!S.models.length) toast('Ollama has no models installed. Try: ollama pull llama3.1', 'warn', 7000);
  }

  init();
})();
