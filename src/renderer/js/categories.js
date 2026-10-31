'use strict';
/*
 * Categories (Lightened Dream compatible): the Categories screen, and the
 * categories / unassigned-words section shown on each dream.
 * Uses helpers exposed by app.js on window.App.
 */
(function () {
  const A = () => window.App;
  const C = {
    data: null, // { root, groups:[{path,name,parent,items:[{key,file,name,description,names,group}]}] }
    group: '', // selected group path ('' = overview)
    item: null, // selected item key, or 'new'
    draft: null, // editor state
    analysis: null, // { path, matches, unassigned }
    suggest: new Map(), // dream path -> Map(word -> group)
    sorting: false,
    addingGroup: false,
  };

  const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1);
  const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);

  async function load(force = false) {
    if (!C.data || force) {
      try {
        C.data = await A().api.getCategories();
      } catch (e) {
        A().toast(`Couldn't load categories: ${A().cleanErr(e)}`, 'error');
        C.data = { root: null, groups: [] };
      }
    }
    return C.data;
  }

  const allItems = () => (C.data?.groups || []).flatMap((g) => g.items);
  const findItem = (key) => allItems().find((i) => i.key === key);
  const inGroup = (itemGroup, groupPath) => itemGroup === groupPath || itemGroup.startsWith(`${groupPath}\\`);

  /** Dream counts per item key and per group path, from the scanned journal. */
  function counts() {
    const dreams = A().S.dreams;
    const items = new Map();
    const groups = new Map();
    for (const d of dreams) {
      const touched = new Set();
      for (const key of d.tags || []) {
        items.set(key, (items.get(key) || 0) + 1);
        const group = key.slice(0, key.lastIndexOf('\\'));
        const parts = group.split('\\');
        for (let i = 1; i <= parts.length; i++) touched.add(parts.slice(0, i).join('\\'));
      }
      for (const g of touched) groups.set(g, (groups.get(g) || 0) + 1);
    }
    return { items, groups, total: dreams.length };
  }

  /* ------------------------------------------------------------------ */
  /* Charts: horizontal bars + monthly columns (single hue, hover tips)   */
  /* ------------------------------------------------------------------ */
  function barsHtml(rows, { total, action }) {
    const max = Math.max(1, ...rows.map((r) => r.value));
    return `<div class="bars" role="list">${rows
      .map(
        (r) => `<button class="bar-row ${r.active ? 'active' : ''}" role="listitem" data-${action}="${A().esc(r.key)}"
          data-tip="${A().esc(`${r.label} — ${r.value} dream${r.value === 1 ? '' : 's'} (${pct(r.value, total)}% of journal)${r.sub ? ` · ${r.sub}` : ''}`)}">
          <span class="bar-label">${A().esc(r.label)}${r.sub ? `<small>${A().esc(r.sub)}</small>` : ''}</span>
          <span class="bar-track"><span class="bar-fill" style="width:${r.value ? Math.max(1.5, (r.value / max) * 100) : 0}%"></span></span>
          <span class="bar-value">${r.value}</span>
        </button>`,
      )
      .join('')}</div>`;
  }

  function timelineHtml(dreams) {
    const U = A().U;
    const byMonth = new Map();
    for (const d of dreams) {
      const p = U.parseDate(d.date);
      if (!p) continue;
      const k = p.y * 12 + (p.m - 1);
      byMonth.set(k, (byMonth.get(k) || 0) + 1);
    }
    if (!byMonth.size) return '';
    const keys = [...byMonth.keys()];
    // Always show at least a year so a single dream doesn't fill the chart; at most three years.
    const last = Math.max(...keys);
    const first = Math.min(Math.max(Math.min(...keys), last - 35), last - 11);
    const max = Math.max(...byMonth.values());
    const cols = [];
    for (let k = first; k <= last; k++) {
      const v = byMonth.get(k) || 0;
      const label = `${U.MONTHS[k % 12].slice(0, 3)} ${Math.floor(k / 12)}`;
      cols.push(`<span class="col" data-tip="${label} — ${v} dream${v === 1 ? '' : 's'}"><span class="col-fill" style="height:${v ? Math.max(6, (v / max) * 100) : 0}%"></span></span>`);
    }
    const lbl = (k) => `${A().U.MONTHS[k % 12].slice(0, 3)} ${Math.floor(k / 12)}`;
    return `<div class="timeline"><div class="cols">${cols.join('')}</div><div class="tl-axis"><span>${lbl(first)}</span><span>${lbl(last)}</span></div></div>`;
  }

  // Shared hover tooltip for any [data-tip] element.
  function setupTooltip() {
    const tip = document.getElementById('chartTip');
    document.addEventListener('mouseover', (e) => {
      const t = e.target.closest('[data-tip]');
      if (!t) return tip.classList.remove('show');
      tip.textContent = t.dataset.tip;
      tip.classList.add('show');
    });
    document.addEventListener('mousemove', (e) => {
      if (!tip.classList.contains('show')) return;
      const x = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
      tip.style.transform = `translate(${x}px, ${e.clientY + 16}px)`;
    });
  }

  /* ------------------------------------------------------------------ */
  /* Categories screen                                                   */
  /* ------------------------------------------------------------------ */
  async function open(group = C.group, itemKey = null) {
    A().showView('categories');
    await load(true);
    C.group = group || '';
    if (itemKey) C.group = findItem(itemKey)?.group || C.group;
    C.item = itemKey;
    C.draft = itemKey ? draftFor(findItem(itemKey)) : null;
    render();
  }

  function draftFor(item) {
    return item ? { file: item.file, group: item.group, name: item.name, description: item.description, names: [...item.names] } : null;
  }

  function render() {
    const view = document.getElementById('view-categories');
    const esc = A().esc;
    if (!C.data?.root) {
      view.innerHTML = `<div class="cat-empty glass">
        <div class="moon mini"><div class="moon-glow"></div></div>
        <h2>Categories</h2>
        <p>Categories tag your dreams with the characters, places, objects, actions, themes and emotions they contain — using the same
        <code>Categories</code> folder as Lightened Dream, so both apps stay in sync.</p>
        <p class="muted small">No categories folder was found next to your dream folders. If you use Lightened Dream, choose its
        <code>Lightened Dream/Categories</code> folder; otherwise create a fresh one.</p>
        <div class="start-actions">
          <button class="btn primary" data-cat="create">${icon('sparkle')}Create categories folder</button>
          <button class="btn ghost" data-cat="choose">${icon('folder')}Choose existing folder…</button>
        </div></div>`;
      return;
    }

    const cnt = counts();
    const groups = C.data.groups;
    const depth = (g) => g.path.split('\\').length - 1;
    const sidebar = `<aside class="sidebar glass cat-side">
      <div class="sidebar-head"><h2>Categories</h2></div>
      <button class="cat-nav ${C.group === '' ? 'active' : ''}" data-group="">${icon('star')}<span class="label">Overview</span><span class="count">${cnt.total}</span></button>
      <div class="cat-groups">${groups
        .map(
          (g) => `<button class="cat-nav ${C.group === g.path ? 'active' : ''}" style="padding-left:${12 + depth(g) * 16}px" data-group="${esc(g.path)}">
            <span class="label">${esc(g.name)}</span><span class="count" title="Dreams tagged">${cnt.groups.get(g.path) || 0}</span></button>`,
        )
        .join('')}</div>
      ${
        C.addingGroup
          ? `<form class="new-group" data-cat-form="group"><input name="name" placeholder="New group name" autofocus /><button class="btn primary small">Add</button></form>`
          : `<button class="btn ghost full" data-cat="new-group">${icon('folder')}New group</button>`
      }
      <div class="muted small cat-root" title="${esc(C.data.root)}"><bdi dir="ltr">${esc(C.data.root)}</bdi></div>
    </aside>`;

    let main;
    if (!C.group) {
      const top = groups.filter((g) => !g.parent);
      const rows = top.map((g) => ({ key: g.path, label: g.name, value: cnt.groups.get(g.path) || 0, sub: `${g.items.length + groups.filter((x) => x.parent && inGroup(x.path, g.path)).reduce((n, x) => n + x.items.length, 0)} items` }));
      const tagged = A().S.dreams.filter((d) => d.tags?.length).length;
      const topItems = allItems()
        .map((i) => ({ key: i.key, label: i.name, sub: i.group.replace(/\\/g, ' › '), value: cnt.items.get(i.key) || 0 }))
        .filter((r) => r.value)
        .sort((a, b) => b.value - a.value)
        .slice(0, 12);
      main = `<div class="cat-main">
        <div class="cat-head"><div><h1>Overview</h1><p class="muted">${tagged} of ${cnt.total} dreams tagged · ${allItems().length} category items</p></div></div>
        <div class="cat-panels">
          <section class="glass cat-card"><h3>Dreams per group</h3>${barsHtml(rows, { total: cnt.total, action: 'group' })}</section>
          <section class="glass cat-card"><h3>Most frequent</h3>${
            topItems.length ? barsHtml(topItems, { total: cnt.total, action: 'item' }) : '<p class="muted">No dreams are tagged yet. Open a dream and file its unassigned words into groups.</p>'
          }</section>
        </div></div>`;
    } else {
      const g = groups.find((x) => x.path === C.group);
      if (!g) {
        C.group = '';
        return render();
      }
      const items = groups.filter((x) => inGroup(x.path, g.path)).flatMap((x) => x.items);
      const rows = items
        .map((i) => ({ key: i.key, label: i.name, sub: i.group !== g.path ? i.group.slice(g.path.length + 1).replace(/\\/g, ' › ') : '', value: cnt.items.get(i.key) || 0, active: C.item === i.key }))
        .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
      main = `<div class="cat-main">
        <div class="cat-head"><div><h1>${esc(g.name)}</h1><p class="muted">${cnt.groups.get(g.path) || 0} of ${cnt.total} dreams · ${items.length} items</p></div>
          <div class="spacer"></div><button class="btn primary small" data-cat="new-item">${icon('sparkle')}New item</button></div>
        <div class="cat-panels ${C.item ? 'with-editor' : ''}">
          <section class="glass cat-card">${rows.length ? barsHtml(rows, { total: cnt.total, action: 'item' }) : '<p class="muted">No items yet. Add one, or file unassigned words from a dream.</p>'}</section>
          ${C.item ? editorHtml() : ''}
        </div></div>`;
    }
    view.innerHTML = sidebar + main;
    view.querySelector('[data-cat-form] input')?.focus();
  }

  function editorHtml() {
    const esc = A().esc;
    const d = C.draft;
    if (!d) return '';
    const isNew = !d.file;
    const item = isNew ? null : findItem(C.item);
    const kw = [d.name, ...d.names].map((k) => k.toLowerCase());
    const dreams = item ? A().S.dreams.filter((x) => (x.tags || []).includes(item.key)) : [];
    return `<section class="glass cat-card editor">
      <div class="editor-head"><h3>${isNew ? 'New item' : esc(item.name)}</h3><div class="spacer"></div>
        <button class="icon-btn small" data-cat="close-item" title="Close">${icon('close')}</button></div>
      <label class="field"><span>Name</span><input data-draft="name" value="${esc(d.name)}" placeholder="e.g. Grandmother" /></label>
      <div class="field"><span>Synonyms — any of these words also tag a dream</span>
        <div class="chips-input">${d.names.map((n, i) => `<span class="chip-tag">${esc(n)}<button data-remove-syn="${i}" title="Remove">${icon('close')}</button></span>`).join('')}
          <input data-syn-input placeholder="${d.names.length ? 'Add…' : 'e.g. nana, granny'}" /></div></div>
      <label class="field"><span>Description</span><textarea data-draft="description" rows="3">${esc(d.description)}</textarea></label>
      <div class="editor-actions">
        ${isNew ? '' : `<button class="btn ghost small danger-text" data-cat="delete-item">${icon('trash')}Delete</button>`}
        <div class="spacer"></div>
        <button class="btn primary small" data-cat="save-item">${icon('check')}Save</button>
      </div>
      ${
        isNew
          ? ''
          : `<h4>Appears in ${dreams.length} dream${dreams.length === 1 ? '' : 's'}</h4>
        ${timelineHtml(dreams)}
        <div class="item-dreams">${
          dreams
            .slice(0, 200)
            .map((x) => `<button class="item-dream" data-path="${esc(x.path)}"><span class="d">${esc(A().U.prettyDate(x.date))}</span><span class="t">${esc(x.title)}</span></button>`)
            .join('') || '<p class="muted small">No dreams mention it yet.</p>'
        }</div>`
      }
      <p class="muted small kw">Matches: ${kw.filter(Boolean).map((k) => `<code>${esc(k)}</code>`).join(' ')}</p>
    </section>`;
  }

  async function saveDraft() {
    const d = C.draft;
    const name = d.name.trim();
    if (!name) return A().toast('Give the item a name.', 'warn');
    try {
      await A().api.saveCategoryItem({ ...d, name });
      await afterCategoryChange();
      C.item = `${d.group}\\${name}`;
      C.draft = draftFor(findItem(C.item));
      render();
      A().toast(`Saved “${name}”`, 'success', 1800);
    } catch (e) {
      A().toast(A().cleanErr(e), 'error');
    }
  }

  /** Reload categories and re-tag the journal after any category change. */
  async function afterCategoryChange() {
    await load(true);
    await A().refreshDreams();
    if (A().S.cur) A().scheduleSave(); // rewrites the open dream's <SubCategories>
  }

  function bindScreen() {
    const view = document.getElementById('view-categories');
    view.addEventListener('click', async (e) => {
      const t = e.target;
      const groupBtn = t.closest('[data-group]');
      const itemBtn = t.closest('[data-item]');
      const dreamBtn = t.closest('[data-path]');
      const action = t.closest('[data-cat]')?.dataset.cat;
      const removeSyn = t.closest('[data-remove-syn]');
      if (groupBtn) {
        C.group = groupBtn.dataset.group;
        C.item = null;
        C.draft = null;
        render();
      } else if (itemBtn) {
        const item = findItem(itemBtn.dataset.item);
        if (!item) return;
        C.group = C.group && inGroup(item.group, C.group) ? C.group : item.group;
        C.item = item.key;
        C.draft = draftFor(item);
        render();
      } else if (dreamBtn) {
        A().openDream(dreamBtn.dataset.path);
      } else if (removeSyn) {
        C.draft.names.splice(Number(removeSyn.dataset.removeSyn), 1);
        render();
      } else if (action === 'create') {
        await A().api.createCategoriesRoot();
        A().S.settings = await A().api.getSettings();
        await afterCategoryChange();
        render();
      } else if (action === 'choose') {
        if (await A().api.chooseCategoriesRoot()) {
          A().S.settings = await A().api.getSettings();
          await afterCategoryChange();
          render();
        }
      } else if (action === 'new-group') {
        C.addingGroup = true;
        render();
      } else if (action === 'new-item') {
        C.item = 'new';
        C.draft = { file: null, group: C.group, name: '', description: '', names: [] };
        render();
        view.querySelector('[data-draft="name"]')?.focus();
      } else if (action === 'close-item') {
        C.item = null;
        C.draft = null;
        render();
      } else if (action === 'save-item') {
        saveDraft();
      } else if (action === 'delete-item') {
        if (await A().api.deleteCategoryItem(C.draft.file)) {
          C.item = null;
          C.draft = null;
          await afterCategoryChange();
          render();
        }
      }
    });
    view.addEventListener('input', (e) => {
      const f = e.target.dataset.draft;
      if (f && C.draft) C.draft[f] = e.target.value;
    });
    view.addEventListener('keydown', (e) => {
      if (e.target.matches('[data-syn-input]')) {
        const v = e.target.value.trim().replace(/,$/, '');
        if ((e.key === 'Enter' || e.key === ',') && v) {
          e.preventDefault();
          C.draft.names.push(...v.split(',').map((s) => s.trim()).filter(Boolean));
          render();
          view.querySelector('[data-syn-input]')?.focus();
        } else if (e.key === 'Backspace' && !e.target.value && C.draft.names.length) {
          C.draft.names.pop();
          render();
          view.querySelector('[data-syn-input]')?.focus();
        }
      } else if (e.key === 'Enter' && e.target.matches('[data-draft="name"]')) saveDraft();
      else if (e.key === 'Escape' && C.addingGroup) {
        C.addingGroup = false;
        render();
      }
    });
    view.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = e.target.name.value.trim();
      if (!name) return;
      try {
        const created = await A().api.createCategoryGroup(name);
        C.addingGroup = false;
        await load(true);
        C.group = created;
        render();
      } catch (err) {
        A().toast(A().cleanErr(err), 'error');
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* Categories on a dream (Dream tab)                                   */
  /* ------------------------------------------------------------------ */
  async function renderDreamCats() {
    const box = document.getElementById('dreamCats');
    const cur = A().S.cur;
    if (!box || !cur) return;
    const esc = A().esc;
    await load();
    if (!C.data.root) {
      box.innerHTML = `<div class="dc-section"><h4>Categories</h4>
        <p class="muted small">Tag this dream with characters, places, emotions and more.</p>
        <button class="btn ghost small" data-dc="setup">${icon('folder')}Set up categories</button></div>`;
      return;
    }
    const a = await A().api.analyseCategories(`${cur.fields.Title} ${cur.fields.Dream}`);
    if (A().S.cur !== cur) return;
    C.analysis = { path: cur.path, ...a };
    const byGroup = new Map();
    for (const m of a.matches) {
      if (!byGroup.has(m.group)) byGroup.set(m.group, []);
      byGroup.get(m.group).push(m);
    }
    const sugg = C.suggest.get(cur.path) || new Map();
    const words = a.unassigned.slice(0, 80);
    const pending = words.filter((w) => sugg.has(w));
    box.innerHTML = `<div class="dc-section">
      <h4>Categories <span class="muted small">${a.matches.length} tag${a.matches.length === 1 ? '' : 's'}</span></h4>
      ${
        byGroup.size
          ? [...byGroup]
              .map(
                ([g, ms]) => `<div class="dc-group"><span class="dc-gname">${esc(g.replace(/\\/g, ' › '))}</span>${ms
                  .map((m) => `<button class="chip-tag link" data-dc-item="${esc(m.key)}" title="Matched “${esc(m.keyword)}”">${esc(m.name)}</button>`)
                  .join('')}</div>`,
              )
              .join('')
          : '<p class="muted small">No category items mentioned yet.</p>'
      }
    </div>
    <div class="dc-section">
      <h4>Unassigned words <span class="muted small">${a.unassigned.length}</span>
        <span class="spacer"></span>
        ${pending.length ? `<button class="btn soft small" data-dc="accept-all">${icon('check')}Accept ${pending.length} suggestion${pending.length === 1 ? '' : 's'}</button>` : ''}
        ${words.length ? `<button class="btn ghost small" data-dc="ai-sort" ${C.sorting ? 'disabled' : ''}>${icon('sparkle')}${C.sorting ? 'Sorting…' : 'Sort with AI'}</button>` : ''}
      </h4>
      ${
        words.length
          ? `<div class="dc-words">${words
              .map((w) => {
                const s = sugg.get(w);
                return `<button class="chip-tag word ${s ? (s === 'ignore' ? 'sugg-ignore' : 'sugg') : ''}" data-dc-word="${esc(w)}">${esc(w)}${
                  s ? `<small>${s === 'ignore' ? 'ignore' : esc(s.split('\\').pop())}</small>` : ''
                }</button>`;
              })
              .join('')}</div>
             <p class="muted small">Click a word to file it into a group (creating a category item) or to ignore it.</p>`
          : '<p class="muted small">Every notable word is categorised or ignored.</p>'
      }
    </div>`;
  }

  function closePopover() {
    document.getElementById('wordPop')?.remove();
  }

  function showWordPopover(btn, word) {
    closePopover();
    const esc = A().esc;
    const sugg = (C.suggest.get(A().S.cur?.path) || new Map()).get(word);
    const pop = document.createElement('div');
    pop.id = 'wordPop';
    pop.className = 'popover glass';
    pop.innerHTML = `<div class="pop-title">File “${esc(word)}” as…</div>
      ${C.data.groups
        .map((g) => `<button data-assign="${esc(g.path)}" class="${sugg === g.path ? 'suggested' : ''}" style="padding-left:${12 + (g.path.split('\\').length - 1) * 14}px">${esc(g.name)}${sugg === g.path ? ' <small>suggested</small>' : ''}</button>`)
        .join('')}
      <hr><button data-ignore class="${sugg === 'ignore' ? 'suggested' : ''}">${icon('close')}Ignore this word</button>`;
    document.body.appendChild(pop);
    const r = btn.getBoundingClientRect();
    const top = Math.min(r.bottom + 6, window.innerHeight - pop.offsetHeight - 10);
    pop.style.left = `${Math.min(r.left, window.innerWidth - pop.offsetWidth - 10)}px`;
    pop.style.top = `${Math.max(10, top)}px`;
    pop.addEventListener('click', async (e) => {
      const assign = e.target.closest('[data-assign]');
      const ignore = e.target.closest('[data-ignore]');
      if (!assign && !ignore) return;
      closePopover();
      await fileWords([[word, assign ? assign.dataset.assign : 'ignore']]);
    });
  }

  /** Apply [[word, groupPath | 'ignore'], …]: create items / extend the ignore list, then refresh. */
  async function fileWords(pairs) {
    const cur = A().S.cur;
    const existing = new Set(allItems().map((i) => `${i.group}\\${i.name}`.toLowerCase()));
    let done = 0;
    try {
      for (const [word, group] of pairs) {
        if (group === 'ignore') await A().api.ignoreWord(word);
        else if (!existing.has(`${group}\\${word}`.toLowerCase())) await A().api.saveCategoryItem({ file: null, group, name: cap(word), description: '', names: [] });
        C.suggest.get(cur?.path)?.delete(word);
        done++;
      }
    } catch (e) {
      A().toast(A().cleanErr(e), 'error');
    }
    await afterCategoryChange();
    if (A().S.cur === cur) renderDreamCats();
    if (done > 1) A().toast(`Filed ${done} words`, 'success', 1800);
  }

  async function aiSort() {
    const cur = A().S.cur;
    if (!cur || !C.analysis || C.sorting || !A().ensureModel()) return;
    const words = C.analysis.unassigned.slice(0, 40);
    const groups = C.data.groups.map((g) => g.path);
    if (!words.length || !groups.length) return;
    C.sorting = true;
    renderDreamCats();
    try {
      const r = await A().llm(A().P.sortWords(words, groups), { format: A().P.sortWordsSchema(groups), temperature: 0 });
      const obj = JSON.parse(A().U.stripThinking(r.text).replace(/```(json)?/g, '').trim());
      const map = new Map();
      const lower = new Map(groups.map((g) => [g.toLowerCase(), g]));
      for (const { word, group } of obj.assignments || []) {
        const w = String(word || '').toLowerCase();
        const g = String(group || '').toLowerCase() === 'ignore' ? 'ignore' : lower.get(String(group || '').toLowerCase());
        if (words.includes(w) && g) map.set(w, g);
      }
      C.suggest.set(cur.path, map);
      A().toast(map.size ? `Suggested groups for ${map.size} words — review and accept` : 'The model had no suggestions', map.size ? 'success' : 'warn', 2600);
    } catch (e) {
      A().toast(`AI sort failed: ${A().cleanErr(e)}`, 'error');
    } finally {
      C.sorting = false;
      if (A().S.cur === cur) renderDreamCats();
    }
  }

  function bindDreamCats() {
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#wordPop') && !e.target.closest('[data-dc-word]')) closePopover();
      const box = e.target.closest('#dreamCats');
      if (!box) return;
      const word = e.target.closest('[data-dc-word]');
      const item = e.target.closest('[data-dc-item]');
      const action = e.target.closest('[data-dc]')?.dataset.dc;
      if (word) showWordPopover(word, word.dataset.dcWord);
      else if (item) {
        A().leaveTo(() => open(null, item.dataset.dcItem));
      } else if (action === 'setup') A().leaveTo(() => open(''));
      else if (action === 'ai-sort') aiSort();
      else if (action === 'accept-all') {
        const sugg = C.suggest.get(A().S.cur?.path);
        if (sugg) fileWords([...sugg]);
      }
    });
    window.addEventListener('resize', closePopover);
    document.addEventListener('scroll', closePopover, true);
  }

  function init() {
    setupTooltip();
    bindScreen();
    bindDreamCats();
  }

  const icon = (n) => window.icon(n);
  window.Categories = { init, open, load, renderDreamCats, invalidate: () => (C.data = null) };
})();
