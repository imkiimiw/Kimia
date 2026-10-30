// Phase 4 rules, without Telegram: what a message contains, the 42 locks and their settings, and
// the language rule — one foreign word never makes a mixed-language message "foreign".
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  bannedHit, commandTarget, deceptive, emojiCount, hostOf, hostsOf, isInvite, langHit, linksOf, longestRun, repeatedWords, scan, scripts, wordsText,
} from '../../tgcloud/lib/core/msgscan.js';
import { normalizeWord } from '../../tgcloud/lib/core/util.js';
import * as locks from '../../tgcloud/lib/engines/locks.js';

const lang = (text, entities = []) => scripts(wordsText(scan({ text, entities })));

test('42 locks in four groups, unique codes; only some have a sensitivity; service and channel posts are never punished', () => {
  assert.equal(locks.LOCKS.length, 42);
  assert.equal(new Set(locks.LOCKS.map((l) => l.code)).size, 42);
  const per = Object.fromEntries(locks.CATEGORIES.map((c) => [c, locks.LOCKS.filter((l) => l.cat === c).length]));
  assert.deepEqual(per, { media: 14, text: 13, content: 9, behavior: 6 });
  assert.deepEqual(locks.LOCKS.filter((l) => !l.punish).map((l) => l.code), ['as_channel', 'service']);
  assert.equal(locks.LOCKS.filter((l) => l.sens).length, 13);
});

test('lock settings: defaults, and anything invalid falls back safely', () => {
  assert.deepEqual(locks.normalize(undefined), locks.DEFAULT);
  const c = locks.normalize({ on: 1, a: 'nuke', d: 123, del: 'x', n: 'loud', txt: '  ', ex: [5, -1, 'a', 7], s: 'max', sc: 'some' });
  assert.deepEqual([c.on, c.a, c.d, c.del, c.n, c.txt, c.ex, c.s, c.sc], [1, 'none', 0, 1, 'default', null, [5, 7], 'medium', 'all']);
  assert.equal(locks.normalize({ txt: 'x'.repeat(400) }).txt.length, 300);
  assert.equal(locks.normalize({ ex: Array.from({ length: 30 }, (_, i) => i + 1) }).ex.length, 20);
  assert.equal(locks.normalize({ a: 'ban', d: 86400 }).d, 86400);
});

test('scan: media kinds (GIFs are not files, animated stickers apart), entities, service messages, forwards', () => {
  assert.deepEqual([...scan({ photo: [{}], caption: 'hi' }).kinds], ['photo'], 'a captioned photo is not a text message');
  assert.deepEqual([...scan({ animation: {}, document: {} }).kinds], ['gif']);
  assert.deepEqual([...scan({ document: {} }).kinds], ['file']);
  assert.deepEqual([...scan({ sticker: { is_animated: true } }).kinds], ['anim_sticker']);
  assert.deepEqual([...scan({ sticker: { is_video: false, is_animated: false } }).kinds], ['sticker']);
  assert.deepEqual([...scan({ venue: {}, location: {} }).kinds], ['location']);
  assert.deepEqual([...scan({ text: 'hello' }).kinds], ['text']);
  assert.deepEqual(scan({ new_chat_members: [{ id: 1 }] }).service, ['new_chat_members']);
  assert.ok(scan({ photo: [{}], has_media_spoiler: true }).types.has('spoiler'));
  const f = scan({ text: 'see example.com and this', entities: [{ type: 'url', offset: 4, length: 11 }, { type: 'text_link', offset: 20, length: 4, url: 'https://evil.io/x' }] });
  assert.deepEqual(f.urls, ['example.com', 'https://evil.io/x']);
  assert.deepEqual(f.hidden, [{ url: 'https://evil.io/x', shown: 'this' }]);
});

test('links at three sensitivities; hosts; invite links; deceptive hidden links; commands to other bots', () => {
  const f = scan({ text: 'go www.site.com or visit shop . com / spam[.]net and t.me/somechan', entities: [] });
  assert.deepEqual(hostsOf(linksOf(f, 'low')), []);
  assert.deepEqual(hostsOf(linksOf(f, 'medium')), ['site.com', 't.me']);
  assert.deepEqual(hostsOf(linksOf(f, 'high')).sort(), ['shop.com', 'site.com', 'spam.net', 't.me']);
  assert.equal(hostOf('HTTPS://www.Example.com:8080/a?b'), 'example.com');
  assert.equal(hostOf('not a url'), null);
  assert.ok(isInvite('https://t.me/+AbCdEf123'));
  assert.ok(isInvite('t.me/joinchat/AAAA'));
  assert.ok(!isInvite('https://t.me/publicchannel'));
  assert.equal(deceptive({ shown: 'paypal.com', url: 'https://evil.io' }), true);
  assert.equal(deceptive({ shown: 'click here', url: 'https://evil.io' }), false);
  assert.equal(deceptive({ shown: 'example.com', url: 'https://www.example.com/x' }), false);
  assert.equal(commandTarget('/start@Other_Bot'), 'other_bot');
  assert.equal(commandTarget('/start'), null);
});

test('language locks: a mixed-language message is never caught because of one foreign word', () => {
  const persianWithOneEnglish = lang('سلام دوستان Hello امروز خوبید؟');
  for (const s of ['low', 'medium', 'high']) assert.equal(langHit(persianWithOneEnglish, 'latin', s), false, s);
  assert.equal(langHit(lang('سلام OK'), 'latin', 'high'), false, 'one word, even in a two-word message');
  assert.equal(langHit(lang('Hello friends, how are you all today?'), 'latin', 'medium'), true);
  assert.equal(langHit(lang('Hello'), 'latin', 'medium'), true, 'a message that is entirely one foreign word is not mixed');
  assert.equal(langHit(lang('Привет всем, как дела?'), 'cyrillic', 'medium'), true);
  assert.equal(langHit(lang('你好朋友们今天怎么样'), 'cjk', 'medium'), true);
  assert.equal(langHit(lang('سلام علیکم برادران عزیز'), 'fa', 'medium'), true);
  assert.equal(langHit(lang('Meeting at five, ممنون'), 'fa', 'medium'), false);
  const linkOnly = scan({ text: 'سلام https://example.com @someone #news', entities: [{ type: 'url', offset: 5, length: 19 }, { type: 'mention', offset: 25, length: 8 },
    { type: 'hashtag', offset: 34, length: 5 }] });
  assert.equal(langHit(scripts(wordsText(linkOnly)), 'latin', 'high'), false, 'links, usernames and tags are not words');
  assert.equal(langHit(lang('hello world from me سلام'), 'latin', 'medium'), true, 'mostly English');
});

test('emoji, length and repetition', () => {
  assert.equal(emojiCount(scan({ text: '😀😀👍🏽 👨\u200D👩\u200D👧 ❤️', entities: [] })), 5);
  assert.equal(emojiCount(scan({ text: 'x', entities: [{ type: 'custom_emoji', offset: 0, length: 1 }] })), 1);
  assert.equal(longestRun('heyyyyyy'), 6);
  assert.equal(longestRun('1000000 and     spaces'), 1, 'digits and spaces don\'t count');
  assert.equal(repeatedWords('buy buy BUY buy now'), 4);
});

test('banned words: whole words, stretched words, anywhere; allowed words never count', () => {
  const banned = ['spam', 'کلمه بد'];
  assert.equal(bannedHit('this is spam', banned, [], normalizeWord, 'low'), 'spam');
  assert.equal(bannedHit('this is spaaaam', banned, [], normalizeWord, 'low'), null);
  assert.equal(bannedHit('this is spaaaam', banned, [], normalizeWord, 'medium'), 'spam');
  assert.equal(bannedHit('antispam tools', banned, [], normalizeWord, 'medium'), null);
  assert.equal(bannedHit('antispam tools', banned, [], normalizeWord, 'high'), 'spam');
  assert.equal(bannedHit('antispam tools', banned, ['antispam'], normalizeWord, 'high'), null, 'an allowed word is skipped');
  assert.equal(bannedHit('این یک كلمه بد است', banned, [], normalizeWord, 'medium'), 'کلمه بد', 'phrases; Arabic/Persian letters are the same');
});

test('evaluate: only active locks; allowed lists; Aegis\'s own commands; forwards by sensitivity', async () => {
  const lists = { aln: ['example.com'], fwd: ['goodchan'], bwd: [], gwd: [] };
  const env = { keys: async (c) => lists[c] || [], anyIn: async (c, ks) => ks.some((k) => (lists[c] || []).includes(String(k).toLowerCase())) };
  const on = (code, extra = {}) => new Map([[code, locks.normalize({ on: 1, ...extra })]]);
  const bot = { id: 1, username: 'aegis_bot' };
  const own = new Set(['config', 'warn']);
  const run = (msg, active, edited = false) => locks.evaluate(scan(msg), active, { env, bot, own, edited });
  const ok = async (msg, active, edited) => (await run(msg, active, edited)).map((m) => m.code);
  assert.deepEqual(await ok({ photo: [{}] }, on('video')), []);
  assert.deepEqual(await ok({ photo: [{}] }, on('photo')), ['photo']);
  assert.deepEqual(await ok({ text: 'a.example.com', entities: [{ type: 'url', offset: 0, length: 13 }] }, on('link')), [], 'allowed domain and its subdomains');
  assert.deepEqual(await ok({ text: 'bad.io', entities: [{ type: 'url', offset: 0, length: 6 }] }, on('link')), ['link']);
  assert.deepEqual(await ok({ text: '/config', entities: [{ type: 'bot_command', offset: 0, length: 7 }] }, on('command')), []);
  assert.deepEqual(await ok({ text: '/start@other_bot', entities: [{ type: 'bot_command', offset: 0, length: 16 }] }, on('command', { s: 'low' })), ['command']);
  assert.deepEqual(await ok({ text: '/start', entities: [{ type: 'bot_command', offset: 0, length: 6 }] }, on('command', { s: 'low' })), []);
  const fromUser = { text: 'x', forward_origin: { type: 'user', sender_user: { id: 5, is_bot: false } } };
  assert.deepEqual(await ok(fromUser, on('forward')), [], 'medium: people\'s forwards are fine');
  assert.deepEqual(await ok(fromUser, on('forward', { s: 'high' })), ['forward']);
  assert.deepEqual(await ok({ text: 'x', forward_origin: { type: 'channel', chat: { id: -100, username: 'GoodChan' } } }, on('forward')), [], 'allowed source');
  assert.deepEqual(await ok({ text: 'x', forward_origin: { type: 'channel', chat: { id: -101, username: 'other' } } }, on('forward', { s: 'low' })), ['forward']);
  assert.deepEqual(await ok({ text: 'x' }, on('edit'), true), ['edit']);
  assert.deepEqual(await ok({ text: 'x', via_bot: { id: 1 } }, on('via_bot')), [], 'Aegis\'s own inline results');
  assert.deepEqual(await ok({ text: 'x', sender_chat: { id: -100 } }, on('as_channel')), ['as_channel']);
  assert.deepEqual(await ok({ text: 'x', sender_chat: { id: -100 }, is_automatic_forward: true }, on('as_channel')), []);
  assert.deepEqual(await ok({ text: 'x'.repeat(600) }, on('long')), []);
  assert.deepEqual(await ok({ text: 'x'.repeat(600) }, on('long', { s: 'high' })), ['long']);
});
