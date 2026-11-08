// Platform rules for everything under tgcloud/ (docs/LIMITS.md): imports, globals the isolate
// lacks, module size and count, pure modules, no secrets, SQL only in lib/db/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../../tgcloud');
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []));
const FILES = walk(ROOT);
const rel = (f) => path.relative(ROOT, f);
const code = (f) => fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('module budget: ≤ 85 modules (an earlier bot had a 104-module deploy refused)', () => {
  assert.ok(FILES.length <= 85, `${FILES.length} modules`);
});

test('module size: < 1 MiB each (measured platform limit 1 048 576 bytes)', () => {
  for (const f of FILES) assert.ok(fs.statSync(f).size < 1048576, rel(f));
});

test('imports: only sdk, sdk/* and relative .js modules inside tgcloud/', () => {
  for (const f of FILES) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/^\s*(?:import|export)\s[^'"]*from\s+['"]([^'"]+)['"]/gm)) {
      const spec = m[1];
      if (spec === 'sdk' || spec.startsWith('sdk/')) continue;
      assert.ok(spec.startsWith('./') || spec.startsWith('../'), `${rel(f)}: ${spec}`);
      assert.ok(spec.endsWith('.js'), `${rel(f)}: ${spec} must end in .js`);
      assert.ok(path.resolve(path.dirname(f), spec).startsWith(ROOT), `${rel(f)}: ${spec} leaves tgcloud/`);
    }
    assert.ok(!/\bimport\s*\(/.test(code(f)), `${rel(f)}: dynamic import() is not supported`);
  }
});

const OWN = FILES.filter((f) => !rel(f).startsWith('lib/vendor/'));

test('vendored libraries: only fflate and pdf-lib, each < 1 MiB, with their license header', () => {
  const vendor = FILES.filter((f) => rel(f).startsWith('lib/vendor/')).map(rel).sort();
  assert.deepEqual(vendor, ['lib/vendor/fflate.js', 'lib/vendor/pdf-lib.js']);
  for (const v of vendor) assert.match(fs.readFileSync(path.join(ROOT, v), 'utf8').slice(0, 800), /MIT License|Permission is hereby granted/i, v);
});

test('pdf-lib is always used with the Serverless-safe options (docs/LIMITS.md §3)', () => {
  for (const f of OWN) {
    const src = code(f);
    for (const m of src.matchAll(/PDFDocument\.load\(([^)]*)\)/g)) assert.match(m[1], /LOAD/, `${rel(f)}: load without parseSpeed: Infinity`);
    for (const m of src.matchAll(/\.save\(([^)]*)\)/g)) if (/doc|out/.test(m[0])) assert.match(m[1], /SAVE/, `${rel(f)}: save without the options`);
  }
  const pdf = fs.readFileSync(path.join(ROOT, 'lib/pdf.js'), 'utf8');
  assert.match(pdf, /parseSpeed: Infinity/);
  assert.match(pdf, /objectsPerTick: Infinity, useObjectStreams: false/);
  // fflate's callback APIs (zip(), unzip(), …) need Workers/setTimeout: only *Sync and the streaming classes
  for (const f of OWN) assert.ok(!/(?<![\w.])(zip|unzip|gzip|gunzip|deflate|inflate)\(/.test(code(f)), `${rel(f)}: only the synchronous fflate APIs exist here`);
});

test('no globals the isolate lacks (measured in C0)', () => {
  const missing = ['setTimeout', 'setInterval', 'queueMicrotask', 'URL', 'URLSearchParams', 'atob', 'btoa', 'Buffer', 'process', 'performance', 'structuredClone', 'AbortController', 'Blob', 'CompressionStream', 'DecompressionStream', 'require'];
  for (const f of OWN) {
    const src = code(f).replace(/'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, "''");
    for (const g of missing) assert.ok(!new RegExp(`(?<![.\\w])${g}\\b(?!\\s*:)`).test(src), `${rel(f)} uses ${g}`);
    assert.ok(!/WebAssembly\.(compile|instantiate)\(/.test(src), `${rel(f)}: only synchronous WebAssembly works`);
  }
});

test('pure modules never import sdk', () => {
  const PURE = ['lib/config.js', 'lib/util.js', 'lib/codec.js', 'lib/names.js', 'lib/ui.js', 'lib/cards.js', 'lib/log.js', 'lib/errors.js', 'lib/archive.js', 'lib/pdf.js', 'lib/images.js', 'lib/ops.js', 'lib/i18n/index.js', 'lib/i18n/fa.js', 'lib/i18n/en.js', 'lib/detect/index.js', 'lib/detect/types.js', 'lib/detect/zip.js', 'lib/vendor/fflate.js', 'lib/vendor/pdf-lib.js'];
  for (const p of PURE) assert.ok(!/from\s+['"]sdk/.test(fs.readFileSync(path.join(ROOT, p), 'utf8')), p);
});

test('SQL only in lib/db/ (and the schema)', () => {
  for (const f of FILES) {
    const r = rel(f);
    if (r.startsWith('lib/db/') || r === 'schema.js') continue;
    assert.ok(!/\bsql`/.test(fs.readFileSync(f, 'utf8')), `${r} contains SQL`);
    assert.ok(!/from\s+['"]sdk\/db['"]/.test(fs.readFileSync(f, 'utf8')), `${r} imports sdk/db`);
  }
});

test('Bot API only through lib/tg.js', () => {
  for (const f of OWN) {
    if (rel(f) === 'lib/tg.js') continue;
    assert.ok(!/\bapi\.[a-zA-Z]+\(/.test(code(f)), `${rel(f)} calls api directly`);
  }
});

test('no secrets or tokens in code', () => {
  for (const f of OWN) {
    const s = fs.readFileSync(f, 'utf8');
    assert.ok(!/\d{8,10}:[A-Za-z0-9_-]{35}/.test(s), `${rel(f)}: bot token`);
    assert.ok(!/app\d+:[A-Za-z0-9_-]{20,}/.test(s), `${rel(f)}: CLI token`);
    assert.ok(!/AIza[0-9A-Za-z_-]{35}/.test(s), `${rel(f)}: Google API key`);
  }
});

test('handlers are thin and only the three C1 update types exist', () => {
  const handlers = fs.readdirSync(path.join(ROOT, 'handlers')).sort();
  assert.deepEqual(handlers, ['callback_query.js', 'message.js', 'my_chat_member.js']);
  for (const h of handlers) assert.ok(fs.readFileSync(path.join(ROOT, 'handlers', h), 'utf8').split('\n').length < 12, h);
  assert.ok(!fs.existsSync(path.join(ROOT, 'endpoints')) || fs.readdirSync(path.join(ROOT, 'endpoints')).length === 0, 'no leftover spike endpoints');
});
