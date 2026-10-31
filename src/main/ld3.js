'use strict';
/**
 * Reading and writing .ld3 dream files.
 *
 * An .ld3 file is a small XML-like document:
 *
 *   <Dream>
 *     <Date>2026-10-10</Date>
 *     <Time>04:20</Time>
 *     <Sleep>23:30</Sleep>
 *     <Awake>06:30</Awake>
 *     <Title>title</Title>
 *     <Lucidity>1-5</Lucidity>
 *     <Dream>initial dream recording</Dream>
 *     <Comments>notes</Comments>
 *     <Clarity>1-5</Clarity>
 *     <SubCategories></SubCategories>
 *     <Image></Image>
 *   </Dream>
 *
 * Note the nested <Dream> element inside the outer <Dream>. Files written by
 * other apps may not be strictly valid XML, so this module uses a tolerant
 * tag-based parser, and when saving an existing file it edits the known fields
 * in place so that any unknown content and formatting is preserved.
 */

const FIELDS = ['Date', 'Time', 'Sleep', 'Awake', 'Title', 'Lucidity', 'Dream', 'Comments', 'Clarity', 'SubCategories', 'Image'];
// Fields whose inner markup is kept verbatim (they may contain child elements).
const RAW_FIELDS = new Set(['SubCategories', 'Image']);

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
}

function encodeEntities(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Decode a file buffer, remembering its encoding so it can be written back the same way. */
function decodeBuffer(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: buf.subarray(2).toString('utf16le'), encoding: 'utf16le', bom: true };
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString('utf8'), encoding: 'utf8', bom: true };
  }
  return { text: buf.toString('utf8'), encoding: 'utf8', bom: false };
}

function encodeText(text, { encoding = 'utf8', bom = false } = {}) {
  const body = Buffer.from(text, encoding);
  if (!bom) return body;
  const mark = encoding === 'utf16le' ? Buffer.from([0xff, 0xfe]) : Buffer.from([0xef, 0xbb, 0xbf]);
  return Buffer.concat([mark, body]);
}

function detectEol(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/** Find the content range of the outer <Dream> ... </Dream> element. */
function locateOuter(text) {
  const open = /<Dream(?:\s[^>]*)?>/i.exec(text);
  if (!open) return null;
  const innerStart = open.index + open[0].length;
  const innerEnd = text.toLowerCase().lastIndexOf('</dream>');
  if (innerEnd < innerStart) return null;
  return { innerStart, innerEnd };
}

function fieldRegex(name) {
  // Matches <Name>content</Name> (attributes tolerated) or a self-closing <Name/>.
  return new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}\\s*>|<${name}(?:\\s[^>]*)?/>`, 'i');
}

/**
 * Name of the document's root element. Lightened Dream uses the .ld3 extension
 * for several document types (<Dream>, <Check>, <Reading>, <REM>, <Recording>,
 * <Subliminal>, <Category>, <LightenedDream> ignore lists, …); only <Dream> is a dream.
 */
function rootElement(text) {
  const s = String(text)
    .replace(/^\uFEFF/, '')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '');
  const m = /<([A-Za-z_][\w.:-]*)/.exec(s);
  return m ? m[1] : null;
}

function isDream(text) {
  return (rootElement(text) || '').toLowerCase() === 'dream';
}

/** Parse .ld3 text into a plain object with one string per field. */
function parse(text) {
  text = String(text).replace(/^﻿/, '');
  const root = rootElement(text);
  if (root && root.toLowerCase() !== 'dream') {
    const err = new Error(`Not a dream: this .ld3 file is a <${root}> document`);
    err.kind = root;
    throw err;
  }
  const loc = locateOuter(text);
  if (!loc) throw new Error('Not a valid .ld3 dream file (no <Dream> element found)');
  const inner = text.slice(loc.innerStart, loc.innerEnd);
  const out = {};
  for (const f of FIELDS) {
    const m = fieldRegex(f).exec(inner);
    if (!m) {
      out[f] = '';
      continue;
    }
    const raw = (m[1] ?? '').replace(/\r\n/g, '\n');
    out[f] = RAW_FIELDS.has(f) ? raw : decodeEntities(raw).trim();
  }
  return out;
}

function serialiseValue(field, value, eol) {
  const v = RAW_FIELDS.has(field) ? String(value ?? '') : encodeEntities(value);
  return v.replace(/\r?\n/g, eol);
}

/**
 * Update the given fields inside existing .ld3 text, leaving everything else
 * (unknown elements, whitespace, ordering) untouched. Missing fields are appended.
 */
function update(text, fields) {
  text = String(text).replace(/^﻿/, '');
  const loc = locateOuter(text);
  if (!loc) return create(fields, detectEol(text));
  const eol = detectEol(text);
  let inner = text.slice(loc.innerStart, loc.innerEnd);
  for (const f of FIELDS) {
    if (!(f in fields)) continue;
    const val = serialiseValue(f, fields[f], eol);
    const re = fieldRegex(f);
    if (re.test(inner)) {
      inner = inner.replace(re, (match) => {
        const openTag = match.endsWith('/>') ? `<${f}>` : match.match(/^<[^>]*>/)[0];
        return `${openTag}${val}</${f}>`;
      });
    } else {
      const indent = (/\n([ \t]*)</.exec(inner) || [null, '  '])[1];
      inner = inner.replace(/\s*$/, (tail) => `${eol}${indent}<${f}>${val}</${f}>${tail.includes('\n') ? tail : eol}`);
    }
  }
  return text.slice(0, loc.innerStart) + inner + text.slice(loc.innerEnd);
}

/** Create fresh .ld3 text from fields. */
function create(fields, eol = '\n') {
  const lines = ['<Dream>'];
  for (const f of FIELDS) {
    const val = serialiseValue(f, fields[f] ?? '', eol);
    if (f === 'SubCategories' && !val.trim()) {
      lines.push(`  <SubCategories>${eol}  </SubCategories>`);
    } else {
      lines.push(`  <${f}>${val}</${f}>`);
    }
  }
  lines.push('</Dream>');
  return lines.join(eol) + eol;
}

module.exports = { FIELDS, parse, rootElement, isDream, update, create, decodeBuffer, encodeText, detectEol, encodeEntities, decodeEntities };
