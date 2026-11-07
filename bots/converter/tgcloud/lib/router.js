// Every update goes through here. Order of checks (private chats only; groups are ignored):
//   1. error boundary (never rethrows: errors → `errors` table + throttled owner alert + a friendly line)
//   2. de-duplication by update_id (claimed before any side effect) and the double-tap guard
//   3. user row + settings + switches; first-run seeding of the forced-join channels; ~1% housekeeping
//   4. ban (owner immune) → commands that work before the gate (/help /privacy /deletemydata /language)
//   5. maintenance (staff exempt) → forced join (staff exempt; lib/gate.js) → the action
//
// callback_data codes (≤ 64 bytes, lib/codec.js):
//   h                home              x            cancel a pending input
//   m:<screen>       tools|set|help|bots|privacy|lang   L:<lang>:<back>  set language
//   s:dg             toggle Persian digits                hi:<page>       history
//   j                "I joined" (re-check, then resume)   dd / dd:y       delete my data
//   f:<ref>          file card     fn:<ref> no fix   fx:<ref> Detect & Fix
//   rn:<ref>[:n|p|s|z|e]  rename menu / new name / prefix / suffix / normalize / extension menu
//   re:<ref>:<ext>   rename to an allowed extension
//   p[:<action>[:<arg>]]  panel (lib/panel.js)
import { HISTORY_PAGE, HOUSEKEEPING_EVERY, OWNER_ID, RESUME_TTL_S, STALE_JOB_S, TAP_GUARD_MS, UPDATE_KEEP_S } from './config.js';
import { parse } from './codec.js';
import * as files from './files.js';
import * as gate from './gate.js';
import * as jobsdb from './db/files.js';
import * as state from './db/state.js';
import * as sys from './db/system.js';
import * as users from './db/users.js';
import { alertOwner } from './alerts.js';
import { LANGS, t, tp } from './i18n/index.js';
import { expireStale } from './jobs.js';
import * as log from './log.js';
import * as panel from './panel.js';
import * as secrets from './secrets.js';
import * as tg from './tg.js';
import * as ui from './ui.js';
import { errorText, isJobCode, nowS, tehranDay } from './util.js';

const PRE_GATE_COMMANDS = new Set(['help', 'privacy', 'deletemydata', 'language']);
const PRE_GATE_CODES = new Set(['L', 'dd', 'x']);
const PRE_GATE_SCREENS = new Set(['help', 'privacy', 'lang']);

function baseCtx(updateId, chatId, from) {
  const now = nowS();
  return { now, nowMs: Date.now(), day: tehranDay(now), updateId, chatId, from, trace: [], lang: 'fa', digits: true, actor: 'user', flags: {}, limits: sys.mergeLimits(null), user: null, answered: false };
}

/** Runs `fn` inside the error boundary; → the handler result for `tgcloud run` output. */
async function boundary(ctx, source, fn, onError) {
  try {
    const view = await fn();
    return { ok: true, view: typeof view === 'string' ? view : undefined, trace: ctx.trace };
  } catch (err) {
    const detail = errorText(err);
    log.error('handler.error', { update_id: ctx.updateId, user_id: ctx.from && ctx.from.id, error_code: 'EXCEPTION', view: source });
    try { await sys.addError(ctx.now, source, 'EXCEPTION', detail); } catch { /* db down: nothing more to do */ }
    await alertOwner(ctx, `error:${source}`, 'alert.error', { source, detail }, 1800);
    if (onError) { try { await onError(); } catch { /* best effort */ } }
    return { ok: false, error: detail, trace: ctx.trace };
  }
}

/** Loads/creates the user, their settings, role, switches and limits into ctx. */
async function prepare(ctx, from) {
  const { row, isNew, firstToday } = await users.touch(from, ctx.now, ctx.day);
  if (isNew) await sys.countMany([['all', 'users'], [ctx.day, 'users_new'], [ctx.day, 'users_active']]);
  else if (firstToday) await sys.count(ctx.day, 'users_active');
  ctx.user = row;
  ctx.actor = from.id === OWNER_ID ? 'owner' : (await sys.isStaff(from.id)) ? 'admin' : 'user';
  ctx.lang = LANGS.includes(row.s_lang) ? row.s_lang : 'fa';
  ctx.digits = row.s_digits != null ? !!row.s_digits : ctx.lang === 'fa';
  const s = await sys.getSettings(['maintenance', 'forced_join', 'limits', 'seeded']);
  ctx.flags = { maintenance: s.maintenance === true, forcedJoin: s.forced_join !== false };
  ctx.limits = sys.mergeLimits(s.limits);
  if (!s.seeded) await gate.seedOnce(ctx);
  if (ctx.updateId % HOUSEKEEPING_EVERY === 0) await housekeeping(ctx);
}

export async function housekeeping(ctx) {
  const out = await sys.housekeeping(ctx.now, { jobDays: ctx.limits.JOB_HISTORY_DAYS, updateKeepS: UPDATE_KEEP_S });
  out.expired = await expireStale(ctx);
  return out;
}

/** '/cmd@bot args' → { name, args } | null (commands for other bots are ignored). */
export function parseCommand(text) {
  const m = /^\/([a-zA-Z0-9_]{1,32})(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/.exec(String(text || '').trim());
  if (!m) return null;
  if (m[2] && m[2].toLowerCase() !== 'wanger_converterbot') return null;
  return { name: m[1].toLowerCase(), args: m[3] ? m[3].trim().split(/\s+/) : [] };
}

const send = (ctx, view, s) => tg.send(ctx, view, ctx.chatId, s);

// ---------------------------------------------------------------------------------------------
// messages

export async function handleMessage(message, update) {
  if (!message || !message.chat || message.chat.type !== 'private' || !message.from || message.from.is_bot) return { ok: true, view: 'ignored' };
  const ctx = baseCtx(update ? update.update_id : 0, message.chat.id, message.from);
  return boundary(ctx, 'message', async () => {
    if (!(await sys.claimUpdate(ctx.updateId, ctx.now))) return 'duplicate';
    await prepare(ctx, message.from);
    const cmd = message.text ? parseCommand(message.text) : null;
    // privacy and data deletion work for everyone, banned users included (a ban survives deletion)
    if (cmd && (cmd.name === 'privacy' || cmd.name === 'deletemydata')) return command(ctx, message, cmd);
    if (ctx.user.banned && ctx.actor !== 'owner') {
      if (await users.claimBanNotice(ctx.user.id, ctx.day)) await send(ctx, 'banned', ui.banned(ctx));
      return 'banned';
    }
    if (cmd && PRE_GATE_COMMANDS.has(cmd.name)) return command(ctx, message, cmd);
    if (ctx.flags.maintenance && ctx.actor === 'user') { await send(ctx, 'maintenance', ui.maintenance(ctx)); return 'maintenance'; }

    const file = files.extractFile(message);
    const g = await gate.check(ctx);
    if (!g.pass) {
      if (file) await state.setPending(ctx.user.id, 'resume', 'file', { file, date: message.date || ctx.now }, ctx.now + RESUME_TTL_S);
      else if (cmd) await state.setPending(ctx.user.id, 'resume', 'cmd', { name: cmd.name, args: cmd.args }, ctx.now + RESUME_TTL_S);
      await send(ctx, 'join', ui.join(ctx, g.missing));
      return 'join';
    }
    if (cmd) return command(ctx, message, cmd);

    const pending = await state.getPending(ctx.user.id, 'input', ctx.now);
    if (pending && pending.kind === 'broadcast') { await panel.onInput(ctx, message, pending); return 'panel_input'; }
    if (pending && message.text) {
      if (pending.kind === 'rename') await files.onInput(ctx, message, pending);
      else await panel.onInput(ctx, message, pending);
      return 'input';
    }
    if (file) { await files.intake(ctx, message, file); return 'intake'; }
    if (message.text) { await send(ctx, 'hint', ui.plain(t(ctx.lang, 'hint.text'), [ui.homeBtn(ctx)])); return 'hint'; }
    await send(ctx, 'hint', ui.plain(t(ctx.lang, 'hint.unsupported'), [ui.homeBtn(ctx)]));
    return 'unsupported';
  }, () => send(ctx, 'error', { text: t(ctx.lang, 'err.generic') }));
}

async function command(ctx, message, cmd) {
  switch (cmd.name) {
    case 'start':
      await state.clearPending(ctx.user.id, 'input');
      await send(ctx, 'home', ui.home(ctx, { greet: true }));
      return 'start';
    case 'help': await send(ctx, 'help', ui.help(ctx)); return 'help';
    case 'privacy': await send(ctx, 'privacy', ui.privacy(ctx)); return 'privacy';
    case 'deletemydata': await send(ctx, 'delete', ui.deleteConfirm(ctx)); return 'delete';
    case 'language': await send(ctx, 'language', ui.language(ctx, 'h')); return 'language';
    case 'settings': await send(ctx, 'settings', ui.settings(ctx)); return 'settings';
    case 'history': await send(ctx, 'history', await historyScreen(ctx, 0)); return 'history';
    case 'status': {
      const code = cmd.args[0] ? cmd.args[0].toUpperCase() : null;
      if (code && !isJobCode(code)) { await send(ctx, 'status', ui.plain(t(ctx.lang, 'status.bad_code'))); return 'status'; }
      const job = code ? await jobsdb.jobByCode(code, ctx.user.id) : await jobsdb.latestJob(ctx.user.id);
      await send(ctx, 'status', ui.statusScreen(ctx, job ? withExpiry(ctx, job) : null));
      return 'status';
    }
    case 'cancel': {
      const had = await state.takePending(ctx.user.id, 'input', ctx.now);
      await state.clearPending(ctx.user.id, 'resume');
      await send(ctx, 'cancel', ui.plain(t(ctx.lang, had ? 'cancel.done' : 'cancel.none'), [ui.homeBtn(ctx)]));
      return 'cancel';
    }
    case 'panel':
      if (ctx.actor === 'user') { await send(ctx, 'hint', ui.plain(t(ctx.lang, 'hint.unknown_cmd'))); return 'denied'; }
      await housekeeping(ctx);
      await panel.onCallback(ctx, [], null);
      return 'panel';
    case 'secret':
      if (ctx.actor !== 'owner') { await send(ctx, 'hint', ui.plain(t(ctx.lang, 'hint.unknown_cmd'))); return 'denied'; }
      await secrets.command(ctx, message, cmd.args);
      return 'secret';
    default:
      await send(ctx, 'hint', ui.plain(t(ctx.lang, 'hint.unknown_cmd'), [ui.homeBtn(ctx)]));
      return 'unknown_command';
  }
}

/** A bot job still "running" long after its invocation must have died: shown as EXPIRED. */
function withExpiry(ctx, job) {
  if (job.engine === 'bot' && ['QUEUED', 'DOWNLOADING', 'PROCESSING', 'UPLOADING'].includes(job.status) && job.created_at < ctx.now - STALE_JOB_S) return { ...job, status: 'EXPIRED', error_code: job.error_code || 'INTERRUPTED' };
  return job;
}

async function historyScreen(ctx, page) {
  const since = ctx.now - ctx.limits.JOB_HISTORY_DAYS * 86400;
  const total = await jobsdb.jobsCount(ctx.user.id, since);
  const p = Math.max(0, Math.min(page, Math.max(0, Math.ceil(total / HISTORY_PAGE) - 1)));
  const rows = await jobsdb.jobsPage(ctx.user.id, since, HISTORY_PAGE, p * HISTORY_PAGE);
  return ui.history(ctx, rows.map((j) => withExpiry(ctx, j)), p, total);
}

// ---------------------------------------------------------------------------------------------
// callbacks

export async function handleCallback(cq, update) {
  const msg = cq && cq.message;
  if (!msg || !msg.chat || msg.chat.type !== 'private') return { ok: true, view: 'ignored' };
  const ctx = baseCtx(update ? update.update_id : 0, msg.chat.id, cq.from);
  ctx.cqId = cq.id;
  return boundary(ctx, 'callback', async () => {
    if (!(await sys.claimUpdate(ctx.updateId, ctx.now))) return 'duplicate';
    await prepare(ctx, cq.from);
    if (!(await users.claimTap(ctx.user.id, `${msg.message_id}:${cq.data}`, ctx.nowMs, TAP_GUARD_MS))) { await tg.answer(ctx, cq.id); return 'double_tap'; }
    const view = await route(ctx, cq, msg);
    if (!ctx.answered) await tg.answer(ctx, cq.id);
    return view;
  }, () => tg.answer(ctx, cq.id, tp(ctx.lang, 'err.generic_short'), true));
}

async function route(ctx, cq, msg) {
  const { code, args } = parse(cq.data);
  const privacyFlow = code === 'dd' || (code === 'm' && args[0] === 'privacy');
  if (ctx.user.banned && ctx.actor !== 'owner' && !privacyFlow) { await alertAnswer(ctx, cq, 'gate.banned_short'); return 'banned'; }
  const preGate = PRE_GATE_CODES.has(code) || (code === 'm' && PRE_GATE_SCREENS.has(args[0]));
  if (!preGate) {
    if (ctx.flags.maintenance && ctx.actor === 'user') { await alertAnswer(ctx, cq, 'gate.maintenance_short'); return 'maintenance'; }
    const g = await gate.check(ctx, { useCache: code !== 'j' });
    if (!g.pass) {
      await tg.edit(ctx, 'join', msg, ui.join(ctx, g.missing));
      if (code === 'j') await alertAnswer(ctx, cq, 'join.still');
      return 'join';
    }
  }
  switch (code) {
    case 'h': await state.clearPending(ctx.user.id, 'input'); await tg.edit(ctx, 'home', msg, ui.home(ctx)); return 'home';
    case 'x': {
      await state.clearPending(ctx.user.id, 'input');
      await tg.edit(ctx, 'cancel', msg, ui.plain(t(ctx.lang, 'cancel.done'), [ui.homeBtn(ctx)]));
      return 'cancel';
    }
    case 'j': return resume(ctx, msg);
    case 'm': return screen(ctx, msg, args[0]);
    case 'L': {
      const lang = LANGS.includes(args[0]) ? args[0] : 'fa';
      await users.setSetting(ctx.user.id, 'lang', lang, ctx.now);
      ctx.lang = lang;
      if (ctx.user.s_digits == null) ctx.digits = lang === 'fa';
      await tg.edit(ctx, 'language', msg, args[1] === 'set' ? ui.settings(ctx) : ui.home(ctx));
      return 'language';
    }
    case 's': {
      if (args[0] !== 'dg') return 'noop';
      ctx.digits = !ctx.digits;
      await users.setSetting(ctx.user.id, 'digits', ctx.digits ? 1 : 0, ctx.now);
      await tg.edit(ctx, 'settings', msg, ui.settings(ctx));
      return 'settings';
    }
    case 'hi': await tg.edit(ctx, 'history', msg, await historyScreen(ctx, Number(args[0]) || 0)); return 'history';
    case 'dd':
      if (args[0] !== 'y') { await tg.edit(ctx, 'delete', msg, ui.deleteConfirm(ctx)); return 'delete'; }
      await users.deleteUserData(ctx.user.id);
      await tg.edit(ctx, 'deleted', msg, ui.deleted(ctx));
      return 'deleted';
    case 'f': case 'fn': case 'fx': case 'rn': case 're':
      await files.onCallback(ctx, code, args, msg);
      return `file_${code}`;
    case 'p':
      if (ctx.actor === 'user') { await alertAnswer(ctx, cq, 'panel.denied_short'); return 'denied'; }
      if (!args.length) await housekeeping(ctx);
      await panel.onCallback(ctx, args, msg);
      return 'panel';
    default:
      await tg.edit(ctx, 'home', msg, ui.home(ctx));
      return 'unknown_callback';
  }
}

async function alertAnswer(ctx, cq, key) {
  ctx.answered = true;
  await tg.answer(ctx, cq.id, tp(ctx.lang, key), true);
}

async function screen(ctx, msg, name) {
  const screens = { tools: ui.tools, set: ui.settings, help: ui.help, bots: ui.bots, privacy: ui.privacy, lang: (c) => ui.language(c, 'set') };
  const fn = screens[name] || ui.home;
  await tg.edit(ctx, name || 'home', msg, fn(ctx));
  return name || 'home';
}

/** After «✅ عضو شدم» passed: continue what the user was doing (the file they sent, the command). */
async function resume(ctx, msg) {
  const r = await state.takePending(ctx.user.id, 'resume', ctx.now);
  await tg.edit(ctx, 'join_ok', msg, ui.plain(t(ctx.lang, 'join.ok')));
  if (r && r.kind === 'file' && r.payload && r.payload.file) {
    await files.intake(ctx, { chat: { id: ctx.chatId }, date: r.payload.date }, r.payload.file);
    return 'resume_file';
  }
  if (r && r.kind === 'cmd' && r.payload) {
    await command(ctx, { chat: { id: ctx.chatId }, message_id: 0 }, { name: r.payload.name, args: r.payload.args || [] });
    return 'resume_cmd';
  }
  await send(ctx, 'home', ui.home(ctx));
  return 'home';
}

// ---------------------------------------------------------------------------------------------
// my_chat_member

export async function handleMyChatMember(upd, update) {
  if (!upd || !upd.chat) return { ok: true, view: 'ignored' };
  const ctx = baseCtx(update ? update.update_id : 0, upd.chat.id, upd.from);
  return boundary(ctx, 'my_chat_member', async () => {
    if (!(await sys.claimUpdate(ctx.updateId, ctx.now))) return 'duplicate';
    const status = upd.new_chat_member && upd.new_chat_member.status;
    if (upd.chat.type === 'private') {
      const existing = await users.get(upd.chat.id);
      if (!existing) return 'unknown_user';
      await users.setBlocked(upd.chat.id, status === 'kicked');
      if (status === 'kicked') await sys.count(ctx.day, 'users_blocked');
      return status === 'kicked' ? 'blocked' : 'unblocked';
    }
    if (upd.chat.type === 'channel' || upd.chat.type === 'supergroup') {
      const r = await gate.onChannelStatus(ctx, upd.chat, status);
      return r.forced ? 'forced_channel' : 'other_chat';
    }
    return 'group_ignored';
  });
}
