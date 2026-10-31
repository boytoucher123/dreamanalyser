'use strict';
/**
 * Lightened Dream categories.
 *
 * Layout (as written by Lightened Dream):
 *   <root>/Lightened Dream/Categories/<Group>[/<SubGroup>…]/<Item>.ld3
 *   <root>/Lightened Dream/IgnoreList.ld3
 *
 * An item file:
 *   <Category>
 *     <Name>Fear</Name>
 *     <Description></Description>
 *     <Names><Name>Scared</Name>…</Names>        synonyms / keywords
 *     <Dreams><Year Value='2026'><Month Value='10'><Dream Date='…' Title='…'/>…   cached index
 *   </Category>
 *
 * A dream is tagged with an item when any of the item's keywords (its name plus
 * its synonyms) appears in the dream text: single words are matched against the
 * dream's words, multi-word keywords as substrings. Tags are stored in the
 * dream's <SubCategories> as <Category Path='Emotions'>Fear</Category>.
 */
const fsp = require('fs/promises');
const fs = require('fs');
const path = require('path');
const ld3 = require('./ld3');

const DEFAULT_GROUPS = ['Characters', 'Locations', 'Objects', 'Actions', 'Themes', 'Emotions'];

// Common words that are never worth categorising (used in addition to IgnoreList.ld3).
const STOPWORDS = new Set(
  `a about above after again against all almost also am among an and another any anyone anything are around as at away back be
  because been before being below between both but by came can cannot could did do does doing done down during each either else
  even ever every few for from further get gets getting go goes going gone got had has have having he her here hers herself him
  himself his how however i if in into is it its itself just kept know knew like made make many maybe me might more most much must
  my myself never no nor not nothing now of off on once one only onto or other others our ours ourselves out over own really
  said same saw say see seemed seems she should so some someone something somewhere still such than that the their theirs them
  themselves then there these they thing things this those though through thought to too took toward towards under until up
  upon us very was we were what when where whether which while who whom whose why will with within without would yet you your
  yours yourself yourselves dream dreamt dreamed dreaming remember remembered felt feel feeling went come comes coming tell told
  think trying tried want wanted look looked looking around started start began seem little bit kind sort lot lots`.split(/\s+/),
);

const sep = '\\'; // Lightened Dream stores group paths with Windows separators

/** Lightened Dream's word splitting (Dreams/Tags.vb GetWords), lower-cased. */
function getWords(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/'s\b/g, ' ')
    .split(/[\s,./\\;\-!?&<>()"“”‘’:]+/)
    .map((w) => w.replace(/^'+|'+$/g, ''))
    .filter(Boolean);
}

function textOf(inner, tag) {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}\\s*>`, 'i').exec(inner);
  return m ? ld3.decodeEntities(m[1]).trim() : '';
}

function parseItem(text) {
  text = String(text).replace(/^﻿/, '');
  if ((ld3.rootElement(text) || '').toLowerCase() !== 'category') throw new Error('Not a category file');
  const body = text.replace(/<Dreams>[\s\S]*<\/Dreams>/i, '');
  const namesBlock = /<Names>([\s\S]*?)<\/Names>/i.exec(body)?.[1] || '';
  const names = [...namesBlock.matchAll(/<Name>([\s\S]*?)<\/Name>/gi)].map((m) => ld3.decodeEntities(m[1]).trim()).filter(Boolean);
  const withoutNames = body.replace(/<Names>[\s\S]*?<\/Names>/i, '');
  return { name: textOf(withoutNames, 'Name'), description: textOf(withoutNames, 'Description'), names };
}

const esc = ld3.encodeEntities;
const escAttr = (s) => esc(s).replace(/'/g, '&apos;').replace(/"/g, '&quot;');

function serialiseItem({ name, description, names }, dreamsIndex = [], eol = '\r\n') {
  const lines = ['<Category>', `  <Name>${esc(name)}</Name>`];
  lines.push(description ? `  <Description>${esc(description)}</Description>` : `  <Description>${eol}  </Description>`);
  lines.push('  <Names>');
  for (const n of names) lines.push(`    <Name>${esc(n)}</Name>`);
  lines.push('  </Names>');
  // Cached index of matching dreams, grouped by year and month (Lightened Dream uses it for its charts).
  const byYear = new Map();
  for (const d of dreamsIndex) {
    const m = /^(\d{4})-(\d{2})/.exec(d.date || '');
    if (!m) continue;
    if (!byYear.has(m[1])) byYear.set(m[1], new Map());
    const months = byYear.get(m[1]);
    if (!months.has(m[2])) months.set(m[2], []);
    months.get(m[2]).push(d);
  }
  lines.push('  <Dreams>');
  for (const y of [...byYear.keys()].sort()) {
    lines.push(`    <Year Value='${y}'>`);
    const months = byYear.get(y);
    for (const mo of [...months.keys()].sort()) {
      lines.push(`      <Month Value='${mo}'>`);
      for (const d of months.get(mo)) lines.push(`        <Dream Date='${escAttr(d.date)}' Title='${escAttr(d.title)}' />`);
      lines.push('      </Month>');
    }
    lines.push('    </Year>');
  }
  lines.push('  </Dreams>');
  lines.push('</Category>');
  return lines.join(eol);
}

/** The keywords that tag a dream with this item (its name and synonyms), lower-cased. */
const keywordsOf = (item) => [...new Set([item.name, ...item.names].map((k) => k.toLowerCase().trim()).filter(Boolean))];

/** Build a fast matcher over all items. */
function buildMatcher(items) {
  const single = new Map(); // word -> [item]
  const multi = []; // [phrase, item]
  for (const item of items) {
    for (const k of keywordsOf(item)) {
      if (/\s/.test(k)) multi.push([k, item]);
      else {
        if (!single.has(k)) single.set(k, []);
        single.get(k).push(item);
      }
    }
  }
  return {
    /** Returns [{ item, keyword }] for every item the text mentions. */
    match(text) {
      const found = new Map();
      for (const w of new Set(getWords(text))) for (const item of single.get(w) || []) if (!found.has(item)) found.set(item, w);
      if (multi.length) {
        const lower = String(text || '').toLowerCase();
        for (const [phrase, item] of multi) if (!found.has(item) && lower.includes(phrase)) found.set(item, phrase);
      }
      return [...found].map(([item, keyword]) => ({ item, keyword }));
    },
    isKnown: (w) => single.has(w),
  };
}

/** Words in the dream that aren't categorised, ignored, or too common/short. */
function unassignedWords(text, matcher, ignore, minLength = 4) {
  const seen = new Set();
  const out = [];
  for (const w of getWords(text)) {
    if (w.length < minLength || seen.has(w) || /^\d+$/.test(w)) continue;
    seen.add(w);
    if (STOPWORDS.has(w) || ignore.has(w) || matcher.isKnown(w)) continue;
    out.push(w);
  }
  return out;
}

/* ---------------- File system ---------------- */

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Find a Lightened Dream "Categories" folder relative to the user's dream folders. */
async function detectRoot(directories) {
  for (const dir of directories) {
    const cands = [
      path.basename(dir).toLowerCase() === 'categories' ? dir : null,
      path.join(dir, 'Categories'),
      path.join(dir, 'Lightened Dream', 'Categories'),
      path.basename(dir).toLowerCase() === 'dreams' ? path.join(path.dirname(dir), 'Categories') : null,
      path.join(dir, 'lucidcode', 'Lightened Dream', 'Categories'),
    ].filter(Boolean);
    for (const c of cands) if (await exists(c)) return c;
  }
  return null;
}

const ignoreFileFor = (root) => path.join(path.dirname(root), 'IgnoreList.ld3');

async function readIgnore(root) {
  try {
    const { text } = ld3.decodeBuffer(await fsp.readFile(ignoreFileFor(root)));
    return new Set([...text.matchAll(/<Ignore>([\s\S]*?)<\/Ignore>/gi)].map((m) => ld3.decodeEntities(m[1]).trim().toLowerCase()).filter(Boolean));
  } catch {
    return new Set();
  }
}

async function addIgnore(root, word) {
  const file = ignoreFileFor(root);
  let text = '<LightenedDream>\r\n</LightenedDream>';
  let enc = { encoding: 'utf8', bom: false };
  try {
    const d = ld3.decodeBuffer(await fsp.readFile(file));
    text = d.text;
    enc = d;
  } catch {
    /* new file */
  }
  const eol = ld3.detectEol(text);
  const close = text.toLowerCase().lastIndexOf('</lighteneddream>');
  const entry = `  <Ignore>${esc(word.toLowerCase())}</Ignore>${eol}`;
  text = close >= 0 ? `${text.slice(0, close).replace(/[ \t]*$/, '')}${entry}${text.slice(close)}` : `<LightenedDream>${eol}${entry}</LightenedDream>`;
  await fsp.writeFile(file, ld3.encodeText(text, enc));
}

/** Load all groups and items under the categories root. */
async function load(root) {
  const groups = [];
  const items = [];
  async function walk(dir, rel) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const group = rel ? { path: rel, name: rel.split(sep).pop(), parent: rel.includes(sep) ? rel.slice(0, rel.lastIndexOf(sep)) : null, items: [] } : null;
    if (group) groups.push(group);
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p, rel ? `${rel}${sep}${e.name}` : e.name);
      else if (group && /\.ld3$/i.test(e.name)) {
        try {
          const parsed = parseItem(ld3.decodeBuffer(await fsp.readFile(p)).text);
          const item = { ...parsed, name: parsed.name || path.basename(e.name, path.extname(e.name)), file: p, group: rel };
          group.items.push(item);
          items.push(item);
        } catch {
          /* not a category item */
        }
      }
    }
  }
  await walk(root, '');
  return { root, groups, items, ignore: await readIgnore(root) };
}

function safeName(s) {
  return String(s).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim();
}

/** Create or update an item file. Renames the file when the name changes (as Lightened Dream does). */
async function saveItem(root, { file, group, name, description = '', names = [] }, dreamsIndex = []) {
  name = String(name || '').trim();
  if (!name) throw new Error('A category item needs a name');
  const dir = path.join(root, ...String(group).split(sep));
  await fsp.mkdir(dir, { recursive: true });
  const target = path.join(dir, `${safeName(name)}.ld3`);
  if (!file && fs.existsSync(target)) throw new Error(`"${name}" already exists in ${group}`);
  let eol = '\r\n';
  let enc = { encoding: 'utf8', bom: false };
  if (file && fs.existsSync(file)) {
    const d = ld3.decodeBuffer(await fsp.readFile(file));
    eol = ld3.detectEol(d.text);
    enc = d;
  }
  const uniq = [...new Map(names.map((n) => String(n).trim()).filter(Boolean).map((n) => [n.toLowerCase(), n])).values()].filter(
    (n) => n.toLowerCase() !== name.toLowerCase(),
  );
  await fsp.writeFile(target, ld3.encodeText(serialiseItem({ name, description, names: uniq }, dreamsIndex, eol), enc));
  if (file && path.resolve(file) !== path.resolve(target) && fs.existsSync(file)) await fsp.unlink(file);
  return target;
}

async function createRoot(baseDir) {
  const root = path.join(baseDir, 'Categories');
  for (const g of DEFAULT_GROUPS) await fsp.mkdir(path.join(root, g), { recursive: true });
  return root;
}

/** <SubCategories> content for a dream, in Lightened Dream's format. */
function subCategoriesXml(matches, eol = '\n') {
  if (!matches.length) return `${eol}  `;
  return `${eol}${matches.map(({ item }) => `    <Category Path='${escAttr(item.group)}'>${esc(item.name)}</Category>`).join(eol)}${eol}  `;
}

module.exports = {
  DEFAULT_GROUPS,
  getWords,
  parseItem,
  serialiseItem,
  buildMatcher,
  unassignedWords,
  detectRoot,
  load,
  saveItem,
  addIgnore,
  readIgnore,
  createRoot,
  subCategoriesXml,
  keywordsOf,
  ignoreFileFor,
};
