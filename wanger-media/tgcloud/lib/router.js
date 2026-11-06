// Entry point for every update: error boundary → de-duplication → state → gates → screen.
//
// Order of checks for a private message or button (brief §5, §6, §8):
//   1. not a private chat / no sender → ignored (groups come in Phase 5; nothing is written)
//   2. update_id handled before → skipped (Telegram may deliver an update twice)
//   3. settings (first run: seed the forced-join channels), the user row (+ running counters)
//   4. buttons only: same button on the same message within DOUBLE_TAP_MS → ignored
//   5. ban (never the owner) → maintenance (staff exempt) → language (first run) → forced join
//      (staff exempt) → the screen
// Handlers never throw: errors are stored in error_log, the owner gets a throttled alert, the user
// a short "something went wrong", and the handler returns { ok: false }.
//
// callback_data codes (lib/codec.js):
//   h          home
//   l          language picker
//   L:<lang>   set language (fa | en | ru)
//   j          check forced join again
import { alertOwner } from './alerts.js';
import { CB, decode } from './codec.js';
import { BOT_USERNAME, DOUBLE_TAP_MS, ERROR_ALERT_EVERY_S, HOUSEKEEP_EVERY_S } from './config.js';
import * as groups from './db/groups.js';
import * as system from './db/system.js';
import * as users from './db/users.js';
import { detectLang, LANG_NAMES, normLang, tp } from './i18n/index.js';
import * as join from './join.js';
import { actorOf, isOwnerId, isStaff } from './roles.js';
import * as tg from './tg.js';
import { formatTime, joinGate, languagePicker, plain, welcome } from './ui.js';
import { clip, displayName, errorText, nowSec, tehranDay } from './util.js';

const SETTING_KEYS = ['seed.channels', 'switch.maintenance', 'switch.forced_join', 'hk'];

function newCtx(sdkCtx) {
  const update = sdkCtx && sdkCtx.update;
  return {
    now: nowSec(),
    nowMs: Date.now(),
    updateId: update && Number.isInteger(update.update_id) ? update.update_id : null,
    trace: [],
    flags: { forcedJoin: true, maintenance: false },
    settings: {},
    settingsLoaded: false,
    replyChat: null,
    lang: null,
  };
}

async function reportError(ctx, source, err) {
  try {
    await system.logError(ctx.now, source, errorText(err), err && err.stack ? clip(err.stack, 1500) : null);
  } catch { /* the database itself may be the problem */ }
  try {
    await alertOwner(ctx, 'error:' + source, 'alert.error', { source, message: errorText(err) }, ERROR_ALERT_EVERY_S);
  } catch { /* best effort */ }
  if (ctx.replyChat) {
    try { await tg.send(ctx, 'error', ctx.replyChat, plain(ctx.lang || 'en', 'error.generic')); } catch { /* best effort */ }
  }
}

/** Piggybacked housekeeping: at most once per HOUSEKEEP_EVERY_S, claimed atomically. */
async function maybeHousekeep(ctx) {
  const hk = ctx.settings.hk;
  if (hk && hk.updatedAt > ctx.now - HOUSEKEEP_EVERY_S) return null;
  try {
    if (!(await system.claimThrottle('hk', ctx.now, HOUSEKEEP_EVERY_S))) return null;
    return await system.housekeep(ctx.now);
  } catch (err) {
    return { error: errorText(err) };
  }
}

async function boundary(source, sdkCtx, fn) {
  const ctx = newCtx(sdkCtx);
  let result;
  try {
    result = await fn(ctx);
  } catch (err) {
    await reportError(ctx, source, err);
    return { ok: false, error: errorText(err), trace: ctx.trace };
  }
  const housekeeping = ctx.settingsLoaded ? await maybeHousekeep(ctx) : null;
  return { ok: true, ...result, ...(housekeeping ? { housekeeping } : {}), trace: ctx.trace };
}

/** false if this update_id was handled before. Updates without an id (manual runs) always pass. */
async function dedupe(ctx) {
  if (ctx.updateId === null) return true;
  return system.markUpdate(ctx.updateId, ctx.now);
}

async function loadState(ctx) {
  const s = await system.loadSettings(SETTING_KEYS);
  ctx.settings = s;
  ctx.settingsLoaded = true;
  ctx.flags.maintenance = !!(s['switch.maintenance'] && s['switch.maintenance'].value === true);
  ctx.flags.forcedJoin = s['switch.forced_join'] ? s['switch.forced_join'].value !== false : true;
  if (!s['seed.channels']) await join.seedOnce(ctx);
}

/** Loads (or creates) the user and keeps the running user counters exact. */
async function prepareUser(ctx, from) {
  const day = tehranDay(ctx.now);
  let row = await users.load(from.id);
  const incs = [];
  let isNew = false;
  if (!row) {
    if (await users.insert(from, ctx.now, day)) {
      isNew = true;
      incs.push(['users', '', 1], ['users_new', day, 1], ['users_active', day, 1]);
    }
    row = await users.load(from.id);
  } else if (row.seen_day !== day) {
    if (await users.markSeenToday(from, ctx.now, day)) incs.push(['users_active', day, 1]);
  } else if (row.blocked || row.username !== (from.username || null) || row.first_name !== (from.first_name || null)
    || row.tg_lang !== (from.language_code || null)) {
    await users.updateProfile(from, ctx.now);
  }
  if (incs.length) await system.count(incs);
  const actor = actorOf(from.id, row && row.role ? { role: row.role, perms: row.role_perms } : null);
  const user = {
    id: from.id, row, actor, isNew,
    lang: normLang(row && row.lang),
    preselected: detectLang(from.language_code),
    name: displayName(from),
  };
  ctx.lang = user.lang || user.preselected;
  return user;
}

/** Ban and maintenance, before anything else: → { view, screen } or null. */
function preGates(ctx, user) {
  const lang = user.lang || user.preselected;
  const until = user.row && user.row.ban_until;
  if (!isOwnerId(user.id) && until != null && (until === 0 || until > ctx.now)) {
    return { view: 'banned', screen: until === 0 ? plain(lang, 'banned.forever') : plain(lang, 'banned.until', { date: formatTime(until) }) };
  }
  if (ctx.flags.maintenance && !isStaff(user.actor)) return { view: 'maintenance', screen: plain(lang, 'maintenance') };
  return null;
}

/** Sends to the user's private chat; a user who blocked the bot is marked, not treated as an error. */
async function reply(ctx, user, view, screen) {
  try {
    await tg.send(ctx, view, user.id, screen);
  } catch (err) {
    if (err && err.kind === 'blocked') return users.setBlocked(user.id, true);
    if (err && err.kind === 'chat_not_found') return null; // e.g. a manual run with a fake id
    throw err;
  }
  return null;
}

/** "/start", "/language@Wanger_mediabot" → "start" / "language"; anything else → null. */
export function command(text) {
  const m = /^\/([A-Za-z0-9_]{1,32})(?:@([A-Za-z0-9_]{3,64}))?(?:\s|$)/.exec(String(text || ''));
  if (!m) return null;
  if (m[2] && m[2].toLowerCase() !== BOT_USERNAME.toLowerCase()) return null;
  return m[1].toLowerCase();
}

const joinSummary = (r) => ({ pass: r.pass, missing: (r.missing || []).length, unknown: (r.unknown || []).length, cached: !!r.cached, skipped: !!r.skipped });

/** Home after the forced-join gate; `message` = the bot message to edit (buttons), else a new one. */
async function showHome(ctx, user, message) {
  const lang = user.lang;
  const r = await join.check(ctx, user);
  const view = r.pass ? 'home' : 'join';
  const screen = r.pass ? welcome(lang, user.name) : joinGate(lang, r);
  if (message) await tg.edit(ctx, view, message, screen);
  else await reply(ctx, user, view, screen);
  return { view, join: joinSummary(r) };
}

export const onMessage = (msg, sdkCtx) => boundary('message', sdkCtx, async (ctx) => {
  if (!msg || !msg.chat || msg.chat.type !== 'private' || !msg.from || msg.from.is_bot) return { ignored: 'not_private' };
  if (!(await dedupe(ctx))) return { dup: true };
  ctx.replyChat = msg.chat.id;
  await loadState(ctx);
  const user = await prepareUser(ctx, msg.from);
  const gate = preGates(ctx, user);
  if (gate) {
    await reply(ctx, user, gate.view, gate.screen);
    return { view: gate.view };
  }
  const cmd = command(msg.text);
  if (!user.lang || cmd === 'language' || cmd === 'lang') {
    await reply(ctx, user, 'language', languagePicker({ current: user.lang, preselected: user.preselected }));
    return { view: 'language' };
  }
  return showHome(ctx, user, null);
});

export const onCallback = (cq, sdkCtx) => boundary('callback_query', sdkCtx, async (ctx) => {
  if (!cq || !cq.from || !cq.id) return { ignored: 'malformed' };
  const msg = cq.message;
  if (!msg || !msg.chat || msg.chat.type !== 'private') {
    await tg.answer(ctx, cq.id);
    return { ignored: 'not_private' };
  }
  if (!(await dedupe(ctx))) return { dup: true };
  ctx.replyChat = msg.chat.id;
  await loadState(ctx);
  const user = await prepareUser(ctx, cq.from);
  if (!(await users.claimTap(user.id, `${msg.message_id}:${cq.data}`, ctx.nowMs, DOUBLE_TAP_MS))) {
    await tg.answer(ctx, cq.id);
    return { doubleTap: true };
  }
  const gate = preGates(ctx, user);
  if (gate) {
    await tg.answer(ctx, cq.id);
    await tg.edit(ctx, gate.view, msg, gate.screen);
    return { view: gate.view };
  }
  const d = decode(cq.data);
  const lang = user.lang || user.preselected;
  if (!d) {
    await tg.answer(ctx, cq.id, tp(lang, 'menu.expired'));
    if (!user.lang) {
      await tg.edit(ctx, 'language', msg, languagePicker({ current: null, preselected: user.preselected }));
      return { view: 'language', expired: true };
    }
    return { ...(await showHome(ctx, user, msg)), expired: true };
  }

  if (d.code === CB.LANG_SET) {
    const l = d.args[0];
    if (user.lang !== l) await users.setLang(user.id, l);
    user.lang = l;
    ctx.lang = l;
    await tg.answer(ctx, cq.id, tp(l, 'lang.saved', { name: LANG_NAMES[l] }));
    return showHome(ctx, user, msg);
  }
  if (!user.lang || d.code === CB.LANG_MENU) {
    await tg.answer(ctx, cq.id);
    await tg.edit(ctx, 'language', msg, languagePicker({ current: user.lang, preselected: user.preselected }));
    return { view: 'language' };
  }
  if (d.code === CB.JOIN_CHECK) {
    const r = await join.check(ctx, user);
    if (r.pass) {
      await tg.answer(ctx, cq.id, tp(lang, 'join.ok'));
      await tg.edit(ctx, 'home', msg, welcome(lang, user.name));
      return { view: 'home', join: joinSummary(r) };
    }
    await tg.answer(ctx, cq.id, tp(lang, r.missing.length ? 'join.not_yet' : 'join.cant_check'), true);
    await tg.edit(ctx, 'join', msg, joinGate(lang, r));
    return { view: 'join', join: joinSummary(r) };
  }
  // CB.HOME
  await tg.answer(ctx, cq.id);
  return showHome(ctx, user, msg);
});

export const onMyChatMember = (upd, sdkCtx) => boundary('my_chat_member', sdkCtx, async (ctx) => {
  if (!upd || !upd.chat || !upd.new_chat_member) return { ignored: 'malformed' };
  if (!(await dedupe(ctx))) return { dup: true };
  const chat = upd.chat;
  const status = upd.new_chat_member.status;
  if (chat.type === 'private') {
    const blocked = status === 'kicked';
    await users.setBlocked(chat.id, blocked);
    return { view: blocked ? 'user_blocked' : 'user_unblocked' };
  }
  if (chat.type === 'group' || chat.type === 'supergroup') {
    const r = await groups.recordStatus(chat, status, status === 'administrator', upd.from ? upd.from.id : 0, ctx.now);
    const incs = [];
    if (r.activated) incs.push(['groups_active', '', 1], ['groups_joined', tehranDay(ctx.now), 1]);
    if (r.deactivated) incs.push(['groups_active', '', -1]);
    if (incs.length) await system.count(incs);
    return { view: 'group_status', status, ...r };
  }
  if (chat.type === 'channel') return { view: 'channel_status', ...(await join.onChannelStatus(ctx, chat, status)) };
  return { ignored: chat.type };
});
