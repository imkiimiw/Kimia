/*
 * Channel data that isn't a setting: join requests Aegis received (aegis_join_requests), subscribers
 * per day (aegis_channel_stats), a channel's discussion group and direct messages chat.
 */
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { JR_KEEP_SEC, JR_PAGE } from '../config.js';
import { nowSec } from '../core/util.js';

export const today = (now = nowSec()) => Math.floor(now / 86400);

/* ---------- join requests ---------- */

export async function addRequest(chatId, user, bio, link, query = null) {
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ').slice(0, 128);
  await db.run(sql`UPDATE aegis_join_requests SET status = 'expired', decided_at = ${nowSec()} WHERE chat_id = ${chatId} AND user_id = ${user.id}
    AND status IN ('pending', 'captcha')`);
  const r = await db.run(sql`INSERT INTO aegis_join_requests (chat_id, user_id, name, username, bio, link, query, at)
    VALUES (${chatId}, ${user.id}, ${name}, ${user.username || null}, ${bio ? String(bio).slice(0, 200) : null}, ${link || null}, ${query}, ${nowSec()})
    RETURNING id`);
  return Number(r.rows[0].id);
}

export const request = (id) => db.get(sql`SELECT * FROM aegis_join_requests WHERE id = ${id}`);

export async function openRequest(chatId, userId) {
  return db.get(sql`SELECT * FROM aegis_join_requests WHERE chat_id = ${chatId} AND user_id = ${userId} AND status IN ('pending', 'captcha')
    ORDER BY id DESC LIMIT 1`);
}

/* Records a decision once (a request already decided stays as it was). Gives true if this call decided it. */
export async function decide(id, status, reason, byId) {
  const r = await db.run(sql`UPDATE aegis_join_requests SET status = ${status}, reason = ${reason}, by_id = ${byId}, decided_at = ${nowSec()}
    WHERE id = ${id} AND status IN ('pending', 'captcha')`);
  return r.rowsAffected > 0;
}

export async function setRequestStatus(id, status) {
  await db.run(sql`UPDATE aegis_join_requests SET status = ${status} WHERE id = ${id} AND status IN ('pending', 'captcha')`);
}

export async function pending(chatId, page = 0) {
  const total = (await db.get(sql`SELECT count(*) AS n FROM aegis_join_requests WHERE chat_id = ${chatId} AND status IN ('pending', 'captcha')`)).n;
  const rows = await db.all(sql`SELECT * FROM aegis_join_requests WHERE chat_id = ${chatId} AND status IN ('pending', 'captcha')
    ORDER BY at DESC LIMIT ${JR_PAGE} OFFSET ${page * JR_PAGE}`);
  return { total: Number(total), rows };
}

export async function pendingIds(chatId, limit = 200) {
  return db.all(sql`SELECT id, user_id FROM aegis_join_requests WHERE chat_id = ${chatId} AND status = 'pending' ORDER BY at LIMIT ${limit}`);
}

export async function requestsSince(chatId, since) {
  return Number((await db.get(sql`SELECT count(*) AS n FROM aegis_join_requests WHERE chat_id = ${chatId} AND at >= ${since}`)).n);
}

/* Today's requests by outcome: { pending, approved, declined } (and the other statuses). */
export async function requestStats(chatId, since) {
  const rows = await db.all(sql`SELECT status, count(*) AS n FROM aegis_join_requests WHERE chat_id = ${chatId} AND at >= ${since} GROUP BY status LIMIT 10`);
  const out = { pending: 0, captcha: 0, approved: 0, declined: 0, expired: 0 };
  for (const r of rows) out[r.status] = Number(r.n);
  return out;
}

/* ---------- subscribers per day ---------- */

export async function bump(chatId, field, now = nowSec()) {
  const d = today(now);
  if (field === 'joins') {
    await db.run(sql`INSERT INTO aegis_channel_stats (chat_id, day, joins) VALUES (${chatId}, ${d}, 1)
      ON CONFLICT(chat_id, day) DO UPDATE SET joins = aegis_channel_stats.joins + 1`);
  } else {
    await db.run(sql`INSERT INTO aegis_channel_stats (chat_id, day, leaves) VALUES (${chatId}, ${d}, 1)
      ON CONFLICT(chat_id, day) DO UPDATE SET leaves = aegis_channel_stats.leaves + 1`);
  }
}

export async function setMembers(chatId, n, now = nowSec()) {
  await db.run(sql`INSERT INTO aegis_channel_stats (chat_id, day, members) VALUES (${chatId}, ${today(now)}, ${n})
    ON CONFLICT(chat_id, day) DO UPDATE SET members = excluded.members`);
}

/* The last `days` days, newest first. */
export async function series(chatId, days = 8, now = nowSec()) {
  return db.all(sql`SELECT * FROM aegis_channel_stats WHERE chat_id = ${chatId} AND day > ${today(now) - days} ORDER BY day DESC LIMIT ${days}`);
}

/* Joins and leaves summed over the last `days` days (today included). */
export async function flow(chatId, days, now = nowSec()) {
  const r = await db.get(sql`SELECT coalesce(sum(joins), 0) AS j, coalesce(sum(leaves), 0) AS l FROM aegis_channel_stats
    WHERE chat_id = ${chatId} AND day > ${today(now) - days}`);
  return { joins: Number(r.j), leaves: Number(r.l) };
}

/* The member count recorded on or before `days` days ago (0 = unknown). */
export async function membersAgo(chatId, days, now = nowSec()) {
  const r = await db.get(sql`SELECT members FROM aegis_channel_stats WHERE chat_id = ${chatId} AND day <= ${today(now) - days} AND members > 0
    ORDER BY day DESC LIMIT 1`);
  return r ? Number(r.members) : 0;
}

/* ---------- linked chats ---------- */

export async function setLinked(chatId, linkedId) {
  await db.run(sql`UPDATE aegis_chats SET linked_id = ${linkedId || 0} WHERE chat_id = ${chatId}`);
}

export async function rememberDm(dmChatId, channelId) {
  await db.run(sql`INSERT INTO aegis_dm_chats (dm_chat_id, channel_id, at) VALUES (${dmChatId}, ${channelId}, ${nowSec()})
    ON CONFLICT(dm_chat_id) DO UPDATE SET channel_id = excluded.channel_id`);
  await db.run(sql`UPDATE aegis_chats SET dm_chat = ${dmChatId} WHERE chat_id = ${channelId}`);
}

export async function channelOfDm(dmChatId) {
  const r = await db.get(sql`SELECT channel_id FROM aegis_dm_chats WHERE dm_chat_id = ${dmChatId}`);
  return r ? Number(r.channel_id) : 0;
}

/* ---------- the admins' vote on direct messages (setting dm_vote) ---------- */

export const DM_VOTE_SEC = 24 * 3600;
export const dmVotes = {
  /* a vote on one message; 0 when that message already has one */
  async open(channelId, dmChatId, messageId, fromId, now = nowSec()) {
    const r = await db.run(sql`INSERT INTO aegis_dm_votes (channel_id, dm_chat_id, message_id, from_id, at, ends_at)
      VALUES (${channelId}, ${dmChatId}, ${messageId}, ${fromId}, ${now}, ${now + DM_VOTE_SEC}) ON CONFLICT(dm_chat_id, message_id) DO NOTHING RETURNING id`);
    return r.rows && r.rows[0] ? Number(r.rows[0].id) : 0;
  },
  setMsgs: (id, msgs) => db.run(sql`UPDATE aegis_dm_votes SET msgs = ${JSON.stringify(msgs)} WHERE id = ${id}`),
  get: (id) => db.get(sql`SELECT * FROM aegis_dm_votes WHERE id = ${id}`),
  /* the sender's votes still open in this channel (a flood of messages does not flood the admins) */
  openBy: async (channelId, fromId) => Number((await db.get(sql`SELECT count(*) AS n FROM aegis_dm_votes
    WHERE channel_id = ${channelId} AND status = 'open' AND from_id = ${fromId}`)).n),
  openIn: async (channelId) => Number((await db.get(sql`SELECT count(*) AS n FROM aegis_dm_votes WHERE channel_id = ${channelId} AND status = 'open'`)).n),
  /* an admin votes (or changes their vote); gives the new count */
  async cast(id, userId, choice, now = nowSec()) {
    await db.run(sql`INSERT INTO aegis_dm_ballots (vote_id, user_id, choice, at) VALUES (${id}, ${userId}, ${choice}, ${now})
      ON CONFLICT(vote_id, user_id) DO UPDATE SET choice = excluded.choice, at = excluded.at`);
    const rows = await db.all(sql`SELECT choice, count(*) AS n FROM aegis_dm_ballots WHERE vote_id = ${id} GROUP BY choice LIMIT 2`);
    const n = (c) => Number((rows.find((r) => r.choice === c) || { n: 0 }).n);
    const yes = n('y');
    const no = n('n');
    await db.run(sql`UPDATE aegis_dm_votes SET yes = ${yes}, "no" = ${no} WHERE id = ${id} AND status = 'open'`);
    return { yes, no };
  },
  choiceOf: async (id, userId) => ((await db.get(sql`SELECT choice FROM aegis_dm_ballots WHERE vote_id = ${id} AND user_id = ${userId}`)) || {}).choice || '',
  due: (now, limit = 5) => db.all(sql`SELECT * FROM aegis_dm_votes WHERE status = 'open' AND ends_at <= ${now} ORDER BY ends_at LIMIT ${limit}`),
  /* one caller closes a vote: gives false when someone else already did */
  async close(id, status) {
    const r = await db.run(sql`UPDATE aegis_dm_votes SET status = ${status} WHERE id = ${id} AND status = 'open'`);
    return r.rowsAffected > 0;
  },
  setStatus: (id, status) => db.run(sql`UPDATE aegis_dm_votes SET status = ${status} WHERE id = ${id}`),
  /* finished votes and their ballots are kept for 30 days */
  async prune(now) {
    const old = await db.all(sql`SELECT id FROM aegis_dm_votes WHERE status != 'open' AND ends_at < ${now - 30 * 86400} LIMIT 50`);
    for (const r of old) {
      await db.run(sql`DELETE FROM aegis_dm_ballots WHERE vote_id = ${r.id}`);
      await db.run(sql`DELETE FROM aegis_dm_votes WHERE id = ${r.id}`);
    }
  },
};

export async function migrate(oldId, newId) {
  for (const t of ['aegis_join_requests', 'aegis_channel_stats']) await db.run(sql`UPDATE ${sql.raw(t)} SET chat_id = ${newId} WHERE chat_id = ${oldId}`);
  await db.run(sql`UPDATE aegis_chats SET linked_id = ${newId} WHERE linked_id = ${oldId}`);
}

export async function sweep(now) {
  const r = await db.run(sql`DELETE FROM aegis_join_requests WHERE id IN (SELECT id FROM aegis_join_requests WHERE status NOT IN ('pending', 'captcha')
    AND at < ${now - JR_KEEP_SEC} LIMIT 500)`);
  await db.run(sql`DELETE FROM aegis_channel_stats WHERE rowid IN (SELECT rowid FROM aegis_channel_stats WHERE day < ${today(now) - 400} LIMIT 500)`);
  return r.rowsAffected;
}
