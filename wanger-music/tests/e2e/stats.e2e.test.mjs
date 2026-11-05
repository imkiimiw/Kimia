// Phase 7 end to end. Done when: the dashboard numbers match direct database counts.
// Every test drives the real handlers, then compares app.stats.dashboard() (what 📊 shows) with SQL
// on the tables themselves. The clock is pinned: Tehran midnight is 20:30 UTC.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, advance, setClock, OWNER, SEED } from '../helpers/harness.mjs';
import { createApp } from '../../tgcloud/lib/core/context.js';

const FLOW = -1004391543350;
const BEAT = -1004370326177;
const SRC = -1003300000001;
const ADMIN = 222;
const join = (h, id) => { for (const c of SEED) h.tg.setMember(c, id, 'member'); };
let seq = 0;

const app = () => createApp({ kind: 'test' });
/** stats_daily value of a metric on a day (summed over dimensions unless one is given). */
const stat = (h, date, metric, dimension) => h.one(
  `SELECT coalesce(sum(value), 0) AS v FROM stats_daily WHERE date = ? AND metric = ?${dimension === undefined ? '' : ' AND dimension = ?'}`,
  ...(dimension === undefined ? [date, metric] : [date, metric, String(dimension)]),
).v;
/** Unix time of a UTC ISO string. */
const ts = (iso) => Date.parse(iso) / 1000;

async function addActive(h, title, performer, { language } = {}) {
  seq += 1;
  advance(61);
  await h.send(OWNER, null, { audio: { file_id: `F${seq}`, file_unique_id: `U${seq}`, duration: 200 + seq, title, performer, file_name: 'x.mp3', mime_type: 'audio/mpeg', file_size: 1000 } });
  const row = h.one('SELECT * FROM tracks ORDER BY id DESC LIMIT 1');
  if (language) h.db().prepare('UPDATE tracks SET language = ?, language_confidence = ? WHERE id = ?').run(language, 'high', row.id);
  await h.press(OWNER, `trk:act:${row.id}`, 1);
  return h.one('SELECT * FROM tracks WHERE id = ?', row.id);
}

async function channel(h, chatId, { approval = false } = {}) {
  if (!h.tg.channels.has(chatId)) h.tg.addChannel({ id: chatId, username: chatId === FLOW ? 'WangerFlow' : 'WangerBeat', title: chatId === FLOW ? 'WangerFlow' : 'WangerBeat' });
  await h.send(OWNER, '/admin');
  await h.tap(OWNER, 'dst:home');
  await h.tap(OWNER, `dst:sug:${chatId}`);
  const id = h.one('SELECT id FROM destination_channels WHERE chat_id = ?', chatId).id;
  if (!approval) await h.pressLast(OWNER, `dst:appr:${id}`);
  await h.pressLast(OWNER, `dst:tog:${id}`);
  await h.pressLast(OWNER, `dst:auto:${id}`);
  return id;
}

test('users: new, active once a day (inline too, across midnight), total, blocked = direct counts', async () => {
  const h = setup();
  setClock('2026-11-05T10:00:00Z'); // 13:30 in Tehran
  for (const id of [111, 112, 113, 114]) join(h, id);
  await h.send(111, '/start');
  for (let i = 0; i < 3; i++) {
    advance(700); // past the 10-minute last_seen throttle: more writes, still one active user
    await h.send(111, 'سلام');
  }
  await h.send(112, '/start');
  await h.inline(113, 'abc'); // inline only: a user row, active
  await h.inline(113, 'abcd');
  await h.send(114, '/start');
  await h.myChatMember({ id: 114, type: 'private' }, 114, 'kicked');

  const day1 = ts('2026-11-04T20:30:00Z');
  assert.equal(stat(h, '2026-11-05', 'users.active'), 4);
  assert.equal(stat(h, '2026-11-05', 'users.active'), h.one('SELECT count(*) AS n FROM users WHERE last_seen_at >= ?', day1).n, 'active today = direct count');

  // after Tehran midnight
  setClock('2026-11-05T21:00:00Z'); // 00:30 on 2026-11-06
  await h.send(111, 'دوباره');
  await h.inline(113, 'abc');
  await h.inline(113, 'abcde');
  const day2 = ts('2026-11-05T20:30:00Z');
  assert.equal(stat(h, '2026-11-06', 'users.active'), 2);
  assert.equal(stat(h, '2026-11-06', 'users.active'), h.one('SELECT count(*) AS n FROM users WHERE last_seen_at >= ?', day2).n);
  assert.equal(stat(h, '2026-11-05', 'users.active'), 4, 'yesterday stays');

  // 23:55 → 00:02: the 10-minute throttle must not hide the new day
  setClock('2026-11-06T20:25:00Z');
  await h.send(112, 'شب');
  advance(420);
  await h.send(112, 'صبح');
  assert.equal(stat(h, '2026-11-07', 'users.active'), 1);

  const a = await app();
  for (const days of [1, 7]) {
    const d = await a.stats.dashboard(days);
    const direct = h.one(`SELECT count(*) AS total, sum(is_blocked) AS blocked, sum(created_at >= ?) AS new, sum(last_seen_at >= ?) AS active FROM users`, d.since, d.since);
    assert.deepEqual({ total: d.users.total, blocked: d.users.blocked, new: d.users.new, active: d.users.active }, { ...direct }, `${days} day(s)`);
  }
  const week = await a.stats.dashboard(7);
  assert.equal(week.users.new, 4);
  assert.equal(week.users.blocked, 2, 'blocked the bot (114) or inline only, never started (113)');
  assert.equal(stat(h, '2026-11-05', 'users.new'), h.one('SELECT count(*) AS n FROM users WHERE created_at >= ? AND created_at < ?', day1, day2).n, 'derived: new users of a day');
  assert.equal(stat(h, '2026-11-07', 'users.total'), h.one('SELECT count(*) AS n FROM users').n);
});

test('searches: first inline pages of 3+ characters by users past the gate; private searches; no-result counts', async () => {
  const h = setup();
  setClock('2026-11-05T10:00:00Z');
  join(h, 111);
  await addActive(h, 'Blinding Lights', 'The Weeknd');
  await h.inline(111, 'bl'); // 2 characters
  await h.inline(111, 'bli');
  await h.inline(111, 'blinding', '20'); // a later page
  await h.inline(111, ''); // empty query
  await h.inline(111, 'zzzz'); // nothing found
  await h.inline(115, 'blinding'); // not a member: gated, not counted
  await h.send(111, 'blinding');
  await h.send(111, 'qqqq');
  await h.send(111, '/search');
  const d = '2026-11-05';
  assert.deepEqual([stat(h, d, 'search.inline'), stat(h, d, 'search.inline_empty'), stat(h, d, 'search.private'), stat(h, d, 'search.private_empty')], [2, 1, 2, 1]);
  const dash = await (await app()).stats.dashboard(1);
  assert.deepEqual(dash.search, { inline: 2, inlineEmpty: 1, private: 2, privateEmpty: 1 });
  assert.equal(h.q('SELECT DISTINCT metric FROM stats_daily').map((r) => r.metric).filter((m) => m.startsWith('search')).length, 4);
  assert.ok(!h.q('SELECT dimension FROM stats_daily WHERE metric LIKE ?', 'search%').some((r) => r.dimension !== ''), 'no query texts are stored');
});

test('plays: inline choices and private sends, per track; top tracks; the sum equals play_count', async () => {
  const h = setup();
  setClock('2026-11-05T10:00:00Z');
  join(h, 111);
  const t1 = await addActive(h, 'Song One', 'Artist A');
  const t2 = await addActive(h, 'Song Two', 'Artist B');
  const t3 = await addActive(h, 'Song Three', 'Artist C');
  const gone = await addActive(h, 'Gone', 'Artist D');
  await h.press(OWNER, `trk:rmok:${gone.id}`, 1);
  for (let i = 0; i < 4; i++) await h.chosen(111, t1.public_id);
  await h.chosen(111, t2.public_id);
  await h.chosen(111, 'ZZZZZZZZZ'); // unknown
  await h.chosen(111, gone.public_id); // removed: not counted
  await h.send(111, '/start');
  await h.press(111, `s:get:${t2.public_id}`, 1);
  await h.press(111, `s:get:${t2.public_id}`, 1);
  await h.send(111, `/start t_${t3.public_id}`);
  const d = '2026-11-05';
  assert.deepEqual([stat(h, d, 'play.inline'), stat(h, d, 'play.private')], [5, 3]);
  for (const tr of [t1, t2, t3, gone]) {
    assert.equal(stat(h, d, 'track.play', tr.id), h.one('SELECT play_count AS n FROM tracks WHERE id = ?', tr.id).n, `plays of ${tr.title} = play_count`);
  }
  assert.equal(stat(h, d, 'track.play'), h.one('SELECT sum(play_count) AS n FROM tracks').n);
  const a = await app();
  const top = await a.stats.top(7);
  assert.deepEqual(top.period.map((r) => [r.title, r.plays]), [['Song One', 4], ['Song Two', 3], ['Song Three', 1]]);
  assert.deepEqual(top.allTime.map((r) => r.title), h.q("SELECT title FROM tracks WHERE status = 'active' AND play_count > 0 ORDER BY play_count DESC, activated_at DESC").map((r) => r.title));
  const dash = await a.stats.dashboard(7);
  assert.deepEqual(dash.plays, { inline: 5, private: 3 });
  assert.equal(dash.top[0].title, 'Song One');
});

test('force-join conversions: a user is counted once when stopped and once when unlocked', async () => {
  const h = setup();
  setClock('2026-11-05T10:00:00Z');
  await h.send(120, '/start');
  await h.send(120, '/start');
  await h.inline(120, 'abc');
  await h.press(120, 'fj:check', 1); // still not a member
  assert.equal(stat(h, '2026-11-05', 'fj.gated'), 1);
  assert.equal(h.one('SELECT force_join_ok_until AS v FROM users WHERE telegram_id = 120').v, -1);
  join(h, 120);
  await h.press(120, 'fj:check', 1);
  assert.equal(stat(h, '2026-11-05', 'fj.converted'), 1);
  assert.ok(h.one('SELECT force_join_ok_until AS v FROM users WHERE telegram_id = 120').v > Date.now() / 1000);
  advance(700); // the pass expires; a normal re-check is no conversion
  await h.send(120, '/start');
  await h.inline(121, 'abc'); // inline-only non-member
  const dash = await (await app()).stats.dashboard(1);
  assert.deepEqual(dash.fj, { gated: 2, converted: 1 });
  assert.equal(dash.fj.gated - dash.fj.converted, h.one('SELECT count(*) AS n FROM users WHERE force_join_ok_until = -1').n, 'still gated = direct count');
});

test('publications per channel: published in the period, waiting, queued, failed = direct counts; a purge is recounted', async () => {
  const h = setup();
  setClock('2026-11-05T06:00:00Z');
  const flow = await channel(h, FLOW);
  const beat = await channel(h, BEAT, { approval: true });
  const a1 = await addActive(h, 'دلم تنگه', 'شادمهر', { language: 'fa' });
  await addActive(h, 'بی تو', 'ابی', { language: 'fa' });
  await addActive(h, 'Hello', 'Adele', { language: 'en' });
  for (let i = 0; i < 3; i++) { advance(700); await h.opsTick(OWNER); }
  await addActive(h, 'نامه', 'داریوش', { language: 'fa' });
  h.tg.failNext('sendAudio', 400, "Bad Request: can't parse entities: unsupported start tag", { match: (p) => p.chat_id === FLOW });
  advance(700);
  await h.opsTick(OWNER);
  await addActive(h, 'شب', 'هایده', { language: 'fa' }); // queued, not yet due for the 10-minute interval

  const a = await app();
  const d = await a.stats.dashboard(1);
  for (const id of [flow, beat]) {
    const c = d.channels.find((x) => x.id === id);
    const direct = h.one(`SELECT sum(status = 'published' AND published_at >= ?) AS published, sum(status = 'published') AS publishedAll,
      sum(status = 'pending_approval') AS waiting, sum(status IN ('queued', 'sending')) AS queued, sum(status = 'failed') AS failed, sum(status = 'uncertain') AS uncertain
      FROM publications WHERE channel_id = ?`, d.since, id);
    assert.deepEqual({ published: c.published, publishedAll: c.publishedAll, waiting: c.waiting, queued: c.queued, failed: c.failed, uncertain: c.uncertain }, { ...direct }, `channel ${id}`);
  }
  const f = d.channels.find((x) => x.id === flow);
  assert.deepEqual([f.published, f.failed, f.queued], [2, 1, 1]);
  assert.equal(d.channels.find((x) => x.id === beat).waiting, 1);

  // purging a published track deletes its publications: the day's number follows the table
  await h.press(OWNER, `trk:rmok:${a1.id}`, 1);
  await h.press(OWNER, `trk:purgeok:${a1.id}`, 1);
  const after = await a.stats.dashboard(1);
  assert.equal(after.channels.find((x) => x.id === flow).published, 1);
  assert.equal(stat(h, '2026-11-05', 'pub.published', flow), h.one("SELECT count(*) AS n FROM publications WHERE channel_id = ? AND status = 'published'", flow).n);
});

test('sources: audio posts, imports and duplicates per source = direct counts', async () => {
  const h = setup();
  setClock('2026-11-05T10:00:00Z');
  h.tg.addChannel({ id: SRC, username: 'PersianHits', title: 'Persian Hits' });
  await h.send(OWNER, '/admin');
  await h.tap(OWNER, 'src:home');
  await h.tap(OWNER, 'src:add');
  await h.send(OWNER, null, { forward_origin: { type: 'channel', chat: { id: SRC, type: 'channel', title: 'Persian Hits' }, message_id: 1, date: 0 }, text: 'x' });
  const src = h.one('SELECT * FROM sources WHERE chat_id = ?', SRC);
  const chat = { id: SRC, title: 'Persian Hits', username: 'PersianHits' };
  const audio = (n) => ({ audio: { file_id: `SF${n}`, file_unique_id: `SU${n}`, duration: 180 + n, title: `Track ${n}`, performer: 'Band', file_name: 'x.mp3' } });
  for (const n of [1, 2, 3]) await h.channelPost(chat, audio(n));
  await h.channelPost(chat, audio(2)); // the same file again
  await h.channelPost(chat, { text: 'not audio' });
  await h.channelPost({ id: -1003300000009, title: 'Other' }, audio(9)); // unregistered
  const d = await (await app()).stats.dashboard(1);
  const s = d.sources.find((x) => x.id === src.id);
  assert.deepEqual([s.posts, s.imported, s.duplicates], [4, 3, 1]);
  assert.equal(s.imported, h.one("SELECT count(*) AS n FROM tracks WHERE source_type = 'telegram_channel' AND source_id = ? AND created_at >= ?", src.id, d.since).n, 'imports = tracks from the source');
  assert.equal(s.importedAll, h.one('SELECT imported_count AS n FROM sources WHERE id = ?', src.id).n);
});

test('aggregation: the tick refreshes every 15 min, yesterday is recounted after midnight, retention', async () => {
  const h = setup();
  setClock('2026-11-05T19:55:00Z'); // 23:25 in Tehran
  join(h, 111);
  join(h, 112);
  let r = await h.send(111, '/start');
  assert.equal(r.tick.stats.aggregated, 6, 'the piggyback tick aggregated today and yesterday (3 numbers each)');
  assert.equal(stat(h, '2026-11-05', 'users.new'), 1);
  advance(5 * 60); // 23:30
  r = await h.send(112, '/start'); // created late on the 5th
  assert.equal(r.tick.stats.aggregated, 'skipped', 'throttled to 15 minutes');
  assert.equal(stat(h, '2026-11-05', 'users.new'), 1, 'not yet recounted');
  setClock('2026-11-05T21:00:00Z'); // 00:30 on the 6th
  r = await h.opsTick(OWNER);
  assert.equal(r.result.results.stats.aggregated, 6);
  const start5 = ts('2026-11-04T20:30:00Z');
  const start6 = ts('2026-11-05T20:30:00Z');
  assert.equal(stat(h, '2026-11-05', 'users.new'), 2);
  assert.equal(stat(h, '2026-11-05', 'users.new'), h.one('SELECT count(*) AS n FROM users WHERE created_at >= ? AND created_at < ?', start5, start6).n, 'yesterday recounted');
  advance(60);
  r = await h.opsTick(OWNER);
  assert.equal(r.result.results.stats.pruned, 'skipped', 'retention runs once a day');

  // retention: old days and old per-track plays go, recent rows stay
  const ins = h.db().prepare('INSERT INTO stats_daily (date, metric, dimension, value) VALUES (?, ?, ?, ?)');
  ins.run('2025-09-01', 'search.inline', '', 5);
  ins.run('2026-07-20', 'track.play', '1', 3);
  ins.run('2026-07-20', 'search.inline', '', 4);
  ins.run('2026-10-20', 'track.play', '1', 2);
  setClock('2026-11-06T21:00:00Z'); // the 7th
  await h.opsTick(OWNER);
  const left = h.q('SELECT date, metric FROM stats_daily WHERE date < ? ORDER BY date, metric', '2026-11-01').map((x) => `${x.date} ${x.metric}`);
  assert.deepEqual(left, ['2026-07-20 search.inline', '2026-10-20 track.play']);
});

test('📊 dashboard: periods, daily table, top tracks; admins may look; valid HTML; forged periods fall back', async () => {
  const h = setup();
  setClock('2026-11-05T10:00:00Z');
  join(h, 111);
  await h.send(111, '/start');
  const t1 = await addActive(h, 'Song <One> & Co', 'Artist');
  await h.chosen(111, t1.public_id);
  await h.send(OWNER, '/admin');
  await h.tap(OWNER, 'sts:home:7');
  let text = h.lastText(OWNER);
  assert.match(text, /^📊 <b>آمار<\/b> · ۷ روز اخیر\n<i>۱۴۰۵\/۰۸\/۰۸ تا ۱۴۰۵\/۰۸\/۱۴ \(Asia\/Tehran\)<\/i>/);
  assert.match(text, /👥 <b>کاربران<\/b>: کل ۲ · جدید ۲ · فعال ۲ \(امروز ۲\) · بلاک‌کرده یا بدون استارت ۰/);
  assert.match(text, /▶️ <b>پخش<\/b>: ۱ \(اینلاین ۱ · داخل ربات ۰\)/);
  assert.match(text, /۱\. Song &lt;One&gt; &amp; Co — Artist · ▶️ ۱/, 'track names are escaped');
  assert.deepEqual(h.lastButtons(OWNER).map((b) => b.callback_data), ['sts:home:1', 'sts:home:7', 'sts:home:30', 'sts:days', 'sts:top:7', 'sts:home:7', 'adm:home']);
  await h.tap(OWNER, 'sts:home:30');
  assert.match(h.lastText(OWNER), /۳۰ روز اخیر/);
  await h.tap(OWNER, 'sts:days');
  text = h.lastText(OWNER);
  assert.match(text, /📈 <b>آمار روزانه<\/b> \(۱۴ روز اخیر\)/);
  assert.equal(text.split('\n').filter((l) => /^۱۴۰۵\//.test(l)).length, 14);
  assert.match(text, /۱۴۰۵\/۰۸\/۱۴ · 👥 ۲ \(\+۲\) · 🟢 ۲ · 🔎 ۰ · ▶️ ۱ · 📢 ۰/);
  await h.tap(OWNER, 'sts:home:7');
  await h.tap(OWNER, 'sts:top:7');
  assert.match(h.lastText(OWNER), /🔥 <b>پرپخش‌ترین‌ها<\/b> · ۷ روز اخیر\n۱\. Song &lt;One&gt;/);
  await h.pressLast(OWNER, 'sts:home:5'); // forged: not a period → 7 days
  assert.match(h.lastText(OWNER), /۷ روز اخیر/);

  // an admin (stats.view by default) may look; English labels
  await h.send(OWNER, '/admin');
  await h.tap(OWNER, 'usr:home');
  await h.tap(OWNER, 'usr:adm:0');
  await h.tap(OWNER, 'usr:addadm');
  await h.send(OWNER, String(ADMIN));
  join(h, ADMIN);
  await h.send(ADMIN, '/lang');
  await h.tap(ADMIN, 'lang:set:en');
  await h.send(ADMIN, '/admin');
  await h.tap(ADMIN, 'sts:home:7');
  assert.match(h.lastText(ADMIN), /^📊 <b>Statistics<\/b> · last 7 days\n<i>2026-10-30 to 2026-11-05 \(Asia\/Tehran\)<\/i>/);
  assert.match(h.lastText(ADMIN), /👥 <b>Users<\/b>: total 3/);
});
