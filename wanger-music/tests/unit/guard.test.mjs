// Guard and platform-rule checks over every deployed module:
// - pure modules never import `sdk` (directly or through another module);
// - only repositories, the Telegram client, schema.js and endpoints import `sdk`;
// - only core/context.js imports repositories; handlers stay thin;
// - no globals the isolate lacks, no literal invisible characters, relative imports end in .js;
// - every i18n key used in code exists; the module count stays within the platform budget.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DICTS } from '../../tgcloud/lib/i18n/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tgcloud');
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js')) files.push(path.relative(ROOT, p));
  }
})(ROOT);
const src = Object.fromEntries(files.map((f) => [f, fs.readFileSync(path.join(ROOT, f), 'utf8')]));
const importsOf = (f) => [...src[f].matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
/** Invisible / special characters that must appear only as \\u escapes in deployed code. */
const range = (a, b) => `${String.fromCharCode(a)}-${String.fromCharCode(b)}`;
const INVISIBLE = new RegExp(`[${range(0x200b, 0x200f)}${range(0x202a, 0x202e)}${range(0x2066, 0x2069)}${String.fromCharCode(0xfeff, 0xad)}${range(0xfff0, 0xffff)}]`);
const resolveRel = (from, spec) => path.normalize(path.join(path.dirname(from), spec));

const PURE = [
  'lib/config/static.js', 'lib/core/util.js', 'lib/core/logger.js', 'lib/core/version.js',
  'lib/telegram/html.js', 'lib/telegram/errors.js', 'lib/telegram/limiter.js', 'lib/telegram/chatref.js',
  'lib/bot/codec.js', 'lib/bot/keyboards.js', 'lib/i18n/index.js', 'lib/i18n/fa.js', 'lib/i18n/en.js',
  'lib/permissions/policy.js', 'lib/forcejoin/gate.js',
  'lib/music/normalize.js', 'lib/music/classify.js', 'lib/music/duplicates.js', 'lib/music/artwork.js',
  'lib/search/terms.js', 'lib/publishing/captions.js', 'lib/publishing/rules.js',
];
const SDK_ALLOWED = (f) => f === 'schema.js' || f.startsWith('lib/repositories/') || f === 'lib/telegram/client.js' || f.startsWith('endpoints/');

test('module budget (the platform refused a 104-module deploy)', () => {
  assert.ok(files.length <= 85, `${files.length} modules`);
});

test('pure modules import nothing from sdk, even indirectly', () => {
  for (const f of PURE) {
    assert.ok(src[f], `${f} exists`);
    const seen = new Set();
    const stack = [f];
    while (stack.length) {
      const cur = stack.pop();
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const spec of importsOf(cur)) {
        assert.ok(!spec.startsWith('sdk'), `${f} reaches sdk through ${cur}`);
        stack.push(resolveRel(cur, spec));
      }
    }
  }
});

test('only repositories, the Telegram client, schema.js and endpoints import sdk', () => {
  for (const f of files) {
    const usesSdk = importsOf(f).some((s) => s === 'sdk' || s.startsWith('sdk/'));
    if (usesSdk) assert.ok(SDK_ALLOWED(f), `${f} imports sdk`);
  }
});

test('layering: repositories only from core/context.js; thin handlers', () => {
  for (const f of files) {
    for (const spec of importsOf(f).filter((s) => s.startsWith('.'))) {
      const target = resolveRel(f, spec);
      if (target.startsWith('lib/repositories/')) assert.equal(f, 'lib/core/context.js', `${f} imports ${target}`);
    }
  }
  for (const f of files.filter((x) => x.startsWith('handlers/'))) {
    assert.deepEqual(importsOf(f).map((s) => resolveRel(f, s)).sort(), ['lib/bot/router.js', 'lib/core/boundary.js'], f);
    assert.ok(src[f].split('\n').length < 15, `${f} is thin`);
  }
});

test('layout: flat handlers named after update types; valid endpoint names', () => {
  const types = new Set(['message', 'edited_message', 'channel_post', 'edited_channel_post', 'inline_query', 'chosen_inline_result', 'callback_query', 'my_chat_member', 'chat_member', 'chat_join_request']);
  for (const f of files.filter((x) => x.startsWith('handlers/'))) {
    assert.equal(f.split('/').length, 2, `${f} is one level deep`);
    assert.ok(types.has(path.basename(f, '.js')), `${f} is an update type`);
  }
  assert.deepEqual(files.filter((x) => x.startsWith('handlers/')).sort(), ['handlers/callback_query.js', 'handlers/channel_post.js', 'handlers/chosen_inline_result.js', 'handlers/inline_query.js', 'handlers/message.js', 'handlers/my_chat_member.js'], 'Phase 1–4 handlers only');
  for (const f of files.filter((x) => x.startsWith('endpoints/'))) assert.match(path.basename(f, '.js'), /^[A-Za-z_][A-Za-z0-9_]*$/);
});

test('platform rules: imports, globals, invisible characters', () => {
  const FORBIDDEN = [/\bsetTimeout\b/, /\bsetInterval\b/, /\bsetImmediate\b/, /\bqueueMicrotask\b/, /\bnew URL\b/, /\bURLSearchParams\b/, /\bBuffer\b/, /\bprocess\./, /\brequire\(/, /\bstructuredClone\b/, /\bperformance\./, /\bimport\(/, /\.references\(/, /\bforeignKey\(/];
  for (const f of files) {
    for (const spec of importsOf(f)) {
      if (spec.startsWith('sdk')) assert.ok(['sdk', 'sdk/db', 'sdk/api', 'sdk/fetch'].includes(spec), `${f}: ${spec}`);
      else {
        assert.ok(spec.startsWith('./') || spec.startsWith('../'), `${f}: ${spec} must be relative`);
        assert.ok(spec.endsWith('.js'), `${f}: ${spec} must end in .js`);
        const target = resolveRel(f, spec);
        assert.ok(!target.startsWith('..') && src[target] !== undefined, `${f}: ${spec} must resolve inside tgcloud/`);
      }
    }
    const code = src[f].replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');
    for (const re of FORBIDDEN) assert.equal(re.test(code), false, `${f} uses ${re}`);
    assert.equal(INVISIBLE.test(src[f]), false, `${f} has a literal invisible character (write it as an escape)`);
  }
});

test('every i18n key used in code exists in both languages', () => {
  const used = new Set();
  for (const f of files) for (const m of src[f].matchAll(/\bt[p]?\((?:app\.)?lang[^,]*,\s*'([a-z_.]+)'/g)) used.add(m[1]);
  for (const f of files) for (const m of src[f].matchAll(/UserError\('([a-z_.]+)'/g)) used.add(m[1]);
  assert.ok(used.size > 50, `found ${used.size} keys`);
  for (const k of used) {
    assert.ok(k in DICTS.fa, `fa: ${k}`);
    assert.ok(k in DICTS.en, `en: ${k}`);
  }
});

test('SQL lives only in repositories (and the schema)', () => {
  for (const f of files) {
    if (f.startsWith('lib/repositories/') || f === 'schema.js') continue;
    assert.equal(/\bsql`|db\.(run|all|get|values)\(/.test(src[f]), false, `${f} contains SQL`);
  }
});
