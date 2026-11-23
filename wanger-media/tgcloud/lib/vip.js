// VIP paid with Telegram Stars (currency XTR: no payment provider, no bank account). Off until the
// owner switches it on and sets the price (Admin › ⭐ VIP). VIP users get their own daily quota and
// cooldown for the plan's days. Flow: invoice (sendInvoice) → pre_checkout_query (checked against the
// current plan, answered at once) → successful_payment (recorded once per charge id, VIP extended).
// Refunds: the owner, from the panel (refundStarPayment), which also takes the days off.
import { OWNER_ID } from './config.js';
import * as payments from './db/payments.js';
import * as system from './db/system.js';
import * as users from './db/users.js';
import { t, tp } from './i18n/index.js';
import * as tg from './tg.js';
import * as ui from './ui.js';
import { tehranDay } from './util.js';

export const SETTING = 'vip';
export const DEFAULTS = { on: false, stars: 100, days: 30, quota: 300, cooldown_s: 3 };
export const FIELDS = { p: ['stars', 1, 10000], d: ['days', 1, 365], q: ['quota', 1, 10000], c: ['cooldown_s', 0, 3600] };

/** The stored plan, clamped; DEFAULTS where unset. */
export function configFrom(value) {
  const v = value && typeof value === 'object' ? value : {};
  const out = { on: v.on === true };
  for (const [field, lo, hi] of Object.values(FIELDS)) out[field] = Number.isInteger(v[field]) && v[field] >= lo && v[field] <= hi ? v[field] : DEFAULTS[field];
  return out;
}

export const isVip = (row, now) => !!row && Number(row.vip_until) > now;
const payloadOf = (cfg) => `vip:${cfg.days}:${cfg.stars}`;

/** The VIP screen for a user: status, what VIP gives, the price, a buy button when sales are on. */
export function screen(lang, cfg, row, now, limits) {
  const active = isVip(row, now);
  const lines = [t(lang, active ? 'vip.active' : 'vip.inactive', { until: ui.formatTime(row.vip_until) })];
  lines.push('', t(lang, 'vip.benefits', { quota: cfg.quota, cooldown: cfg.cooldown_s, free: limits.quota_per_day, freeCooldown: limits.cooldown_s }));
  const kb = [];
  if (cfg.on) {
    lines.push('', t(lang, 'vip.price', { stars: cfg.stars, days: cfg.days }));
    kb.push([ui.button(tp(lang, active ? 'vip.btn_extend' : 'vip.btn_buy', { stars: cfg.stars, days: cfg.days }), 'B')]);
  } else lines.push('', t(lang, 'vip.closed'));
  kb.push(ui.navRow(lang));
  return { text: lines.join('\n'), reply_markup: ui.markup(kb) };
}

export async function load() {
  const s = await system.loadSettings([SETTING]);
  return configFrom(s[SETTING] && s[SETTING].value);
}

export async function sendInvoice(ctx, user, cfg) {
  const lang = user.lang;
  return tg.call(ctx, 'vip_invoice', 'sendInvoice', {
    chat_id: user.id, title: tp(lang, 'vip.invoice_title', { days: cfg.days }), description: tp(lang, 'vip.invoice_desc', { days: cfg.days, quota: cfg.quota, cooldown: cfg.cooldown_s }),
    payload: payloadOf(cfg), currency: 'XTR', prices: [{ label: tp(lang, 'vip.invoice_title', { days: cfg.days }), amount: cfg.stars }],
  });
}

/** pre_checkout_query: accept only the current plan, in Stars, for a user who isn't banned. */
export async function onPreCheckout(ctx, q) {
  const cfg = await load();
  const row = await users.load(q.from.id);
  const banned = !!(row && row.ban_until != null && (row.ban_until === 0 || row.ban_until > ctx.now));
  const ok = cfg.on && q.currency === 'XTR' && q.invoice_payload === payloadOf(cfg) && q.total_amount === cfg.stars && !!row && !banned;
  const lang = (row && row.lang) || 'en';
  await tg.call(ctx, 'vip_precheckout', 'answerPreCheckoutQuery', ok
    ? { pre_checkout_query_id: q.id, ok: true }
    : { pre_checkout_query_id: q.id, ok: false, error_message: tp(lang, 'vip.precheckout_refused') });
  return { view: 'vip_precheckout', ok };
}

/** A successful_payment message: record it (once per charge) and extend VIP by the paid days. */
export async function onPaid(ctx, user, sp) {
  const m = /^vip:(\d{1,3}):(\d{1,5})$/.exec(String(sp.invoice_payload || ''));
  if (!m || sp.currency !== 'XTR' || Number(m[2]) !== sp.total_amount) {
    await system.logError(ctx.now, 'vip', 'unexpected payment payload', JSON.stringify({ payload: String(sp.invoice_payload).slice(0, 40), currency: sp.currency })).catch(() => {});
    return { view: 'vip_paid', ok: false };
  }
  const days = Number(m[1]);
  const fresh = await payments.insert({ userId: user.id, chargeId: sp.telegram_payment_charge_id, stars: sp.total_amount, days, vipUntil: 0 }, ctx.now);
  if (!fresh) return { view: 'vip_paid', duplicate: true };
  const until = await users.extendVip(user.id, days * 86400, ctx.now);
  await payments.setVipUntil(sp.telegram_payment_charge_id, until);
  await system.count([['vip_sales', tehranDay(ctx.now), 1], ['vip_stars', tehranDay(ctx.now), sp.total_amount], ['vip_stars', '', sp.total_amount]]);
  await system.audit(ctx.now, user.id, 'vip.paid', String(user.id), { stars: sp.total_amount, days });
  await tg.send(ctx, 'vip_paid', user.id, { text: t(user.lang, 'vip.thanks', { until: ui.formatTime(until) }) });
  return { view: 'vip_paid', ok: true, until };
}

/** Owner: refunds a payment through Telegram and takes its days off. → 'ok' | 'already' | 'failed'. */
export async function refund(ctx, actorId, paymentId) {
  if (actorId !== OWNER_ID) return 'failed';
  const p = await payments.get(paymentId);
  if (!p) return 'failed';
  if (p.refunded) return 'already';
  try {
    await tg.call(ctx, 'vip_refund', 'refundStarPayment', { user_id: p.user_id, telegram_payment_charge_id: p.charge_id });
  } catch {
    return 'failed';
  }
  if (!(await payments.markRefunded(p.id))) return 'already';
  await users.reduceVip(p.user_id, p.days * 86400, ctx.now);
  await system.audit(ctx.now, actorId, 'vip.refund', String(p.user_id), { stars: p.stars, days: p.days });
  return 'ok';
}
