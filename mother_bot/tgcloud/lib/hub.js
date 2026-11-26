// Hub posts from the child bots (the format is in lib/hubout.js). Kinds a child sends:
//   hello { v }                      first run or lost config: the mother answers with a full sync
//   hb    { v, users, blocked }      heartbeat with the child's own totals (optional numbers)
//   use   { u: [[userId, count, isNew], ...] }  batched activity
//   err   { e: [[signature, text, count], ...] } batched errors
//   blk   { u: [userId, ...] }       users who blocked the child (a 403 when writing to them)
//   abuse { u: userId, r: reason, d: detail }  the child flagged a user (spam, flood, harassment)
//   buy   { u: userId, amt: amount, cur: 'XTR'|..., code? }  a purchase (club points, code use)
//   ack   { v }                      the child applied config version v
// Only posts in the configured hub chat are read, only for bots in the catalog. After reading, a post is
// deleted to keep the hub small (switch off with kv hub_keep = 1).
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { HUB_PREFIX, HUB_SELF } from './config.js';
import { recordBlocked, recordUses } from './activity.js';
import { getBot, updateBot } from './catalog.js';
import { redeemCode, rewardPurchase } from './club.js';
import { recordErrors } from './health.js';
import { fullSync, hubChat } from './hubout.js';
import { flagAbuse } from './moderation.js';
import { kvGet } from './store.js';
import { del } from './tg.js';
import { nowSec, parseJson } from './util.js';

/** Parses a hub post: the document, or null if the text isn't one. */
export function parseHub(text) {
  const s = String(text || '');
  if (!s.startsWith(`${HUB_PREFIX} `)) return null;
  const doc = parseJson(s.slice(HUB_PREFIX.length + 1), null);
  if (!doc || typeof doc !== 'object' || typeof doc.b !== 'string' || typeof doc.k !== 'string') return null;
  if (!doc.d || typeof doc.d !== 'object') doc.d = {};
  return doc;
}

/**
 * A channel post. Returns { hub: false } when it isn't a hub event for us, else
 * { hub: true, bot, kind, result }.
 */
export async function onHubPost(ctx, post) {
  const chat = await hubChat();
  if (!chat || !post || !post.chat || Number(post.chat.id) !== chat) return { hub: false };
  const doc = parseHub(post.text);
  if (!doc || doc.b === HUB_SELF) return { hub: false };
  const bot = await getBot(doc.b);
  if (!bot) {
    console.warn(`hub: unknown bot "${String(doc.b).slice(0, 20)}"`);
    return { hub: true, bot: null, kind: doc.k, result: 'unknown bot' };
  }
  const d = doc.d;
  const now = nowSec();
  const fields = {};
  let result = null;
  switch (doc.k) {
    case 'hello':
      await fullSync(ctx, bot.key);
      result = 'synced';
      break;
    case 'hb':
      if (Number.isFinite(Number(d.users)) && Number(d.users) > 0) fields.users_reported = Math.floor(Number(d.users));
      result = 'ok';
      break;
    case 'use':
      result = await recordUses(bot.key, Array.isArray(d.u) ? d.u : []);
      break;
    case 'err':
      result = await recordErrors(ctx, bot, Array.isArray(d.e) ? d.e : []);
      break;
    case 'blk':
      result = await recordBlocked(bot.key, Array.isArray(d.u) ? d.u : []);
      break;
    case 'abuse':
      result = await flagAbuse(ctx, { userId: Number(d.u), botKey: bot.key, source: 'bot', reason: d.r, detail: d.d });
      break;
    case 'buy':
      result = await rewardPurchase(ctx, bot, Number(d.u), Number(d.amt) || 0, String(d.cur || ''));
      if (d.code) await redeemCode(ctx, bot, String(d.code), Number(d.u), Number(d.amt) || 0);
      break;
    case 'ack':
      if (Number.isFinite(Number(d.v))) fields.cfg_ack = Math.floor(Number(d.v));
      result = 'ok';
      break;
    default:
      result = 'unknown kind';
  }
  if (typeof d.v === 'string' && d.v) fields.version = d.v.slice(0, 20);
  await updateBot(bot.key, fields);
  await db.run(sql`UPDATE bots SET last_event_at = ${now} WHERE key = ${bot.key}`);
  if ((await kvGet('hub_keep')) !== '1') await del(ctx, chat, post.message_id, 'hub_clean');
  return { hub: true, bot: bot.key, kind: doc.k, result };
}
