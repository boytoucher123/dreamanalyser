'use strict';
/** File-system operations on dream directories (no Electron dependencies, so it can be unit tested). */
const fsp = require('fs/promises');
const fs = require('fs');
const path = require('path');
const os = require('os');
const ld3 = require('./ld3');

const MAX_DEPTH = 12;

async function findLd3Files(dir, depth = 0, out = []) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (depth < MAX_DEPTH && e.name !== 'node_modules') await findLd3Files(p, depth + 1, out);
    } else if (/\.ld3$/i.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

async function readDreamFile(file) {
  const buf = await fsp.readFile(file);
  const { text } = ld3.decodeBuffer(buf);
  return ld3.parse(text);
}

/** Scan all directories and return a lightweight summary of every dream found. */
async function scan(directories) {
  const seen = new Set();
  const files = [];
  for (const dir of directories) {
    const root = path.resolve(dir);
    for (const f of await findLd3Files(root)) {
      if (!seen.has(f)) {
        seen.add(f);
        files.push({ file: f, root });
      }
    }
  }
  const results = await Promise.all(
    files.map(async ({ file, root }) => {
      try {
        const [d, st] = await Promise.all([readDreamFile(file), fsp.stat(file)]);
        return {
          path: file,
          root,
          relDir: path.relative(root, path.dirname(file)),
          title: d.Title || path.basename(file, path.extname(file)),
          date: d.Date,
          time: d.Time,
          lucidity: d.Lucidity,
          clarity: d.Clarity,
          excerpt: d.Dream.slice(0, 220),
          hasInterpretation: /==== Dream Interpretation ====/.test(d.Comments),
          mtime: st.mtimeMs,
        };
      } catch (err) {
        return { path: file, root, error: err.message, title: path.basename(file), date: '', mtime: 0 };
      }
    }),
  );
  return results;
}

function sanitiseFileName(s) {
  return String(s || 'Untitled dream')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .replace(/[. ]+$/, '') || 'Untitled dream';
}

function uniquePath(dir, base) {
  let p = path.join(dir, `${base}.ld3`);
  for (let i = 2; fs.existsSync(p); i++) p = path.join(dir, `${base} (${i}).ld3`);
  return p;
}

/**
 * Save a dream. Existing files are updated in place (preserving encoding, line
 * endings and unknown content); new files are created in saveDir.
 */
async function saveDream({ path: file, fields }, saveDir) {
  if (file && fs.existsSync(file)) {
    const buf = await fsp.readFile(file);
    const decoded = ld3.decodeBuffer(buf);
    const text = ld3.update(decoded.text, fields);
    await writeAtomic(file, ld3.encodeText(text, decoded));
    return file;
  }
  if (!saveDir) throw new Error('No folder selected for saving new dreams');
  await fsp.mkdir(saveDir, { recursive: true });
  const target = file || uniquePath(saveDir, sanitiseFileName(`${fields.Date || ''} ${fields.Title || ''}`));
  await writeAtomic(target, Buffer.from(ld3.create(fields, os.EOL), 'utf8'));
  return target;
}

async function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, file);
}

module.exports = { scan, findLd3Files, readDreamFile, saveDream, sanitiseFileName };
