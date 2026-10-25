// Unit tests for the pure helpers. Run: npm run test:unit
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addDays, formatJalali, parseDate, toGregorian, toJalali, today } from '../tgcloud/lib/dates.js';
import { asciiDigits, charLength, esc, fa, normalize, short } from '../tgcloud/lib/text.js';
import { parseChannelInput } from '../tgcloud/lib/admin.js';
import { isMember } from '../tgcloud/lib/join.js';
import { parseCommand } from '../tgcloud/lib/router.js';
import { parseBack } from '../tgcloud/lib/todo.js';
import { btn } from '../tgcloud/lib/tg.js';

const NOW = Date.UTC(2026, 9, 25, 8, 0); // 2026-10-25 11:30 in Tehran = 1405/08/03

test('Jalali <-> Gregorian on known dates', () => {
  const pairs = [
    [[1405, 8, 10], [2026, 11, 1]],
    [[1405, 8, 3], [2026, 10, 25]],
    [[1405, 1, 1], [2026, 3, 21]],
    [[1404, 1, 1], [2025, 3, 21]],
    [[1403, 12, 30], [2025, 3, 20]], // 1403 is a leap year
    [[1399, 12, 30], [2021, 3, 20]], // so is 1399
    [[1400, 1, 1], [2021, 3, 21]],
    [[1402, 10, 11], [2024, 1, 1]],
  ];
  for (const [[jy, jm, jd], [gy, gm, gd]] of pairs) {
    assert.deepEqual(toGregorian(jy, jm, jd), { gy, gm, gd }, `${jy}/${jm}/${jd}`);
    assert.deepEqual(toJalali(gy, gm, gd), { jy, jm, jd }, `${gy}-${gm}-${gd}`);
  }
});

test('Jalali round trip for every day of 1395..1415', () => {
  let d = '2016-03-20';
  while (d < '2037-03-21') {
    const [y, m, day] = d.split('-').map(Number);
    const j = toJalali(y, m, day);
    assert.deepEqual(toGregorian(j.jy, j.jm, j.jd), { gy: y, gm: m, gd: day }, d);
    d = addDays(d, 1);
  }
});

test('today() is the Tehran date', () => {
  assert.equal(today(NOW), '2026-10-25');
  assert.equal(today(Date.UTC(2026, 9, 25, 20, 29)), '2026-10-25'); // 23:59 Tehran
  assert.equal(today(Date.UTC(2026, 9, 25, 20, 30)), '2026-10-26'); // 00:00 Tehran
});

test('parseDate: Jalali, Gregorian, Persian digits, words', () => {
  assert.equal(parseDate('1405/08/10', NOW), '2026-11-01');
  assert.equal(parseDate('۱۴۰۵/۰۸/۱۰', NOW), '2026-11-01');
  assert.equal(parseDate('1405-8-10', NOW), '2026-11-01');
  assert.equal(parseDate('2026-11-01', NOW), '2026-11-01');
  assert.equal(parseDate('2026/11/1', NOW), '2026-11-01');
  assert.equal(parseDate(' ٢٠٢٦-١١-٠١ ', NOW), '2026-11-01');
  assert.equal(parseDate('امروز', NOW), '2026-10-25');
  assert.equal(parseDate('فردا', NOW), '2026-10-26');
  assert.equal(parseDate('پس‌فردا', NOW), '2026-10-27');
  assert.equal(parseDate('1403/12/30', NOW), '2025-03-20');
  assert.equal(parseDate('1404/12/30', NOW), null); // 1404 is not a leap year
  assert.equal(parseDate('1405/13/01', NOW), null);
  assert.equal(parseDate('1405/07/31', NOW), null); // Mehr has 30 days
  assert.equal(parseDate('2026-02-29', NOW), null);
  assert.equal(parseDate('2028-02-29', NOW), '2028-02-29');
  assert.equal(parseDate('1800-01-01', NOW), null);
  assert.equal(parseDate('hello', NOW), null);
  assert.equal(parseDate('', NOW), null);
});

test('formatJalali', () => {
  assert.equal(formatJalali('2026-11-01'), '۱۴۰۵/۰۸/۱۰');
});

test('text helpers', () => {
  assert.equal(fa(1405), '۱۴۰۵');
  assert.equal(asciiDigits('۱۲۳٤٥'), '12345');
  assert.equal(esc('<b>&'), '&lt;b&gt;&amp;');
  assert.equal(normalize('  علي و كتاب \u0007 '), 'علی و کتاب');
  assert.equal(normalize('خط اول\nخط دوم'), 'خط اول\nخط دوم');
  assert.equal(charLength('سلام 👋'), 6);
  assert.equal(short('یک  دو\nسه', 20), 'یک دو سه');
  assert.equal(short('abcdefghij', 5), 'abcd…');
});

test('parseChannelInput', () => {
  assert.deepEqual(parseChannelInput('@wangerBots'), { username: 'wangerBots' });
  assert.deepEqual(parseChannelInput('wangerBots'), { username: 'wangerBots' });
  assert.deepEqual(parseChannelInput('https://t.me/HIDE_i_SEEK'), { username: 'HIDE_i_SEEK' });
  assert.deepEqual(parseChannelInput('t.me/Nepenthw_ir/'), { username: 'Nepenthw_ir' });
  assert.deepEqual(parseChannelInput('http://telegram.me/s/abcde?x=1'), { username: 'abcde' });
  assert.deepEqual(parseChannelInput('https://t.me/abcde/123'), { username: 'abcde' });
  assert.deepEqual(parseChannelInput('https://t.me/+AbCdEf123'), { error: 'private' });
  assert.deepEqual(parseChannelInput('t.me/joinchat/AbCd'), { error: 'private' });
  assert.deepEqual(parseChannelInput('@ab'), { error: 'invalid' });
  assert.deepEqual(parseChannelInput('@1abcde'), { error: 'invalid' });
  assert.deepEqual(parseChannelInput('سلام'), { error: 'invalid' });
});

test('isMember follows the spec', () => {
  assert.equal(isMember({ status: 'member' }), true);
  assert.equal(isMember({ status: 'administrator' }), true);
  assert.equal(isMember({ status: 'creator' }), true);
  assert.equal(isMember({ status: 'restricted', is_member: true }), true);
  assert.equal(isMember({ status: 'restricted', is_member: false }), false);
  assert.equal(isMember({ status: 'restricted' }), false);
  assert.equal(isMember({ status: 'left' }), false);
  assert.equal(isMember({ status: 'kicked' }), false);
  assert.equal(isMember(null), false);
});

test('parseCommand', () => {
  assert.deepEqual(parseCommand('/start'), { name: 'start', arg: '' });
  assert.deepEqual(parseCommand('/add@my_bot خرید نان'), { name: 'add', arg: 'خرید نان' });
  assert.deepEqual(parseCommand('/search  نان  '), { name: 'search', arg: 'نان' });
  assert.equal(parseCommand('خرید نان'), null);
  assert.equal(parseCommand('/ نان'), null);
});

test('parseBack', () => {
  assert.deepEqual(parseBack('l2.15'), { kind: 'l', page: 2, cat: 15, code: 'l2.15' });
  assert.deepEqual(parseBack('s3'), { kind: 's', page: 3, code: 's3' });
  assert.deepEqual(parseBack('x'), { kind: 'l', page: 0, cat: 0, code: 'l0.0' });
  assert.deepEqual(parseBack(undefined), { kind: 'l', page: 0, cat: 0, code: 'l0.0' });
});

test('callback_data is limited to 64 ASCII bytes', () => {
  assert.equal(btn('x', 'a'.repeat(64)).callback_data.length, 64);
  assert.throws(() => btn('x', 'a'.repeat(65)));
  assert.throws(() => btn('x', ''));
  assert.throws(() => btn('x', 'نان'));
  // the longest code the bot builds: ids are at most 15 digits (router int()), pages 4
  const id = '9'.repeat(15);
  assert.ok(btn('x', `cs:${id}:${id}:l9999.${id}`));
});
