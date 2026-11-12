// Background work without a scheduler (brief §7, §11): run after an update's reply is sent
// (piggyback, small budget), and from owner buttons (bigger budget). Order: housekeeping (at most
// every 10 min, elected by compare-and-set) → broadcast slice → one queued channel post → one slice
// of a bulk pack op → daily owner summary / error-spike alert.
import { system } from './db/system.js';
import { users } from './db/users.js';
import { ops as opsDb } from './db/packs.js';
import { transfer as tdb } from './db/transfer.js';
import { dayKey, dayStart } from './core/util.js';
import { t, dateText } from './i18n/index.js';
import { T, OWNER_ID } from './config.js';

async function housekeeping(app) {
  const now = app.clock.now();
  const last = Number(app.settings.get('hk.last_at') || 0);
  if (now - last < T.housekeepingEverySec) return null;
  // elect one invocation: insert-or-CAS on the timestamp
  const won = app.settings.has('hk.last_at') ? await system.casSetting('hk.last_at', last, now, now) : await system.claimSetting('hk.last_at', now, now);
  if (!won) return null;
  const out = {
    expired: await system.pruneExpired(now),
    updates: await system.pruneUpdates(now - T.processedKeepSec),
    errors: await system.pruneErrors(T.errorsKeep),
    buckets: await system.pruneBuckets(now - 86400),
    usage: await users.pruneUsage(dayKey(now - 40 * 86400)),
    ops: await opsDb.pruneOld(now - 7 * 86400),
    transfer: await tdb.pruneExpired(now),
    audit: await system.pruneAudit(20000),
  };
  app.log.info('housekeeping', { count: Object.values(out).reduce((a, b) => a + b, 0) });
  return out;
}

async function ownerNotices(app) {
  const now = app.clock.now();
  if (app.settings.get('notify.errors')) {
    const n = await system.errorsSince(now - 600);
    if (n >= 10) await app.alerts.owner('errors:spike', (lang) => t(lang, 'alert.error_spike', { n }), 3600);
  }
  if (app.settings.get('notify.daily')) {
    const today = dayKey(now);
    const yesterday = dayKey(dayStart(now) - 3600);
    // once a day, from the first activity after 09:00 Tehran
    if (now - dayStart(now) >= 9 * 3600 && (await system.claimAlert(`daily:${today}`, now, 20 * 3600))) {
      const m = Object.fromEntries((await system.statsOfDay(yesterday)).map((r) => [r.metric, r.value]));
      const u = await users.stats(now, dayStart(now));
      const owner = await users.get(OWNER_ID);
      const lang = owner && owner.lang === 'en' ? 'en' : 'fa';
      const sum = (prefix) => Object.entries(m).filter(([k]) => k.startsWith(prefix)).reduce((a, [, v]) => a + v, 0);
      try {
        await app.tg.send(OWNER_ID, { text: t(lang, 'alert.daily', {
          day: dateText(dayStart(now) - 3600, lang, false), users: u.total, active: u.active_7, packs: m['pack.created'] || 0,
          stickers: sum('sticker.added.'), requests: m['pub.requested'] || 0, published: m['pub.published'] || 0, blocked: m['gate.blocked'] || 0,
        }) }, 'daily_summary');
      } catch (e) {
        app.log.warn('daily_summary_failed', { error: String(e && e.description).slice(0, 120) });
      }
    }
  }
}

/**
 * @param {any} app @param {{budgetMs: number}} opts
 * @returns {Promise<Record<string, any>>}
 */
export async function runTick(app, { budgetMs }) {
  const deadlineMs = app.clock.ms() + budgetMs;
  const out = {};
  const step = async (name, fn) => {
    if (app.clock.ms() >= deadlineMs) return;
    try {
      out[name] = await fn();
    } catch (e) {
      out[name] = 'error';
      await app.alerts.recordError(`tick:${name}`, null, e);
    }
  };
  await step('housekeeping', () => housekeeping(app));
  await step('broadcast', () => app.broadcast.runBatch({ deadlineMs, max: budgetMs > T.piggybackBudgetMs ? undefined : 10 }));
  await step('publish', () => app.publish.drain());
  await step('ops', async () => {
    const r = await app.ops.step({ deadlineMs });
    if (r && r.op) await app.opsNotify(r.op, r.stopped);
    return r ? r.stopped : null;
  });
  await step('notices', () => ownerNotices(app));
  return out;
}
