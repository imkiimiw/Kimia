// The owner's minimal panel for Phase 3 (brief §11.3): switch platforms and their methods on and
// off, pause a platform instantly, run a health check. Owner only (it moves into the full admin
// panel with roles in Phase 4); lib/router.js calls canUsePanel() on every command and button.
// Every method starts OFF; switching on a public/third-party/external method shows the adapter's
// risk note first, and every change is audit-logged.
import * as system from './db/system.js';
import { t } from './i18n/index.js';
import * as registry from './platforms/index.js';
import { platformState } from './policy.js';
import { isOwnerId } from './roles.js';
import * as ui from './ui.js';

export const canUsePanel = (user) => !!user && isOwnerId(user.id);
export const NEEDS_RISK_NOTE = ['public', 'thirdparty', 'external'];

const key = (id) => 'platform:' + id;

async function stateOf(id) {
  const s = await system.loadSettings([key(id)]);
  return platformState(s[key(id)] && s[key(id)].value);
}

export async function listScreen(user) {
  const s = await system.loadSettings(registry.ADAPTERS.map((a) => key(a.id)));
  const rows = registry.ADAPTERS.map((adapter) => ({ adapter, state: platformState(s[key(adapter.id)] && s[key(adapter.id)].value) }));
  return { view: 'admin', screen: ui.adminPlatforms(user.lang, rows, registry.STUBS.map((x) => x.id)) };
}

export async function platformScreen(user, id, healthLine = null) {
  const adapter = registry.byId(id);
  return { view: 'admin_platform', screen: ui.adminPlatform(user.lang, adapter, await stateOf(id), healthLine) };
}

/**
 * Switches a method. Switching ON a method with a risk note needs `confirmed` (the note was shown);
 * otherwise the note is returned to show. → { view, screen, toast? }
 */
export async function setMethod(ctx, user, id, method, on, confirmed) {
  const adapter = registry.byId(id);
  if (!adapter.methodOrder.includes(method)) return platformScreen(user, id);
  if (on && NEEDS_RISK_NOTE.includes(method) && !confirmed) return { view: 'admin_risk', screen: ui.adminRisk(user.lang, adapter, method) };
  const state = await stateOf(id);
  state.methods[method] = on;
  await system.setSetting(key(id), state, user.id, ctx.now);
  await system.audit(ctx.now, user.id, on ? 'platform.method_on' : 'platform.method_off', id, { method });
  const names = { method: t(user.lang, 'method.' + method), platform: adapter.name };
  return { ...(await platformScreen(user, id)), toast: t(user.lang, on ? 'admin.saved_on' : 'admin.saved_off', names) };
}

export async function setPaused(ctx, user, id, paused) {
  const adapter = registry.byId(id);
  const state = await stateOf(id);
  state.paused = paused;
  await system.setSetting(key(id), state, user.id, ctx.now);
  await system.audit(ctx.now, user.id, paused ? 'platform.pause' : 'platform.resume', id, null);
  return { ...(await platformScreen(user, id)), toast: t(user.lang, paused ? 'admin.paused' : 'admin.resumed', { platform: adapter.name }) };
}

/** Runs the adapter's health check (its first method) and shows the result on the platform screen. */
export async function health(ctx, user, id) {
  const adapter = registry.byId(id);
  let r;
  try {
    r = await adapter.healthCheck(ctx, adapter.methodOrder[0]);
  } catch (err) {
    r = { ok: false, detail: (err && err.message) || 'error' };
  }
  const line = t(user.lang, r.ok ? 'admin.health_ok' : 'admin.health_fail', { platform: adapter.name, detail: String(r.detail || '').slice(0, 120) });
  return platformScreen(user, id, line);
}
