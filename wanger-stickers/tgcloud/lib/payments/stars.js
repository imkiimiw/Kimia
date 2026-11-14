// Pro with Telegram Stars (Phase 5, brief §12): the currency for digital goods in bots (XTR) needs
// no payment provider account. A 30-day subscription invoice link; pre_checkout_query answered at
// once (Telegram waits ≤ 10 s); successful_payment stored once per telegram_payment_charge_id and
// Pro extended to the subscription's expiry; refunds with refundStarPayment from the owner's panel.
// Off until the owner sets a price (`pro.price_stars` > 0) and turns on flags.payments.
import { payments as paydb } from '../db/community.js';
import { users } from '../db/users.js';
import { UserError } from '../core/util.js';

export const STARS = Object.freeze({
  currency: 'XTR',
  subscriptionPeriod: 30 * 86400, // Bot API: must be exactly 2592000 seconds
  maxPrice: 10000, // Bot API: a Stars subscription costs at most 10 000
  product: 'pro_month',
});

/** The invoice payload: product + buyer, checked again at pre-checkout and payment. */
export const payloadFor = (userId) => `pro1:${userId}`;
export function parsePayload(p) {
  const m = /^pro1:(\d{1,16})$/.exec(String(p || ''));
  return m ? { product: STARS.product, userId: Number(m[1]) } : null;
}

/** @param {any} app */
export function createStars(app) {
  const { clock, tg } = app;
  const price = () => Number(app.settings.get('pro.price_stars')) || 0;
  const onSale = () => app.flag('payments') && price() > 0 && price() <= STARS.maxPrice;

  return {
    onSale,
    async invoiceLink(user) {
      if (!onSale()) throw new UserError('pay.err.off');
      return tg.call('createInvoiceLink', {
        title: app.tp('pay.title'),
        description: app.tp('pay.description', { quota: 5 }),
        payload: payloadFor(user.tg_id),
        currency: STARS.currency,
        prices: [{ label: app.tp('pay.title'), amount: price() }],
        subscription_period: STARS.subscriptionPeriod,
      }, 'invoice_link');
    },

    /** pre_checkout_query: must be answered (ok or not) within 10 seconds. */
    async preCheckout(q) {
      const p = parsePayload(q.invoice_payload);
      let error = null;
      if (!p || p.userId !== q.from.id) error = 'pay.err.payload';
      else if (q.currency !== STARS.currency) error = 'pay.err.payload';
      else if (!onSale()) error = 'pay.err.off';
      else if (q.total_amount !== price()) error = 'pay.err.price';
      else {
        const u = await users.get(q.from.id);
        if (u && u.banned) error = 'pay.err.banned';
      }
      await tg.call('answerPreCheckoutQuery', { pre_checkout_query_id: q.id, ok: !error, ...(error ? { error_message: app.tp(error) } : {}) }, 'pre_checkout');
      app.stats.count(error ? 'pay.precheckout_refused' : 'pay.precheckout_ok');
      return error ? `refused:${error}` : 'ok';
    },

    /** message.successful_payment: stored once; Pro until the subscription's expiry (or + 30 days). */
    async paid(userId, sp) {
      const p = parsePayload(sp.invoice_payload);
      const now = clock.now();
      const acc = await users.get(userId);
      const until = sp.subscription_expiration_date || Math.max(now, (acc && acc.plan_until) || 0) + STARS.subscriptionPeriod;
      const row = await paydb.insert({ tg_id: userId, charge_id: sp.telegram_payment_charge_id, stars: sp.total_amount, product: (p && p.product) || 'unknown', payload: String(sp.invoice_payload || '').slice(0, 128), recurring: !!sp.is_recurring, until, now });
      if (!row) return 'duplicate';
      await users.extendPro(userId, until);
      await app.audit(userId, 'payment', sp.telegram_payment_charge_id, `${sp.total_amount} XTR`);
      app.stats.count('pay.paid');
      app.stats.count('pay.stars', sp.total_amount);
      await tg.send(userId, { text: app.t('pay.thanks', { days: Math.max(1, Math.round((until - now) / 86400)) }) }, 'pay_thanks');
      return 'paid';
    },

    /** Owner: refund the user's last payment and end their Pro. */
    async refundLast(actorId, userId) {
      const last = await paydb.lastOf(userId);
      if (!last || last.refunded) throw new UserError('pay.err.nothing');
      await tg.call('refundStarPayment', { user_id: userId, telegram_payment_charge_id: last.charge_id }, 'refund');
      if (last.recurring) {
        try {
          await tg.call('editUserStarSubscription', { user_id: userId, telegram_payment_charge_id: last.charge_id, is_canceled: true }, 'cancel_subscription');
        } catch {
          /* already ended or not a subscription charge: the refund stands */
        }
      }
      await paydb.markRefunded(last.id);
      await users.endPro(userId, clock.now());
      await app.audit(actorId, 'refund', String(userId), `${last.stars} XTR ${last.charge_id}`);
      return last;
    },
    totals: () => paydb.totals(),
    listOf: (userId) => paydb.listOf(userId, 10),
  };
}
