// Static checks for the platform's rules, on every module under tgcloud/:
// - syntax, and still valid with all line breaks removed (a paste into BotFather can lose them,
//   so only /* */ comments and explicit semicolons);
// - imports only from `sdk*` or relative `.js` paths that stay inside tgcloud/;
// - no Node or web globals the bare V8 isolate lacks (Buffer, TextEncoder, timers, URL, Intl…);
// - no foreign keys; handlers/ and endpoints/ flat; handler names are Bot API update types;
// - no literal invisible characters (write ‌) — except emoji variation selectors in locales;
// - SQL only through the sql`…` tag; env.js holds no token-looking value; module count under the cap.
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
  /\batob\s*\(/, /\bbtoa\s*\(/, /\.normalize\s*\(\s*['"]/, /\\p\{/, /\.references\s*\(/, /\bforeignKey\s*\(/, /\bimport\s*\(/,
];
// The platform refused a deploy of 104 modules (88 and 94 deployed, measured with Aegis).
const MODULE_CAP = 90;

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

const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '');

const files = walk(TG);
if (files.length > MODULE_CAP) fail(TG, `${files.length} modules: keep at most ${MODULE_CAP} (the platform refuses too many)`);
for (const dir of ['handlers', 'endpoints']) {
  const d = path.join(TG, dir);
  if (!fs.existsSync(d)) continue;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.isDirectory()) fail(path.join(d, e.name), `${dir}/ must be flat`);
    if (dir === 'handlers' && e.isFile() && !UPDATE_TYPES.has(e.name.replace(/\.js$/, ''))) fail(path.join(d, e.name), 'not a Bot API update type');
  }
}
for (const e of fs.readdirSync(TG, { withFileTypes: true })) {
  if (e.isFile() && e.name.endsWith('.js') && e.name !== 'schema.js') fail(path.join(TG, e.name), 'not deployed: only schema.js, lib/, handlers/, endpoints/');
}

for (const file of files) {
  const rel = path.relative(TG, file);
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (e) {
    fail(file, `syntax: ${String(e.stderr).split('\n').slice(0, 5).join(' ')}`);
  }
  const src = fs.readFileSync(file, 'utf8');
  const flat = path.join(os.tmpdir(), `memebot-flat-${process.pid}-${rel.replace(/[\\/]/g, '_')}.mjs`);
  fs.writeFileSync(flat, src.replace(/\r?\n/g, ' '));
  try {
    execFileSync(process.execPath, ['--check', flat], { stdio: 'pipe' });
  } catch (e) {
    fail(file, `does not parse once its line breaks are removed (a // comment or a missing semicolon?): ${String(e.stderr).split('\n').slice(0, 4).join(' ')}`);
  } finally {
    fs.rmSync(flat, { force: true });
  }
  const code = stripComments(src);
  for (const m of code.matchAll(/\bfrom\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gm)) {
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
  if (rel.startsWith('handlers') && !/export default/.test(code)) fail(file, 'handler without export default');
  const invisible = rel.startsWith(`lib${path.sep}locales`) ? /[­​-‏‪-‮⁠-⁩︎﻿]/ : /[­​-‏‪-‮⁠-⁩︎️﻿]/;
  if (invisible.test(src)) fail(file, 'literal invisible character in source: write it as an escape (\\u200C)');
  for (const m of code.matchAll(/\bdb\.(run|all|get|values)\(\s*([^)]{0,12})/g)) {
    if (!m[2].startsWith('sql`')) fail(file, `db.${m[1]}() without the sql\`…\` tag (values must be parameters)`);
  }
  if (/\bsql\.raw\(/.test(code)) fail(file, 'sql.raw() is not used in this bot (values must be parameters)');
}

const envFile = path.join(TG, 'lib/env.js');
if (!fs.existsSync(envFile)) fail(envFile, 'missing: run `npm run build` (scripts/gen-env.mjs)');
else if (/app\d+:|\d{6,}:[A-Za-z0-9_-]{30,}/.test(fs.readFileSync(envFile, 'utf8'))) fail(envFile, 'contains something that looks like a token');

if (failures) {
  console.log(`\n${failures} static check(s) failed`);
  process.exit(1);
}
console.log(`✔ static checks: ${files.length} modules`);
