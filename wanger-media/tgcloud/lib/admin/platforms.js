// Admin › Platforms (needs MANAGE_PLATFORMS; checked by lib/admin/index.js before anything here):
// methods on/off (the adapter's risk note first for public / third-party / external), pause a
// platform instantly, health check, recent failures, and the owner tools of brief §6 — blocklist
// (URL / account / domain) and purging cached file_ids for a URL. Every change is audit-logged.
import { BUILT_PLATFORMS } from '../config.js';
import * as admin from '../db/admin.js';
import * as downloadsDb from '../db/downloads.js';
import * as system from '../db/system.js';
import { t, tp } from '../i18n/index.js';
import * as registry from '../platforms/index.js';
import { platformState } from '../policy.js';
import * as ui from '../ui.js';
import { isPublicHostname, parseUrl } from '../url.js';
import { clip } from '../util.js';

export const NEEDS_RISK_NOTE = ['public', 'thirdparty', 'external'];
const ACCOUNT_RE = new RegExp(`^(${BUILT_PLATFORMS.join('|')}):@?([A-Za-z0-9_.-]{1,60})$`);

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

/** The latest failed downloads of a platform, with their reasons. */
export async function failuresScreen(user, id) {
  const adapter = registry.byId(id);
  const rows = await admin.recentFailures(id, 10);
  const lines = [t(user.lang, 'adm.fail.title', { platform: adapter.name }), ''];
  if (!rows.length) lines.push(t(user.lang, 'adm.fail.none'));
  for (const r of rows) lines.push(t(user.lang, 'adm.fail.line', { date: ui.formatTime(r.created_at), reason: r.reason || '?', url: clip(r.url || '', 70) }));
  return { view: 'admin_failures', screen: { text: lines.join('\n'), reply_markup: ui.markup([ui.navRow(user.lang, 'P:' + id)]) } };
}

export async function blocklistScreen(user, notice = null) {
  const lang = user.lang;
  const rows = await admin.blocklistPage(20);
  const lines = [t(lang, 'adm.block.title'), ''];
  if (notice) lines.unshift(notice, '');
  if (!rows.length) lines.push(t(lang, 'adm.block.empty'));
  const kb = [];
  for (const r of rows) {
    lines.push(t(lang, 'adm.block.line', { kind: tp(lang, 'adm.block.kind.' + r.kind), value: r.value }));
    kb.push([ui.button('🗑 ' + clip(r.value, 40), 'A:pbd:' + r.id)]);
  }
  kb.push(['url', 'account', 'domain'].map((k) => ui.button('➕ ' + tp(lang, 'adm.block.kind.' + k), 'A:pba:' + k)));
  kb.push(ui.navRow(lang, 'A:p'));
  return { view: 'admin_blocklist', screen: { text: lines.join('\n'), reply_markup: ui.markup(kb) } };
}

/**
 * Turns the staff member's text into a blocklist value, or null:
 *   url     — a post link of a built platform → "platform:id" (every link form of the post matches)
 *   account — "platform:name" (e.g. x:SpaceX) or a post link that names its account
 *   domain  — a host or any URL → its host
 */
export function blockValue(kind, text) {
  const s = String(text || '').trim();
  if (kind === 'url' || kind === 'account') {
    const m = ACCOUNT_RE.exec(s);
    if (kind === 'account' && m) return `${m[1]}:${m[2].toLowerCase()}`;
    const id = registry.identify(/^https?:\/\//i.test(s) ? s : 'https://' + s);
    if (id.kind !== 'post') return null;
    if (kind === 'url') return id.ref.key || null;
    return id.ref.account || null;
  }
  const u = parseUrl(/^https?:\/\//i.test(s) ? s : 'https://' + s);
  return u && isPublicHostname(u.host) ? u.host.replace(/^www\./, '') : null;
}

export async function blockAdd(ctx, user, kind, text) {
  const value = blockValue(kind, text);
  if (!value) return { error: t(user.lang, 'adm.block.bad.' + kind) };
  const added = await admin.blocklistAdd(kind, value, null, user.id, ctx.now);
  if (added) await system.audit(ctx.now, user.id, 'block.add', value, { kind });
  return blocklistScreen(user, t(user.lang, added ? 'adm.block.added' : 'adm.block.exists', { value }));
}

export async function blockRemove(ctx, user, entryId) {
  const r = await admin.blocklistRemove(entryId);
  if (r) await system.audit(ctx.now, user.id, 'block.remove', r.value, { kind: r.kind });
  return blocklistScreen(user, r ? t(user.lang, 'adm.block.removed', { value: r.value }) : null);
}

/** Purges cached file_ids for a post link (any link form of the post). */
export async function purge(ctx, user, text) {
  const s = String(text || '').trim();
  const id = registry.identify(/^https?:\/\//i.test(s) ? s : 'https://' + s);
  if (id.kind !== 'post' || !id.ref.key) return { error: t(user.lang, 'adm.purge.bad') };
  const n = await admin.cacheCount(id.ref.key);
  await downloadsDb.cacheDrop(id.ref.key);
  await system.audit(ctx.now, user.id, 'cache.purge', id.ref.key, { variants: n });
  return { ...(await listScreen(user)), notice: t(user.lang, 'adm.purge.done', { n, key: id.ref.key }) };
}
