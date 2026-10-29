// Static checks for the platform's module rules, on every file under tgcloud/:
// - syntax (node --check), imports only from `sdk*` or relative `.js` paths inside tgcloud/;
// - no Node or web globals the bare V8 isolate doesn't have (Buffer, TextEncoder, timers, URL, Intl…);
// - no foreign keys; handlers/ and endpoints/ flat; handler names are Bot API update types.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
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

/** Code without comments (string contents like "https://" are kept). */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

const files = walk(TG);
for (const dir of ['handlers', 'endpoints']) {
  const d = path.join(TG, dir);
  if (!fs.existsSync(d)) continue;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.isDirectory()) fail(path.join(d, e.name), `${dir}/ must be flat`);
    if (dir === 'handlers' && e.isFile() && !UPDATE_TYPES.has(e.name.replace(/\.js$/, ''))) fail(path.join(d, e.name), 'not a Bot API update type');
  }
}

for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (e) {
    fail(file, `syntax: ${String(e.stderr).split('\n').slice(0, 5).join(' ')}`);
  }
  const src = fs.readFileSync(file, 'utf8');
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
  if (/handlers\//.test(path.relative(TG, file)) && !/export default/.test(code)) fail(file, 'handler without export default');
}

// ---------- i18n: same keys and placeholders in every language, and every key the code uses exists ----------
const dicts = {};
for (const lang of ['fa', 'en', 'ru']) dicts[lang] = (await import(path.join(TG, 'lib/i18n', `${lang}.js`))).default;
const i18nFile = path.join(TG, 'lib/i18n');
const keysOf = (d) => Object.keys(d).sort();
const holes = (v) => (typeof v === 'string' ? [...v.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',') : `list:${v.length}`);
for (const lang of ['en', 'ru']) {
  const a = new Set(keysOf(dicts.fa));
  const b = new Set(keysOf(dicts[lang]));
  for (const k of a) if (!b.has(k)) fail(i18nFile, `${lang}.js is missing "${k}"`);
  for (const k of b) if (!a.has(k)) fail(i18nFile, `${lang}.js has extra "${k}"`);
  for (const k of a) if (b.has(k) && holes(dicts.fa[k]) !== holes(dicts[lang][k])) fail(i18nFile, `"${k}": placeholders differ in ${lang} (${holes(dicts.fa[k])} vs ${holes(dicts[lang][k])})`);
}
const DYNAMIC = {
  kind: ['text', 'photo', 'video', 'animation', 'voice', 'audio', 'document', 'sticker', 'video_note'],
  cat: ['q', 'c', 'o', 'f', 'h', 'g', 'd'],
  'a.spam': ['restricted', 'flood', 'hour', 'target', 'duplicate'],
  'bc.s_': ['draft', 'running', 'done', 'stopped', 'cancelled'],
  'adm.rp_status_': ['open', 'banned', 'restricted', 'dismissed'],
  cmd: ['start', 'whisper', 'anon', 'link', 'inbox', 'profile', 'lang', 'help', 'privacy'],
};
const used = new Set();
for (const [prefix, names] of Object.entries(DYNAMIC)) for (const n of names) used.add(prefix.endsWith('_') ? `${prefix}${n}` : `${prefix}.${n}`);
for (const code of ['no_recipient', 'no_text', 'too_many', 'bad_expiry', 'self', 'bot', 'blocked']) for (const part of ['title', 'desc']) used.add(`w.err.${code}.${part}`);
for (const file of files.filter((f) => !f.includes(`${path.sep}i18n${path.sep}`))) {
  const code = stripComments(fs.readFileSync(file, 'utf8'));
  for (const m of code.matchAll(/'((?:w|wh|wd|wc|wst|bl|a|in|q|cd|fs|fw|as|dd|pf|adm|bc|main|ws|help|privacy|join|lang|btn|common|e|time|cat|kind|cmd|bot)\.[a-z_][\w.]*)'/g)) used.add(m[1]);
}
for (const k of used) if (!(k in dicts.fa)) fail(i18nFile, `key "${k}" is used but missing from the dictionaries`);
if (dicts.fa.qotd.length < 30) fail(i18nFile, 'the question-of-the-day pool is too small');

const count = files.length;
if (failures) {
  console.log(`\nstatic checks: ${failures} problem(s) in ${count} modules`);
  process.exit(1);
}
console.log(`✔ static checks: ${count} modules — syntax, imports, isolate globals, layout; i18n: ${keysOf(dicts.fa).length} keys × 3 languages, ${used.size} used`);
