// Static guards: i18n parity and coverage, callback_data size, invisible characters, the module
// budget, and the pure pack rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fa from '../tgcloud/lib/i18n/fa.js';
import en from '../tgcloud/lib/i18n/en.js';
import { t, tp, digits } from '../tgcloud/lib/i18n/index.js';
import { encode, decode, parseArgs } from '../tgcloud/lib/core/codec.js';
import { makePackName, isValidPackName, parseEmojiList, parseKeywords, parseNumberList, parseSetRef, cleanTitle } from '../tgcloud/lib/core/packs.js';
import { classify, friendlyKey } from '../tgcloud/lib/core/errors.js';
import { isMemberStatus, outcomeOf, evaluate } from '../tgcloud/lib/core/gate.js';
import { roleOf, can } from '../tgcloud/lib/core/roles.js';
import { postKeyboard } from '../tgcloud/lib/packs/publish.js';
import { FEATURES, SETTING_RANGES, QUOTA_FEATURES } from '../tgcloud/lib/config.js';
import { ROUTES } from '../tgcloud/lib/bot/router.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const code = walk(path.join(ROOT, 'tgcloud')).filter((f) => f.endsWith('.js'));

test('fa and en have exactly the same keys and the same {vars}', () => {
  assert.deepEqual(Object.keys(fa).sort(), Object.keys(en).sort());
  const vars = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  for (const k of Object.keys(fa)) assert.equal(vars(fa[k]), vars(en[k]), `vars differ in ${k}`);
});

test('every text key written in the code exists (literal keys and the dynamic families)', () => {
  const NS = /^(common|lang|gate|menu|help|acct|feature|dm|cmd|media|st|pk|imp|cp|dup|mg|op|err|pub|adm|set|flag|gm|bc|pc|pq|alert)\./;
  const missing = new Set();
  for (const f of code.filter((f) => !f.includes(`${path.sep}i18n${path.sep}`))) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/'([a-z]+(?:\.[a-z0-9_]+)+)'/g)) {
      const k = m[1];
      if (!NS.test(k) || /\.(js|json|png|webp)$/.test(k)) continue;
      if (/^(set|flags|quota|publish|gate|notify|text|maintenance|limits|broadcast|storage|account|boot|hk|telegram)\.[a-z_.]+$/.test(k) && !(k in fa)) continue; // settings keys, not texts
      if (/^(pack|sticker|op|pub|gate|user|event|points)\.[a-z_.]+$/.test(k) && !(k in fa) && !/^(pub|op|gate)\.(err|btn|status|n_|t_)/.test(k)) continue; // stats metrics
      if (!(k in fa)) missing.add(`${k} (${path.relative(ROOT, f)})`);
    }
  }
  const families = [
    ...['pending', 'approved', 'posting', 'published', 'rejected', 'withdrawn', 'removed', 'failed'].map((s) => `pub.status.${s}`),
    ...['draft', 'running', 'paused', 'done', 'cancelled'].map((s) => `bc.status.${s}`),
    ...['all', 'fa', 'en', 'active30', 'pro'].map((s) => `bc.aud.${s}`),
    ...['copy', 'forward'].map((s) => `bc.mode.${s}`),
    ...['ok', 'bot_not_admin', 'not_found', 'error'].map((s) => `gm.health.${s}`),
    ...['ok', 'bot_not_admin', 'not_found', 'error'].map((s) => `alert.reason.${s}`),
    ...['posted', 'waiting', 'failed', 'skipped', 'none'].map((s) => `pq.drain.${s}`),
    ...['start', 'menu', 'studio', 'packs', 'lang', 'help', 'cancel', 'deletemydata', 'admin'].map((s) => `cmd.${s}`),
    ...FEATURES.map((f) => `flag.${f}`),
    ...QUOTA_FEATURES.map((f) => `feature.${f}`),
    ...Object.keys(SETTING_RANGES).map((k) => `set.${k}`),
    ...['text.start.fa', 'text.start.en', 'text.help.fa', 'text.help.en', 'maintenance.text', 'notify.gate', 'notify.errors', 'notify.daily'].map((k) => `set.${k}`),
    'lang.name.fa', 'lang.name.en',
  ];
  for (const k of families) if (!(k in fa)) missing.add(k);
  assert.deepEqual([...missing], []);
});

test('t() escapes vars and uses Persian digits; tp() does not escape', () => {
  assert.equal(t('fa', 'pk.list', { n: 12 }), '🗂 <b>پک‌های من</b> (۱۲)');
  assert.equal(t('en', 'gate.btn_join', { title: '<b>x</b>' }), '➕ &lt;b&gt;x&lt;/b&gt;');
  assert.equal(tp('en', 'gate.btn_join', { title: '<b>x</b>' }), '➕ <b>x</b>');
  assert.equal(digits(2026, 'fa'), '۲۰۲۶');
});

test('every route has valid callback_data within 64 bytes for its largest arguments', () => {
  const BIG = { uint: '999999999999999', int: '-999999999999999', lang: 'fa', word: 'x'.repeat(24), fuid: 'A'.repeat(32) };
  for (const [name, r] of Object.entries(ROUTES)) {
    const [ns, action] = name.split(':');
    const data = encode(ns, action, ...r.args.map((a) => BIG[a]));
    assert.ok(Buffer.byteLength(data) <= 64, `${name} → ${data.length}`);
    const d = decode(data);
    assert.ok(d && parseArgs(d.args, r.args), name);
  }
  assert.equal(decode('x'.repeat(65)), null);
  assert.equal(decode('pk:open:<script>'), null);
  assert.equal(parseArgs(['abc'], ['uint']), null);
});

test('no invisible characters written literally in tgcloud/ (use \\u200c escapes)', () => {
  for (const f of code) {
    const s = fs.readFileSync(f, 'utf8');
    assert.ok(!/[​-‏⁦-⁩﻿]/.test(s), `${path.relative(ROOT, f)} has a literal invisible character`);
  }
});

test('module budget: ≤ 85 deployed modules (a 104-module deploy was refused for another bot)', () => {
  assert.ok(code.length <= 85, `${code.length} modules`);
});

test('pack names follow the Bot API rules', () => {
  const name = makePackName(5557901897, 3, 'Wanger_Motionbot');
  assert.equal(name, 'ws_2jx14jt_3_by_Wanger_Motionbot');
  assert.ok(isValidPackName(name, 'wanger_motionbot'));
  assert.ok(!isValidPackName('ws__x_by_Wanger_Motionbot', 'Wanger_Motionbot'));
  assert.ok(!isValidPackName('1ws_by_Wanger_Motionbot', 'Wanger_Motionbot'));
  assert.ok(!isValidPackName('ws_x_by_otherbot', 'Wanger_Motionbot'));
  assert.ok(makePackName(Number.MAX_SAFE_INTEGER, 99999, 'a'.repeat(32)).length <= 64);
  assert.equal(cleanTitle('  پک   من \n'), 'پک من');
  assert.equal(cleanTitle('x'.repeat(65)), null);
});

test('emoji, keyword, number-list and link parsing', () => {
  assert.deepEqual(parseEmojiList('😀 hi 😀 👍🏽'), ['😀', '👍🏽']);
  assert.equal(parseEmojiList('no emoji'), null);
  assert.equal(parseEmojiList('😀'.repeat(1) + [...'🍎🍐🍊🍋🍌🍉🍇🍓🫐🍈🍒🍑🥭🍍🥥🥝🍅🍆🥑🥦🥬']), null);
  assert.deepEqual(parseKeywords('Cat, گربه  cat'), ['cat', 'گربه']);
  assert.deepEqual(parseKeywords('-'), []);
  assert.equal(parseKeywords(Array.from({ length: 21 }, (_, i) => `w${i}`).join(' ')), null);
  assert.equal(parseKeywords('x'.repeat(65)), null);
  assert.deepEqual(parseNumberList('1-3, 5 تا 6', 10), [0, 1, 2, 4, 5]);
  assert.equal(parseNumberList('0-2', 10), null);
  assert.equal(parseNumberList('8-12', 10), null);
  assert.equal(parseSetRef('https://t.me/addstickers/Animals'), 'Animals');
  assert.equal(parseSetRef('tg://addstickers?set=Animals'), 'Animals');
  assert.equal(parseSetRef('https://evil.example/addstickers/x'), null);
});

test('Bot API error classification for sticker sets and the gate', () => {
  const e = (code, description, parameters) => ({ code, description, parameters });
  assert.equal(classify(e(400, 'Bad Request: sticker set name is already occupied')).kind, 'set_name_taken');
  assert.equal(classify(e(400, 'Bad Request: STICKERS_TOO_MUCH')).kind, 'set_full');
  assert.equal(classify(e(400, 'Bad Request: STICKERSET_INVALID')).kind, 'set_invalid');
  assert.equal(classify(e(429, 'Too Many Requests', { retry_after: 7 })).retryAfter, 7);
  assert.equal(friendlyKey(e(400, 'Bad Request: STICKER_PNG_DIMENSIONS')), 'err.sticker_invalid');
  assert.equal(outcomeOf(null, e(400, 'Bad Request: member not found')).outcome, 'not_member');
  assert.equal(outcomeOf(null, e(400, 'Bad Request: member list is inaccessible')).health, 'bot_not_admin');
  assert.ok(isMemberStatus({ status: 'restricted', is_member: true }));
  assert.ok(!isMemberStatus({ status: 'restricted', is_member: false }));
  assert.ok(!isMemberStatus({ status: 'left' }));
  assert.deepEqual(evaluate([{ channel: 1, outcome: 'member' }, { channel: 2, outcome: 'error' }]), { passed: true, missing: [], broken: [2] });
});

test('roles: owner everything; reviewer only publication review; a user nothing', () => {
  assert.equal(roleOf({ tg_id: 5557901897 }, null), 'owner');
  assert.equal(roleOf({ tg_id: 1 }, { role: 'reviewer' }), 'reviewer');
  assert.equal(roleOf({ tg_id: 1 }, null), 'user');
  assert.ok(can('owner', 'admin'));
  assert.ok(can('reviewer', 'publish.review') && !can('reviewer', 'admin'));
  assert.ok(!can('user', 'panel.open'));
});

test('the channel post shows the credit only as the creator chose', () => {
  const pack = { title: 'Cats', tg_name: 'ws_a_1_by_Wanger_Motionbot' };
  const creator = { first_name: 'Kimi', username: 'kimi' };
  const texts = (p) => postKeyboard({ id: 5, ...p }, pack, creator).inline_keyboard.flat().map((b) => b.text).join('|');
  assert.ok(!/Kimi|@kimi/.test(texts({ show_name: 0, show_username: 0 })));
  assert.ok(/Kimi/.test(texts({ show_name: 1, show_username: 0 })) && !/@kimi/.test(texts({ show_name: 1, show_username: 0 })));
  assert.ok(/@kimi/.test(texts({ show_name: 0, show_username: 1 })));
});
