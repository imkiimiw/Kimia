// Admin › Overview (VIEW_STATS), Switches and limits + Texts (MANAGE_SETTINGS; the forced-join
// switch is the owner's), Audit log (VIEW_AUDIT). Numbers come only from running counters — no table
// is counted (brief §8: no invented numbers; the platform fails queries that read ≈ 50 000 rows).
import { BUILT_PLATFORMS, DEFAULT_LIMITS, LANGS, PLATFORM_NAMES } from '../config.js';
import * as system from '../db/system.js';
import { LANG_NAMES, t, tp } from '../i18n/index.js';
import { limitsFrom } from '../policy.js';
import { canManageChannels } from '../roles.js';
import * as ui from '../ui.js';
import { clip, tehranDay } from '../util.js';

export const TEXT_KEYS = ['welcome', 'join'];
export const textSettingKey = (key, lang) => `text.${key}.${lang}`;
const MAX_CUSTOM_TEXT = 1000;

export async function overviewScreen(ctx, user) {
  const lang = user.lang;
  const today = tehranDay(ctx.now);
  const week = Array.from({ length: 7 }, (_, i) => tehranDay(ctx.now - i * 86400));
  const pairs = [
    ['users', ''], ['users_blocked', ''], ['groups_active', ''],
    ['users_active', today], ['dl_ok', today], ['dl_failed', today], ['dl_denied', today], ['dl_cached', today],
    ...week.map((d) => ['users_new', d]),
    ...BUILT_PLATFORMS.flatMap((p) => [[`dl_ok:${p}`, today], [`dl_ok:${p}`, ''], [`dl_failed:${p}`, today], [`dl_failed:${p}`, '']]),
  ];
  const v = await system.counterValues(pairs);
  const c = (n, d = '') => v[`${n}|${d}`] || 0;
  const lines = [t(lang, 'adm.ov.users', {
    total: c('users'), active: c('users_active', today), today: c('users_new', today),
    week: week.reduce((a, d) => a + c('users_new', d), 0), blocked: Math.max(0, c('users_blocked')), groups: Math.max(0, c('groups_active')),
  }), '', t(lang, 'adm.ov.downloads', { ok: c('dl_ok', today), failed: c('dl_failed', today), denied: c('dl_denied', today), cached: c('dl_cached', today) })];
  for (const p of BUILT_PLATFORMS) {
    lines.push(t(lang, 'adm.ov.platform', {
      platform: PLATFORM_NAMES[p], ok: c(`dl_ok:${p}`, today), failed: c(`dl_failed:${p}`, today), okAll: c(`dl_ok:${p}`), failedAll: c(`dl_failed:${p}`),
    }));
  }
  return { view: 'admin_overview', screen: { text: lines.join('\n'), reply_markup: ui.markup([ui.navRow(lang, 'A')]) } };
}

const SWITCHES = ['switch.maintenance', 'switch.downloads', 'switch.forced_join', 'switch.group_join', 'limits'];

export async function switchesScreen(user, notice = null) {
  const lang = user.lang;
  const s = await system.loadSettings(SWITCHES);
  const on = (k, dflt) => (s[k] ? s[k].value === true || (s[k].value !== false && dflt) : dflt);
  const maint = on('switch.maintenance', false);
  const dls = on('switch.downloads', true);
  const fj = on('switch.forced_join', true);
  const gj = on('switch.group_join', false);
  const l = limitsFrom(s.limits && s.limits.value);
  const lines = [];
  if (notice) lines.push(notice, '');
  lines.push(t(lang, 'adm.sw.text', {
    maint: tp(lang, maint ? 'adm.on' : 'adm.off'), downloads: tp(lang, dls ? 'adm.on' : 'adm.off'), fj: tp(lang, fj ? 'adm.on' : 'adm.off'), gj: tp(lang, gj ? 'adm.on' : 'adm.off'),
    quota: l.quota_per_day, cooldown: l.cooldown_s, max: l.max_mb,
  }));
  const kb = [
    [ui.button(tp(lang, maint ? 'adm.btn.maint_off' : 'adm.btn.maint_on'), 'A:sm')],
    [ui.button(tp(lang, dls ? 'adm.btn.dl_off' : 'adm.btn.dl_on'), 'A:sd')],
    canManageChannels(user.actor) ? [ui.button(tp(lang, fj ? 'adm.btn.fj_off' : 'adm.btn.fj_on'), 'A:sf')] : [],
    canManageChannels(user.actor) ? [ui.button(tp(lang, gj ? 'adm.btn.gj_off' : 'adm.btn.gj_on'), 'A:sg')] : [],
    [ui.button(tp(lang, 'adm.btn.quota_limit'), 'A:sl:q'), ui.button(tp(lang, 'adm.btn.cooldown'), 'A:sl:c'), ui.button(tp(lang, 'adm.btn.max_mb'), 'A:sl:m')],
    ui.navRow(lang, 'A'),
  ];
  return { view: 'admin_switches', screen: { text: lines.join('\n'), reply_markup: ui.markup(kb) } };
}

/** Flips a switch; the forced-join switches are refused unless the actor is the owner (checked again here). */
export async function toggle(ctx, user, which) {
  const key = { m: 'switch.maintenance', d: 'switch.downloads', f: 'switch.forced_join', g: 'switch.group_join' }[which];
  if ((which === 'f' || which === 'g') && !canManageChannels(user.actor)) return { toast: t(user.lang, 'adm.denied'), alert: true };
  const s = await system.loadSettings([key]);
  const dflt = which === 'd' || which === 'f';
  const current = s[key] ? s[key].value === true || (s[key].value !== false && dflt) : dflt;
  await system.setSetting(key, !current, user.id, ctx.now);
  await system.audit(ctx.now, user.id, 'switch', key, { on: !current });
  return switchesScreen(user);
}

const LIMIT_FIELDS = { q: ['quota_per_day', 0, 10000], c: ['cooldown_s', 0, 3600], m: ['max_mb', 1, 50] };

export function limitPrompt(user, f) {
  const [field, lo, hi] = LIMIT_FIELDS[f];
  return {
    view: 'admin_switches', input: { k: 'sl', a: f },
    screen: { text: t(user.lang, 'adm.sw.limit_prompt', { field: tp(user.lang, 'adm.limit.' + field), lo, hi, dflt: DEFAULT_LIMITS[field] }), reply_markup: ui.markup([[ui.button(tp(user.lang, 'adm.btn.cancel'), 'A:i')]]) },
  };
}

export async function onLimitInput(ctx, user, f, text) {
  const [field, lo, hi] = LIMIT_FIELDS[f] || [];
  const n = /^\d{1,5}$/.test(String(text || '').trim()) ? Number(String(text).trim()) : NaN;
  if (!field || !(n >= lo && n <= hi)) return { error: t(user.lang, 'adm.sw.limit_bad', { lo, hi }) };
  const s = await system.loadSettings(['limits']);
  const next = { ...limitsFrom(s.limits && s.limits.value), [field]: n };
  await system.setSetting('limits', next, user.id, ctx.now);
  await system.audit(ctx.now, user.id, 'limits', field, { value: n });
  return switchesScreen(user, t(user.lang, 'adm.saved'));
}

export async function textsScreen(user, notice = null) {
  const lang = user.lang;
  const keys = TEXT_KEYS.flatMap((k) => LANGS.map((l) => textSettingKey(k, l)));
  const s = await system.loadSettings(keys);
  const lines = [];
  if (notice) lines.push(notice, '');
  lines.push(t(lang, 'adm.tx.title'));
  const kb = [];
  for (const k of TEXT_KEYS) {
    for (const l of LANGS) {
      const custom = !!(s[textSettingKey(k, l)] && s[textSettingKey(k, l)].value);
      lines.push(t(lang, 'adm.tx.line', { key: tp(lang, 'adm.tx.' + k), lang: LANG_NAMES[l], state: tp(lang, custom ? 'adm.tx.custom' : 'adm.tx.default') }));
      const row = [ui.button(`✏️ ${tp(lang, 'adm.tx.' + k)} · ${l.toUpperCase()}`, `A:te:${k}:${l}`)];
      if (custom) row.push(ui.button(`↩️ ${l.toUpperCase()}`, `A:tr:${k}:${l}`));
      kb.push(row);
    }
  }
  kb.push(ui.navRow(lang, 'A'));
  return { view: 'admin_texts', screen: { text: lines.join('\n'), reply_markup: ui.markup(kb) } };
}

export function textPrompt(user, key, lang) {
  return {
    view: 'admin_texts', input: { k: 'te', a: `${key}:${lang}` },
    screen: { text: t(user.lang, 'adm.tx.prompt', { key: tp(user.lang, 'adm.tx.' + key), lang: LANG_NAMES[lang], max: MAX_CUSTOM_TEXT }), reply_markup: ui.markup([[ui.button(tp(user.lang, 'adm.btn.cancel'), 'A:i')]]) },
  };
}

export async function onTextInput(ctx, user, arg, text) {
  const [key, lang] = String(arg || '').split(':');
  const s = String(text || '').trim();
  if (!TEXT_KEYS.includes(key) || !LANGS.includes(lang) || !s) return { error: t(user.lang, 'adm.tx.bad'), done: !s ? false : true };
  if (s.length > MAX_CUSTOM_TEXT) return { error: t(user.lang, 'adm.tx.too_long', { max: MAX_CUSTOM_TEXT }) };
  await system.setSetting(textSettingKey(key, lang), s, user.id, ctx.now);
  await system.audit(ctx.now, user.id, 'text.set', textSettingKey(key, lang), { length: s.length });
  return textsScreen(user, t(user.lang, 'adm.saved'));
}

export async function textReset(ctx, user, key, lang) {
  await system.deleteSetting(textSettingKey(key, lang));
  await system.audit(ctx.now, user.id, 'text.reset', textSettingKey(key, lang), null);
  return textsScreen(user, t(user.lang, 'adm.saved'));
}

const AUDIT_PAGE = 10;
const AUDIT_PAGES = 10;

export async function auditScreen(user, page) {
  const lang = user.lang;
  const p = Math.max(0, Math.min(page, AUDIT_PAGES - 1));
  const rows = await system.auditPage(p * AUDIT_PAGE, AUDIT_PAGE + 1);
  const more = rows.length > AUDIT_PAGE;
  const lines = [t(lang, 'adm.audit.title', { page: p + 1 }), ''];
  if (!rows.length) lines.push(t(lang, 'adm.audit.empty'));
  for (const r of rows.slice(0, AUDIT_PAGE)) {
    lines.push(t(lang, 'adm.audit.line', {
      date: ui.formatTime(r.at), actor: r.actor_id || t(lang, 'adm.audit.bot'), action: r.action,
      target: r.target || '—', details: r.details ? clip(r.details, 80) : '',
    }));
  }
  const pager = [];
  if (p > 0) pager.push(ui.button(tp(lang, 'btn.prev'), `A:a:${p - 1}`));
  if (more && p < AUDIT_PAGES - 1) pager.push(ui.button(tp(lang, 'btn.next'), `A:a:${p + 1}`));
  return { view: 'admin_audit', screen: { text: lines.join('\n'), reply_markup: ui.markup([pager, ui.navRow(lang, 'A')]) } };
}
