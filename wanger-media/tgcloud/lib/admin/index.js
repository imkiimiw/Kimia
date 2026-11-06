// The admin panel (brief §8): /admin for staff. Every button and every text input is checked again
// here against the actor's permissions (lib/roles.js) before a section module runs — the panel's
// buttons are never trusted on their own. Sections only appear for those who may use them.
//
// Text input (search, channel to add, limits, texts, broadcast message, …) is a pending state in the
// settings table ('input:<user id>' = { k, a, at }), valid INPUT_TTL_S; /cancel or ✖️ ends it.
// Section results: { view, screen, toast?, alert?, input?, notice? } | { error, done? } for input.
import * as system from '../db/system.js';
import { t, tp } from '../i18n/index.js';
import { can, canManageChannels, isStaff, P } from '../roles.js';
import * as ui from '../ui.js';
import * as platforms from './platforms.js';
import * as bcast from './broadcast.js';
import * as channels from './channels.js';
import * as staff from './staff.js';
import * as sys from './system.js';
import * as usersAdmin from './users.js';

export const INPUT_TTL_S = 600;
export const canOpen = (user) => !!user && isStaff(user.actor);
const inputKey = (user) => 'input:' + user.id;

export function homeScreen(user, notice = null) {
  const a = user.actor;
  const lang = user.lang;
  const items = [
    [can(a, P.VIEW_STATS), 'adm.btn.overview', 'A:o'],
    [can(a, P.VIEW_USERS), 'adm.btn.users', 'A:u'],
    [canManageChannels(a), 'adm.btn.channels', 'A:c'],
    [can(a, P.MANAGE_PLATFORMS), 'adm.btn.platforms', 'A:p'],
    [can(a, P.MANAGE_SETTINGS), 'adm.btn.settings', 'A:s'],
    [can(a, P.MANAGE_SETTINGS), 'adm.btn.texts', 'A:t'],
    [can(a, P.BROADCAST), 'adm.btn.broadcast', 'A:b'],
    [can(a, P.VIEW_AUDIT), 'adm.btn.audit', 'A:a:0'],
    [can(a, P.MANAGE_ADMINS), 'adm.btn.staff', 'A:x'],
  ].filter(([ok]) => ok).map(([, key, data]) => ui.button(tp(lang, key), data));
  const rows = [];
  for (let i = 0; i < items.length; i += 2) rows.push(items.slice(i, i + 2));
  rows.push([ui.button(tp(lang, 'btn.home'), 'h')]);
  const text = (notice ? notice + '\n\n' : '') + t(lang, 'adm.home', { role: tp(lang, 'role.' + a.role) });
  return { view: 'admin', screen: { text, reply_markup: ui.markup(rows) } };
}

/** Which permission a section needs (the owner has all). */
function allowed(actor, section) {
  if (!section) return true;
  const c = section[0];
  if (section === 'i') return true;
  if (c === 'o') return can(actor, P.VIEW_STATS);
  if (c === 'u') return can(actor, P.VIEW_USERS);
  if (c === 'c') return canManageChannels(actor);
  if (c === 'p') return can(actor, P.MANAGE_PLATFORMS);
  if (c === 's' || c === 't') return can(actor, P.MANAGE_SETTINGS);
  if (c === 'b') return can(actor, P.BROADCAST);
  if (c === 'a') return can(actor, P.VIEW_AUDIT);
  if (c === 'x') return can(actor, P.MANAGE_ADMINS);
  return false;
}

async function setInput(ctx, user, input) {
  await system.setSetting(inputKey(user), { k: input.k, a: input.a ?? null, at: ctx.now }, user.id, ctx.now);
}
export async function clearInput(user) {
  await system.deleteSetting(inputKey(user));
}

/** Applies a section result's side effects (pending input, notices) and returns it. */
async function finish(ctx, user, r) {
  if (r.input) await setInput(ctx, user, r.input);
  if (r.notice && r.screen) r.screen = { ...r.screen, text: r.notice + '\n\n' + r.screen.text };
  return r;
}

/**
 * A panel button. `d` = decoded callback_data (code 'A' with a section, or the platform codes
 * P/M/C/E/T). `message` = the panel message (broadcast progress is shown there).
 * → a section result, or { denied: true } when the actor may not use it.
 */
export async function onButton(ctx, user, d, message) {
  if (!canOpen(user)) return { denied: true };
  const a = user.actor;
  if (d.code !== 'A') {
    if (!can(a, P.MANAGE_PLATFORMS)) return { denied: true };
    const [pid, x, y] = d.args;
    if (d.code === 'P') return finish(ctx, user, await platforms.platformScreen(user, pid));
    if (d.code === 'M') return finish(ctx, user, await platforms.setMethod(ctx, user, pid, x, y === '1', false));
    if (d.code === 'C') return finish(ctx, user, await platforms.setMethod(ctx, user, pid, x, true, true));
    if (d.code === 'E') return finish(ctx, user, await platforms.setPaused(ctx, user, pid, x === '1'));
    return finish(ctx, user, await platforms.health(ctx, user, pid));
  }
  const [section, x, y] = d.args;
  if (!allowed(a, section)) return { denied: true };
  const id = x !== undefined && /^\d+$/.test(x) ? Number(x) : null;
  let r;
  switch (section) {
    case undefined: r = homeScreen(user); break;
    case 'i': await clearInput(user); r = homeScreen(user, t(user.lang, 'adm.input_cancelled')); break;
    case 'o': r = await sys.overviewScreen(ctx, user); break;
    case 'u': r = id ? await usersAdmin.profileScreen(ctx, user, id) : usersAdmin.searchPrompt(user); break;
    case 'ub': r = await usersAdmin.ban(ctx, user, id, Number(y)); break;
    case 'uu': r = await usersAdmin.unban(ctx, user, id); break;
    case 'uq': r = await usersAdmin.quotaPrompt(user, id); break;
    case 'un': r = await usersAdmin.notePrompt(user, id); break;
    case 'uh': r = await usersAdmin.historyScreen(user, id, Number(y)); break;
    case 'c': r = id ? await channels.channelScreen(user, id) : await channels.listScreen(user); break;
    case 'ca': r = channels.addPrompt(user); break;
    case 'ct': r = await channels.toggle(ctx, user, id); break;
    case 'cr': r = await channels.recheck(ctx, user, id); break;
    case 'cd': r = await channels.deleteAsk(user, id); break;
    case 'cD': r = await channels.deleteNow(ctx, user, id); break;
    case 'p': r = await platforms.listScreen(user); break;
    case 'pb': r = await platforms.blocklistScreen(user); break;
    case 'pba': r = { view: 'admin_blocklist', input: { k: 'pba', a: x }, screen: { text: t(user.lang, 'adm.block.prompt.' + x), reply_markup: ui.markup([[ui.button(tp(user.lang, 'adm.btn.cancel'), 'A:i')]]) } }; break;
    case 'pbd': r = await platforms.blockRemove(ctx, user, id); break;
    case 'pc': r = { view: 'admin_platforms', input: { k: 'pc' }, screen: { text: t(user.lang, 'adm.purge.prompt'), reply_markup: ui.markup([[ui.button(tp(user.lang, 'adm.btn.cancel'), 'A:i')]]) } }; break;
    case 'pe': r = await platforms.failuresScreen(user, x); break;
    case 's': r = await sys.switchesScreen(user); break;
    case 'sm': r = await sys.toggle(ctx, user, 'm'); break;
    case 'sd': r = await sys.toggle(ctx, user, 'd'); break;
    case 'sf': r = await sys.toggle(ctx, user, 'f'); break;
    case 'sl': r = sys.limitPrompt(user, x); break;
    case 't': r = await sys.textsScreen(user); break;
    case 'te': r = sys.textPrompt(user, x, y); break;
    case 'tr': r = await sys.textReset(ctx, user, x, y); break;
    case 'b': r = await bcast.menuScreen(user); break;
    case 'bn': r = bcast.newPrompt(user); break;
    case 'bs': r = await bcast.start(ctx, user, id, message); break;
    case 'bg': r = await bcast.nextBatch(ctx, user, id); break;
    case 'bx': r = await bcast.cancel(ctx, user, id); break;
    case 'a': r = await sys.auditScreen(user, Number(x)); break;
    case 'x': r = id ? await staff.memberScreen(user, id) : await staff.listScreen(user); break;
    case 'xa': r = staff.addPrompt(user); break;
    case 'xr': r = await staff.setRole(ctx, user, id, y); break;
    case 'xf': r = await staff.toggleFlag(ctx, user, id, Number(y)); break;
    default: return { denied: true };
  }
  return finish(ctx, user, r);
}

/** The pending input of a staff member, or null (expired inputs are dropped). */
export async function pendingInput(ctx, user) {
  if (!canOpen(user)) return null;
  const s = await system.loadSettings([inputKey(user)]);
  const v = s[inputKey(user)] && s[inputKey(user)].value;
  if (!v || !v.k) return null;
  if (!(v.at > ctx.now - INPUT_TTL_S)) {
    await clearInput(user);
    return null;
  }
  return v;
}

/**
 * A private message while an input is pending. Permissions are checked again for the section the
 * input belongs to. → a section result to show, or { error } (shown; the input stays pending unless
 * `done`).
 */
export async function onInput(ctx, user, pending, msg) {
  const section = { us: 'u', uq: 'uq', un: 'un', ca: 'ca', pba: 'pba', pc: 'pc', sl: 'sl', te: 'te', bn: 'bn', xa: 'xa' }[pending.k];
  if (!section || !allowed(user.actor, section)) {
    await clearInput(user);
    return { error: t(user.lang, 'adm.denied') };
  }
  const text = msg.text || '';
  let r;
  if (pending.k === 'us' || pending.k === 'uq' || pending.k === 'un') r = await usersAdmin.onInput(ctx, user, pending.k, pending.a, text);
  else if (pending.k === 'ca') r = await channels.onInput(ctx, user, msg);
  else if (pending.k === 'pba') r = await platforms.blockAdd(ctx, user, pending.a, text);
  else if (pending.k === 'pc') r = await platforms.purge(ctx, user, text);
  else if (pending.k === 'sl') r = await sys.onLimitInput(ctx, user, pending.a, text);
  else if (pending.k === 'te') r = await sys.onTextInput(ctx, user, pending.a, text);
  else if (pending.k === 'bn') r = await bcast.onInput(ctx, user, msg);
  else r = await staff.onInput(ctx, user, text);
  if (!r.error || r.done) await clearInput(user);
  if (r.error) return r;
  return finish(ctx, user, r);
}
