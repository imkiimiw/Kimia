// Phase 3 rules, without Telegram: durations, the step ladder, list entry parsing, CSV export bytes,
// group moderation commands, and who may use or undo what.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { csv, isoMinute, utf8Bytes } from '../../tgcloud/lib/core/util.js';
import { durationOf, parseDuration } from '../../tgcloud/lib/core/clock.js';
import { parseArgs, parseModCommand } from '../../tgcloud/lib/core/commands.js';
import * as lists from '../../tgcloud/lib/engines/lists.js';
import { DEFAULT_STEPS, DEFAULTS, lastStep, parseSteps, stepAt, validSteps } from '../../tgcloud/lib/engines/settings.js';
import { L } from '../../tgcloud/lib/engines/admins.js';
import { mayUndo, mayUse } from '../../tgcloud/lib/ui/moderation.js';
import { dur, modCommand } from '../../tgcloud/lib/i18n/index.js';

test('durations typed in any of the five languages; forever words; out-of-range is refused', () => {
  assert.equal(durationOf('30m'), 1800);
  assert.equal(durationOf('2h'), 7200);
  assert.equal(durationOf('1d'), 86400);
  assert.equal(durationOf('1w'), 7 * 86400);
  assert.equal(durationOf('۲ ساعت'), 7200);
  assert.equal(durationOf('3 روز'), 3 * 86400);
  assert.equal(durationOf('1 day'), 86400);
  assert.equal(durationOf('3 дня'), 3 * 86400);
  assert.equal(durationOf('2 jours'), 2 * 86400);
  assert.equal(durationOf('30分钟'), 1800);
  assert.equal(durationOf('forever'), 0);
  assert.equal(durationOf('دائم'), 0);
  assert.equal(durationOf('5'), null, 'a bare number is not a duration');
  assert.equal(durationOf('400d'), null, 'over 366 days');
  assert.deepEqual(parseDuration(['400d', 'x']), { sec: null, used: 1, invalid: true });
  assert.deepEqual(parseDuration(['2', 'ساعت', 'اسپم']), { sec: 7200, used: 2 });
  assert.equal(parseDuration(['spam']), null);
});

test('the step ladder: parsing in Persian and English, errors with line numbers, the step at a count', () => {
  assert.deepEqual(parseSteps('3 mute 1d\n5 ban'), { steps: [{ n: 3, a: 'mute', d: 86400 }, { n: 5, a: 'ban', d: 0 }] });
  assert.deepEqual(parseSteps('۲ سکوت ۲ ساعت\n۴ اخراج\n۶ بن'), { steps: [{ n: 2, a: 'mute', d: 7200 }, { n: 4, a: 'kick', d: 0 }, { n: 6, a: 'ban', d: 0 }] });
  assert.deepEqual(parseSteps(''), { error: 'empty', line: 0 });
  assert.deepEqual(parseSteps('3 slap'), { error: 'action', line: 1 });
  assert.deepEqual(parseSteps('3 mute 1d\n2 ban'), { error: 'order', line: 2 });
  assert.deepEqual(parseSteps('0 mute'), { error: 'count', line: 1 });
  assert.deepEqual(parseSteps('3 mute soon'), { error: 'duration', line: 1 });
  assert.deepEqual(parseSteps('3 kick 1d'), { error: 'format', line: 1 }, 'a kick has no duration');
  assert.deepEqual(parseSteps(Array.from({ length: 11 }, (_, i) => `${i + 1} mute`).join('\n')), { error: 'too_many', line: 11 });
  assert.ok(validSteps(DEFAULT_STEPS));
  assert.ok(!validSteps([{ n: 3, a: 'explode', d: 0 }]));
  assert.equal(stepAt(DEFAULT_STEPS, 3).a, 'mute');
  assert.equal(stepAt(DEFAULT_STEPS, 4), null);
  assert.equal(lastStep(DEFAULT_STEPS).n, 5);
  assert.equal(DEFAULTS.steps, JSON.stringify(DEFAULT_STEPS));
  assert.equal(DEFAULTS.audit, '0', 'Audit Mode is off by default');
});

test('the 18 lists, and typed entries per kind', () => {
  assert.equal(lists.LISTS.length, 18);
  assert.equal(new Set(lists.LISTS.map((l) => l.code)).size, 18);
  for (const [kind, list] of Object.entries(lists.MIRRORS)) assert.equal(lists.get(list).effect, kind, `${list} mirrors ${kind}`);
  assert.deepEqual(lists.parseEntries('domain', 'https://www.Example.com/path?q=1\nt.me\nnot a domain'),
    { entries: [{ ekey: 'example.com', value: 'example.com' }, { ekey: 't.me', value: 't.me' }], bad: [3], tooMany: false });
  assert.deepEqual(lists.parseEntries('chat', '@NewsChannel\nhttps://t.me/other_chan\n-1001234567890\n@ab').entries.map((e) => e.ekey),
    ['newschannel', 'other_chan', '-1001234567890']);
  assert.deepEqual(lists.parseEntries('bot', '@SpamBot\nhelper_bot\n@someone').entries.map((e) => e.value), ['@SpamBot', '@helper_bot']);
  assert.deepEqual(lists.parseEntries('sticker', 'https://t.me/addstickers/FunnyCats\nPack_2').entries.map((e) => e.ekey), ['funnycats', 'pack_2']);
  const words = lists.parseEntries('word', 'كلمه\nکلمه\nSPAM\nspam');
  assert.deepEqual(words.entries.map((e) => e.ekey), ['کلمه', 'spam'], 'Arabic/Persian letters and case are the same word');
  assert.equal(lists.parseEntries('word', Array.from({ length: 60 }, (_, i) => `w${i}`).join('\n')).tooMany, true);
  assert.deepEqual(lists.entryFromMessage(lists.get('stk'), { sticker: { set_name: 'FunnyCats' } }), { ekey: 'funnycats', value: 'FunnyCats' });
  assert.deepEqual(lists.entryFromMessage(lists.get('fwd'), { forward_origin: { type: 'channel', chat: { id: -100555, username: 'Src' } } }), { ekey: 'src', value: '@Src' });
});

test('CSV export: UTF-8 by hand (no TextEncoder), a BOM, quoting, UTC minutes', () => {
  assert.deepEqual([...utf8Bytes('aé😀س')], [0x61, 0xc3, 0xa9, 0xf0, 0x9f, 0x98, 0x80, 0xd8, 0xb3]);
  assert.deepEqual([...utf8Bytes('سلام')], [...Buffer.from('سلام', 'utf8')]);
  assert.equal(csv([['a', 'b,c'], ['say "hi"', 'line\nbreak']]), '\uFEFFa,"b,c"\r\n"say ""hi""","line\nbreak"\r\n');
  assert.equal(isoMinute(Date.UTC(2026, 9, 30, 9, 5) / 1000), '2026-10-30 09:05');
  assert.equal(isoMinute(0), '');
});

test('group moderation commands: slash forms, Persian and other words, targets, durations, reasons', () => {
  assert.deepEqual(parseModCommand('/ban@aegis_bot 1d spam'), { cmd: 'ban', slash: true, mention: 'aegis_bot', args: ['1d', 'spam'] });
  assert.equal(parseModCommand('/config'), null, 'not a moderation command');
  assert.equal(parseModCommand('بن').cmd, 'ban');
  assert.equal(parseModCommand('رفع سکوت @ali_user').cmd, 'unmute');
  assert.equal(parseModCommand('حذف\u200Cاخطار').cmd, 'unwarn');
  assert.equal(parseModCommand('اخطارها').cmd, 'warns');
  assert.equal(parseModCommand('размут').cmd, 'unmute');
  assert.equal(parseModCommand('解除禁言').cmd, 'unmute');
  assert.equal(parseModCommand('lever restriction').cmd, 'unrestrict');
  assert.equal(parseModCommand('banana bread'), null);
  assert.equal(modCommand('MUTE'), 'mute');
  assert.deepEqual(parseArgs('mute', ['@someone', '2', 'ساعت', 'flood', 'again']), { target: { username: 'someone' }, sec: 7200, badDuration: false, reason: 'flood again' });
  assert.deepEqual(parseArgs('ban', ['123456789', 'forever']), { target: { id: 123456789 }, sec: 0, badDuration: false, reason: null });
  assert.deepEqual(parseArgs('ban', ['999d']), { target: null, sec: null, badDuration: true, reason: null });
  assert.deepEqual(parseArgs('warn', ['1d', 'is', 'a', 'reason']), { target: null, sec: null, badDuration: false, reason: '1d is a reason' }, 'a warning has no duration');
  assert.equal(parseArgs('kick', ['x'.repeat(300)]).reason.length, 200);
});

test('who may use and undo what: creator, admins (with and without «ban users»), the «mod» list', () => {
  const creator = { role: 'creator', level: L.creator, restrict: true, member: { status: 'creator' } };
  const banner = { role: 'admin', level: L.view, restrict: true, member: { status: 'administrator', can_restrict_members: true } };
  const plain = { role: 'admin', level: L.view, restrict: false, member: { status: 'administrator' } };
  const fullPromoter = { role: 'admin', level: L.full, restrict: true, member: { status: 'administrator', can_restrict_members: true, can_promote_members: true } };
  const mod = { role: 'mod', level: 0, restrict: false, member: { status: 'member' } };
  for (const cmd of ['warn', 'unwarn', 'warns', 'mute', 'unmute', 'restrict', 'unrestrict', 'kick', 'ban', 'unban']) {
    assert.equal(mayUse(creator, cmd), true, cmd);
    assert.equal(mayUse(banner, cmd), true, cmd);
  }
  assert.equal(mayUse(plain, 'warn'), true);
  assert.equal(mayUse(plain, 'mute'), false, 'restricting needs Telegram\'s ban-users right');
  assert.equal(mayUse(plain, 'ban'), false);
  assert.equal(mayUse(mod, 'mute'), true);
  assert.equal(mayUse(mod, 'warn'), true);
  assert.equal(mayUse(mod, 'ban'), false);
  assert.equal(mayUse(mod, 'kick'), false);
  assert.equal(mayUse(null, 'warn'), false);
  assert.equal(mayUndo(plain, { kind: 'warn' }), true);
  assert.equal(mayUndo(plain, { kind: 'ban' }), false);
  assert.equal(mayUndo(mod, { kind: 'mute' }), true);
  assert.equal(mayUndo(mod, { kind: 'ban' }), false);
  assert.equal(mayUndo(banner, { kind: 'demote' }), false, 'restoring an admin needs Full and «add new admins»');
  assert.equal(mayUndo(fullPromoter, { kind: 'demote' }), true);
  assert.equal(mayUndo(creator, { kind: 'demote' }), true);
});

test('durations of days read naturally', () => {
  assert.equal(dur('en', 86400), '1 d');
  assert.equal(dur('en', 90000), '1 d 1 h');
  assert.equal(dur('fa', 7 * 86400), '۷ روز');
});
