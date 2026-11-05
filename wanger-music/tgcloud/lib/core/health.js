// Data for 🧪 System Status: live checks (getMe, getWebhookInfo, a DB round trip), counts,
// the last tick, force-join health and the latest errors.
import { VERSION } from './version.js';

/** @param {any} app */
export async function healthReport(app) {
  const t0 = app.clock.ms();
  await app.settings.ping();
  const dbMs = app.clock.ms() - t0;
  const [stats, channels, errors, tickLast, cooldownUntil, tracks, search, destinations] = await Promise.all([
    app.users.stats(),
    app.forcejoin.list(),
    app.alerts.recentErrors(),
    app.settings.get('tick.last'),
    app.settings.get('telegram.cooldown_until'),
    app.catalog.counts(),
    app.search.stats(),
    app.destinations.list(),
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
  return { version: VERSION, me, webhook, dbMs, stats, tracks, search, destinations, channels, errors, tickLast, cooldownUntil: Number(cooldownUntil) || 0, now: app.clock.now() };
}
