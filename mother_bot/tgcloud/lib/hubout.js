// What the mother posts to the hub channel for the child bots (they read it with client/mother-client.js).
//
// The hub is a private channel where the mother and every connected child bot are admins. A hub post is
// plain text: the tag HUB_PREFIX, a space, and one JSON document
//   { "b": sender key ("mother" here), "k": kind, "to": target bot key or "*", "t": unix time, "d": data }
// Kinds the mother sends:
//   cfg       to one bot: { v: version, mode: off|slow|closed, msg, until, slow: seconds, join: [{ id, u, t, inv }] }
//   ban       { u: [user ids], until: 0 (permanent) | unix time, s: scope } — to '*' or one bot
//   unban     { u: [user ids] }
//   promo     { c: code, p: percent, bots: [keys] | '*', until, uid: 0 | the only user allowed, max }
//   promos    { l: [promo, ...] } — several at once (a full sync)
//   promo_off { c: code } or { cs: [codes] }
// Trust: anyone who can post in the hub can speak for a bot, so the hub stays private with only the
// owner and the bots as admins. The mother accepts posts from the configured hub chat only.
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { HUB_BAN_CHUNK, HUB_MAX_TEXT, HUB_PREFIX, HUB_SELF } from './config.js';
import { getBot, updateBot } from './catalog.js';
import { kvGet } from './store.js';
import { call, describeError } from './tg.js';
import { nowSec, parseJson } from './util.js';

export const hubChat = async () => {
  const v = await kvGet('hub_chat');
  return v ? Number(v) : null;
};

/** Posts one hub message; returns the sent message or null (no hub, too long, or Telegram refused). */
export async function postHub(ctx, kind, to, d) {
  const chat = await hubChat();
  if (!chat) return null;
  const text = `${HUB_PREFIX} ${JSON.stringify({ b: HUB_SELF, k: kind, to, t: nowSec(), d })}`;
  if (text.length > HUB_MAX_TEXT) {
    console.warn(`hub ${kind} message too long (${text.length})`);
    return null;
  }
  try {
    return await call(ctx, 'sendMessage', { chat_id: chat, text, disable_notification: true, link_preview_options: { is_disabled: true } }, `hub_${kind}`);
  } catch (err) {
    console.warn(`hub post ${kind} failed: ${describeError(err)}`);
    return null;
  }
}

/** The forced-join channels a bot must enforce: the global ones and its own. */
export async function joinListFor(key) {
  const rows = await db.all(sql`SELECT * FROM channels WHERE scope IN ('*', ${key}) ORDER BY id LIMIT 30`);
  const on = (await kvGet('join_on')) !== '0';
  if (!on) return rows.filter((r) => r.scope === key);
  return rows;
}

/** Posts a bot's current config (access mode + forced-join channels) with a new version number. */
export async function pushConfig(ctx, key) {
  const bot = await getBot(key);
  if (!bot) return null;
  const v = Number(bot.cfg_ver || 0) + 1;
  const join = (await joinListFor(key)).map((c) => ({ id: Number(c.chat_id), u: c.username || undefined, t: c.title || undefined, inv: c.invite || undefined }));
  const d = { v, mode: bot.mode || 'off', slow: Number(bot.slow_sec || 30), until: Number(bot.mode_until || 0), join };
  if (bot.mode_msg) d.msg = String(bot.mode_msg).slice(0, 500);
  const m = await postHub(ctx, 'cfg', key, d);
  if (m) await updateBot(key, { cfg_ver: v });
  return m;
}

/** Re-posts the config of every bot (after a global forced-join change). */
export async function pushAllConfigs(ctx) {
  const rows = await db.all(sql`SELECT key FROM bots ORDER BY sort LIMIT 60`);
  let n = 0;
  for (const r of rows) if (await pushConfig(ctx, r.key)) n += 1;
  return n;
}

export async function pushBan(ctx, userIds, scope, until) {
  const to = scope === '*' || scope === 'mother' ? '*' : scope;
  if (scope === 'mother') return 0;
  let n = 0;
  for (let i = 0; i < userIds.length; i += HUB_BAN_CHUNK) {
    if (await postHub(ctx, 'ban', to, { u: userIds.slice(i, i + HUB_BAN_CHUNK), until, s: scope })) n += 1;
  }
  return n;
}

export async function pushUnban(ctx, userIds, scopes) {
  const targets = new Set(scopes.filter((s) => s !== 'mother').map((s) => (s === '*' ? '*' : s)));
  for (const to of targets) await postHub(ctx, 'unban', to, { u: userIds });
}

/** Everything a (re)connecting child needs: its config, its active bans, the promos that apply to it. */
export async function fullSync(ctx, key) {
  await pushConfig(ctx, key);
  const now = nowSec();
  const bans = await db.all(sql`
    SELECT user_id, scope, until FROM bans WHERE scope IN ('*', ${key}) AND (until = 0 OR until > ${now})
    ORDER BY user_id LIMIT 3000`);
  const groups = new Map();
  for (const b of bans) {
    const g = `${b.scope}|${b.until}`;
    if (!groups.has(g)) groups.set(g, { scope: b.scope, until: Number(b.until), ids: [] });
    groups.get(g).ids.push(Number(b.user_id));
  }
  for (const g of groups.values()) {
    for (let i = 0; i < g.ids.length; i += HUB_BAN_CHUNK) {
      await postHub(ctx, 'ban', key, { u: g.ids.slice(i, i + HUB_BAN_CHUNK), until: g.until, s: g.scope });
    }
  }
  await postPromos(ctx, key, await promosFor(key));
}

/** Posts promos in as few hub messages as fit. */
export async function postPromos(ctx, to, list) {
  let batch = [];
  let size = 0;
  for (const p of list) {
    const len = JSON.stringify(p).length + 1;
    if (batch.length && size + len > HUB_MAX_TEXT - 200) {
      await postHub(ctx, 'promos', to, { l: batch });
      batch = [];
      size = 0;
    }
    batch.push(p);
    size += len;
  }
  if (batch.length) await postHub(ctx, 'promos', to, { l: batch });
}

/** Withdraws codes, many per hub message. */
export async function postPromoOff(ctx, codes) {
  for (let i = 0; i < codes.length; i += 200) await postHub(ctx, 'promo_off', '*', { cs: codes.slice(i, i + 200) });
}

/** The hub form of a code: { c, p, bots, until, uid, max }. */
export function promoOf(campaign, code, uid) {
  const bots = parseJson(campaign.bots, '*');
  return { c: code, p: Number(campaign.pct), bots, until: Number(campaign.ends_at || 0), uid: Number(uid || 0), max: Number(campaign.max_uses || 0) };
}

const appliesTo = (campaign, key) => {
  const bots = parseJson(campaign.bots, '*');
  return bots === '*' || (Array.isArray(bots) && bots.includes(key));
};

/** Active codes a bot should accept: shared codes and claimed, unused personal codes. */
export async function promosFor(key) {
  const now = nowSec();
  const camps = await db.all(sql`SELECT * FROM campaigns WHERE status = 'active' ORDER BY id DESC LIMIT 50`);
  const out = [];
  for (const c of camps) {
    if (!appliesTo(c, key) || (c.ends_at && c.ends_at <= now)) continue;
    if (!c.personal && c.code) {
      if (!c.max_uses || c.uses < c.max_uses) out.push(promoOf(c, c.code, 0));
      continue;
    }
    const rows = await db.all(sql`SELECT code, user_id FROM codes WHERE campaign_id = ${c.id} AND used_at = 0 AND user_id > 0 ORDER BY code LIMIT 200`);
    for (const r of rows) out.push(promoOf(c, r.code, r.user_id));
  }
  return out;
}
