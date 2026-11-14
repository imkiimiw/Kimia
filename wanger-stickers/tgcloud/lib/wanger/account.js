// Wanger Account adapter (brief §5). The ONLY code that touches account storage. Phase 0 found no
// Wanger Account hub or contract, so the LocalAccountProvider (this bot's `users` table) is the
// only provider; the `account.provider` setting stays 'local'. A HubAccountProvider is written
// once the hub's contract exists (DECISIONS D6) — never invented here.
import { users } from '../db/users.js';
import { ledger } from '../db/community.js';
import { dayKey, randomId } from '../core/util.js';
import { QUOTA_FEATURES, POINTS, isOwner } from '../config.js';

/**
 * @param {{clock: any, settings: any, stats: any}} app
 */
export function createAccount(app) {
  const { clock, settings } = app;
  const local = {
    /** Create or refresh on contact → users row. */
    ensureAccount: (tgUser) => users.touch(tgUser, clock.now()),

    async getAccount(tgUserId) {
      const u = await users.get(tgUserId);
      if (!u) return null;
      return {
        wangerId: u.wanger_id || null,
        tgUserId: u.tg_id,
        lang: u.lang || null,
        plan: u.plan === 'pro' && u.plan_until > clock.now() ? 'pro' : 'free',
        planUntil: u.plan_until || 0,
        points: u.points || 0,
        banned: !!u.banned,
      };
    },

    /**
     * Daily limits per feature; the owner has none (brief §2: owner bypasses quotas). Pro ×5; a
     * points boost bought today adds its bonus (usage rows `bonus.<feature>`).
     */
    async getEntitlements(tgUserId) {
      const acc = await local.getAccount(tgUserId);
      const pro = !!acc && acc.plan === 'pro';
      const day = dayKey(clock.now());
      const quotas = {};
      for (const f of QUOTA_FEATURES) {
        const base = Number(settings.get(`quota.${f}`));
        const bonus = f === 'sticker_add' || f === 'media_send' ? await users.usage(tgUserId, day, `bonus.${f}`) : 0;
        quotas[f] = isOwner(tgUserId) ? Infinity : (pro ? base * 5 : base) + bonus;
      }
      return { pro, quotas };
    },

    /** A manual change (the owner's panel) or an award with its own key; recorded in the ledger. */
    async addPoints(tgUserId, delta, reason, idempotencyKey) {
      const key = idempotencyKey || `manual:${randomId(12)}`;
      const row = await ledger.insert({ key, tg_id: tgUserId, delta, reason: String(reason || 'manual').slice(0, 32), day: dayKey(clock.now()), at: clock.now() });
      if (!row) return { ok: true, duplicate: true };
      const points = await users.addPoints(tgUserId, delta);
      app.stats.count('points.changed');
      return { ok: points !== null, points };
    },

    /**
     * Points for real activity (Phase 5): the amount from settings `points.<reason>`, at most the
     * reason's daily cap, once per `uniqueKey` (e.g. the pack id). Returns the points given (0 = none).
     */
    async award(tgUserId, reason, uniqueKey) {
      const rule = POINTS[reason];
      const amount = Number(settings.get(`points.${reason}`)) || 0;
      if (!rule || amount <= 0 || !settings.get('flags.points') || !Number.isSafeInteger(tgUserId)) return 0;
      const day = dayKey(clock.now());
      if ((await ledger.sumToday(tgUserId, day, reason)) + amount > rule.dailyCap) return 0;
      const row = await ledger.insert({ key: `${reason}:${uniqueKey}`, tg_id: tgUserId, delta: amount, reason, day, at: clock.now() });
      if (!row) return 0;
      await users.addPoints(tgUserId, amount);
      app.stats.count(`points.earned.${reason}`);
      return amount;
    },

    /**
     * Spends points atomically: the ledger row claims the key, then the balance is debited only if
     * it covers the cost (one conditional UPDATE); on a short balance the claim is undone.
     */
    async spendCredits(tgUserId, amount, reason, idempotencyKey) {
      const key = idempotencyKey || `spend:${randomId(12)}`;
      const row = await ledger.insert({ key, tg_id: tgUserId, delta: -amount, reason: String(reason).slice(0, 32), day: dayKey(clock.now()), at: clock.now() });
      if (!row) return { ok: true, duplicate: true };
      const balance = await users.spendPoints(tgUserId, amount);
      if (balance === null) {
        await ledger.remove(key);
        return { ok: false, reason: 'INSUFFICIENT' };
      }
      app.stats.count(`points.spent.${String(reason).slice(0, 20)}`);
      return { ok: true, balance };
    },

    /** scope: 'bot' (this bot only) or 'ecosystem' (stored; reaches other bots once a hub exists). */
    setBan: (tgUserId, banned, reason, scope = 'bot') => users.setBan(tgUserId, banned, reason, scope === 'ecosystem' ? 'ecosystem' : 'bot'),

    /** Ecosystem analytics, fire-and-forget (locally: a daily counter). */
    recordEvent(_tgUserId, type) {
      app.stats.count(`event.${String(type).slice(0, 40)}`);
    },
  };
  return local;
}
