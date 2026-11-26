// Customer club: opt-in membership with points and levels, and discount codes for subscriptions in the
// child bots.
//   Points: joining, the first activity of each day in any Wanger bot (lib/activity.js), inviting
//   friends (start=r_<id>), and purchases the child bots report (hub "buy").
//   Campaigns: the team makes one for an occasion (Nowruz, Yalda, …) or the mother makes the monthly
//   one by itself on the first update of each Jalali month (kv club_monthly_pct > 0). A campaign has a
//   shared code (everyone types the same code; optional use limit) or personal codes (each member
//   claims their own, single use). Members of the right level are told with a queued broadcast.
//   Child bots learn the codes from the hub (promo / promo_off) and check them themselves
//   (client/mother-client.js checkPromo), then report the use (hub "buy" with code).
import { db } from 'sdk';
import { sql } from 'sdk/db';
import {
  CODE_DAYS_DEFAULT, LEVELS, POINTS_JOIN, POINTS_PER_PURCHASE, POINTS_PER_STAR, POINTS_REFERRAL,
} from './config.js';
import { createBroadcast } from './broadcast.js';
import { getBot } from './catalog.js';
import { postHub, postPromoOff, promoOf } from './hubout.js';
import { notifyTeam } from './notify.js';
import { getUser, kvGet } from './store.js';
import { btn } from './tg.js';
import {
  esc, fa, formatDate, jalaliMonthName, jalaliOf, nowSec, parseJson, randomCode,
} from './util.js';

export function levelOf(points) {
  let lvl = 0;
  LEVELS.forEach((l, i) => {
    if (Number(points) >= l.min) lvl = i;
  });
  return lvl;
}
export const levelLabel = (i) => `${LEVELS[i].emoji} ${LEVELS[i].name}`;

export async function joinClub(userId) {
  const r = await db.run(sql`UPDATE users SET club = 1, club_since = ${nowSec()}, points = points + ${POINTS_JOIN} WHERE user_id = ${userId} AND club = 0`);
  return r.rowsAffected > 0;
}

export async function leaveClub(userId) {
  await db.run(sql`UPDATE users SET club = 0 WHERE user_id = ${userId}`);
}

/** A new user opened the mother through a friend's link (start=r_<id>). */
export async function creditReferral(newUser, refId) {
  if (!refId || refId === newUser.user_id || Number(newUser.ref_by)) return false;
  const ref = await getUser(refId);
  if (!ref) return false;
  const r = await db.run(sql`UPDATE users SET ref_by = ${refId} WHERE user_id = ${newUser.user_id} AND ref_by = 0`);
  if (!r.rowsAffected) return false;
  await db.run(sql`UPDATE users SET ref_count = ref_count + 1, points = points + CASE WHEN club = 1 THEN ${POINTS_REFERRAL} ELSE 0 END WHERE user_id = ${refId}`);
  return true;
}

export async function rewardPurchase(ctx, bot, userId, amount, currency) {
  if (!Number.isSafeInteger(userId) || userId <= 0) return 0;
  const stars = currency === 'XTR' ? Math.max(0, Math.floor(amount)) : 0;
  const pts = POINTS_PER_PURCHASE + Math.min(5000, stars * POINTS_PER_STAR);
  const r = await db.run(sql`UPDATE users SET points = points + ${pts} WHERE user_id = ${userId} AND club = 1`);
  return r.rowsAffected ? pts : 0;
}

// ---------- campaigns ----------

export async function getCampaign(id) {
  return db.get(sql`SELECT * FROM campaigns WHERE id = ${Number(id)}`);
}

export async function listCampaigns(limit = 10) {
  return db.all(sql`SELECT * FROM campaigns ORDER BY id DESC LIMIT ${limit}`);
}

/** Campaigns a member can see now: active, started, not ended, for their level. */
export async function campaignsFor(user, limit = 8) {
  const now = nowSec();
  const lvl = levelOf(user.points);
  const rows = await db.all(sql`SELECT * FROM campaigns WHERE status = 'active' ORDER BY id DESC LIMIT 30`);
  return rows.filter((c) => c.starts_at <= now && (!c.ends_at || c.ends_at > now) && lvl >= Number(c.min_level)).slice(0, limit);
}

export const botsLabel = async (c) => {
  const bots = parseJson(c.bots, '*');
  if (bots === '*') return 'همه‌ی ربات‌ها';
  const names = [];
  for (const k of bots) {
    const b = await getBot(k);
    names.push(b ? b.name : k);
  }
  return names.join('، ');
};

/**
 * Creates a campaign. { title, pct, bots ('*' | [keys]), personal, code (shared), days, minLevel, maxUses,
 * monthly }. Posts a shared code to the hub at once. Returns the campaign row (or null for a duplicate code).
 */
export async function createCampaign(ctx, f) {
  const now = nowSec();
  const ends = now + Math.max(1, Number(f.days) || CODE_DAYS_DEFAULT) * 86400;
  const code = f.personal ? null : String(f.code || randomCode(8)).toUpperCase();
  if (code && (await db.get(sql`SELECT code FROM codes WHERE code = ${code}`))) return null;
  const r = await db.run(sql`
    INSERT INTO campaigns (title, code, personal, pct, bots, min_level, starts_at, ends_at, max_uses, status, monthly, created_at)
    VALUES (${String(f.title).slice(0, 80)}, ${code}, ${f.personal ? 1 : 0}, ${Number(f.pct)}, ${JSON.stringify(f.bots || '*')}, ${Number(f.minLevel) || 0},
      ${now}, ${ends}, ${Number(f.maxUses) || 0}, 'active', ${f.monthly || null}, ${now})
    ON CONFLICT DO NOTHING
    RETURNING *`);
  const c = r.rows && r.rows[0];
  if (!c) return null;
  if (code) {
    await db.run(sql`INSERT INTO codes (code, campaign_id, user_id, created_at) VALUES (${code}, ${c.id}, 0, ${now})`);
    await postHub(ctx, 'promo', '*', promoOf(c, code, 0));
  }
  return c;
}

/** Queues the "new discount" message to the members of the campaign's level. */
export async function announceCampaign(c, createdBy = 0) {
  const min = LEVELS[Number(c.min_level)] ? LEVELS[Number(c.min_level)].min : 0;
  const where = await botsLabel(c);
  const lines = [
    `🎁 <b>${esc(c.title)}</b>`,
    '',
    `${fa(c.pct)}٪ تخفیف برای خرید اشتراک در: ${esc(where)}`,
    `⏳ تا ${formatDate(c.ends_at)}`,
  ];
  if (c.personal) lines.push('', 'کد شخصی‌ات را با دکمه‌ی زیر بگیر.');
  else lines.push('', `کد: <code>${esc(c.code)}</code>`);
  const kb = c.personal ? [[btn('🎟 دریافت کد من', `cc:${c.id}`)]] : [[btn('🎁 باشگاه مشتریان', 'c')]];
  return createBroadcast({ kind: 'club', title: c.title, content: { html: lines.join('\n'), kb }, audiences: [`club:${min}`], createdBy });
}

export async function stopCampaign(ctx, id) {
  const c = await getCampaign(id);
  if (!c || c.status !== 'active') return false;
  await db.run(sql`UPDATE campaigns SET status = 'stopped' WHERE id = ${c.id}`);
  const rows = await db.all(sql`SELECT code FROM codes WHERE campaign_id = ${c.id} AND user_id > 0 AND used_at = 0 LIMIT 5000`);
  await postPromoOff(ctx, [...(c.code ? [c.code] : []), ...rows.map((r) => r.code)]);
  return true;
}

/**
 * A member claims their personal code. Returns { code, campaign } or { error: 'not_member' | 'level' |
 * 'ended' | 'shared' }.
 */
export async function claimCode(ctx, user, campaignId) {
  const c = await getCampaign(campaignId);
  const now = nowSec();
  if (!c || c.status !== 'active' || c.starts_at > now || (c.ends_at && c.ends_at <= now)) return { error: 'ended' };
  if (!c.personal) return { error: 'shared', campaign: c };
  if (!Number(user.club)) return { error: 'not_member' };
  if (levelOf(user.points) < Number(c.min_level)) return { error: 'level', campaign: c };
  const have = await db.get(sql`SELECT code FROM codes WHERE campaign_id = ${c.id} AND user_id = ${user.user_id}`);
  if (have) return { code: have.code, campaign: c, again: true };
  let code = null;
  for (let i = 0; i < 5 && !code; i += 1) {
    const candidate = `W${randomCode(7)}`;
    const r = await db.run(sql`INSERT INTO codes (code, campaign_id, user_id, created_at) VALUES (${candidate}, ${c.id}, ${user.user_id}, ${now}) ON CONFLICT DO NOTHING`);
    if (r.rowsAffected) code = candidate;
  }
  if (!code) return { error: 'ended' };
  await db.run(sql`UPDATE campaigns SET claims = claims + 1 WHERE id = ${c.id}`);
  await postHub(ctx, 'promo', '*', promoOf(c, code, user.user_id));
  return { code, campaign: c };
}

/** A user's codes, newest first, with their campaign. */
export async function myCodes(userId, limit = 10) {
  return db.all(sql`
    SELECT k.code, k.used_at, k.used_bot, c.title, c.pct, c.ends_at, c.status, c.bots FROM codes k JOIN campaigns c ON c.id = k.campaign_id
    WHERE k.user_id = ${userId} ORDER BY k.created_at DESC LIMIT ${limit}`);
}

/** A child bot reports that a code was used. Returns 'ok' | 'unknown' | 'used' | 'not_yours'. */
export async function redeemCode(ctx, bot, code, userId, amount) {
  const k = await db.get(sql`SELECT * FROM codes WHERE code = ${String(code).toUpperCase()}`);
  if (!k) return 'unknown';
  const c = await getCampaign(k.campaign_id);
  const now = nowSec();
  if (Number(k.user_id) > 0) {
    if (Number(k.user_id) !== userId) return 'not_yours';
    const r = await db.run(sql`UPDATE codes SET used_at = ${now}, used_bot = ${bot.key}, amount = ${amount} WHERE code = ${k.code} AND used_at = 0`);
    if (!r.rowsAffected) return 'used';
    await postHub(ctx, 'promo_off', '*', { c: k.code });
  } else {
    const r = await db.run(sql`INSERT INTO redeems (code, user_id, bot_key, amount, at) VALUES (${k.code}, ${userId}, ${bot.key}, ${amount}, ${now}) ON CONFLICT DO NOTHING`);
    if (!r.rowsAffected) return 'used';
  }
  if (c) {
    const r = await db.run(sql`UPDATE campaigns SET uses = uses + 1 WHERE id = ${c.id} RETURNING uses`);
    const uses = Number(r.rows[0].uses);
    if (!c.personal && c.max_uses && uses >= c.max_uses) await postHub(ctx, 'promo_off', '*', { c: k.code });
  }
  return 'ok';
}

/** Compare-and-set on kv club_month, so exactly one update makes the month's campaign. */
async function claimMonth(month) {
  const r = await db.run(sql`
    INSERT INTO kv (key, value) VALUES ('club_month', ${month})
    ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE kv.value IS NULL OR kv.value <> excluded.value`);
  return r.rowsAffected > 0;
}

/**
 * The automatic monthly campaign: on the first update of a Jalali month, if the owner set a percent
 * (kv club_monthly_pct), one personal-code campaign for all members, announced to them.
 */
export async function monthlyDue(ctx) {
  const pct = Number(await kvGet('club_monthly_pct'));
  if (!pct) return null;
  const j = jalaliOf();
  const month = `${j.jy}-${String(j.jm).padStart(2, '0')}`;
  if ((await kvGet('club_month')) === month) return null;
  if (!(await claimMonth(month))) return null;
  const c = await createCampaign(ctx, {
    title: `هدیه‌ی ماهانه‌ی ${jalaliMonthName(j.jm)} ${fa(String(j.jy))}`, pct, bots: '*', personal: true, days: 10, monthly: month,
  });
  if (!c) return null;
  await announceCampaign(c);
  await notifyTeam(ctx, 'club_monthly', `🎁 کمپین ماهانه ساخته و برای اعضای باشگاه فرستاده شد: ${esc(c.title)} (${fa(pct)}٪)`, null, { silent: true });
  return c;
}
