import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { LOCALES, t, tp } from '../../tgcloud/lib/i18n/index.js';
import { cb, parse, btn } from '../../tgcloud/lib/codec.js';
import { classifyMember, channelProblem } from '../../tgcloud/lib/gate.js';
import { classify } from '../../tgcloud/lib/tg.js';
import { validate } from '../../tgcloud/lib/secrets.js';
import { mergeLimits } from '../../tgcloud/lib/db/system.js';
import { esc, ulid, jobCode, isJobCode, fileRef, tehranDay, formatBytes, faDigits, asciiDigits } from '../../tgcloud/lib/util.js';
import { parseCommand } from '../../tgcloud/lib/router.js';
import * as ui from '../../tgcloud/lib/ui.js';
import * as cards from '../../tgcloud/lib/cards.js';
import { detect } from '../../tgcloud/lib/detect/index.js';
import { DEFAULT_LIMITS } from '../../tgcloud/lib/config.js';
import { SAMPLES } from '../helpers/fixtures.mjs';

const ROOT = path.resolve(import.meta.dirname, '../../tgcloud');
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []));

test('i18n: fa and en have exactly the same keys and the same {vars}', () => {
  const fa = LOCALES.fa;
  const en = LOCALES.en;
  assert.deepEqual(Object.keys(fa).sort(), Object.keys(en).sort());
  const vars = (s) => [...s.matchAll(/\{(_?\w+)\}/g)].map((m) => m[1]).sort();
  for (const k of Object.keys(fa)) assert.deepEqual(vars(fa[k]), vars(en[k]), k);
});

test('i18n: every key the code uses exists (static scan, including dynamic families)', () => {
  const src = walk(path.join(ROOT, 'lib')).filter((f) => !f.includes('/i18n/')).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  const used = new Set([...src.matchAll(/\b(?:t|tp|L|P)\((?:ctx\.lang|ctx|'fa'|lang), *'([a-z_.A-Z0-9]+)'/g)].map((m) => m[1]));
  for (const m of src.matchAll(/'((?:panel|bc|sec|rn|card|err|status|op|hint|rate|intake|join|gate|alert)\.[a-z_A-Z0-9]+)'/g)) used.add(m[1]);
  const dynamic = {
    'card.': ['image', 'pdf', 'document', 'text', 'archive', 'audio', 'video', 'font', 'data', 'executable', 'unknown'],
    'status.': ['QUEUED', 'DOWNLOADING', 'PROCESSING', 'UPLOADING', 'COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED'],
    'err.': ['TOO_BIG', 'RATE_LIMITED', 'USER_BLOCKED', 'FILE_GONE', 'DOWNLOAD_FAILED', 'UPLOAD_FAILED', 'OUTPUT_INVALID', 'INTERNAL'],
    'op.': ['fix', 'rename'],
    'rn.ask_': ['name', 'prefix', 'suffix'],
    'rn.err_': ['dangerous', 'empty', 'same', 'ext_not_allowed', 'too_long'],
    'lang.': ['fa', 'en'],
    'bots.': ['media', 'music', 'channel'],
    'panel.ch_': ['ok', 'bad', 'not_found', 'failed', 'not_channel'],
  };
  for (const [p, list] of Object.entries(dynamic)) for (const s of list) used.add(p + s);
  const missing = [...used].filter((k) => !(k in LOCALES.fa));
  assert.deepEqual(missing, []);
});

test('i18n: every text is valid Telegram HTML once filled (balanced tags, nothing unescaped)', () => {
  const ALLOWED = ['b', 'i', 'u', 's', 'code', 'pre', 'a', 'blockquote', 'tg-spoiler'];
  for (const [lang, loc] of Object.entries(LOCALES)) {
    for (const key of Object.keys(loc)) {
      const filled = t(lang, key, Object.fromEntries([...loc[key].matchAll(/\{(_?\w+)\}/g)].map((m) => [m[1], '<x&y>'])));
      const stack = [];
      for (const m of filled.matchAll(/<(\/?)([a-z-]+)[^>]*>/g)) {
        assert.ok(ALLOWED.includes(m[2]), `${lang}:${key} uses <${m[2]}>`);
        if (!m[1]) stack.push(m[2]); else assert.equal(stack.pop(), m[2], `${lang}:${key}`);
      }
      assert.equal(stack.length, 0, `${lang}:${key} unbalanced`);
      const bare = filled.replace(/<\/?[a-z-]+[^>]*>/g, '');
      assert.ok(!/<|&(?!(lt|gt|amp|quot|#\d+);)/.test(bare), `${lang}:${key} has an unescaped < or &`);
    }
  }
  assert.equal(tp('fa', 'card.name', { name: '<b>' }), '📄 نام: <code><b></code>', 'tp does not escape (buttons/toasts)');
});

test('invisible characters (ZWNJ, bidi controls, …) are written as escapes, never literally', () => {
  for (const f of walk(ROOT).filter((x) => !x.includes('/vendor/'))) assert.ok(!/\p{Cf}/u.test(fs.readFileSync(f, 'utf8')), path.relative(ROOT, f));
});

test('codec: callback_data ≤ 64 bytes, parse round trip', () => {
  assert.equal(cb('rn', 'ABCDEF', 'n'), 'rn:ABCDEF:n');
  assert.deepEqual(parse('p:rt:01JC0ABCDEFGHJKMNPQRSTVWXY'), { code: 'p', args: ['rt', '01JC0ABCDEFGHJKMNPQRSTVWXY'] });
  assert.throws(() => cb('x'.repeat(65)));
  assert.throws(() => btn('a', 'é'.repeat(33)), /too long/);
});

test('every screen\'s buttons fit in 64 bytes with the longest arguments', () => {
  const ctx = { lang: 'fa', digits: true, actor: 'owner', limits: DEFAULT_LIMITS, from: { first_name: 'x' } };
  const file = { ref: 'ZZZZZZ', name: 'n'.repeat(64) + '.jpeg', size: 20 * 1024 * 1024, kind: 'photo', meta: { image: { w: 10, h: 10 } } };
  const d = detect(SAMPLES.jpeg[0], 'x.png');
  const items = Array.from({ length: 1000 }, (_, i) => [999 + i, 'ف'.repeat(80), 123456789]);
  const pdfFile = { ...file, name: 'x.pdf', meta: { pdf: { pages: 999 } } };
  const pdfD = detect(SAMPLES.pdf[0], 'x.pdf');
  const arcFile = { ...file, name: 'x.zip', meta: { archive: { files: 1000, total: 1e9, items } } };
  const batch = { id: 'ZZZZZZ' };
  const rows = [{ ref: 'ZZZZZZ', name: 'ن'.repeat(64), type: 'jpeg!zip#enc', size: 1 }];
  const screens = [ui.home(ctx, { greet: true }), ui.tools(ctx), ui.pdfTools(ctx), ui.zipTools(ctx), ui.help(ctx), ui.privacy(ctx), ui.deleteConfirm(ctx), ui.bots(ctx), ui.settings(ctx), ui.language(ctx), ui.language(ctx, 'h'),
    ui.join(ctx, [{ username: 'a'.repeat(32), title: 'x'.repeat(200) }]), cards.card(ctx, file, d), cards.card(ctx, pdfFile, pdfD), cards.card(ctx, pdfFile, pdfD, { page: 2 }), cards.card(ctx, arcFile, detect(SAMPLES.zip[0], 'x.zip')),
    cards.renameMenu(ctx, file, d), cards.extMenu(ctx, file, d), cards.renamePrompt(ctx, file, 'name'),
    cards.extractChoice(ctx, arcFile), cards.entryList(ctx, arcFile, 124), cards.pdfPrompt(ctx, pdfFile, 'x'), cards.rotateMenu(ctx, pdfFile), cards.rotateMenu(ctx, pdfFile, '1-999'), cards.splitMenu(ctx, pdfFile),
    cards.batchStatus(ctx, batch, 20, 5e7), cards.batchMenu(ctx, batch, rows, (f) => detect(SAMPLES.jpeg[0], f.name)), cards.batchList(ctx, batch, rows), cards.batchRenameMenu(ctx, batch), cards.batchPrompt(ctx, batch, 'number'),
    ui.history(ctx, [], 0, 0), ui.statusScreen(ctx, null)];
  for (const s of screens) for (const b of (s.reply_markup ? s.reply_markup.inline_keyboard.flat() : [])) {
    if (b.callback_data) assert.ok(new TextEncoder().encode(b.callback_data).length <= 64, b.callback_data);
  }
  assert.ok(cards.card(ctx, file, d).text.length < 4096);
  assert.ok(cards.entryList(ctx, arcFile, 0).reply_markup.inline_keyboard.length <= 12, 'a list page stays short');
});

test('gate: member classification ("member not found" = not a member; errors = unknown)', () => {
  assert.equal(classifyMember({ status: 'member' }).state, 'member');
  assert.equal(classifyMember({ status: 'creator' }).state, 'member');
  assert.equal(classifyMember({ status: 'restricted', is_member: true }).state, 'member');
  assert.equal(classifyMember({ status: 'restricted', is_member: false }).state, 'not_member');
  assert.equal(classifyMember({ status: 'left' }).state, 'not_member');
  assert.equal(classifyMember({ status: 'kicked' }).state, 'not_member');
  assert.equal(classifyMember(null, { code: 400, description: 'Bad Request: member not found' }).state, 'not_member');
  assert.equal(classifyMember(null, { code: 400, description: 'Bad Request: member list is inaccessible' }).state, 'unknown');
  assert.equal(classifyMember(null, { code: 429, description: 'Too Many Requests' }).state, 'unknown');
  assert.equal(channelProblem('no_access'), 'not_admin');
  assert.equal(channelProblem('chat_not_found'), 'error');
  assert.equal(channelProblem('rate'), null);
  assert.equal(classify({ code: 400, description: 'Bad Request: file is too big' }).kind, 'too_big');
  assert.equal(classify({ code: 403, description: 'Forbidden: bot was blocked by the user' }).kind, 'blocked');
  assert.equal(classify(new Error('fetch: request failed')).kind, 'network');
});

test('secrets: names, values, https worker URL', () => {
  assert.equal(validate('GEMINI_API_KEY', 'abc'), null);
  assert.equal(validate('NOPE', 'abc'), 'sec.err_name');
  assert.equal(validate('HUB_KEY', 'a b'), 'sec.err_value');
  assert.equal(validate('HUB_KEY', ''), 'sec.err_value');
  assert.equal(validate('WORKER_URL', 'http://x.example'), 'sec.err_url');
  assert.equal(validate('WORKER_URL', 'https://worker.example.com/v1'), null);
});

test('limits: spec §9 defaults, overridable key by key with numbers only', () => {
  assert.equal(mergeLimits(null).MAX_INPUT_MB, 20);
  const m = mergeLimits({ RATE_JOBS_PER_HOUR: 50, MAX_INPUT_MB: 'x', NOT_A_LIMIT: 1, BATCH_MAX_FILES: -1 });
  assert.equal(m.RATE_JOBS_PER_HOUR, 50);
  assert.equal(m.MAX_INPUT_MB, 20);
  assert.equal(m.BATCH_MAX_FILES, 20);
  assert.ok(!('NOT_A_LIMIT' in m));
});

test('util: ids, codes, digits, sizes, Tehran days', () => {
  assert.match(ulid(Date.UTC(2026, 10, 7)), /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.ok(ulid(1000) < ulid(2000), 'sortable by time');
  assert.ok(isJobCode(jobCode()));
  assert.ok(!isJobCode('WC-ILOU12'), 'no I L O U in Crockford');
  assert.match(fileRef(), /^[0-9A-HJKMNP-TV-Z]{6}$/);
  assert.equal(esc('<a & b>'), '&lt;a &amp; b&gt;');
  assert.equal(formatBytes(2.4 * 1024 * 1024), '2.4 MB');
  assert.equal(formatBytes(830 * 1024), '830 KB');
  assert.equal(faDigits('2.4 MB'), '۲.۴ MB');
  assert.equal(asciiDigits('۱۲۳٤'), '1234');
  assert.equal(tehranDay(Date.UTC(2026, 10, 6, 20, 29) / 1000), '2026-11-06');
  assert.equal(tehranDay(Date.UTC(2026, 10, 6, 20, 31) / 1000), '2026-11-07');
});

test('Jalali dates', () => {
  assert.deepEqual(ui.toJalali(2026, 11, 7), [1405, 8, 16]);
  assert.deepEqual(ui.toJalali(2026, 3, 21), [1405, 1, 1]);
  assert.deepEqual(ui.toJalali(2025, 3, 20), [1403, 12, 30]);
});

test('commands: /cmd@bot, other bots ignored, args split', () => {
  assert.deepEqual(parseCommand('/start'), { name: 'start', args: [] });
  assert.deepEqual(parseCommand('/status@Wanger_Converterbot WC-ABC123'), { name: 'status', args: ['WC-ABC123'] });
  assert.equal(parseCommand('/start@OtherBot'), null);
  assert.equal(parseCommand('hello /start'), null);
});

test('sizes: Persian digits use the Persian decimal separator', () => {
  assert.equal(ui.size({ digits: true }, 2.4 * 1024 * 1024), '۲٫۴ MB');
  assert.equal(ui.size({ digits: false }, 2.4 * 1024 * 1024), '2.4 MB');
});
