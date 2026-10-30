// Static checks for the platform's module rules, on every file under tgcloud/:
// - syntax (node --check); imports only from `sdk*` or relative `.js` paths that stay inside tgcloud/;
// - no Node or web globals the bare V8 isolate doesn't have (Buffer, TextEncoder, timers, URL, Intl…);
// - no foreign keys; handlers/ and endpoints/ flat; handler names are Bot API update types;
// - no line comments, and still valid with all line breaks removed (a paste can lose them);
// - every table in schema.js is named aegis_* (the bot's own namespace);
// - tgcloud/lib/env.js holds no token-looking value.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TG = path.join(ROOT, 'tgcloud');
const UPDATE_TYPES = new Set(['message', 'edited_message', 'channel_post', 'edited_channel_post', 'business_connection',
  'business_message', 'edited_business_message', 'deleted_business_messages', 'message_reaction', 'message_reaction_count',
  'inline_query', 'chosen_inline_result', 'callback_query', 'shipping_query', 'pre_checkout_query', 'purchased_paid_media',
  'poll', 'poll_answer', 'my_chat_member', 'chat_member', 'chat_join_request', 'chat_boost', 'removed_chat_boost']);
const FORBIDDEN = [
  /\bBuffer\b/, /\bTextEncoder\b/, /\bTextDecoder\b/, /\brequire\s*\(/, /\bprocess\./, /\bsetTimeout\b/, /\bsetInterval\b/,
  /\bsetImmediate\b/, /\bnew URL\b/, /\bURLSearchParams\b/, /\bIntl\./, /\btoLocale\w*String\b/, /\bstructuredClone\b/,
  /\batob\s*\(/, /\bbtoa\s*\(/, /\bglobalThis\.fetch\b/, /\.references\s*\(/, /\bforeignKey\s*\(/, /\bimport\s*\(/,
];

let failures = 0;
const fail = (file, msg) => {
  failures += 1;
  console.log(`✘ ${path.relative(ROOT, file)}: ${msg}`);
};

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

/**
 * Splits source into code and non-code: returns the code with string/template/regex contents and
 * comments blanked, plus whether a `//` comment occurs outside strings. A light tokenizer: enough
 * for this project's code style.
 */
function scan(src) {
  let out = '';
  let lineComment = false;
  let i = 0;
  let prev = ''; // last significant code character, to tell a regex from a division
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 2;
      out += ' ';
      continue;
    }
    if (c === '/' && n === '/') {
      lineComment = true;
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      i += 1;
      while (i < src.length && src[i] !== q) {
        if (src[i] === '\\') i += 1;
        i += 1;
      }
      i += 1;
      out += `${q}${q}`;
      prev = q;
      continue;
    }
    if (c === '/' && /[(,=:[!&|?{};+\-*%<>~^]|^$/.test(prev)) {
      i += 1;
      let inClass = false;
      while (i < src.length && (src[i] !== '/' || inClass)) {
        if (src[i] === '\\') i += 1;
        else if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        i += 1;
      }
      i += 1;
      while (/[a-z]/.test(src[i] || '')) i += 1;
      out += '/r/';
      prev = '/';
      continue;
    }
    out += c;
    if (!/\s/.test(c)) prev = c;
    i += 1;
  }
  return { code: out, lineComment };
}

const files = walk(TG);
for (const dir of ['handlers', 'endpoints']) {
  const d = path.join(TG, dir);
  if (!fs.existsSync(d)) continue;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.isDirectory()) fail(path.join(d, e.name), `${dir}/ must be flat`);
    if (dir === 'handlers' && e.isFile() && !UPDATE_TYPES.has(e.name.replace(/\.js$/, ''))) fail(path.join(d, e.name), 'not a Bot API update type');
    if (dir === 'endpoints' && e.isFile() && !/^[A-Za-z_][A-Za-z0-9_]*\.js$/.test(e.name)) fail(path.join(d, e.name), 'endpoint names: letters, digits, _');
  }
}

for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (e) {
    fail(file, `syntax: ${String(e.stderr).split('\n').slice(0, 5).join(' ')}`);
  }
  const src = fs.readFileSync(file, 'utf8');
  const { code, lineComment } = scan(src);
  const importCode = src.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of importCode.matchAll(/\bfrom\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gm)) {
    const spec = m[1] || m[2];
    if (/^sdk(\/(db|api|fetch))?$/.test(spec)) continue;
    if (!spec.startsWith('./') && !spec.startsWith('../')) {
      fail(file, `import "${spec}" is not available on the platform`);
      continue;
    }
    if (!spec.endsWith('.js')) fail(file, `relative import "${spec}" must end in .js`);
    const target = path.resolve(path.dirname(file), spec);
    if (!target.startsWith(TG + path.sep)) fail(file, `import "${spec}" leaves tgcloud/`);
    else if (!fs.existsSync(target)) fail(file, `import "${spec}" does not exist`);
  }
  for (const re of FORBIDDEN) if (re.test(code)) fail(file, `uses ${re} (not available in the platform's isolate)`);
  if (lineComment) fail(file, 'line comment (//): use /* */ so a paste without line breaks still works');
  const flat = path.join(os.tmpdir(), `aegis-flat-${process.pid}-${path.basename(file, '.js')}.mjs`);
  fs.writeFileSync(flat, src.replace(/\r?\n/g, ' '));
  try {
    execFileSync(process.execPath, ['--check', flat], { stdio: 'pipe' });
  } catch (e) {
    fail(file, `does not parse once its line breaks are removed: ${String(e.stderr).split('\n').slice(0, 5).join(' ')}`);
  } finally {
    fs.rmSync(flat, { force: true });
  }
  if (/[\u200B-\u200F\u2066-\u2069\u202A-\u202E\uFEFF]/.test(src) && !file.includes(`${path.sep}strings${path.sep}`)) {
    fail(file, 'invisible bidi/zero-width character in source: write it as an escape (\\u200F)');
  }
  const rel = path.relative(TG, file);
  if (rel.startsWith(`handlers${path.sep}`) && !/export default/.test(code)) fail(file, 'handler without export default');
  if (rel.startsWith(`endpoints${path.sep}`) && !/export default/.test(code)) fail(file, 'endpoint without export default');
}

const schema = fs.readFileSync(path.join(TG, 'schema.js'), 'utf8');
for (const m of schema.matchAll(/\btable\(\s*'([^']+)'/g)) if (!m[1].startsWith('aegis_')) fail(path.join(TG, 'schema.js'), `table "${m[1]}" is not in the aegis_ namespace`);
for (const m of schema.matchAll(/\b(?:index|uniqueIndex)\(\s*'([^']+)'/g)) if (!m[1].startsWith('idx_aegis_')) fail(path.join(TG, 'schema.js'), `index "${m[1]}" is not named idx_aegis_*`);
const env = fs.readFileSync(path.join(TG, 'lib/env.js'), 'utf8');
if (/\d{6,}:[A-Za-z0-9_-]{20,}|app\d+[:_-][A-Za-z0-9_-]{16,}/.test(env)) fail(path.join(TG, 'lib/env.js'), 'looks like it contains a token');

if (failures) {
  console.log(`\nstatic checks: ${failures} problem(s) in ${files.length} modules`);
  process.exit(1);
}
console.log(`✔ static checks: ${files.length} modules — syntax, imports, isolate globals, layout, namespace`);
