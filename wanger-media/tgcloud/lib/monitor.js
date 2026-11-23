// Watching the bot without a scheduler: both jobs piggyback on ordinary updates (lib/router.js).
//   health — at most every HEALTH_EVERY_S one switched-on platform (the least recently checked) runs
//            its health check; the result is kept in settings ('health:<id>'). Two failures in a
//            row alert the owner; the first success after an alert says it works again.
//   report — the first update of a Tehran day sends the owner yesterday's numbers (counters only),
//            unless the owner switched it off ('switch.daily_report').
import { BUILT_PLATFORMS, OWNER_ID, PLATFORM_NAMES } from './config.js';
import * as system from './db/system.js';
import * as users from './db/users.js';
import { alertOwner } from './alerts.js';
import { normLang, t } from './i18n/index.js';
import * as registry from './platforms/index.js';
import { platformState } from './policy.js';
import * as tg from './tg.js';
import { tehranDay } from './util.js';

export const HEALTH_EVERY_S = 20 * 60;
export const HEALTH_TICK = 'health.tick';
export const REPORT_DAY = 'report.day';
export const REPORT_SWITCH = 'switch.daily_report';
/** Don't start a check this late in the invocation (≈ 30 s wall limit; checks can take seconds). */
const LATE_MS = 8000;
const healthKey = (id) => 'health:' + id;

/** Platforms with a method on and not paused, from loaded settings. */
function enabledAdapters(s) {
  return registry.ADAPTERS.filter((a) => {
    const st = platformState(s['platform:' + a.id] && s['platform:' + a.id].value);
    return !st.paused && a.methodOrder.some((m) => st.methods[m] === true);
  });
}

export async function healthPiggyback(ctx, settings) {
  const tick = settings[HEALTH_TICK];
  if (tick && tick.updatedAt > ctx.now - HEALTH_EVERY_S) return null;
  if (Date.now() - ctx.nowMs > LATE_MS) return null;
  if (!(await system.claimThrottle(HEALTH_TICK, ctx.now, HEALTH_EVERY_S))) return null;
  const s = await system.loadSettings(BUILT_PLATFORMS.flatMap((p) => ['platform:' + p, healthKey(p)]));
  const list = enabledAdapters(s);
  if (!list.length) return { checked: null };
  const last = (a) => (s[healthKey(a.id)] && s[healthKey(a.id)].value && s[healthKey(a.id)].value.at) || 0;
  const adapter = list.slice().sort((x, y) => last(x) - last(y))[0];
  const st = platformState(s['platform:' + adapter.id].value);
  const method = adapter.methodOrder.find((m) => st.methods[m] === true) || adapter.methodOrder[0];
  let r;
  try {
    r = await adapter.healthCheck({ trace: ctx.trace, now: ctx.now, nowMs: ctx.nowMs }, method);
  } catch (err) {
    r = { ok: false, detail: (err && err.message) || 'error' };
  }
  const prev = (s[healthKey(adapter.id)] && s[healthKey(adapter.id)].value) || {};
  const fails = r.ok ? 0 : (prev.fails || 0) + 1;
  const alerted = r.ok ? false : prev.alerted || fails >= 2;
  await system.setSetting(healthKey(adapter.id), { ok: !!r.ok, at: ctx.now, detail: String(r.detail || '').slice(0, 120), fails, alerted }, 0, ctx.now);
  const vars = { platform: PLATFORM_NAMES[adapter.id], detail: String(r.detail || '').slice(0, 80) };
  if (!r.ok && fails === 2) await alertOwner(ctx, 'health:' + adapter.id, 'alert.health_fail', vars, 1).catch(() => {});
  if (r.ok && prev.alerted) await alertOwner(ctx, 'health_ok:' + adapter.id, 'alert.health_ok', vars, 1).catch(() => {});
  return { checked: adapter.id, ok: !!r.ok };
}

/** The last health result of a platform, for the admin screen: { ok, at, detail } or null. */
export async function lastHealth(id) {
  const s = await system.loadSettings([healthKey(id)]);
  return (s[healthKey(id)] && s[healthKey(id)].value) || null;
}

export async function reportPiggyback(ctx, settings) {
  const today = tehranDay(ctx.now);
  const r = settings[REPORT_DAY];
  if (r && r.value === today) return null;
  if (settings[REPORT_SWITCH] && settings[REPORT_SWITCH].value === false) return null;
  if (!(await system.claimValue(REPORT_DAY, today, ctx.now))) return null;
  if (!r) return { reportFrom: today }; // the very first update only starts the calendar: no report yet
  const day = tehranDay(ctx.now - 86400);
  const names = ['users_new', 'users_active', 'dl_ok', 'dl_meta', 'dl_failed', 'dl_denied', 'dl_cached', 'groups_joined', 'vip_sales', 'vip_stars', 'ref_credited'];
  const v = await system.counterValues([
    ...names.map((n) => [n, day]), ['users', ''], ['users_blocked', ''], ['groups_active', ''],
    ...BUILT_PLATFORMS.flatMap((p) => [[`dl_ok:${p}`, day], [`dl_meta:${p}`, day], [`dl_failed:${p}`, day]]),
  ]);
  const c = (n, d = day) => v[`${n}|${d}`] || 0;
  const top = BUILT_PLATFORMS.map((p) => ({ p, ok: c(`dl_ok:${p}`) + c(`dl_meta:${p}`), failed: c(`dl_failed:${p}`) }))
    .filter((x) => x.ok || x.failed).sort((a, b) => b.ok - a.ok).slice(0, 5);
  const lang = normLang(await users.langOf(OWNER_ID)) || 'en';
  const lines = [t(lang, 'report.daily', {
    day, total: c('users', ''), new: c('users_new'), active: c('users_active'), blocked: Math.max(0, c('users_blocked', '')),
    groups: Math.max(0, c('groups_active', '')), joined: c('groups_joined'),
    ok: c('dl_ok'), meta: c('dl_meta'), failed: c('dl_failed'), denied: c('dl_denied'), cached: c('dl_cached'),
    errors: await system.errorsSince(ctx.now - 86400), sales: c('vip_sales'), stars: c('vip_stars'), refs: c('ref_credited'),
  })];
  for (const x of top) lines.push(t(lang, 'report.platform', { platform: PLATFORM_NAMES[x.p], ok: x.ok, failed: x.failed }));
  try {
    await tg.send(ctx, 'owner_report', OWNER_ID, { text: lines.join('\n') });
  } catch { /* the owner can't be reached right now */ }
  return { reported: day };
}
