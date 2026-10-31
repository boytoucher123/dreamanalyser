'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ld3 = require('../src/main/ld3');
const dreams = require('../src/main/dreams');
const U = require('../src/renderer/js/util');

const SAMPLE = `<Dream>
  <Date>2026-10-10</Date>
  <Time>04:20</Time>
  <Sleep>23:30</Sleep>
  <Awake>06:30</Awake>
  <Title>The flooded library</Title>
  <Lucidity>2</Lucidity>
  <Dream>I was in a library &amp; the water was rising.
Books floated past me.</Dream>
  <Comments>notes go here</Comments>
  <Clarity>4</Clarity>
  <SubCategories>
  <Item>Water</Item>
  </SubCategories>
  <Image></Image>
</Dream>
`;

test('parses all fields including the nested Dream element', () => {
  const d = ld3.parse(SAMPLE);
  assert.equal(d.Date, '2026-10-10');
  assert.equal(d.Time, '04:20');
  assert.equal(d.Title, 'The flooded library');
  assert.equal(d.Lucidity, '2');
  assert.equal(d.Dream, 'I was in a library & the water was rising.\nBooks floated past me.');
  assert.equal(d.Comments, 'notes go here');
  assert.equal(d.Clarity, '4');
  assert.match(d.SubCategories, /<Item>Water<\/Item>/);
  assert.equal(d.Image, '');
});

test('update edits fields in place and preserves unknown content', () => {
  const text = SAMPLE.replace(/<\/Dream>\n$/, '  <Mood>calm</Mood>\n</Dream>\n');
  const out = ld3.update(text, { Comments: 'New <notes> & thoughts\nline 2', Title: 'Renamed' });
  const d = ld3.parse(out);
  assert.equal(d.Comments, 'New <notes> & thoughts\nline 2');
  assert.equal(d.Title, 'Renamed');
  assert.equal(d.Dream, 'I was in a library & the water was rising.\nBooks floated past me.');
  assert.match(out, /<Mood>calm<\/Mood>/);
  assert.match(out, /<Item>Water<\/Item>/);
  assert.match(out, /New &lt;notes&gt; &amp; thoughts/);
});

test('update appends missing fields and keeps CRLF line endings', () => {
  const text = '<Dream>\r\n  <Title>Short</Title>\r\n  <Dream>text</Dream>\r\n</Dream>\r\n';
  const out = ld3.update(text, { Comments: 'a\nb', Date: '2026-01-02' });
  assert.ok(!/[^\r]\n/.test(out), 'all newlines should be CRLF');
  const d = ld3.parse(out);
  assert.equal(d.Comments, 'a\nb');
  assert.equal(d.Date, '2026-01-02');
  assert.equal(d.Dream, 'text');
  assert.equal(d.Title, 'Short');
});

test('create produces a file in the documented layout that round-trips', () => {
  const fields = { Date: '2026-10-31', Time: '07:00', Title: 'Fresh', Dream: 'A <strange> dream', Comments: '', Lucidity: '1', Clarity: '3' };
  const out = ld3.create(fields);
  assert.match(out, /^<Dream>\n {2}<Date>2026-10-31<\/Date>/);
  assert.match(out, /<SubCategories>\n {2}<\/SubCategories>/);
  const d = ld3.parse(out);
  for (const [k, v] of Object.entries(fields)) assert.equal(d[k], v);
});

test('UTF-16 and BOM files are decoded and written back in the same encoding', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ld3-'));
  const file = path.join(dir, 'utf16.ld3');
  fs.writeFileSync(file, ld3.encodeText(SAMPLE.replace(/\n/g, '\r\n'), { encoding: 'utf16le', bom: true }));
  const fields = await dreams.readDreamFile(file);
  assert.equal(fields.Title, 'The flooded library');
  await dreams.saveDream({ path: file, fields: { ...fields, Comments: 'héllo ✨' } });
  const buf = fs.readFileSync(file);
  assert.equal(buf[0], 0xff);
  assert.equal(buf[1], 0xfe);
  assert.equal((await dreams.readDreamFile(file)).Comments, 'héllo ✨');
});

test('scan finds dreams recursively and saveDream creates unique files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ld3-'));
  fs.mkdirSync(path.join(dir, '2026', 'Oct'), { recursive: true });
  fs.writeFileSync(path.join(dir, '2026', 'Oct', 'a.ld3'), SAMPLE);
  fs.writeFileSync(path.join(dir, 'broken.ld3'), 'not a dream');
  const p1 = await dreams.saveDream({ path: null, fields: { Date: '2026-10-31', Title: 'Same: name?', Dream: 'x' } }, dir);
  const p2 = await dreams.saveDream({ path: null, fields: { Date: '2026-10-31', Title: 'Same: name?', Dream: 'y' } }, dir);
  assert.notEqual(p1, p2);
  assert.equal(path.basename(p1), '2026-10-31 Same name.ld3');
  const list = await dreams.scan([dir, dir]);
  assert.equal(list.length, 4);
  assert.equal(list.filter((d) => d.unsupported).length, 1);
  assert.equal(list.find((d) => d.unsupported).kind, 'unreadable');
  assert.ok(list.some((d) => d.title === 'The flooded library' && d.relDir === path.join('2026', 'Oct')));
});

test('detail list parsing: strict JSON and numbered fallback', () => {
  assert.deepEqual(U.parseDetailsJson('```json\n{"details":[{"title":"Red door","description":"A door"}]}\n```'), [
    { title: 'Red door', description: 'A door' },
  ]);
  assert.deepEqual(U.parseDetailsJson('[{"title":"A","description":"b"}]'), [{ title: 'A', description: 'b' }]);
  assert.equal(U.parseDetailsJson('nonsense'), null);
  assert.deepEqual(U.parseNumberedList('Here:\n1. **Red door** — a big door\n2) Cat: black cat\n- Rain - heavy rain'), [
    { title: 'Red door', description: 'a big door' },
    { title: 'Cat', description: 'black cat' },
    { title: 'Rain', description: 'heavy rain' },
  ]);
});

test('filterNewDetails drops duplicates of covered details', () => {
  const out = U.filterNewDetails(
    [{ title: 'The red door' }, { title: 'Grandma' }, { title: 'grandma' }, { title: 'Red Door' }],
    [{ title: 'Red door' }],
  );
  assert.deepEqual(out.map((d) => d.title), ['Grandma']);
});

test('comments compose/split keeps notes and interpretation separate', () => {
  const c = U.composeComments('my notes', '## Overview\nIt means things');
  assert.deepEqual(U.splitComments(c), { notes: 'my notes', interpretation: '## Overview\nIt means things' });
  assert.deepEqual(U.splitComments('just notes'), { notes: 'just notes', interpretation: '' });
});

test('markdown renderer escapes HTML', () => {
  const html = U.markdown('## Hi\n- **bold** <script>x</script>\n\ntext *em*');
  assert.match(html, /<h3>Hi<\/h3>/);
  assert.match(html, /<strong>bold<\/strong> &lt;script&gt;/);
  assert.match(html, /<em>em<\/em>/);
});

test('stripThinking removes reasoning blocks', () => {
  assert.equal(U.stripThinking('<think>hmm</think>\nHello'), 'Hello');
  assert.equal(U.stripThinking('Hello <think>partial'), 'Hello ');
});

test('parseDate handles ISO and day-first dates', () => {
  assert.deepEqual(U.parseDate('2026-10-10'), { y: 2026, m: 10, d: 10 });
  assert.deepEqual(U.parseDate('31/10/2026'), { y: 2026, m: 10, d: 31 });
  assert.equal(U.parseDate(''), null);
});

test('non-dream .ld3 documents (Lightened Dream checks, readings, …) are detected and flagged', async () => {
  assert.equal(ld3.rootElement('<?xml version="1.0"?>\n<!-- x -->\n<Check>\n  <Title>Time</Title>\n</Check>'), 'Check');
  assert.equal(ld3.isDream(SAMPLE), true);
  assert.equal(ld3.isDream('<LightenedDream><Ignore>a</Ignore></LightenedDream>'), false);
  assert.throws(() => ld3.parse('<Reading><Title>Relax</Title></Reading>'), /Not a dream/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ld3-'));
  fs.writeFileSync(path.join(dir, 'dream.ld3'), SAMPLE);
  fs.writeFileSync(path.join(dir, 'IgnoreList.ld3'), '<LightenedDream>\n  <Ignore>a</Ignore>\n</LightenedDream>\n');
  fs.writeFileSync(path.join(dir, 'Time.ld3'), '<Check>\n  <Title>Time</Title>\n</Check>\n');
  const list = await dreams.scan([dir]);
  const bad = list.filter((d) => d.unsupported).map((d) => d.kind).sort();
  assert.deepEqual(bad, ['Check', 'LightenedDream']);
  assert.equal(list.filter((d) => !d.unsupported).length, 1);
});
