'use strict';
/* Small helpers: markdown rendering, detail-list parsing, dates. Exposed as window.Util (and module.exports for tests). */
(function (root) {
  const escapeHtml = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  function inline(s) {
    return s
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_]+)__/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
      .replace(/(^|[^_\w])_([^_\n]+)_(?!_)/g, '$1<em>$2</em>');
  }

  /** A deliberately small, safe markdown renderer (input is HTML-escaped first). */
  function markdown(src) {
    const lines = escapeHtml(src).replace(/\r\n/g, '\n').split('\n');
    const out = [];
    let list = null; // 'ul' | 'ol'
    let para = [];
    let code = null;
    const flushPara = () => {
      if (para.length) out.push(`<p>${inline(para.join('<br>'))}</p>`);
      para = [];
    };
    const closeList = () => {
      if (list) out.push(`</${list}>`);
      list = null;
    };
    for (const line of lines) {
      if (code !== null) {
        if (/^\s*```/.test(line)) {
          out.push(`<pre><code>${code.join('\n')}</code></pre>`);
          code = null;
        } else code.push(line);
        continue;
      }
      if (/^\s*```/.test(line)) {
        flushPara();
        closeList();
        code = [];
        continue;
      }
      let m;
      if ((m = /^\s*(#{1,4})\s+(.*)$/.exec(line))) {
        flushPara();
        closeList();
        const level = Math.min(m[1].length + 1, 5);
        out.push(`<h${level}>${inline(m[2])}</h${level}>`);
      } else if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
        flushPara();
        closeList();
        out.push('<hr>');
      } else if ((m = /^\s*[-*•]\s+(.*)$/.exec(line))) {
        flushPara();
        if (list !== 'ul') {
          closeList();
          out.push('<ul>');
          list = 'ul';
        }
        out.push(`<li>${inline(m[1])}</li>`);
      } else if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) {
        flushPara();
        if (list !== 'ol') {
          closeList();
          out.push('<ol>');
          list = 'ol';
        }
        out.push(`<li>${inline(m[1])}</li>`);
      } else if ((m = /^\s*&gt;\s?(.*)$/.exec(line))) {
        flushPara();
        closeList();
        out.push(`<blockquote>${inline(m[1])}</blockquote>`);
      } else if (!line.trim()) {
        flushPara();
        closeList();
      } else {
        if (list) closeList();
        para.push(line.trim());
      }
    }
    if (code !== null) out.push(`<pre><code>${code.join('\n')}</code></pre>`);
    flushPara();
    closeList();
    return out.join('\n');
  }

  /** Remove <think>…</think> reasoning blocks some models emit. */
  function stripThinking(s) {
    s = String(s || '');
    s = s.replace(/<think>[\s\S]*?<\/think>/gi, '');
    if (/<\/think>/i.test(s)) s = s.slice(s.search(/<\/think>/i) + 8);
    const open = s.search(/<think>/i);
    if (open >= 0) s = s.slice(0, open);
    return s.replace(/^\s+/, '');
  }

  function cleanItem(d) {
    if (d == null) return null;
    if (typeof d === 'string') return splitLine(d);
    const title = String(d.title ?? d.name ?? d.detail ?? '').replace(/\*\*/g, '').trim();
    const description = String(d.description ?? d.desc ?? d.summary ?? '').replace(/\*\*/g, '').trim();
    return title ? { title, description } : null;
  }

  /** Parse the strict JSON detail list returned by the model. Returns null if unparseable. */
  function parseDetailsJson(text) {
    if (!text) return null;
    const t = String(text).replace(/```(?:json)?/gi, '').trim();
    const candidates = [];
    const ob = t.indexOf('{');
    const cb = t.lastIndexOf('}');
    if (ob >= 0 && cb > ob) candidates.push(t.slice(ob, cb + 1));
    const ab = t.indexOf('[');
    const ae = t.lastIndexOf(']');
    if (ab >= 0 && ae > ab) candidates.push(t.slice(ab, ae + 1));
    for (const c of candidates) {
      try {
        const obj = JSON.parse(c);
        const arr = Array.isArray(obj) ? obj : obj.details || obj.items || obj.list || Object.values(obj).find(Array.isArray);
        if (Array.isArray(arr)) return arr.map(cleanItem).filter(Boolean);
      } catch {
        /* try next */
      }
    }
    return null;
  }

  function splitLine(line) {
    const s = String(line).replace(/\*\*/g, '').trim();
    if (!s) return null;
    const m = /^(.{1,80}?)\s+(?:—|–|-{1,2}|:)\s+(.*)$/.exec(s) || /^(.{1,80}?):\s*(.*)$/.exec(s);
    return m ? { title: m[1].trim(), description: m[2].trim() } : { title: s.length > 60 ? `${s.slice(0, 57)}…` : s, description: s };
  }

  /** Fallback: parse a free-form numbered/bulleted list. */
  function parseNumberedList(text) {
    const out = [];
    for (const line of String(text || '').split('\n')) {
      const m = /^\s*(?:\d+[.)]|[-*•])\s+(.*)$/.exec(line);
      if (m) {
        const item = splitLine(m[1]);
        if (item) out.push(item);
      }
    }
    return out;
  }

  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');

  /** Drop details whose titles duplicate ones already covered. */
  function filterNewDetails(candidates, existing, limit = 8) {
    const seen = existing.map((d) => norm(d.title));
    const out = [];
    for (const c of candidates) {
      const n = norm(c.title);
      if (!n) continue;
      const dup = seen.some((s) => s === n || (s.length > 3 && n.length > 3 && (s.includes(n) || n.includes(s))));
      if (!dup) {
        out.push(c);
        seen.push(n);
      }
      if (out.length >= limit) break;
    }
    return out;
  }

  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  /** Parse an .ld3 date string into {y, m, d}; supports YYYY-MM-DD and DD/MM/YYYY. */
  function parseDate(s) {
    s = String(s || '').trim();
    let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s);
    if (m) return { y: +m[1], m: +m[2], d: +m[3] };
    m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/.exec(s);
    if (m) return { y: +m[3], m: +m[2], d: +m[1] };
    const t = Date.parse(s);
    if (!Number.isNaN(t)) {
      const dt = new Date(t);
      return { y: dt.getFullYear(), m: dt.getMonth() + 1, d: dt.getDate() };
    }
    return null;
  }

  function prettyDate(s) {
    const p = parseDate(s);
    if (!p) return s || 'Undated';
    return `${p.d} ${MONTHS[p.m - 1] || ''} ${p.y}`;
  }

  function todayIso() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function nowTime() {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  const INTERP_MARK = '==== Dream Interpretation ====';

  function composeComments(notes, interpretation) {
    const n = String(notes || '').trim();
    const i = String(interpretation || '').trim();
    return i ? `${n}${n ? '\n\n' : ''}${INTERP_MARK}\n${i}` : n;
  }

  function splitComments(comments) {
    const c = String(comments || '');
    const idx = c.indexOf(INTERP_MARK);
    if (idx < 0) return { notes: c.trim(), interpretation: '' };
    return { notes: c.slice(0, idx).trim(), interpretation: c.slice(idx + INTERP_MARK.length).trim() };
  }

  const api = {
    escapeHtml,
    markdown,
    stripThinking,
    parseDetailsJson,
    parseNumberedList,
    filterNewDetails,
    parseDate,
    prettyDate,
    todayIso,
    nowTime,
    MONTHS,
    composeComments,
    splitComments,
    INTERP_MARK,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Util = api;
})(typeof window !== 'undefined' ? window : globalThis);
