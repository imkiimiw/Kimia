// Analytics (spec Phase 7). Aggregated numbers only: no per-user rows, no search texts.
// - Event counters: services call count(); the numbers are buffered for this invocation and written
//   by flush() in ONE statement at the end (core/boundary), so the inline answer never waits on them.
// - Derived numbers (new users, users in total, activated tracks, published posts per channel) are
//   recomputed from the tables for today and yesterday by aggregate(): they always equal a direct count.
// - Days are local days in the time_zone setting ('YYYY-MM-DD').
import { dayStart, localDate, addDays } from '../core/util.js';

/**
 * Every metric in stats_daily. kind: 'event' (added up as it happens) or 'derived' (recomputed).
 * dim: what `dimension` holds ('' = a total).
 */
export const METRICS = Object.freeze({
  'users.active': { kind: 'event', dim: '', about: 'distinct users active that day (private chat or inline); counted by a conditional UPDATE of last_seen_at, exactly once per user per day' },
  'search.inline': { kind: 'event', dim: '', about: 'inline queries: first page, 3+ characters, user passed the gate (Telegram sends one per keystroke, so this is more than “searches”)' },
  'search.inline_empty': { kind: 'event', dim: '', about: 'of those, queries with no result' },
  'search.private': { kind: 'event', dim: '', about: 'searches in the bot chat (text or /search)' },
  'search.private_empty': { kind: 'event', dim: '', about: 'of those, searches with no result' },
  'play.inline': { kind: 'event', dim: '', about: 'inline results chosen (needs /setinlinefeedback)' },
  'play.private': { kind: 'event', dim: '', about: 'audios sent in the bot chat (result buttons, t_<id> links)' },
  'track.play': { kind: 'event', dim: 'track id', about: 'both of the above, per track (top tracks); kept 90 days' },
  'fj.gated': { kind: 'event', dim: '', about: 'users stopped by the force-join gate (once until they pass)' },
  'fj.converted': { kind: 'event', dim: '', about: 'gated users who then passed the gate' },
  'source.post': { kind: 'event', dim: 'source id', about: 'audio posts of an enabled source' },
  'source.import': { kind: 'event', dim: 'source id', about: 'tracks created from them' },
  'source.duplicate': { kind: 'event', dim: 'source id', about: 'posts skipped as duplicates' },
  'users.new': { kind: 'derived', dim: '', about: 'users created that day' },
  'users.total': { kind: 'derived', dim: '', about: 'users at the end of that day' },
  'tracks.activated': { kind: 'derived', dim: '', about: 'tracks activated that day' },
  'pub.published': { kind: 'derived', dim: 'channel id', about: 'posts published that day' },
});

export const PERIODS = Object.freeze([1, 7, 30]);
const AGGREGATE_EVERY_SECONDS = 15 * 60;
const KEEP_DAYS = 400;
const KEEP_PLAY_DAYS = 90;
const SEP = '\n';

/** Stand-in for unit tests of services that count something. */
export const NOOP_STATS = Object.freeze({ count() {}, dayStart: async () => 0 });

/**
 * @param {{repo: any, settings: any, clock: any, log: any,
 *   live?: {userStats: () => Promise<any>, trackCounts: () => Promise<any>, channels: () => Promise<any[]>, sources: () => Promise<any[]>}}} deps
 */
export function createStatsService({ repo, settings, clock, log, live }) {
  /** @type {Map<string, number>} */
  const pending = new Map();
  const zone = async () => String((await settings.get('time_zone')) || 'UTC');
  /** Start of the local day after the one starting at `start` (DST-safe). */
  const nextDay = (start, tz) => dayStart(start + 86400 + 3 * 3600, tz);

  /** Derived rows of one local day. */
  async function deriveDay(start, end) {
    const [newUsers, total, activated, published] = await Promise.all([
      repo.usersCreatedBetween(start, end),
      repo.usersCreatedBefore(end),
      repo.tracksActivatedBetween(start, end),
      repo.publishedBetween(start, end),
    ]);
    return {
      totals: [
        { metric: 'users.new', dimension: '', value: newUsers },
        { metric: 'users.total', dimension: '', value: total },
        { metric: 'tracks.activated', dimension: '', value: activated },
      ],
      perChannel: new Map(published.map((r) => [String(r.channel_id), Number(r.n)])),
    };
  }

  const svc = {
    /** Buffers an event; flush() writes it. @param {string} metric @param {string|number} [dimension] */
    count(metric, dimension = '', n = 1) {
      const k = `${metric}${SEP}${dimension}`;
      pending.set(k, (pending.get(k) || 0) + n);
    },
    pendingSize: () => pending.size,

    /** Unix time of local midnight today (or of the day containing `now`). */
    dayStart: async (now = clock.now()) => dayStart(now, await zone()),
    today: async (now = clock.now()) => localDate(now, await zone()),

    /** Writes the buffered counters (one statement). Never throws: analytics must not break an update. */
    async flush() {
      if (!pending.size) return 0;
      const rows = [...pending].map(([k, value]) => {
        const i = k.indexOf(SEP);
        return { metric: k.slice(0, i), dimension: k.slice(i + SEP.length), value };
      });
      pending.clear();
      try {
        await repo.add(await svc.today(), rows);
      } catch (e) {
        log.warn('stats_flush_failed', { error: String((e && e.message) || e).slice(0, 200) });
        return 0;
      }
      return rows.length;
    },

    /**
     * Recomputes the derived numbers of today and yesterday (overwrite; a channel that has no post
     * any more that day gets 0). Throttled to every 15 min unless forced (dashboard).
     */
    async aggregate({ force = false } = {}) {
      const now = clock.now();
      if (!force && now - Number(await settings.get('stats.aggregated_at')) < AGGREGATE_EVERY_SECONDS) return 'skipped';
      const tz = await zone();
      const today = dayStart(now, tz);
      const yesterday = dayStart(today - 1, tz);
      let rows = 0;
      for (const [start, end] of [[yesterday, today], [today, nextDay(today, tz)]]) {
        const date = localDate(start, tz);
        const d = await deriveDay(start, end);
        for (const dim of await repo.dimensions(date, 'pub.published')) if (!d.perChannel.has(dim)) d.perChannel.set(dim, 0);
        const all = [...d.totals, ...[...d.perChannel].map(([dimension, value]) => ({ metric: 'pub.published', dimension, value }))];
        await repo.put(date, all);
        rows += all.length;
      }
      await settings.setInternal('stats.aggregated_at', now);
      return { days: 2, rows };
    },

    /** Retention, once per local day: everything after 400 days, plays per track after 90. */
    async prune() {
      const today = await svc.today();
      if ((await settings.get('stats.pruned_date')) === today) return 'skipped';
      const old = await repo.pruneBefore(addDays(today, -KEEP_DAYS));
      const plays = await repo.prunePlays(addDays(today, -KEEP_PLAY_DAYS - 60), addDays(today, -KEEP_PLAY_DAYS));
      await settings.setInternal('stats.pruned_date', today);
      return { old, plays };
    },

    /** Tick processor. */
    async runTick() {
      const aggregated = await svc.aggregate();
      const pruned = await svc.prune();
      return { aggregated: typeof aggregated === 'string' ? aggregated : aggregated.rows, pruned: typeof pruned === 'string' ? pruned : pruned.old + pruned.plays };
    },

    /**
     * Everything the 📊 dashboard shows for the last `days` local days (today included).
     * Period numbers come from stats_daily (after a forced aggregation); live numbers straight from the tables.
     * @param {number} days one of PERIODS
     */
    async dashboard(days) {
      if (!live) throw new Error('stats.dashboard needs live sources');
      const period = PERIODS.includes(days) ? days : 7;
      await svc.flush();
      await svc.aggregate({ force: true });
      const now = clock.now();
      const tz = await zone();
      const to = localDate(now, tz);
      const from = addDays(to, 1 - period);
      let since = dayStart(now, tz);
      for (let i = 1; i < period; i += 1) since = dayStart(since - 1, tz);
      const [sums, top, users, activeInPeriod, tracks, open, publishedAll, channels, sources] = await Promise.all([
        repo.sums(from, to), repo.topTracks(from, to, 10), live.userStats(), repo.usersSeenSince(since),
        live.trackCounts(), repo.openByChannel(), repo.publishedByChannel(), live.channels(), live.sources(),
      ]);
      /** @type {(metric: string, dim?: string) => number} */
      const sum = (metric, dim) => sums.filter((r) => r.metric === metric && (dim === undefined || r.dimension === dim)).reduce((a, r) => a + Number(r.value), 0);
      const openOf = (id, status) => open.filter((r) => r.channel_id === id && r.status === status).reduce((a, r) => a + Number(r.n), 0);
      return {
        days: period, from, to, since, now, tz,
        users: { total: users.total, blocked: users.blocked, banned: users.banned, new: sum('users.new'), active: activeInPeriod, activeToday: period === 1 ? activeInPeriod : await repo.usersSeenSince(dayStart(now, tz)) },
        search: { inline: sum('search.inline'), inlineEmpty: sum('search.inline_empty'), private: sum('search.private'), privateEmpty: sum('search.private_empty') },
        plays: { inline: sum('play.inline'), private: sum('play.private') },
        fj: { gated: sum('fj.gated'), converted: sum('fj.converted') },
        tracks: { active: tracks.active, total: tracks.total, activated: sum('tracks.activated') },
        top,
        channels: channels.map((c) => ({
          id: c.id, title: c.title, username: c.username, enabled: !!c.enabled, auto: !!c.auto_publish,
          published: sum('pub.published', String(c.id)),
          publishedAll: Number((publishedAll.find((r) => r.channel_id === c.id) || { n: 0 }).n),
          waiting: openOf(c.id, 'pending_approval'), queued: openOf(c.id, 'queued') + openOf(c.id, 'sending'),
          failed: openOf(c.id, 'failed'), uncertain: openOf(c.id, 'uncertain'),
        })),
        sources: sources.map((s) => ({
          id: s.id, title: s.title, username: s.username, enabled: !!s.enabled, mode: s.auto_import,
          posts: sum('source.post', String(s.id)), imported: sum('source.import', String(s.id)), duplicates: sum('source.duplicate', String(s.id)),
          importedAll: Number(s.imported_count) || 0, lastPostAt: Number(s.last_post_at) || 0,
        })),
      };
    },

    /** Per-day numbers for the last `n` days (newest first). */
    async daily(n = 14) {
      await svc.flush();
      await svc.aggregate({ force: true });
      const to = await svc.today();
      const from = addDays(to, 1 - n);
      const rows = await repo.series(from, to, ['users.total', 'users.new', 'users.active', 'search.inline', 'search.private', 'play.inline', 'play.private', 'pub.published']);
      /** @type {{date: string, [metric: string]: any}[]} */
      const days = [];
      for (let i = 0; i < n; i += 1) {
        const date = addDays(to, -i);
        /** @type {Record<string, number>} */
        const v = {};
        for (const r of rows) if (r.date === date) v[r.metric] = Number(r.value);
        days.push({ date, ...v });
      }
      return days;
    },

    /** Most played tracks: the period (stats_daily) and all time (tracks.play_count). */
    async top(days) {
      const period = PERIODS.includes(days) ? days : 7;
      await svc.flush();
      const to = await svc.today();
      const [periodTop, allTime] = await Promise.all([repo.topTracks(addDays(to, 1 - period), to, 15), repo.topAllTime(15)]);
      return { days: period, period: periodTop, allTime };
    },
  };
  return svc;
}
