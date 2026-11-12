// Wanger Account adapter (brief §5). The ONLY code that touches account storage. Phase 0 found no
// Wanger Account hub or contract, so the LocalAccountProvider (this bot's `users` table) is the
// only provider; the `account.provider` setting stays 'local'. A HubAccountProvider is written
// once the hub's contract exists (DECISIONS D6) — never invented here.
import { users } from '../db/users.js';
import { system } from '../db/system.js';
import { QUOTA_FEATURES, isOwner } from '../config.js';

/** One-time claim of an idempotency key (stored as an alert row that never expires). */
const claimOnce = (key, now) => system.claimAlert(`idem:${key}`, now, 10 * 365 * 86400);

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

    /** Daily limits per feature; the owner has none (brief §2: owner bypasses quotas). */
    async getEntitlements(tgUserId) {
      const acc = await local.getAccount(tgUserId);
      const pro = !!acc && acc.plan === 'pro';
      const quotas = {};
      for (const f of QUOTA_FEATURES) {
        const base = Number(settings.get(`quota.${f}`));
        quotas[f] = isOwner(tgUserId) ? Infinity : pro ? base * 5 : base;
      }
      return { pro, quotas };
    },

    async addPoints(tgUserId, delta, reason, idempotencyKey) {
      if (idempotencyKey && !(await claimOnce(idempotencyKey, clock.now()))) return { ok: true, duplicate: true };
      const points = await users.addPoints(tgUserId, delta);
      app.stats.count('points.changed');
      return { ok: points !== null, points };
    },

    async spendCredits(tgUserId, amount, reason, idempotencyKey) {
      const u = await users.get(tgUserId);
      if (!u || u.points < amount) return { ok: false, reason: 'INSUFFICIENT' };
      if (idempotencyKey && !(await claimOnce(idempotencyKey, clock.now()))) return { ok: true, duplicate: true, balance: u.points };
      const balance = await users.addPoints(tgUserId, -amount);
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
