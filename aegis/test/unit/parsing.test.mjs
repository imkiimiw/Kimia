// Pure helpers: broadcast button lines, channel input, time, text, numbers, content types.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { countButtons, parseButtons } from '../../tgcloud/lib/core/content.js';
import { parseChannelInput } from '../../tgcloud/lib/ui/owner.js';
import { contentType } from '../../tgcloud/lib/ui/owner_bc.js';
import { dayStart, esc, iso, normalizeWord, short, toInt, utf8Length } from '../../tgcloud/lib/core/util.js';

test('broadcast buttons: rows, several per row, t.me links, errors with line numbers', () => {
  const ok = parseButtons('Channel - https://t.me/example\nRules - t.me/example/5 | Site — https://example.com\n\n');
  assert.deepEqual(ok, { rows: [
    [{ text: 'Channel', url: 'https://t.me/example' }],
    [{ text: 'Rules', url: 'https://t.me/example/5' }, { text: 'Site', url: 'https://example.com' }],
  ] });
  assert.equal(countButtons(ok.rows), 3);
  assert.deepEqual(parseButtons('A - B - https://x.io'), { rows: [[{ text: 'A - B', url: 'https://x.io' }]] });
  assert.deepEqual(parseButtons('کانال ما - https://t.me/x'), { rows: [[{ text: 'کانال ما', url: 'https://t.me/x' }]] });
  assert.deepEqual(parseButtons('Open - tg://resolve?domain=x'), { rows: [[{ text: 'Open', url: 'tg://resolve?domain=x' }]] });
  assert.deepEqual(parseButtons(''), { error: 'empty', line: 0 });
  assert.deepEqual(parseButtons('just text'), { error: 'format', line: 1 });
  assert.deepEqual(parseButtons('ok - https://a.io\nbad - ftp://x'), { error: 'url', line: 2 });
  assert.deepEqual(parseButtons('bad - javascript:alert(1)'), { error: 'url', line: 1 });
  assert.deepEqual(parseButtons(`${'x'.repeat(49)} - https://a.io`), { error: 'text', line: 1 });
  assert.deepEqual(parseButtons('a - https://a.io | b - https://b.io | c - https://c.io | d - https://d.io | e - https://e.io'), { error: 'too_many_in_row', line: 1 });
  assert.deepEqual(parseButtons(Array.from({ length: 9 }, (_, i) => `b${i} - https://a.io`).join('\n')), { error: 'too_many_rows', line: 9 });
});

test('forced-join channel input: @name, links, ids; anything else is refused', () => {
  assert.equal(parseChannelInput('@HIDE_i_SEEK'), '@HIDE_i_SEEK');
  assert.equal(parseChannelInput('https://t.me/wangerBots'), '@wangerBots');
  assert.equal(parseChannelInput('t.me/Nepenthw_ir/'), '@Nepenthw_ir');
  assert.equal(parseChannelInput('-1001234567890'), -1001234567890);
  assert.equal(parseChannelInput('1234567890'), -1001234567890);
  assert.equal(parseChannelInput('https://t.me/+AbCdEf'), null);
  assert.equal(parseChannelInput('@ab'), null);
  assert.equal(parseChannelInput('hello'), null);
  assert.equal(parseChannelInput(''), null);
});

test('"today" starts at midnight Tehran time (UTC+03:30)', () => {
  const at = Date.UTC(2026, 9, 30, 21, 0) / 1000; // 00:30 on Oct 31 in Tehran
  assert.equal(dayStart(at, 210), Date.UTC(2026, 9, 30, 20, 30) / 1000);
  const before = Date.UTC(2026, 9, 30, 20, 0) / 1000; // 23:30 on Oct 30 in Tehran
  assert.equal(dayStart(before, 210), Date.UTC(2026, 9, 29, 20, 30) / 1000);
});

test('text helpers: escape, shorten without splitting surrogates, isolate, normalize, ints, utf-8 length', () => {
  assert.equal(esc('<b>&"'), '&lt;b&gt;&amp;&quot;');
  assert.equal(short('abcdef', 4), 'abc…');
  assert.equal(short('ab😀cd', 4), 'ab…');
  assert.equal(iso('<Ali>'), '\u2068&lt;Ali&gt;\u2069');
  assert.equal(normalizeWord(' مدیريت '), 'مدیریت');
  assert.equal(normalizeWord('پنل\u200Cمدیریت'), 'پنلمدیریت');
  assert.equal(toInt('42'), 42);
  assert.equal(toInt('-1001'), -1001);
  assert.equal(toInt('4x'), null);
  assert.equal(toInt('99999999999999999'), null);
  assert.equal(utf8Length('abc'), 3);
  assert.equal(utf8Length('سلام'), 8);
  assert.equal(utf8Length('😀'), 4);
});

test('broadcast content types', () => {
  assert.equal(contentType({ text: 'hi' }), 'text');
  assert.equal(contentType({ photo: [{}], caption: 'x' }), 'photo');
  assert.equal(contentType({ document: {} }), 'document');
  assert.equal(contentType({ venue: {}, location: {} }), 'location');
  assert.equal(contentType({ new_chat_members: [] }), null);
});
