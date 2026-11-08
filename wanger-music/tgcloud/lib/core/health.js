// Data for 🧪 System Status: live checks (getMe, getWebhookInfo, a DB round trip), counts,
// the last tick, force-join health and the latest errors. Phase 8 monitoring: healthWarnings()
// (shown on System Status) and the tick processor runMonitor() (throttled owner alerts).
import { VERSION } from './version.js';
import { LIMITS } from '../config/static.js';
import { t } from '../i18n/index.js';

/** Warning kinds that also alert the owner (the rest are shown on System Status only). */
const ALERTED = new Set(['errors', 'pub_failed', 'no_language', 'schedule_stopped', 'cooldown', 'webhook_sync', 'webhook_pending', 'webhook_error']);
const int = (v) => (Number.isSafeInteger(Number(v)) && Number(v) >= 0 ? Number(v) : 0);

/**
 * Stores what the CLI reported about the webhook (the GitHub Actions job runs `tgcloud webhook`
 * and passes it to endpoints/opsTick: the bot itself may not call getWebhookInfo here).
 * @param {any} app @param {any} w {in_sync, pending, last_error, last_error_at}
 */
export async function recordWebhookCheck(app, w) {
  const clean = {
    at: app.clock.now(),
    in_sync: w && w.in_sync === true,
    pending: int(w && w.pending),
    last_error: w && typeof w.last_error === 'string' && w.last_error ? w.last_error.slice(0, 200) : null,
    last_error_at: int(w && w.last_error_at) || null,
  };
  await app.settings.setInternal('monitor.webhook', clean);
  return clean;
}

/**
 * Problems worth the owner's attention, from live data ("rising failures": errors in the last
 * hour, publication failures in the last day), plus the scheduled tick and the webhook report.
 * @param {any} app @returns {Promise<{key: string, vars: Record<string, any>}[]>}
 */
export async function healthWarnings(app) {
  const now = app.clock.now();
  const [errors, pubBroken, scheduledAt, cooldownUntil, webhook, undecided] = await Promise.all([
    app.repos.system.errorsSince(now - 3600, 500),
    app.repos.publications.brokenSince(now - 86400),
    app.settings.get('monitor.github_at'),
    app.settings.get('telegram.cooldown_until'),
    app.settings.get('monitor.webhook'),
    app.catalog.countUndecidedActive(),
  ]);
  /** @type {{key: string, vars: Record<string, any>}[]} */
  const out = [];
  if (errors >= LIMITS.monitorErrorsPerHour) out.push({ key: 'errors', vars: { n: errors } });
  if (pubBroken >= LIMITS.monitorPubFailuresPerDay) out.push({ key: 'pub_failed', vars: { n: pubBroken } });
  if (undecided > 0) out.push({ key: 'no_language', vars: { n: undecided } });
  const sched = Number(scheduledAt) || 0;
  // the GitHub job is optional (publishing is manual by default): never set up → a note on System
  // Status only; it ran and then stopped → an alert, since someone relied on it
  if (!sched) out.push({ key: 'no_schedule', vars: {} });
  else if (now - sched > LIMITS.monitorTickStaleSeconds) out.push({ key: 'schedule_stopped', vars: { h: Math.floor((now - sched) / 3600) } });
  if ((Number(cooldownUntil) || 0) - now > LIMITS.monitorCooldownSeconds) out.push({ key: 'cooldown', vars: { m: Math.ceil(((Number(cooldownUntil) || 0) - now) / 60) } });
  const w = /** @type {any} */ (webhook);
  if (w && w.at && now - w.at <= LIMITS.monitorTickStaleSeconds) {
    if (!w.in_sync) out.push({ key: 'webhook_sync', vars: {} });
    if (w.pending >= LIMITS.monitorWebhookPending) out.push({ key: 'webhook_pending', vars: { n: w.pending } });
    if (w.last_error && w.last_error_at && now - w.last_error_at <= 3600) out.push({ key: 'webhook_error', vars: { error: w.last_error } });
  }
  return out;
}

/** Tick processor: alerts the owner about each warning kind at most every 3 hours. */
export async function runMonitor(app) {
  const warnings = await healthWarnings(app);
  let sent = 0;
  for (const w of warnings) {
    if (!ALERTED.has(w.key)) continue;
    if (await app.alerts.owner(`mon:${w.key}`, (lang) => t(lang, 'mon.alert', { text: { __html: t(lang, `mon.${w.key}`, w.vars) } }), LIMITS.alertMonitorEverySeconds)) sent += 1;
  }
  return { warnings: warnings.map((w) => w.key), sent };
}

/** @param {any} app */
export async function healthReport(app) {
  const t0 = app.clock.ms();
  await app.settings.ping();
  const dbMs = app.clock.ms() - t0;
  const [stats, channels, errors, tickLast, cooldownUntil, tracks, search, destinations, publications, backupLast, backupWeekly, warnings, webhookCheck] = await Promise.all([
    app.users.stats(),
    app.forcejoin.list(),
    app.alerts.recentErrors(),
    app.settings.get('tick.last'),
    app.settings.get('telegram.cooldown_until'),
    app.catalog.counts(),
    app.search.stats(),
    app.destinations.list(),
    app.publisher.counts(),
    app.settings.get('backup.last'),
    app.settings.get('backup.weekly'),
    healthWarnings(app),
    app.settings.get('monitor.webhook'),
  ]);
  let me = null;
  try {
    me = await app.tg.getMe();
  } catch {
    me = null;
  }
  /** @type {any} */
  let webhook;
  try {
    webhook = { info: await app.tg.getWebhookInfo() };
  } catch (e) {
    webhook = { restricted: e && e.code === 403, error: String((e && e.description) || e).slice(0, 120) };
  }
  return { version: VERSION, me, webhook, dbMs, stats, tracks, search, destinations, publications, channels, errors, tickLast, cooldownUntil: Number(cooldownUntil) || 0, backup: { last: backupLast || null, weekly: !!backupWeekly }, warnings, webhookCheck: webhookCheck || null, now: app.clock.now() };
}
