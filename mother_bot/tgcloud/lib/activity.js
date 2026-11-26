// Activity history: which Wanger bots each user uses (reported by the child bots through the hub) and
// which bot pages they open in the mother. Per bot and day the counters go to bot_daily; per user and
// bot to user_bots. Club members get a point for the first activity of each local day.
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { POINTS_DAILY } from './config.js';
import { localDay, nowSec } from './util.js';

async function bumpDaily(botKey, day, f) {
  await db.run(sql`
    INSERT INTO bot_daily (bot_key, day, active, new_users, uses, errors, reports, blocked)
    VALUES (${botKey}, ${day}, ${f.active || 0}, ${f.newUsers || 0}, ${f.uses || 0}, ${f.errors || 0}, ${f.reports || 0}, ${f.blocked || 0})
    ON CONFLICT(bot_key, day) DO UPDATE SET
      active = active + excluded.active, new_users = new_users + excluded.new_users, uses = uses + excluded.uses,
      errors = errors + excluded.errors, reports = reports + excluded.reports, blocked = blocked + excluded.blocked`);
}

export const bumpDay = (botKey, fields, sec = nowSec()) => bumpDaily(botKey, localDay(sec), fields);

/**
 * Records a batch of usage from a child bot: entries [userId, count, isNewToTheBot].
 * Returns { users, newUsers, active } for this batch.
 */
export async function recordUses(botKey, entries) {
  const now = nowSec();
  const day = localDay(now);
  let active = 0;
  let newUsers = 0;
  let uses = 0;
  let users = 0;
  for (const e of entries.slice(0, 250)) {
    const uid = Number(Array.isArray(e) ? e[0] : e);
    const n = Math.max(1, Math.min(10000, Number((Array.isArray(e) && e[1]) || 1)));
    if (!Number.isSafeInteger(uid) || uid <= 0) continue;
    users += 1;
    uses += n;
    let firstToday = false;
    let r = await db.run(sql`
      UPDATE user_bots SET uses = uses + ${n}, last_at = ${now}, last_day = ${day},
        first_at = CASE WHEN first_at = 0 THEN ${now} ELSE first_at END
      WHERE user_id = ${uid} AND bot_key = ${botKey} AND last_day <> ${day}
      RETURNING (uses = ${n}) AS fresh`);
    if (r.rowsAffected) {
      firstToday = true;
      if (r.rows && r.rows[0] && Number(r.rows[0].fresh)) newUsers += 1; // known from a page view, first use now
    } else {
      r = await db.run(sql`UPDATE user_bots SET uses = uses + ${n}, last_at = ${now} WHERE user_id = ${uid} AND bot_key = ${botKey} RETURNING uses`);
      if (!r.rowsAffected) {
        await db.run(sql`
          INSERT INTO user_bots (user_id, bot_key, uses, first_at, last_at, last_day) VALUES (${uid}, ${botKey}, ${n}, ${now}, ${now}, ${day})
          ON CONFLICT(user_id, bot_key) DO UPDATE SET uses = uses + excluded.uses, last_at = excluded.last_at, last_day = excluded.last_day`);
        firstToday = true;
        newUsers += 1;
      }
    }
    if (firstToday) {
      active += 1;
      await db.run(sql`UPDATE users SET points = points + ${POINTS_DAILY}, point_day = ${day} WHERE user_id = ${uid} AND club = 1 AND point_day <> ${day}`);
    }
  }
  if (users) {
    await bumpDaily(botKey, day, { active, newUsers, uses });
    if (newUsers) await db.run(sql`UPDATE bots SET users_known = users_known + ${newUsers} WHERE key = ${botKey}`);
  }
  return { users, newUsers, active };
}

/** A child bot could not write to these users any more (403). */
export async function recordBlocked(botKey, userIds) {
  let n = 0;
  for (const raw of userIds.slice(0, 250)) {
    const uid = Number(raw);
    if (!Number.isSafeInteger(uid) || uid <= 0) continue;
    const r = await db.run(sql`UPDATE user_bots SET blocked = 1 WHERE user_id = ${uid} AND bot_key = ${botKey} AND blocked = 0`);
    n += r.rowsAffected;
  }
  if (n) {
    await db.run(sql`UPDATE bots SET blocked_known = blocked_known + ${n} WHERE key = ${botKey}`);
    await bumpDay(botKey, { blocked: n });
  }
  return n;
}

/** A user opened a bot's page (or asked about it) in the mother. */
export async function recordView(userId, botKey) {
  const now = nowSec();
  await db.run(sql`
    INSERT INTO user_bots (user_id, bot_key, views, last_at) VALUES (${userId}, ${botKey}, 1, 0)
    ON CONFLICT(user_id, bot_key) DO UPDATE SET views = views + 1`);
  await db.run(sql`UPDATE bots SET views = views + 1 WHERE key = ${botKey}`);
  return now;
}

/** A user's bots, most used first (then most viewed). */
export async function userBotsOf(userId, limit = 10) {
  return db.all(sql`
    SELECT ub.*, b.name, b.emoji, b.username FROM user_bots ub JOIN bots b ON b.key = ub.bot_key
    WHERE ub.user_id = ${userId} AND (ub.uses > 0 OR ub.views > 0)
    ORDER BY ub.uses DESC, ub.views DESC LIMIT ${limit}`);
}

/** Per-bot totals for one day: [{ bot_key, active, new_users, uses, errors, reports, blocked }]. */
export async function dailyFor(day) {
  return db.all(sql`SELECT * FROM bot_daily WHERE day = ${day} ORDER BY bot_key LIMIT 60`);
}

/** The last `days` days of one bot. */
export async function botHistory(botKey, days = 7) {
  return db.all(sql`SELECT * FROM bot_daily WHERE bot_key = ${botKey} ORDER BY day DESC LIMIT ${days}`);
}
