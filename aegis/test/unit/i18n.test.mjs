// Locales: every key in every language (and this test fails if one is missing), same placeholders,
// valid Telegram HTML, every key the code uses exists, RTL and digits for Persian, command aliases.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LANGS, readLocales, validate } from '../../scripts/locales.mjs';
import { parseHtml } from '../mock-telegram.mjs';
import { aliasCommand, dur, num, pickLang, t } from '../../tgcloud/lib/i18n/index.js';
import { parseCommand } from '../../tgcloud/lib/core/commands.js';
import { LISTS } from '../../tgcloud/lib/engines/lists.js';
import { LOCKS } from '../../tgcloud/lib/engines/locks.js';

const LIST_CODES = LISTS.map((l) => l.code);
const LOCK_CODES = LOCKS.map((l) => l.code);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { dicts, problems } = readLocales();
const RLM = '\u200F';

test('the five languages are fa, en, ru, zh, fr', () => {
  assert.deepEqual([...LANGS].sort(), ['en', 'fa', 'fr', 'ru', 'zh']);
});

test('every key exists in every language, with the same placeholders and no empty strings', () => {
  assert.deepEqual(problems, []);
  assert.deepEqual(validate(dicts), []);
  const n = Object.keys(dicts.en).length;
  for (const lang of LANGS) assert.equal(Object.keys(dicts[lang]).length, n, `${lang} has a different number of keys`);
});

test('the completeness check really fails when a key is missing or a placeholder differs', () => {
  const broken = JSON.parse(JSON.stringify(dicts));
  delete broken.zh['bc.btn_send'];
  broken.ru['stats.started'] = 'Запустили бота';
  const found = validate(broken);
  assert.ok(found.some((p) => p === 'zh: missing key "bc.btn_send"'), found.join('\n'));
  assert.ok(found.some((p) => p.startsWith('ru: "stats.started" has placeholders')), found.join('\n'));
});

test('the generated runtime modules are up to date with aegis/locales', async () => {
  for (const lang of LANGS) {
    const mod = (await import(`../../tgcloud/lib/i18n/strings/${lang}.js`)).default;
    assert.deepEqual(mod, dicts[lang], `${lang}.js is stale: run npm run locales`);
  }
});

test('every string is valid Telegram HTML once filled in', () => {
  for (const lang of LANGS) {
    for (const [key, s] of Object.entries(dicts[lang])) {
      const filled = s.replace(/\{(\w+)\}/g, 'X');
      const r = parseHtml(filled);
      assert.equal(r.error, undefined, `${lang} ${key}: ${r.error}`);
    }
  }
});

test('button labels and command descriptions fit Telegram limits', () => {
  for (const lang of LANGS) {
    for (const [key, s] of Object.entries(dicts[lang])) {
      if (/\.btn_|^common\.(back|cancel|no|yes_remove|refresh)$|^bc\.(aud|mode)_btn_/.test(key)) assert.ok(s.length <= 64, `${lang} ${key} is too long for a button`);
      if (key.startsWith('cmd.')) assert.ok(s.length >= 1 && s.length <= 256, `${lang} ${key}`);
      if (/^(app|cmd|alias|modcmd|rights|levels)\./.test(key)) assert.ok(!/[<>&]/.test(s), `${lang} ${key} must be plain text (no < > &): it is used in buttons and inside HTML`);
    }
  }
});

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'strings') out.push(...walk(p)); } else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

test('every locale key the code names exists (literal keys and the dynamic families)', () => {
  const namespaces = new Set(Object.keys(dicts.en).map((k) => k.split('.')[0]));
  const used = new Set();
  for (const file of walk(path.join(ROOT, 'tgcloud'))) {
    const src = fs.readFileSync(file, 'utf8');
    for (const call of src.matchAll(/\bt\(([^;]{0,240})/g)) {
      for (const m of call[1].matchAll(/['`]([a-z]+)\.([a-z_]+)['`]/g)) if (namespaces.has(m[1])) used.add(`${m[1]}.${m[2]}`);
    }
    for (const m of src.matchAll(/\bkey = [^;]*/g)) for (const k of m[0].matchAll(/'([a-z]+\.[a-z_]+)'/g)) used.add(k[1]);
    /* keys chosen before the t() call: `return 'chat.x'`, `error = 'chat.x'`, `? 'chat.x' : 'chat.y'` */
    for (const m of src.matchAll(/(?:return|=|\?|:)\s*\(?'([a-z]+)\.([a-z_]+)'/g)) if (namespaces.has(m[1]) && dicts.en[`${m[1]}.${m[2]}`] !== undefined) used.add(`${m[1]}.${m[2]}`);
    for (const m of src.matchAll(/(?:return|=)\s*'(chat|group|sys)\.([a-z_]+)'/g)) used.add(`${m[1]}.${m[2]}`);
  }
  const families = {
    'bc.st_': ['draft', 'queued', 'running', 'paused', 'done', 'cancelled'],
    'bc.aud_': ['users', 'groups', 'channels'],
    'bc.mode_': ['copy', 'forward'],
    'bc.ct_': ['text', 'photo', 'video', 'animation', 'document', 'audio', 'voice', 'video_note', 'sticker', 'poll', 'location', 'contact', 'dice'],
    'bc.buttons_err_': ['empty', 'too_many_rows', 'too_many_in_row', 'format', 'text', 'url'],
    'bc.toast_': ['wait', 'locked', 'not_running', 'batch'],
    'cmd.': ['start', 'language', 'help', 'panel', 'cancel'],
    'alias.': ['start', 'language', 'help', 'panel', 'cancel'],
    'alias2.': [],
    'app.': ['title', 'idle', 'sent', 'failed', 'blocked', 'left', 'audience', 'mode', 'status', 'wait', 'hint', 'pause', 'resume', 'cancel', 'cancel_q', 'close', 'paused_source_gone', 'error'],
    'lang.': ['name', 'flag', 'pick', 'current', 'saved'],
    'alias.': ['config', 'status', 'shutdown', 'activate'],
    'cmd.': ['config', 'status', 'shutdown', 'activate'],
    'chat.type_': ['group', 'supergroup', 'channel'],
    'chat.block_': ['no_rights', 'creator', 'not_admin', 'not_via_aegis', 'higher', 'level'],
    'rights.req_': ['delete', 'restrict', 'ban', 'invite', 'pin', 'promote'],
    'rights.': ['can_change_info', 'can_post_messages', 'can_edit_messages', 'can_delete_messages', 'can_invite_users', 'can_restrict_members',
      'can_pin_messages', 'can_manage_video_chats', 'can_promote_members'],
    'levels.': ['none', 'view', 'settings', 'full', 'creator'],
    'pun.icon_': ['warn', 'mute', 'restrict', 'quarantine', 'kick', 'ban', 'blacklist', 'demote'],
    'pun.k_': ['warn', 'mute', 'restrict', 'quarantine', 'kick', 'ban', 'blacklist', 'demote'],
    'pun.s_': ['active', 'expired', 'undone', 'audit', 'done'],
    'pun.src_': ['command', 'panel', 'list', 'step', 'blacklist', 'betrayal', 'telegram'],
    'lists.n_': LIST_CODES,
    'lists.d_': LIST_CODES,
    'lists.add_prompt_': ['word', 'pattern', 'domain', 'chat', 'bot', 'sticker'],
    'lists.fail_': ['bot', 'unknown', 'admin', 'self', 'vip', 'tg', 'full'],
    'lists.h_': ['add', 'edit', 'remove'],
    'lists.remove_lifts_': ['mute', 'restrict', 'ban', 'blacklist', 'quarantine'],
    'logs.c_': ['punish', 'lists', 'admin', 'settings'],
    'logs.s_': ['warn_reset', 'notify'],
    'mod.done_': ['unmute', 'unrestrict', 'unban'],
    'modcmd.': ['warn', 'unwarn', 'warns', 'mute', 'unmute', 'restrict', 'unrestrict', 'kick', 'ban', 'unban'],
    'betray.a_': ['demote', 'alert'],
    'betray.action_': ['demoted', 'unmod', 'alert', 'audit'],
    'betray.short_': ['demoted', 'unmod', 'alert', 'audit'],
    'betray.why_': ['setting', 'creator', 'not_via_aegis', 'unknown', 'failed'],
    'warns.steps_err_': ['empty', 'format', 'action', 'count', 'order', 'duration', 'too_many'],
    'common.dur_': ['d', 'h', 'm', 's'],
    'locks.n_': LOCK_CODES,
    'locks.d_': LOCK_CODES,
    'locks.cat_': ['media', 'text', 'content', 'behavior'],
    'locks.a_': ['none', 'warn', 'mute', 'restrict', 'kick', 'ban'],
    'locks.sens_': ['low', 'medium', 'high'],
    'locks.notice_': ['default', 'custom', 'off'],
    'locks.allow_': ['aln', 'fwd', 'bot', 'gwd'],
    'locks.h_': ['deleted', 'kept', 'audit', 'removed'],
    'locks.l_notice_': ['default', 'off', 'custom'],
    'logs.c_': ['punish', 'lists', 'locks', 'admin', 'settings'],
    'pun.src_': ['lock'],
  };
  for (const fam of ['link', 'masked', 'command', 'badword', 'blocklink', 'emoji', 'long', 'repeat', 'lang', 'forward']) {
    for (const lv of ['low', 'medium', 'high']) used.add(`locks.s_${fam}_${lv}`);
  }
  for (const [prefix, names] of Object.entries(families)) for (const n of names) used.add(`${prefix}${n}`);
  used.delete('alias2.');
  const missing = [...used].filter((k) => dicts.en[k] === undefined);
  assert.deepEqual(missing, []);
  assert.ok(used.size > 300, `only ${used.size} keys found in code`);
});

test('every change a chat\'s panel can show in its change log has a log line in every language', () => {
  const actions = new Set();
  for (const file of walk(path.join(ROOT, 'tgcloud'))) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/audit\.log\([^,]+,\s*[`']([a-z]+)\.([a-z_]+)[`'],\s*\{[^}]*\bchatId\b/g)) actions.add(`log.${m[1]}_${m[2]}`);
    for (const m of src.matchAll(/audit\.log\([^,]+,\s*`admin\.\$\{kind\}`/g)) for (const k of ['promote', 'edit']) actions.add(`log.admin_${k}`);
  }
  assert.ok(actions.size >= 10, [...actions].join(', '));
  const missing = [...actions].filter((k) => dicts.en[k] === undefined);
  assert.deepEqual(missing, []);
});

test('Persian: every line starts with a right-to-left mark; Persian digits and separators', () => {
  const s = t('fa', 'stats.new', { today: 3, week: 12345 });
  for (const line of s.split('\n')) if (line) assert.equal(line[0], RLM);
  assert.match(s, /۳/);
  assert.match(s, /۱۲٬۳۴۵/);
  const multi = t('fa', 'bc.report_done', { id: 1, sent: 2, failed: 0, blocked: 1, total: 3, time: '5' });
  for (const line of multi.split('\n')) if (line) assert.equal(line[0], RLM, JSON.stringify(line));
  for (const lang of ['en', 'ru', 'zh', 'fr']) assert.ok(!t(lang, 'stats.new', { today: 1, week: 2 }).includes(RLM), lang);
  assert.equal(num('en', 1234567), '1,234,567');
  assert.equal(num('en', 1234), '1234');
  assert.equal(num('fa', 1234567), '۱٬۲۳۴٬۵۶۷');
  assert.equal(num('ru', 54321), '54 321');
  assert.equal(num('fa', -12), '-۱۲');
});

test('durations in each language', () => {
  assert.equal(dur('en', 0), '0 s');
  assert.equal(dur('en', 65), '1 min 5 s');
  assert.equal(dur('en', 3600), '1 h');
  assert.equal(dur('en', 3725), '1 h 2 min');
  assert.equal(dur('fa', 90), '۱ دقیقه ۳۰ ثانیه');
  assert.ok(!dur('fa', 90).includes(RLM));
  assert.equal(dur('zh', 30), '30 秒');
});

test('Persian and English command aliases both work, whatever the language', () => {
  assert.equal(aliasCommand('زبان'), 'language');
  assert.equal(aliasCommand('language'), 'language');
  assert.equal(aliasCommand('LANGUAGE'), 'language');
  assert.equal(aliasCommand('راهنما'), 'help');
  assert.equal(aliasCommand('help'), 'help');
  assert.equal(aliasCommand('پنل'), 'panel');
  assert.equal(aliasCommand('پنل مدیریت'), 'panel');
  assert.equal(aliasCommand(' شروع '), 'start');
  assert.equal(aliasCommand('لغو'), 'cancel');
  assert.equal(aliasCommand('مديريت'), 'panel', 'Arabic yeh typed on an Arabic keyboard');
  assert.equal(aliasCommand('язык'), 'language');
  assert.equal(aliasCommand('语言'), 'language');
  assert.equal(aliasCommand('langue'), 'language');
  assert.equal(aliasCommand('hello there'), null);
  assert.equal(parseCommand('/start'), 'start');
  assert.equal(parseCommand('/start payload'), 'start');
  assert.equal(parseCommand('/help@aegis_test_bot'), 'help');
  assert.equal(parseCommand('/زبان'), 'language');
  assert.equal(parseCommand('/whatever'), 'unknown');
  assert.equal(parseCommand('راهنما'), 'help');
  assert.equal(parseCommand('راهنما', { aliases: false }), null);
  assert.equal(parseCommand('/cancel', { aliases: false }), 'cancel');
  assert.equal(parseCommand('a long sentence that mentions help somewhere inside it, more than forty characters'), null);
});

test('Telegram language codes map to our languages', () => {
  assert.equal(pickLang('fa'), 'fa');
  assert.equal(pickLang('fa-IR'), 'fa');
  assert.equal(pickLang('zh-hans'), 'zh');
  assert.equal(pickLang('uk'), 'ru');
  assert.equal(pickLang('fr-CA'), 'fr');
  assert.equal(pickLang('de'), 'en');
  assert.equal(pickLang(undefined), 'en');
});
