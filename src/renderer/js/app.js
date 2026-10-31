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
      S.dreams = (await api.listDreams()).sort((a, b) => sortKey(b) - sortKey(a) || b.mtime - a.mtime);
    } catch (e) {
      toast(`Couldn't scan dream folders: ${cleanErr(e)}`, 'error');
    }
    renderTree();
    renderHome();
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
          html += `<button class="tree-dream ${d.path === activePath ? 'active' : ''} ${d.error ? 'broken' : ''}" data-path="${esc(d.path)}" title="${esc(d.error || d.path)}">
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

    const recent = S.dreams.filter((d) => !d.error).slice(0, 6);
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
  const newSession = () => ({
    version: 1,
    phase: 'new', // new | extract | walk | interpret | debate
    round: 1,
    details: [],
    index: 0,
    transcript: [],
    segStart: 0,
    debateStart: 0,
    interpHistory: [],
  });

  const alive = (cur) => S.cur === cur;
  const dreamCtx = (cur) => ({ title: cur.fields.Title, date: cur.fields.Date, text: cur.fields.Dream });

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
    if (!session || session.version !== 1) session = newSession();
    session.interpHistory ||= [];
    const { notes, interpretation } = U.splitComments(data.fields.Comments);
    S.cur = { path, fields: data.fields, session, notes, interpretation };
    S.interpEditing = false;
    showView('session');
    renderSession();
    switchTab(interpretation && session.phase !== 'walk' ? 'interp' : 'notes');
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
    const notes = $('#notesInput');
    notes.value = S.cur.notes;
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
    walk: 'Exploring',
    interpret: 'Interpreting',
    debate: 'Discussing',
  };

  function renderPill() {
    if (!S.cur) return;
    const s = S.cur.session;
    let label = PHASES[s.phase] || s.phase;
    if (s.phase === 'walk') label = s.round > 1 ? 'Exploring new threads' : 'Exploring details';
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

  function entryHtml(e) {
    switch (e.role) {
      case 'user':
        return `<div class="msg user"><div class="bubble">${esc(e.content).replace(/\n/g, '<br>')}</div></div>`;
      case 'assistant':
        return `<div class="msg ai"><div class="avatar">${icon('moon')}</div><div class="bubble markdown">${
          e.content ? U.markdown(e.content) : '<span class="typing"><i></i><i></i><i></i></span>'
        }</div></div>`;
      case 'event':
        return `<div class="event"><span>${icon(e.icon || 'sparkle')}${esc(e.content)}</span></div>`;
      case 'error':
        return `<div class="event error"><span>${esc(e.content)}</span></div>`;
      case 'work':
        return `<div class="work-card ${e.pending ? 'pending' : ''}">
          <div class="work-head">${icon(e.icon || 'feather')}<span>${esc(e.title || '')}</span>${e.pending ? '<span class="typing"><i></i><i></i><i></i></span>' : ''}</div>
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
      <p>I'll break your dream into its details and explore each one with you, asking what it brings to mind.
      New threads that surface get explored too — then everything is woven into an interpretation you can question and refine.</p>
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
    target.innerHTML = text ? U.markdown(text) : '<span class="typing"><i></i><i></i><i></i></span>';
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
      if (d.round > 1 && (i === 0 || s.details[i - 1].round !== d.round)) html += '<span class="strip-divider">new threads</span>';
      const current = i === s.index && s.phase === 'walk';
      html += `<div class="chip ${d.done ? 'done' : ''} ${d.skipped ? 'skipped' : ''} ${current ? 'current' : ''}" title="${esc(d.description)}">
        <span class="n">${d.done ? icon('check') : i + 1}</span><span class="t">${esc(d.title)}</span></div>`;
    });
    strip.innerHTML = html;
    $('.chip.current', strip)?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }

  function lastConversational(s) {
    const from = s.phase === 'debate' ? s.debateStart : s.segStart;
    const seg = s.transcript.slice(from).filter((e) => ['user', 'assistant', 'guide'].includes(e.role));
    return seg[seg.length - 1];
  }

  function needsResume(s) {
    if (s.phase === 'extract' || s.phase === 'interpret') return true;
    if (s.phase === 'walk' || s.phase === 'debate') {
      const last = lastConversational(s);
      return !!last && (last.role === 'user' || last.role === 'guide' || !last.content);
    }
    return false;
  }

  function renderActions() {
    if (!S.cur) return;
    const s = S.cur.session;
    const b = (action, label, ic, cls = 'ghost') => `<button class="btn ${cls} small" data-action="${action}">${icon(ic)}${label}</button>`;
    let html = '';
    if (S.busy) {
      html = `<span class="working"><span class="typing"><i></i><i></i><i></i></span>Dreaming…</span>${b('stop', 'Stop', 'stop')}`;
    } else {
      if (needsResume(s)) html += b('resume', s.phase === 'walk' || s.phase === 'debate' ? 'Continue' : 'Resume', 'play', 'primary');
      if (s.phase === 'walk') {
        const d = s.details[s.index];
        html += `<span class="current-detail">${d ? `${icon('star')}${esc(d.title)}` : ''}</span>`;
        html += b('skip', 'Skip', 'skip');
        html += b('next', 'Next detail', 'next', needsResume(s) ? 'ghost' : 'soft');
      } else if (s.phase === 'debate') {
        html += '<span class="current-detail muted">Question, challenge or add to the interpretation</span>';
        html += b('rewrite', 'Rewrite interpretation', 'refresh', 'soft');
      }
    }
    $('#composerActions').innerHTML = html;
    const canType = !S.busy && (s.phase === 'walk' || s.phase === 'debate');
    const input = $('#chatInput');
    input.disabled = !canType;
    $('#sendBtn').disabled = !canType;
    input.placeholder =
      s.phase === 'walk'
        ? 'What does it remind you of? What does it mean to you?'
        : s.phase === 'debate'
          ? 'What resonates? What feels off?'
          : s.phase === 'new'
            ? 'Begin dream-work to start the conversation'
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

  /* ---------- Notes & interpretation panels ---------- */
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
      : `<div class="interp-empty">${icon('sparkle')}<p>Your interpretation will appear here once you've explored the dream's details.</p></div>`;
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
  /* Workflow                                                            */
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
    const s = cur.session;
    Object.assign(s, newSession(), { transcript: s.transcript, interpHistory: s.interpHistory });
    s.phase = 'extract';
    s.round = 1;
    renderSession();
    await runExtraction();
  }

  async function restartAnalysis() {
    const cur = S.cur;
    if (!cur) return;
    if (!window.confirm('Restart the analysis? This clears the conversation, notes and interpretation for this dream.')) return;
    if (S.busy) stopGeneration();
    while (S.busy) await new Promise((r) => setTimeout(r, 50));
    cur.session = newSession();
    cur.notes = '';
    cur.interpretation = '';
    renderSession();
    scheduleSave();
  }

  function detailsMarkdown(details, plain = false) {
    return details.map((d, i) => (plain ? `${i + 1}. ${d.title} — ${d.description}` : `${i + 1}. **${d.title}** — ${d.description}`)).join('\n');
  }

  /** Steps 1 & 4: extract a detail list (from the dream, or new threads from the notes) and parse it. */
  async function runExtraction() {
    const cur = S.cur;
    if (!cur || S.busy) return;
    const s = cur.session;
    const round = s.round;
    let next = null;
    s.phase = 'extract';
    setBusy(true);
    try {
      const dream = dreamCtx(cur);
      addEntry({
        role: 'event',
        icon: 'feather',
        content: round === 1 ? 'Reading your dream and picking out its details…' : 'Looking through your notes for new threads…',
      });
      const work = addEntry({ role: 'work', title: round === 1 ? 'Dream details' : 'New threads', content: '', pending: true });
      const listMsgs = round === 1 ? P.listDetails(dream) : P.listNewThreads(dream, cur.notes, s.details.map((d) => d.title));
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
      if (round > 1) details = U.filterNewDetails(details, s.details);
      else details = details.slice(0, 20);

      if (round === 1 && !details.length) {
        removeEntry(work);
        throw new Error("Couldn't pick out any details from the dream. Try again, or choose a different model.");
      }

      work.pending = false;
      work.title = round === 1 ? `Dream details · ${details.length}` : `New threads · ${details.length}`;
      work.content = details.length ? detailsMarkdown(details) : '_Nothing new surfaced — moving on to the interpretation._';
      refreshEntry(work);

      if (!details.length) {
        s.phase = 'interpret';
        next = 'interpret';
      } else {
        details.forEach((d) => Object.assign(d, { round, done: false, skipped: false }));
        s.index = s.details.length;
        s.details.push(...details);
        appendNotes(
          round === 1
            ? `# Dream details\n${detailsMarkdown(details, true)}\n\n# Reflections`
            : `# New threads\n${detailsMarkdown(details, true)}\n\n# Reflections on new threads`,
        );
        s.phase = 'walk';
        next = 'walk';
      }
      scheduleSave();
      renderStrip();
    } catch (e) {
      handleError(e);
    } finally {
      doneBusy(cur);
    }
    if (!alive(cur)) return;
    if (next === 'walk') await beginDetail();
    else if (next === 'interpret') await runInterpretation();
  }

  /** Step 2/5: introduce the current detail and let the AI ask about it. */
  async function beginDetail() {
    const cur = S.cur;
    const s = cur.session;
    const d = s.details[s.index];
    if (!d) return;
    const roundDetails = s.details.filter((x) => x.round === d.round);
    const pos = roundDetails.indexOf(d) + 1;
    s.segStart = s.transcript.length;
    addEntry({ role: 'event', icon: 'star', content: `${d.round > 1 ? 'New thread' : 'Detail'} ${pos} of ${roundDetails.length} · ${d.title}` });
    addEntry({ role: 'guide', content: P.detailIntro(d, pos, roundDetails.length, d.round, s.index === 0) });
    renderStrip();
    await assistantTurn();
  }

  function buildMessages(cur) {
    const s = cur.session;
    const dream = dreamCtx(cur);
    const toMsg = (e) => ({ role: e.role === 'guide' ? 'user' : e.role, content: e.content });
    const conversational = (e) => ['user', 'assistant', 'guide'].includes(e.role) && e.content;
    if (s.phase === 'walk') {
      const seg = s.transcript.slice(s.segStart).filter(conversational);
      return [{ role: 'system', content: P.walkSystem(dream, s.details, s.index, cur.notes) }, ...seg.map(toMsg)];
    }
    if (s.phase === 'debate') {
      const seg = s.transcript.slice(s.debateStart).filter(conversational).slice(-20);
      return [{ role: 'system', content: P.debateSystem(dream, cur.notes, cur.interpretation) }, ...seg.map(toMsg)];
    }
    return null;
  }

  const NEXT_RE = /\[\[\s*NEXT\s*\]\]/gi;

  function displayText(raw) {
    let t = U.stripThinking(raw).replace(NEXT_RE, '').replace(/\[\[?\s*N?E?X?T?\s*\]?$/i, '');
    const i = t.search(/<interpretation>/i);
    if (i >= 0) t = `${t.slice(0, i).trim()}\n\n*Revising the interpretation…*`;
    return t;
  }

  /** One AI reply in the walkthrough or debate conversation. */
  async function assistantTurn() {
    const cur = S.cur;
    if (!cur || S.busy) return;
    const s = cur.session;
    const msgs = buildMessages(cur);
    if (!msgs) return;
    const phase = s.phase;
    let autoNext = false;
    setBusy(true);
    const entry = addEntry({ role: 'assistant', content: '' });
    try {
      const r = await llm(msgs, { onToken: (acc) => streamInto(entry, displayText(acc)) });
      if (!alive(cur)) return;
      let text = U.stripThinking(r.text);
      if (phase === 'walk' && NEXT_RE.test(text)) {
        NEXT_RE.lastIndex = 0;
        text = text.replace(NEXT_RE, '').trim();
        const userReplied = s.transcript.slice(s.segStart).some((e) => e.role === 'user');
        autoNext = userReplied && !r.aborted;
      }
      NEXT_RE.lastIndex = 0;
      let revised = null;
      if (phase === 'debate') {
        const m = /<interpretation>([\s\S]*?)(?:<\/interpretation>|$)/i.exec(text);
        if (m) {
          if (!r.aborted && m[1].trim().length > 80) revised = m[1].trim();
          text = (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim();
        }
      }
      entry.content = text.trim() || (revised ? "I've revised the interpretation." : '');
      if (!entry.content) removeEntry(entry);
      else refreshEntry(entry);
      if (revised) {
        setInterpretation(revised);
        addEntry({ role: 'event', icon: 'feather', content: 'Interpretation revised' });
      }
      scheduleSave();
    } catch (e) {
      if (!entry.content) removeEntry(entry);
      handleError(e);
      return;
    } finally {
      doneBusy(cur);
    }
    if (autoNext && alive(cur)) {
      await sleep(900);
      if (alive(cur) && !S.busy && cur.session.phase === 'walk') await advanceDetail();
    }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function normaliseBullets(text) {
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    const bullets = lines.filter((l) => /^[-*•]\s+/.test(l)).map((l) => l.replace(/^[-*•]\s+/, '- '));
    if (bullets.length) return bullets.join('\n');
    return lines.filter((l) => !/^(here|notes?)\b.*:$/i.test(l)).map((l) => `- ${l}`).join('\n');
  }

  /** Summarise the current detail into the notes and move to the next one. */
  async function advanceDetail(skip = false) {
    const cur = S.cur;
    if (!cur || S.busy) return;
    const s = cur.session;
    if (s.phase !== 'walk') return;
    const d = s.details[s.index];
    if (!d) return;
    const seg = s.transcript.slice(s.segStart).filter((e) => (e.role === 'user' || e.role === 'assistant') && e.content);
    if (!skip && seg.some((e) => e.role === 'user')) {
      setBusy(true);
      const status = addEntry({ role: 'event', icon: 'feather', content: `Adding notes on “${d.title}”…` });
      try {
        const r = await llm(P.summariseDetail(d, seg), { temperature: 0.3 });
        if (!alive(cur) || r.aborted) {
          if (alive(cur)) removeEntry(status);
          return;
        }
        const bullets = normaliseBullets(U.stripThinking(r.text));
        if (bullets) appendNotes(`## ${d.title}\n${bullets}`);
        status.content = `Notes added · ${d.title}`;
        refreshEntry(status);
      } catch (e) {
        handleError(e);
        return;
      } finally {
        doneBusy(cur);
      }
    }
    d.done = !skip;
    d.skipped = !!skip;
    s.index += 1;
    scheduleSave();
    renderStrip();
    if (s.index < s.details.length) return beginDetail();
    if (s.round === 1) {
      s.round = 2;
      s.phase = 'extract';
      return runExtraction();
    }
    s.phase = 'interpret';
    renderActions();
    return runInterpretation();
  }

  /** Final step: compile the notes into an interpretation. */
  async function runInterpretation() {
    const cur = S.cur;
    if (!cur || S.busy) return;
    const s = cur.session;
    s.phase = 'interpret';
    setBusy(true);
    addEntry({ role: 'event', icon: 'sparkle', content: 'Weaving everything together into an interpretation…' });
    switchTab('interp');
    try {
      const r = await llm(P.interpret(dreamCtx(cur), cur.notes), { onToken: (acc) => streamInterp(U.stripThinking(acc)) });
      if (!alive(cur)) return;
      if (r.aborted) return;
      const text = U.stripThinking(r.text).trim();
      if (!text) throw new Error('The model returned an empty interpretation.');
      setInterpretation(text);
      s.phase = 'debate';
      s.debateStart = s.transcript.length;
      addEntry({
        role: 'assistant',
        content:
          "Your interpretation is ready in the **Interpretation** tab.\n\nRead it through and tell me what resonates and what doesn't — challenge anything that feels off, or add context I'm missing, and I'll refine it with you.",
      });
      scheduleSave();
    } catch (e) {
      handleError(e);
    } finally {
      doneBusy(cur);
      if (alive(cur)) renderInterp();
    }
  }

  async function rewriteInterpretation() {
    const cur = S.cur;
    if (!cur || S.busy || cur.session.phase !== 'debate') return;
    const s = cur.session;
    const discussion = s.transcript.slice(s.debateStart).filter((e) => (e.role === 'user' || e.role === 'assistant') && e.content);
    setBusy(true);
    switchTab('interp');
    try {
      const r = await llm(P.rewriteInterpretation(dreamCtx(cur), cur.notes, cur.interpretation, discussion), {
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

  function discussExisting() {
    const cur = S.cur;
    if (!cur || S.busy || !ensureModel()) return;
    const s = cur.session;
    s.phase = 'debate';
    s.debateStart = s.transcript.length;
    addEntry({
      role: 'assistant',
      content: "Here's the interpretation saved with this dream. What would you like to explore, question or add?",
    });
    switchTab('interp');
    renderActions();
    $('#chatInput').focus();
  }

  function resume() {
    const cur = S.cur;
    if (!cur || S.busy || !ensureModel()) return;
    const s = cur.session;
    if (s.phase === 'extract') return runExtraction();
    if (s.phase === 'interpret') return runInterpretation();
    if (s.phase === 'walk' || s.phase === 'debate') {
      const last = lastConversational(s);
      if (last && last.role === 'assistant' && !last.content) removeEntry(last);
      if (s.phase === 'walk' && !lastConversational(s)) return beginDetail();
      return assistantTurn();
    }
  }

  async function sendMessage() {
    const cur = S.cur;
    const input = $('#chatInput');
    const text = input.value.trim();
    if (!cur || !text || S.busy) return;
    if (!['walk', 'debate'].includes(cur.session.phase)) return;
    if (!ensureModel()) return;
    input.value = '';
    autosize(input);
    addEntry({ role: 'user', content: text });
    await assistantTurn();
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
      else if (a === 'next') advanceDetail(false);
      else if (a === 'skip') advanceDetail(true);
      else if (a === 'resume') resume();
      else if (a === 'rewrite') rewriteInterpretation();
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
