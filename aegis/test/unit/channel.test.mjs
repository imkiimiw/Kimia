// Phase 7 rules, without Telegram: what a post contains and how it is published again, footers,
// reading a backup file (UTF-8 by hand), checking a backup for a chat, times for scheduled posts,
// known fakes and post links.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canPublish, contentOf, hasCaption, same, withFooter } from '../../tgcloud/lib/core/content.js';
import { utf8Bytes, utf8Text } from '../../tgcloud/lib/core/csv.js';
import * as backup from '../../tgcloud/lib/engines/backup.js';
import * as settings from '../../tgcloud/lib/engines/settings.js';
import { isFake, postLink } from '../../tgcloud/lib/ui/channel.js';
import { parseWhen } from '../../tgcloud/lib/ui/panel_posts.js';

/* 2026-01-01 00:00:00 UTC */
const MIDNIGHT = 1767225600;

test('post content: text, the largest photo, files by file_id; things a bot can\'t publish are "other"', () => {
  assert.deepEqual(contentOf({ text: 'hi', entities: [{ type: 'bold', offset: 0, length: 2 }] }), { kind: 'text', c: { t: 'hi', e: [{ type: 'bold', offset: 0, length: 2 }] } });
  assert.deepEqual(contentOf({ photo: [{ file_id: 's' }, { file_id: 'L' }], caption: 'cap' }), { kind: 'photo', c: { t: 'cap', e: [], f: 'L' } });
  assert.equal(contentOf({ animation: { file_id: 'a' }, document: { file_id: 'a' } }).kind, 'animation', 'a GIF is not a document');
  assert.equal(contentOf({ video_note: { file_id: 'v' } }).kind, 'video_note');
  assert.equal(contentOf({ poll: { question: 'q' } }).kind, 'other');
  assert.ok(canPublish('sticker') && !canPublish('other'));
  assert.ok(hasCaption('photo') && hasCaption('text') && !hasCaption('sticker'));
  assert.ok(same({ t: 'a', e: [] }, { t: 'a' }));
  assert.ok(!same({ t: 'a', f: '1' }, { t: 'a', f: '2' }), 'a replaced photo is a change');
  assert.ok(!same({ t: 'a', e: [{ type: 'bold', offset: 0, length: 1 }] }, { t: 'a' }), 'formatting is a change');
});

test('footers go after the text (entities keep their offsets) and only when they still fit', () => {
  assert.equal(withFooter('text', 'News', '— @chan'), 'News\n\n— @chan');
  assert.equal(withFooter('photo', '', '— @chan'), '— @chan', 'a photo without a caption gets the footer as its caption');
  assert.equal(withFooter('sticker', '', '— @chan'), '', 'no caption on stickers');
  assert.equal(withFooter('photo', 'x'.repeat(1020), '— @chan'), 'x'.repeat(1020), 'captions stop at 1024');
  assert.equal(withFooter('text', 'x'.repeat(4000), '— @chan').length, 4009);
  assert.equal(withFooter('text', 'News', ''), 'News');
});

test('UTF-8 decoding without TextDecoder: Persian, emoji, a BOM, broken bytes', () => {
  for (const s of ['سلام دنیا', 'Привет 👋🏽', '中文', 'a"b,c']) assert.equal(utf8Text(utf8Bytes(s)), s);
  assert.equal(utf8Text(new Uint8Array([0xef, 0xbb, 0xbf, 0x41])), 'A');
  assert.equal(utf8Text(new Uint8Array([0x41, 0xff, 0x42])), 'A�B');
  assert.equal(utf8Text(new Uint8Array([0xe2, 0x82])), '��', 'a cut sequence');
});

test('a backup is checked against the chat: kind of chat, version, only known settings and configuration lists', () => {
  const chan = { chat_id: -1001, type: 'channel' };
  const file = (extra) => JSON.stringify({ aegis: 'backup', v: backup.VERSION, type: 'channel', chat: -1001, settings: { ch_approval: '1', nonsense: '1', log_chat: '-5' },
    lists: { vip: [{ k: '1', v: '1' }], ban: [{ k: '2', v: '2' }], nam: [{ k: 'support', v: 'support' }, { k: 'admin', v: 'admin' }] }, locks: {}, guards: {}, ...extra });
  const r = backup.check(file({}), chan);
  assert.deepEqual(r.counts, { settings: 1, entries: 3, locks: 0, guards: 0 }, 'unknown keys, the log channel and the ban list are left out');
  assert.equal(r.other, false);
  assert.equal(backup.check(file({ chat: -1002 }), chan).other, true);
  assert.deepEqual(backup.check('not json', chan), { error: 'not_backup' });
  assert.deepEqual(backup.check(file({ v: 99 }), chan), { error: 'version' });
  assert.deepEqual(backup.check(file({ type: 'supergroup' }), chan), { error: 'type' });
  assert.deepEqual(backup.check(JSON.stringify({ aegis: 'backup', v: backup.VERSION, type: 'channel', settings: { nonsense: '1' } }), chan), { error: 'empty' });
});

test('scheduled posts: «21:30» is the next one in the chat\'s zone; a full date must be ahead', () => {
  assert.equal(parseWhen('03:00', MIDNIGHT, 0), MIDNIGHT + 3 * 3600);
  assert.equal(parseWhen('۲۱:۳۰', MIDNIGHT, 210), MIDNIGHT + 21.5 * 3600 - 210 * 60, 'Persian digits, Tehran time');
  assert.equal(parseWhen('2026-01-02 08:00', MIDNIGHT, 60), Date.UTC(2026, 0, 2, 7, 0) / 1000);
  assert.equal(parseWhen('2025-12-31 08:00', MIDNIGHT, 0), 0, 'the past');
  assert.equal(parseWhen('2026-13-02 08:00', MIDNIGHT, 0), 0);
  assert.equal(parseWhen('soon', MIDNIGHT, 0), 0);
});

test('known fakes match a @username (any case) or an id; post links for public and private channels', () => {
  const s = { ...settings.DEFAULTS, ch_fakes: JSON.stringify(['@Fake_News', '-100777']) };
  assert.ok(isFake(s, { id: 5, username: 'fake_news' }));
  assert.ok(isFake(s, { id: -100777 }));
  assert.ok(!isFake(s, { id: 6, username: 'real_news' }));
  assert.ok(!isFake(settings.DEFAULTS, { id: 5, username: 'fake_news' }));
  assert.equal(postLink({ chat_id: -1001234, username: 'news' }, 7), 'https://t.me/news/7');
  assert.equal(postLink({ chat_id: -1001234, username: null }, 7), 'https://t.me/c/1234/7');
});

test('channel settings: defaults are safe (nothing held, reverted or filtered until switched on)', () => {
  const d = settings.DEFAULTS;
  for (const k of ['ch_approval', 'ch_edit_lock', 'ch_jr_captcha', 'dg_members', 'dg_as_channel', 'dg_first', 'dm_on', 'ch_protect']) assert.equal(d[k], '0', k);
  assert.equal(d.ch_jr_mode, 'manual');
  assert.equal(d.ch_archive, '1', 'the archive is kept: it is what versions and restore need');
  for (const k of Object.keys(d).filter((x) => /^(ch_|dg_|dm_)/.test(x))) {
    if (settings.CHOICES[k]) assert.ok(settings.CHOICES[k].map(String).includes(d[k]), k);
  }
});
