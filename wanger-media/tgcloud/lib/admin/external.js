// Admin › Platforms › 🔌 External service (owner only — it is the owner's server, key and money;
// checked by lib/admin/index.js and again here). Address, key (never shown again; the owner's
// message carrying it is deleted at once), large-file relay on/off and its size limit, a health
// test, removal. Every change is audit-logged without the key.
import { MB } from '../config.js';
import * as system from '../db/system.js';
import * as ext from '../external.js';
import { t, tp } from '../i18n/index.js';
import { canManageChannels } from '../roles.js';
import * as tg from '../tg.js';
import * as ui from '../ui.js';
import { parseUrl } from '../url.js';

const PROMPTS = { zu: 'adm.ext.url_prompt', zk: 'adm.ext.key_prompt', zm: 'adm.ext.max_prompt' };
const denied = (user) => ({ toast: t(user.lang, 'adm.denied'), alert: true });

async function load() {
  const s = await system.loadSettings([ext.SETTING]);
  const v = s[ext.SETTING] && s[ext.SETTING].value;
  return v && typeof v === 'object' ? v : {};
}
const save = (ctx, user, v) => system.setSetting(ext.SETTING, v, user.id, ctx.now);

export async function screen(user, notice = null) {
  if (!canManageChannels(user.actor)) return denied(user);
  const lang = user.lang;
  const v = await load();
  const url = ext.normalizeBase(v.url);
  const text = (notice ? notice + '\n\n' : '') + t(lang, 'adm.ext.title', {
    url: url || tp(lang, 'adm.ext.none'),
    key: tp(lang, ext.validKey(v.key) ? 'adm.ext.key_saved' : 'adm.ext.none'),
    relay: tp(lang, v.relay ? 'adm.on' : 'adm.off'),
    max: Number.isInteger(v.max_mb) ? v.max_mb : ext.RELAY_DEFAULT_MB,
  });
  const kb = [
    [ui.button(tp(lang, 'adm.btn.ext_url'), 'A:zu'), ui.button(tp(lang, 'adm.btn.ext_key'), 'A:zk')],
    [ui.button(tp(lang, v.relay ? 'adm.btn.ext_relay_off' : 'adm.btn.ext_relay_on'), 'A:zr'), ui.button(tp(lang, 'adm.btn.ext_max'), 'A:zm')],
    [ui.button(tp(lang, 'adm.btn.ext_test'), 'A:zt'), ui.button(tp(lang, 'adm.btn.ext_clear'), 'A:zx')],
    ui.navRow(lang, 'A:p'),
  ];
  return { view: 'admin_external', screen: { text, reply_markup: ui.markup(kb) } };
}

export function prompt(user, k) {
  if (!canManageChannels(user.actor)) return denied(user);
  return {
    view: 'admin_external', input: { k },
    screen: { text: t(user.lang, PROMPTS[k], { lo: ext.RELAY_MIN_MB, hi: ext.RELAY_MAX_MB }), reply_markup: ui.markup([[ui.button(tp(user.lang, 'adm.btn.cancel'), 'A:i')]]) },
  };
}

export async function onInput(ctx, user, k, msg) {
  if (!canManageChannels(user.actor)) return { error: t(user.lang, 'adm.denied'), done: true };
  const text = String(msg.text || '').trim();
  const v = await load();
  if (k === 'zk') {
    // The key must not stay in the chat: delete the owner's message first, whatever happens next.
    try { await tg.call(ctx, 'admin_external', 'deleteMessage', { chat_id: msg.chat.id, message_id: msg.message_id }); } catch { /* too old or gone */ }
    if (!ext.validKey(text)) return { error: t(user.lang, 'adm.ext.bad_key') };
    await save(ctx, user, { ...v, key: text });
    await system.audit(ctx.now, user.id, 'external.key', null, null);
    return screen(user, t(user.lang, 'adm.ext.key_stored'));
  }
  if (k === 'zu') {
    const url = ext.normalizeBase(text);
    if (!url) return { error: t(user.lang, 'adm.ext.bad_url') };
    await save(ctx, user, { ...v, url });
    await system.audit(ctx.now, user.id, 'external.url', parseUrl(url).host, null);
    return screen(user, t(user.lang, 'adm.saved'));
  }
  const n = /^\d{2,4}$/.test(text) ? Number(text) : NaN;
  if (!(n >= ext.RELAY_MIN_MB && n <= ext.RELAY_MAX_MB)) return { error: t(user.lang, 'adm.ext.bad_max', { lo: ext.RELAY_MIN_MB, hi: ext.RELAY_MAX_MB }) };
  await save(ctx, user, { ...v, max_mb: n });
  await system.audit(ctx.now, user.id, 'external.max_mb', null, { value: n });
  return screen(user, t(user.lang, 'adm.saved'));
}

export async function toggleRelay(ctx, user) {
  if (!canManageChannels(user.actor)) return denied(user);
  const v = await load();
  if (!v.relay && !ext.configFrom(v)) return { toast: t(user.lang, 'adm.ext.need_config'), alert: true };
  await save(ctx, user, { ...v, relay: !v.relay });
  await system.audit(ctx.now, user.id, 'external.relay', null, { on: !v.relay });
  return screen(user);
}

export async function test(ctx, user) {
  if (!canManageChannels(user.actor)) return denied(user);
  const cfg = ext.configFrom(await load());
  if (!cfg) return { toast: t(user.lang, 'adm.ext.need_config'), alert: true };
  const r = await ext.health(ctx, cfg);
  await system.audit(ctx.now, user.id, 'external.test', cfg.host, { ok: r.ok });
  const lang = user.lang;
  const notice = r.ok
    ? t(lang, 'adm.ext.test_ok', { version: r.version, relay: r.relayMax ? `${Math.floor(r.relayMax / MB)} MB` : tp(lang, 'adm.off'), resolve: tp(lang, r.resolve ? 'adm.on' : 'adm.off') })
    : t(lang, 'adm.ext.test_fail', { detail: String(r.detail || '').slice(0, 80) });
  return screen(user, notice);
}

export async function clear(ctx, user) {
  if (!canManageChannels(user.actor)) return denied(user);
  await system.deleteSetting(ext.SETTING);
  await system.audit(ctx.now, user.id, 'external.clear', null, null);
  return screen(user, t(user.lang, 'adm.ext.cleared'));
}

/** Is the service usable (address and key set)? For the platform screen's 'external' switch. */
export const isConfigured = async () => !!ext.configFrom(await load());
