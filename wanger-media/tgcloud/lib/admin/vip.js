// Admin › ⭐ VIP & invitations (owner only: prices and refunds are the owner's money). VIP sales
// on/off, price in Stars, days, the VIP quota and cooldown, the latest payments with refunds
// (confirmed first), and the invitations switch. Every change is audit-logged.
import { REF_BONUS, REF_CAP } from '../config.js';
import * as payments from '../db/payments.js';
import * as system from '../db/system.js';
import { t, tp } from '../i18n/index.js';
import * as referral from '../referral.js';
import { canManageChannels } from '../roles.js';
import * as ui from '../ui.js';
import * as vip from '../vip.js';

const denied = (user) => ({ toast: t(user.lang, 'adm.denied'), alert: true });
const onOff = (lang, v) => tp(lang, v ? 'adm.on' : 'adm.off');

async function state() {
  const s = await system.loadSettings([vip.SETTING, referral.SWITCH]);
  return { cfg: vip.configFrom(s[vip.SETTING] && s[vip.SETTING].value), refOn: referral.enabled(s) };
}

export async function screen(user, notice = null) {
  if (!canManageChannels(user.actor)) return denied(user);
  const lang = user.lang;
  const { cfg, refOn } = await state();
  const total = (await system.counterValues([['vip_stars', '']]))['vip_stars|'] || 0;
  const rows = await payments.recent(8);
  const lines = [];
  if (notice) lines.push(notice, '');
  lines.push(t(lang, 'adm.vip.title', {
    sales: onOff(lang, cfg.on), stars: cfg.stars, days: cfg.days, quota: cfg.quota, cooldown: cfg.cooldown_s,
    total, ref: onOff(lang, refOn), bonus: REF_BONUS, cap: REF_CAP,
  }));
  if (rows.length) lines.push('', t(lang, 'adm.vip.payments'));
  const kb = [
    [ui.button(tp(lang, cfg.on ? 'adm.btn.vip_off' : 'adm.btn.vip_on'), 'A:vt')],
    [ui.button(tp(lang, 'adm.btn.vip_price'), 'A:vi:p'), ui.button(tp(lang, 'adm.btn.vip_days'), 'A:vi:d')],
    [ui.button(tp(lang, 'adm.btn.vip_quota'), 'A:vi:q'), ui.button(tp(lang, 'adm.btn.vip_cooldown'), 'A:vi:c')],
    [ui.button(tp(lang, refOn ? 'adm.btn.ref_off' : 'adm.btn.ref_on'), 'A:vf')],
  ];
  for (const p of rows) {
    lines.push(t(lang, 'adm.vip.payment', { date: ui.formatTime(p.created_at), user: p.user_id, stars: p.stars, days: p.days, state: p.refunded ? tp(lang, 'adm.vip.refunded') : '' }));
    if (!p.refunded) kb.push([ui.button(tp(lang, 'adm.btn.vip_refund', { user: p.user_id, stars: p.stars }), 'A:vr:' + p.id)]);
  }
  kb.push(ui.navRow(lang, 'A'));
  return { view: 'admin_vip', screen: { text: lines.join('\n'), reply_markup: ui.markup(kb) } };
}

export function prompt(user, f) {
  if (!canManageChannels(user.actor)) return denied(user);
  const [field, lo, hi] = vip.FIELDS[f];
  return {
    view: 'admin_vip', input: { k: 'vi', a: f },
    screen: { text: t(user.lang, 'adm.vip.prompt', { field: tp(user.lang, 'adm.vip.field.' + field), lo, hi }), reply_markup: ui.markup([[ui.button(tp(user.lang, 'adm.btn.cancel'), 'A:i')]]) },
  };
}

export async function onInput(ctx, user, f, text) {
  if (!canManageChannels(user.actor)) return { error: t(user.lang, 'adm.denied'), done: true };
  const [field, lo, hi] = vip.FIELDS[f] || [];
  const n = /^\d{1,5}$/.test(String(text || '').trim()) ? Number(String(text).trim()) : NaN;
  if (!field || !(n >= lo && n <= hi)) return { error: t(user.lang, 'adm.sw.limit_bad', { lo, hi }) };
  const { cfg } = await state();
  await system.setSetting(vip.SETTING, { ...cfg, [field]: n }, user.id, ctx.now);
  await system.audit(ctx.now, user.id, 'vip.' + field, null, { value: n });
  return screen(user, t(user.lang, 'adm.saved'));
}

export async function toggleSales(ctx, user) {
  if (!canManageChannels(user.actor)) return denied(user);
  const { cfg } = await state();
  await system.setSetting(vip.SETTING, { ...cfg, on: !cfg.on }, user.id, ctx.now);
  await system.audit(ctx.now, user.id, 'vip.sales', null, { on: !cfg.on });
  return screen(user);
}

export async function toggleInvites(ctx, user) {
  if (!canManageChannels(user.actor)) return denied(user);
  const { refOn } = await state();
  await system.setSetting(referral.SWITCH, !refOn, user.id, ctx.now);
  await system.audit(ctx.now, user.id, 'switch', referral.SWITCH, { on: !refOn });
  return screen(user);
}

export async function refundAsk(user, id) {
  if (!canManageChannels(user.actor)) return denied(user);
  const p = await payments.get(id);
  if (!p || p.refunded) return screen(user);
  return {
    view: 'admin_vip',
    screen: {
      text: t(user.lang, 'adm.vip.refund_ask', { user: p.user_id, stars: p.stars, days: p.days }),
      reply_markup: ui.markup([[ui.button(tp(user.lang, 'adm.btn.vip_refund_yes'), 'A:vR:' + id), ui.button(tp(user.lang, 'adm.btn.cancel'), 'A:v')]]),
    },
  };
}

export async function refundNow(ctx, user, id) {
  if (!canManageChannels(user.actor)) return denied(user);
  const r = await vip.refund(ctx, user.id, id);
  return screen(user, t(user.lang, 'adm.vip.refund_' + r));
}
