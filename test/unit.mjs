import assert from 'node:assert/strict';
import test from 'node:test';
import { parseChannelInput } from '../tgcloud/lib/admin.js';
import { cleanCategory, parseQuickAdd } from '../tgcloud/lib/quickadd.js';
import { utf8Bytes, utf8Length } from '../tgcloud/lib/utf8.js';
import { addRepeat, DAY, fa, formatDate, fromLocal, g2j, HOUR, j2g, localParts, MINUTE, nextDigestAt, nextOccurrence, parseWhen } from '../tgcloud/lib/time.js';

// Tuesday 1405/07/28 (2026-10-20) 15:00 Tehran.
const NOW = fromLocal(2026, 10, 20, 15, 0);
const at = (r) => (r ? localParts(r.ts) : null);

test('Jalali conversion', () => {
  assert.deepEqual(g2j(2026, 10, 20), { jy: 1405, jm: 7, jd: 28 });
  assert.deepEqual(g2j(2025, 3, 21), { jy: 1404, jm: 1, jd: 1 });
  assert.deepEqual(g2j(2025, 3, 20), { jy: 1403, jm: 12, jd: 30 }); // leap year
  assert.deepEqual(j2g(1405, 1, 1), { gy: 2026, gm: 3, gd: 21 });
  for (let d = 0; d < 800; d += 1) {
    const p = localParts(NOW + d * DAY);
    const j = g2j(p.y, p.m, p.d);
    assert.deepEqual(j2g(j.jy, j.jm, j.jd), { gy: p.y, gm: p.m, gd: p.d });
  }
  assert.equal(formatDate(NOW, { now: NOW }), 'سه‌شنبه ۲۸ مهر، ساعت ۱۵:۰۰');
  assert.equal(fa('12:05 / 2026'), '۱۲:۰۵ / ۲۰۲۶');
});

test('parseWhen: keywords, times, dates, relative', () => {
  assert.deepEqual(at(parseWhen('فردا', NOW)), { y: 2026, m: 10, d: 21, hh: 9, mm: 0, dow: 3 });
  assert.equal(parseWhen('فردا', NOW).hasTime, false);
  assert.equal(at(parseWhen('فردا ساعت ۹ شب', NOW)).hh, 21);
  assert.deepEqual(at(parseWhen('۱۸:۳۰', NOW)), { y: 2026, m: 10, d: 20, hh: 18, mm: 30, dow: 2 });
  assert.equal(at(parseWhen('10:00', NOW)).d, 21, 'past time today -> tomorrow');
  assert.deepEqual(at(parseWhen('1405/08/02 10:00', NOW)), { y: 2026, m: 10, d: 24, hh: 10, mm: 0, dow: 6 });
  assert.equal(at(parseWhen('2026-11-01', NOW)).d, 1);
  assert.equal(at(parseWhen('8/15', NOW)).m, 11, 'month/day = current Jalali year');
  assert.equal(at(parseWhen('شنبه', NOW)).dow, 6);
  assert.equal(at(parseWhen('سه‌شنبه', NOW)).d, 27, 'same weekday -> next week');
  assert.equal(at(parseWhen('پس‌فردا', NOW)).d, 22);
  assert.equal(at(parseWhen('هفته بعد', NOW)).d, 27);
  assert.equal(parseWhen('30 دقیقه دیگر', NOW).ts, NOW + 30 * MINUTE);
  assert.equal(parseWhen('2h', NOW).ts, NOW + 2 * HOUR);
  assert.equal(parseWhen('2 ساعت بعد', NOW).ts, NOW + 2 * HOUR);
  assert.equal(at(parseWhen('+3', NOW)).d, 23);
  assert.equal(at(parseWhen('ساعت 1 ظهر', NOW)).hh, 13);
  assert.equal(at(parseWhen('دوشنبه 7 صبح', NOW)).hh, 7);
  for (const bad of ['', 'abc', '25:00', '1405/12/30', '2026-02-30', '1405/13/01', 'دیروز']) assert.equal(parseWhen(bad, NOW), null, bad);
  assert.equal(parseWhen('1403/12/30', NOW) !== null, true, '1403 is a leap year');
});

test('daily digest scheduling', () => {
  const at = (ts) => localParts(ts);
  assert.deepEqual([at(nextDigestAt(NOW, 18)).d, at(nextDigestAt(NOW, 18)).hh], [20, 18], 'later today');
  assert.deepEqual([at(nextDigestAt(NOW, 15)).d, at(nextDigestAt(NOW, 15)).hh], [21, 15], 'current hour -> tomorrow');
  assert.deepEqual([at(nextDigestAt(NOW, 8)).d, at(nextDigestAt(NOW, 8)).hh], [21, 8], 'past hour -> tomorrow');
});

test('recurrence', () => {
  const t = fromLocal(2026, 10, 20, 9, 0);
  assert.equal(addRepeat(t, 'd'), t + DAY);
  assert.equal(addRepeat(t, 'w'), t + 7 * DAY);
  const m = localParts(addRepeat(t, 'm'));
  assert.deepEqual(g2j(m.y, m.m, m.d), { jy: 1405, jm: 8, jd: 28 }, 'monthly follows the Jalali month');
  assert.equal(nextOccurrence(t - 10 * DAY, 'd', t), t + DAY, 'skips missed occurrences');
});

test('quick add syntax', () => {
  const r = parseQuickAdd('خرید نان #خانه !1 @فردا 18:00', NOW);
  assert.equal(r.text, 'خرید نان');
  assert.equal(r.category, 'خانه');
  assert.equal(r.priority, 1);
  assert.deepEqual(at(r.due), { y: 2026, m: 10, d: 21, hh: 18, mm: 0, dow: 3 });
  const plain = parseQuickAdd('ایمیل به @ali_reza درباره قرارداد', NOW);
  assert.equal(plain.text, 'ایمیل به @ali_reza درباره قرارداد');
  assert.equal(plain.due, null);
  const dateOnly = parseQuickAdd('گزارش ماهانه @1405/08/10 #کار_شرکت !۳', NOW);
  assert.equal(dateOnly.text, 'گزارش ماهانه');
  assert.equal(dateOnly.category, 'کار شرکت');
  assert.equal(dateOnly.priority, 3);
  assert.equal(dateOnly.due.hasTime, false);
  assert.equal(at(dateOnly.due).hh, 23);
  assert.equal(parseQuickAdd('عالیه! !5 #', NOW).text, 'عالیه! !5 #');
  const zwnj = parseQuickAdd('جارو کشیدن #خانه\u200cداری', NOW);
  assert.equal(zwnj.category, 'خانه\u200cداری', 'ZWNJ is part of Persian words');
  assert.equal(zwnj.text, 'جارو کشیدن');
});

test('UTF-8 helpers match TextEncoder', () => {
  const enc = new TextEncoder();
  for (const s of ['', 'abc', 'خرید نان', 'کارهای\u200cروزانه', '😀 emoji', '漢字', 'a\ud800b', '۱۴۰۵/۰۸/۱۰']) {
    assert.deepEqual(Array.from(utf8Bytes(s)), Array.from(enc.encode(s)), s);
    assert.equal(utf8Length(s), enc.encode(s).length, s);
  }
});

test('category names fit in callback_data', () => {
  assert.equal(cleanCategory('کارهای\u200cروزانه'), 'کارهای\u200cروزانه');
  assert.equal(cleanCategory('  کار شرکت  '), 'کار شرکت');
  assert.equal(cleanCategory('a|b'), null);
  assert.equal(cleanCategory('ا'.repeat(21)), null, 'more than 20 characters');
  assert.equal(cleanCategory('漢'.repeat(14)), null, 'more than 40 bytes');
  for (const name of ['ا'.repeat(20), 'ک\u200c'.repeat(10).slice(0, 19), 'abcdefghijklmnopqrst']) {
    const c = cleanCategory(name);
    if (c) assert.ok(new TextEncoder().encode(`L|c${c}|99`).length <= 64, name);
  }
});

test('channel input parsing', () => {
  assert.deepEqual(parseChannelInput({ text: '@HIDE_i_SEEK' }), { chat: '@HIDE_i_SEEK', link: 'https://t.me/HIDE_i_SEEK' });
  assert.deepEqual(parseChannelInput({ text: 'https://t.me/Nepenthw_ir/' }), { chat: '@Nepenthw_ir', link: 'https://t.me/Nepenthw_ir' });
  assert.deepEqual(parseChannelInput({ text: '-1001234567890 https://t.me/+AbCdEf_12' }), { chat: '-1001234567890', link: 'https://t.me/+AbCdEf_12' });
  assert.deepEqual(parseChannelInput({ text: '/addchannel t.me/joinchat/XyZ -100555555555' }), { chat: '-100555555555', link: 'https://t.me/joinchat/XyZ' });
  assert.deepEqual(parseChannelInput({ text: 'x', forward_origin: { type: 'channel', chat: { id: -1009, type: 'channel', username: 'wangerBots' } } }), { chat: '@wangerBots', link: 'https://t.me/wangerBots' });
  assert.equal(parseChannelInput({ text: 'سلام' }), null);
  assert.equal(parseChannelInput({ text: 'عضو شوید @other_channel' }), null, 'a copied post is not a channel reference');
  assert.equal(parseChannelInput({ caption: '@other_channel' }), null, 'captions are ignored');
  assert.equal(parseChannelInput({ text: 'x', forward_origin: { type: 'hidden_user', sender_user_name: 'A' } }), null);
  assert.equal(parseChannelInput({ text: '@ab' }), null, 'too short for a username');
});
