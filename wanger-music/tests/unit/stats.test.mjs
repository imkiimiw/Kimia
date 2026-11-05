// Phase 7 units: date helpers, number formatting, the inline "counts as a search" rule, the stats
// service with a fake repository (buffer, flush, throttle, zeroing, retention) and a guard that every
// metric the code counts is documented in METRICS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { addDays, localDate, dayStart } from '../../tgcloud/lib/core/util.js';
import { num, pct, dateLabel } from '../../tgcloud/lib/admin/stats_ui.js';
import { countsAsSearch } from '../../tgcloud/lib/bot/search_ui.js';
import { createStatsService, METRICS, NOOP_STATS } from '../../tgcloud/lib/stats/service.js';
import { fakeClock, fakeSettings, noLog } from '../helpers/fakes.mjs';

const ts = (iso) => Date.parse(iso) / 1000;

test('dates: local days in Tehran, calendar arithmetic across months and years', () => {
  assert.equal(localDate(ts('2026-11-05T20:29:59Z'), 'Asia/Tehran'), '2026-11-05');
  assert.equal(localDate(ts('2026-11-05T20:30:00Z'), 'Asia/Tehran'), '2026-11-06');
  assert.equal(dayStart(ts('2026-11-05T21:00:00Z'), 'Asia/Tehran'), ts('2026-11-05T20:30:00Z'));
  assert.equal(localDate(ts('2026-11-05T23:00:00Z'), 'UTC'), '2026-11-05');
  assert.equal(addDays('2026-11-05', -6), '2026-10-30');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(addDays('2028-03-01', -1), '2028-02-29');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-11-05', -400), '2025-10-01');
  // DST zone: a 23-hour day still has one start and one end
  const berlin = 'Europe/Berlin';
  const s = dayStart(ts('2026-03-29T12:00:00Z'), berlin);
  assert.equal(s, ts('2026-03-28T23:00:00Z'));
  assert.equal(dayStart(s + 86400 + 3 * 3600, berlin), ts('2026-03-29T22:00:00Z'));
});

test('numbers: grouping and digits per language; percentages; Jalali dates', () => {
  assert.equal(num(1234567, 'en'), '1,234,567');
  assert.equal(num(1234567, 'fa'), '۱٬۲۳۴٬۵۶۷');
  assert.equal(num(0, 'fa'), '۰');
  assert.equal(num(undefined, 'en'), '0');
  assert.equal(pct(1, 3, 'en'), '33%');
  assert.equal(pct(5, 8, 'fa'), '۶۳٪');
  assert.equal(pct(1, 0, 'fa'), '—');
  assert.equal(dateLabel('2026-11-05', 'fa'), '۱۴۰۵/۰۸/۱۴');
  assert.equal(dateLabel('2026-03-21', 'fa'), '۱۴۰۵/۰۱/۰۱');
  assert.equal(dateLabel('2026-11-05', 'en'), '2026-11-05');
});

test('inline queries count as a search only on the first page with 3+ characters', () => {
  const page = (text) => ({ q: { text } });
  assert.equal(countsAsSearch(page('abc'), 0), true);
  assert.equal(countsAsSearch(page('ab'), 0), false);
  assert.equal(countsAsSearch(page('abc'), 20), false);
  assert.equal(countsAsSearch(page(''), 0), false);
  assert.equal(countsAsSearch(page('علی'), 0), true, 'characters, not bytes');
  assert.equal(countsAsSearch(page('🎵🎵'), 0), false, 'two emoji are two characters');
});

/** A fake stats repository recording every write. */
function fakeRepo({ failAdd = false } = {}) {
  const rows = new Map();
  const key = (d, m, x) => `${d}|${m}|${x}`;
  const writes = [];
  return {
    rows, writes,
    async add(date, list) {
      if (failAdd) throw new Error('db down');
      writes.push(['add', date, list]);
      for (const r of list) rows.set(key(date, r.metric, r.dimension), (rows.get(key(date, r.metric, r.dimension)) || 0) + r.value);
    },
    async put(date, list) {
      writes.push(['put', date, list]);
      for (const r of list) rows.set(key(date, r.metric, r.dimension), r.value);
    },
    dimensions: async (date, metric) => [...rows.keys()].filter((k) => k.startsWith(`${date}|${metric}|`)).map((k) => k.split('|')[2]),
    usersCreatedBetween: async () => 2,
    usersCreatedBefore: async () => 10,
    tracksActivatedBetween: async () => 1,
    publishedBetween: async () => [{ channel_id: 7, n: 3 }],
    pruned: [],
    async pruneBefore(d) { this.pruned.push(['before', d]); return 0; },
    async prunePlays(a, b) { this.pruned.push(['plays', a, b]); return 0; },
  };
}

function make(opts) {
  const clock = fakeClock(ts('2026-11-05T10:00:00Z'));
  const repo = fakeRepo(opts);
  const settings = fakeSettings({ time_zone: 'Asia/Tehran', 'stats.aggregated_at': 0, 'stats.pruned_date': '' });
  const warned = [];
  const log = { ...noLog, warn: (e) => warned.push(e) };
  return { clock, repo, settings, warned, svc: createStatsService({ repo, settings, clock, log }) };
}

test('counters are buffered and written once, merged, under the local date', async () => {
  const f = make();
  f.svc.count('search.inline');
  f.svc.count('search.inline');
  f.svc.count('track.play', 12);
  f.svc.count('track.play', 12, 2);
  f.svc.count('track.play', 13);
  assert.equal(f.repo.writes.length, 0, 'nothing written before flush');
  assert.equal(await f.svc.flush(), 3);
  assert.equal(f.repo.writes.length, 1, 'one statement');
  const [, date, list] = f.repo.writes[0];
  assert.equal(date, '2026-11-05');
  assert.deepEqual(list, [
    { metric: 'search.inline', dimension: '', value: 2 },
    { metric: 'track.play', dimension: '12', value: 3 },
    { metric: 'track.play', dimension: '13', value: 1 },
  ]);
  assert.equal(await f.svc.flush(), 0, 'the buffer is empty afterwards');
  assert.equal(f.repo.writes.length, 1);
});

test('flush never throws: analytics can’t break an update', async () => {
  const f = make({ failAdd: true });
  f.svc.count('play.inline');
  assert.equal(await f.svc.flush(), 0);
  assert.deepEqual(f.warned, ['stats_flush_failed']);
  assert.equal(f.svc.pendingSize(), 0, 'dropped, not retried forever');
});

test('aggregate: today and yesterday, overwrite, vanished channels zeroed, throttled to 15 minutes', async () => {
  const f = make();
  await f.repo.put('2026-11-05', [{ metric: 'pub.published', dimension: '9', value: 4 }]); // a channel whose posts were purged
  f.repo.writes.length = 0;
  const r = await f.svc.aggregate();
  assert.deepEqual(r, { days: 2, rows: 9 });
  assert.deepEqual(f.repo.writes.map((w) => [w[0], w[1]]), [['put', '2026-11-04'], ['put', '2026-11-05']]);
  assert.equal(f.repo.rows.get('2026-11-05|pub.published|9'), 0, 'zeroed');
  assert.equal(f.repo.rows.get('2026-11-05|pub.published|7'), 3);
  assert.equal(f.repo.rows.get('2026-11-05|users.total|'), 10);
  f.clock.advance(14 * 60);
  assert.equal(await f.svc.aggregate(), 'skipped');
  assert.notEqual(await f.svc.aggregate({ force: true }), 'skipped', 'the dashboard forces it');
  f.clock.advance(15 * 60);
  assert.notEqual(await f.svc.aggregate(), 'skipped');
});

test('retention runs once per local day: 400 days for everything, 90 for plays per track', async () => {
  const f = make();
  assert.deepEqual(await f.svc.prune(), { old: 0, plays: 0 });
  assert.deepEqual(f.repo.pruned, [['before', '2025-10-01'], ['plays', '2026-06-08', '2026-08-07']]);
  assert.equal(await f.svc.prune(), 'skipped');
  f.clock.advance(12 * 3600); // past Tehran midnight
  assert.notEqual(await f.svc.prune(), 'skipped');
});

test('NOOP_STATS lets services run without analytics', async () => {
  NOOP_STATS.count('anything');
  assert.equal(await NOOP_STATS.dayStart(), 0);
});

test('guard: every metric the code counts is documented in METRICS (and no texts are used as dimensions)', () => {
  const root = new URL('../../tgcloud/', import.meta.url).pathname;
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.js')) files.push(p);
    }
  };
  walk(root);
  const used = new Set();
  for (const p of files) {
    for (const m of readFileSync(p, 'utf8').matchAll(/\bstats\.count\('([a-z_.]+)'(?:,\s*([^)]*))?\)/g)) {
      used.add(m[1]);
      if (m[2] !== undefined) assert.doesNotMatch(m[2], /text|query|\.q\b/, `${p}: ${m[0]} must not use text as a dimension`);
    }
  }
  assert.ok(used.size >= 12, `found ${used.size} counted metrics`);
  for (const m of used) assert.ok(METRICS[m] && METRICS[m].kind === 'event', `${m} is counted but not documented as an event in METRICS`);
  for (const [m, def] of Object.entries(METRICS)) if (def.kind === 'event') assert.ok(used.has(m), `${m} is documented but never counted`);
});
