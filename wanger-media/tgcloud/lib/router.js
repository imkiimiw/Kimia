// Entry point for every update: error boundary → de-duplication → state → gates → screen.
//
// Order of checks for a private message or button (brief §5, §6, §8):
//   1. not a private chat / no sender → ignored (groups come in Phase 5; nothing is written)
//   2. update_id handled before → skipped (Telegram may deliver an update twice)
//   3. settings (first run: seed the forced-join channels), the user row (+ running counters)
//   4. buttons only: same button on the same message within DOUBLE_TAP_MS → ignored
//   5. ban (never the owner) → maintenance (staff exempt) → language (first run) → forced join
//      (staff exempt) → disclaimer (first use; the owner is exempt) → the screen (lib/menu.js)
// Handlers never throw: errors are stored in error_log, the owner gets a throttled alert, the user
// a short "something went wrong", and the handler returns { ok: false }.
//
// A private message with a link (entities: url / text_link) goes to lib/download.js after the
// gates (the first link only). /admin and the owner panel's buttons are owner-only (lib/admin.js),
// re-checked on every command and every button.
//
// callback_data codes (lib/codec.js):
//   h          home                       s          settings
//   l[:s]      language picker            q          quality picker
//   L:<lang>[:s] set language (fa|en|ru)  Q:<q>      set quality (auto|best|small)
//   j          check forced join again    i          help
//   a          accept the disclaimer      o          about
//   H:<page>   my downloads, page 0–12    d          how to download
//   owner panel: A list · P:<pid> platform · M:<pid>:<method>:<0|1> method off/on (on → risk note)
//                C:<pid>:<method> confirm after the risk note · E:<pid>:<1|0> pause/resume · T:<pid> health
// ":s" = opened from Settings, so the picker returns there.
import * as admin from './admin/index.js';
import { ACTIVE_KEY, piggyback } from './broadcast.js';
import { alertOwner } from './alerts.js';
import { CB, decode } from './codec.js';
import { BOT_USERNAME, DISCLAIMER_VERSION_AT, DOUBLE_TAP_MS, ERROR_ALERT_EVERY_S, HOUSEKEEP_EVERY_S } from './config.js';
import * as groups from './db/groups.js';
import * as system from './db/system.js';
import * as users from './db/users.js';
import { detectLang, LANG_NAMES, normLang, t, tp } from './i18n/index.js';
import * as join from './join.js';
import * as menu from './menu.js';
import { handleLink } from './download.js';
import { extractLinks } from './url.js';
import { actorOf, isOwnerId, isStaff } from './roles.js';
import * as tg from './tg.js';
import { disclaimer, formatTime, joinGate, languagePicker, plain } from './ui.js';
import { clip, displayName, errorText, nowSec, tehranDay } from './util.js';

const SETTING_KEYS = [
  'seed.channels', 'switch.maintenance', 'switch.forced_join', 'hk', ACTIVE_KEY,
  ...['welcome', 'join'].flatMap((k) => ['fa', 'en', 'ru'].map((l) => `text.${k}.${l}`)),
];

/** A staff-edited text (welcome / join) for a language, or null. */
const customText = (ctx, key, lang) => {
  const v = ctx.settings[`text.${key}.${lang}`];
  return v && typeof v.value === 'string' && v.value.trim() ? v.value : null;
};

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
  // A few messages of a running broadcast on the side of this update (there is no scheduler).
  const broadcast = ctx.settingsLoaded && ctx.settings[ACTIVE_KEY] && !ctx.broadcastRan ? await piggyback(ctx, ctx.settings[ACTIVE_KEY]) : null;
  return { ok: true, ...result, ...(housekeeping ? { housekeeping } : {}), ...(broadcast ? { broadcast } : {}), trace: ctx.trace };
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
  } else if (row.username !== (from.username || null) || row.first_name !== (from.first_name || null)
    || row.tg_lang !== (from.language_code || null)) {
    await users.updateProfile(from, ctx.now);
  }
  // Writing to the bot means it is not blocked (any more); counted only by the call that changed it.
  if (row && row.blocked && (await users.setBlocked(from.id, false))) {
    incs.push(['users_blocked', '', -1]);
    row.blocked = 0;
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
    if (err && err.kind === 'blocked') {
      if (await users.setBlocked(user.id, true)) await system.count([['users_blocked', '', 1]]);
      return null;
    }
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

/** Shows a screen: edits `message` (buttons) or sends a new message (commands, text). */
async function show(ctx, user, message, view, screen) {
  if (message) await tg.edit(ctx, view, message, screen);
  else await reply(ctx, user, view, screen);
}

export const needsDisclaimer = (user) => !isOwnerId(user.id) && (Number(user.row && user.row.disclaimer_at) || 0) < DISCLAIMER_VERSION_AT;

/**
 * Forced join, then the disclaimer. → { held, join }: `held` is null when the user may see menus;
 * otherwise the gate or the disclaimer has been shown and `held` is the result to hand back.
 */
async function gateway(ctx, user, message) {
  const r = await join.check(ctx, user);
  const summary = joinSummary(r);
  if (!r.pass) {
    await show(ctx, user, message, 'join', joinGate(user.lang, r, customText(ctx, 'join', user.lang)));
    return { held: { view: 'join', join: summary }, join: summary };
  }
  if (needsDisclaimer(user)) {
    await show(ctx, user, message, 'disclaimer', disclaimer(user.lang));
    return { held: { view: 'disclaimer', join: summary }, join: summary };
  }
  return { held: null, join: summary };
}

/** Opens a menu target after the gateway. */
async function open(ctx, user, message, target, arg) {
  const g = await gateway(ctx, user, message);
  if (g.held) return g.held;
  const { view, screen } = await menu.build(user, target, arg, { welcome: customText(ctx, 'welcome', user.lang) });
  await show(ctx, user, message, view, screen);
  return { view, join: g.join };
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
  if (admin.canOpen(user)) {
    if (cmd === 'cancel') {
      await admin.clearInput(user);
      const r = admin.homeScreen(user, t(user.lang, 'adm.input_cancelled'));
      await reply(ctx, user, r.view, r.screen);
      return { view: r.view };
    }
    if (cmd === 'admin') {
      const r = admin.homeScreen(user);
      await reply(ctx, user, r.view, r.screen);
      return { view: r.view };
    }
    const pending = cmd ? null : await admin.pendingInput(ctx, user);
    if (pending) {
      const r = await admin.onInput(ctx, user, pending, msg);
      if (r.error) {
        await reply(ctx, user, 'admin_input_error', { text: r.error });
        return { view: 'admin_input_error' };
      }
      await reply(ctx, user, r.view, r.screen);
      return { view: r.view };
    }
  }
  const links = cmd ? [] : extractLinks(msg);
  if (links.length) {
    const g = await gateway(ctx, user, null);
    if (g.held) return g.held;
    const result = await handleLink(ctx, user, msg, links[0]);
    return { view: 'download', download: { status: result.status, reason: result.reason || null, platform: result.platform || null, method: result.method || null, cached: !!result.cached } };
  }
  return open(ctx, user, null, menu.COMMAND_TARGETS[cmd] || 'home', 0);
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
    return { ...(await open(ctx, user, msg, 'home')), expired: true };
  }

  if (d.code === CB.LANG_SET) {
    const l = d.args[0];
    if (user.lang !== l) await users.setLang(user.id, l);
    user.lang = l;
    ctx.lang = l;
    await tg.answer(ctx, cq.id, tp(l, 'lang.saved', { name: LANG_NAMES[l] }));
    return open(ctx, user, msg, d.args[1] === 's' ? 'settings' : 'home');
  }
  if (!user.lang || d.code === CB.LANG_MENU) {
    await tg.answer(ctx, cq.id);
    await tg.edit(ctx, 'language', msg, languagePicker({ current: user.lang, preselected: user.preselected, from: d.args[0] || null }));
    return { view: 'language' };
  }
  if (d.code === CB.JOIN_CHECK) {
    const r = await join.check(ctx, user);
    if (!r.pass) {
      await tg.answer(ctx, cq.id, tp(lang, r.missing.length ? 'join.not_yet' : 'join.cant_check'), true);
      await tg.edit(ctx, 'join', msg, joinGate(lang, r));
      return { view: 'join', join: joinSummary(r) };
    }
    await tg.answer(ctx, cq.id, tp(lang, 'join.ok'));
    return open(ctx, user, msg, 'home');
  }
  if (d.code === CB.ACCEPT) {
    if (needsDisclaimer(user)) {
      // Never earlier than the current version's date, so an acceptance always satisfies it.
      const at = Math.max(ctx.now, DISCLAIMER_VERSION_AT);
      await users.setDisclaimer(user.id, at);
      user.row.disclaimer_at = at;
    }
    await tg.answer(ctx, cq.id, tp(lang, 'disclaimer.ok'));
    return open(ctx, user, msg, 'home');
  }
  if (d.code === CB.QUALITY_SET) {
    const g = await gateway(ctx, user, msg);
    if (g.held) {
      await tg.answer(ctx, cq.id);
      return g.held;
    }
    await users.setQuality(user.id, d.args[0], ctx.now);
    await tg.answer(ctx, cq.id, tp(lang, 'quality.saved', { name: tp(lang, 'quality.' + d.args[0]) }));
    return open(ctx, user, msg, 'settings');
  }

  if ('APMCET'.includes(d.code)) return ownerPanel(ctx, user, cq, msg, d);

  await tg.answer(ctx, cq.id);
  const targets = { [CB.HISTORY]: 'downloads', [CB.SETTINGS]: 'settings', [CB.QUALITY_MENU]: 'quality', [CB.HELP]: 'help', [CB.ABOUT]: 'about', [CB.DOWNLOAD]: 'download' };
  return open(ctx, user, msg, targets[d.code] || 'home', d.code === CB.HISTORY ? Number(d.args[0]) : 0);
});

/** Admin panel buttons: permissions are checked again on every press (lib/admin/index.js). */
async function ownerPanel(ctx, user, cq, msg, d) {
  const r = await admin.onButton(ctx, user, d, msg);
  if (r.denied) {
    await tg.answer(ctx, cq.id);
    return { ignored: 'not_allowed' };
  }
  await tg.answer(ctx, cq.id, r.toast ? r.toast.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') : undefined, !!r.alert);
  if (r.screen) await tg.edit(ctx, r.view, msg, r.screen);
  return { view: r.view };
}

export const onMyChatMember = (upd, sdkCtx) => boundary('my_chat_member', sdkCtx, async (ctx) => {
  if (!upd || !upd.chat || !upd.new_chat_member) return { ignored: 'malformed' };
  if (!(await dedupe(ctx))) return { dup: true };
  const chat = upd.chat;
  const status = upd.new_chat_member.status;
  if (chat.type === 'private') {
    const blocked = status === 'kicked';
    if (await users.setBlocked(chat.id, blocked)) await system.count([['users_blocked', '', blocked ? 1 : -1]]);
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
