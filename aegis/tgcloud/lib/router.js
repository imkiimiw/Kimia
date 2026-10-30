/*
 * Entry points for every update type Aegis handles, and the order of checks.
 *
 * Every update:  dedupe (update_id seen? → skip) → data migrations → the global switch (shut down?
 * → only the owner is served; membership changes are recorded quietly) → the handler → background
 * jobs (lib/jobs.js). Everything is caught: a failure is recorded (aegis_errors + console JSON + a
 * rate-limited note to the owner) and the update still returns { trace } for `npx tgcloud run`.
 * Every button press is answered exactly once.
 *
 * Private message:  user tracked (started) → /cancel → a pending input (slash commands interrupt
 * it; plain words don't) → no language chosen yet → language picker → /language → forced join
 * (owner exempt; this also gates the configuration flow) → /start c_<chat> (a group's «open panel»
 * button; kept across the picker and the join screen) → /help, «پیکربندی» /config (my chats),
 * owner: /panel, /status, /shutdown, /activate → otherwise the main menu.
 * Group message: group → supergroup migration; the locks (ui/enforce.js — admins are exempt; a
 * message a lock deletes goes no further); the security checks (ui/security.js: federation bans,
 * captcha, flood, anti-link, anti-ads, suspicious content, risk); the advanced rules (ui/advanced.js:
 * service notices, forced join/add, slow mode, lengths, mentions, caps, junk, read-only topics,
 * @admin, names); /rules /report /admins /mywarns; /lockdown /readonly /fban /unfban; «پیکربندی» / /config (admins: a button to the
 * private panel — ordinary members are never blocked or answered); a moderation command
 * (ui/moderation.js: /warn /mute /ban … or «اخطار» «سکوت» «بن» …, from the creator, admins and the
 * «mod» list only); otherwise the occasional reminder about admins not appointed through Aegis.
 *
 * callback_data in any chat (group notices, private chats, the log channel), authorized live in
 * the punishment's chat — ui/moderation.js:
 *   pu:<id>       undo a punishment          bt:<id>:v|r   anti-betrayal: unban victims / restore admin
 *   cp:<id>:<n|ok|no>   captcha answer / admin approves or removes — ui/security.js
 *   rk:<id>:y|n   risk alert feedback          ld:<id>:end   end an emergency lock, read-only or raid mode
 *   fj:<chat>     forced join re-check         rp:<id>:d|m|b|x   a member's report: delete/mute/ban/dismiss
 *   an:<id>       a real admin confirms an anonymous admin's command — ui/advanced.js
 *   pq:<id>:a|r   publish / reject a post waiting for approval — ui/channel.js
 * callback_data (private chat):
 *   lg            language picker            lg:<fa|en|ru|zh|fr>   set language
 *   jc            "✅ I joined" (re-check, no cache)
 *   mm            main menu                  hp                    help
 *   cl… g:…       my chats and a chat's panel (any admin with access) — ui/panel.js
 *   db… xp…       the channels dashboard and posting to several channels — ui/dashboard.js
 *   op os oj… ob… bc:… ox sy:…   owner panel and global switch (OWNER_ID only; anyone else gets a
 *                 silent answer) — ui/owner.js, ui/owner_bc.js, ui/system.js
 *
 * edited_message: in a group, the locks again (and the edit lock), then the security checks.
 * channel_post / edited_channel_post: a channel's posts and edits (ui/channel.js).
 * A message in a channel's direct messages chat: its filters (ui/channel.js), nothing else.
 * Group messages also pass the discussion-group protection of their channel (ui/channel.js) right
 * after the locks.
 * chat_join_request: a channel's requests (ui/channel.js); a group's join captcha in the
 * requester's private chat (ui/security.js).
 * my_chat_member: private → the user blocked / unblocked the bot; group/supergroup/channel → the
 * bot's membership and rights there (ui/group.js: registration, warnings).
 * chat_member: someone's admin status changed (cache, revocation, log, reminder); bans and unbans
 * done in Telegram by admins (recorded; anti-betrayal counts them); a blacklisted member joined
 * (banned again).
 */
import { OWNER_ID } from './config.js';
import { me } from './core/bot.js';
import { mentionOf, parseCommand, startPayload, syncCommands, syncOwnerCommands } from './core/commands.js';
import * as dedupe from './core/dedupe.js';
import * as errors from './core/errors.js';
import * as kv from './core/kv.js';
import * as migrations from './core/migrations.js';
import * as state from './core/state.js';
import { answer, createCtx, send, tryCall } from './core/tg.js';
import { esc, iso, toInt } from './core/util.js';
import * as chats from './engines/chats.js';
import * as join from './engines/join.js';
import * as settings from './engines/settings.js';
import * as system from './engines/system.js';
import * as users from './engines/users.js';
import { isLang, pickLang, t } from './i18n/index.js';
import { afterUpdate } from './jobs.js';
import * as advanced from './ui/advanced.js';
import * as channel from './ui/channel.js';
import * as dashboard from './ui/dashboard.js';
import * as enforce from './ui/enforce.js';
import * as group from './ui/group.js';
import * as moderation from './ui/moderation.js';
import * as security from './ui/security.js';
import * as owner from './ui/owner.js';
import * as ownerBc from './ui/owner_bc.js';
import * as panel from './ui/panel.js';
import * as panelAdv from './ui/panel_adv.js';
import * as panelChannel from './ui/panel_channel.js';
import * as panelFed from './ui/panel_fed.js';
import * as panelLocks from './ui/panel_locks.js';
import * as panelMod from './ui/panel_mod.js';
import * as panelPosts from './ui/panel_posts.js';
import * as panelTopics from './ui/panel_topics.js';
import * as start from './ui/start.js';
import * as sys from './ui/system.js';

const OWNER_HEADS = new Set(['op', 'os', 'oj', 'ob', 'bc', 'ox', 'sy']);
const PANEL_HEADS = new Set(['cl', 'g']);
const OWNER_INPUTS = new Set(['join_add', 'bc_content', 'bc_buttons']);
const GROUP_HEADS = new Set(['pu', 'bt', 'cp', 'rk', 'ld', 'fj', 'rp', 'an', 'pq']);
const DASH_HEADS = new Set(['db', 'xp']);
const PANELS = [panelMod, panelLocks, panelFed, panelAdv, panelTopics, panelChannel, panelPosts, dashboard];
const isUserInput = (kind) => kind === 'adm_pick' || PANELS.some((p) => p.INPUTS.has(kind));
const hasKeyboard = (kind) => kind === 'adm_pick' || PANELS.some((p) => p.KEYBOARD_INPUTS.has(kind));

function result(ctx) {
  const out = { trace: ctx.trace };
  if (ctx.error) out.error = ctx.error;
  if (ctx.duplicate) out.duplicate = true;
  if (ctx.gc) out.gc = ctx.gc;
  return out;
}

async function run(kind, pctx, fn, extra = {}) {
  const update = pctx && pctx.update;
  const ctx = createCtx({ kind, updateId: update && Number.isSafeInteger(update.update_id) ? update.update_id : null, ...extra });
  try {
    if (!(await dedupe.begin(ctx.updateId))) {
      ctx.duplicate = true;
      return result(ctx);
    }
    await migrations.ensure(ctx);
    ctx.shutdown = system.isShutdown(await kv.all(ctx));
    await fn(ctx);
  } catch (err) {
    await errors.record(ctx, err, { source: kind, updateId: ctx.updateId || 0, chatId: ctx.chatId || 0, userId: ctx.userId || 0 });
  }
  try {
    await dedupe.finish(ctx.updateId);
  } catch (err) {
    console.warn(`dedupe.finish: ${String((err && err.message) || err)}`);
  }
  await answer(ctx);
  await afterUpdate(ctx);
  return result(ctx);
}

/* /start c_<chat id>: open that chat's panel; r_<chat id>: that group's rules; anything else: the main menu. */
async function openPayload(ctx, user, from, payload, place = null) {
  const m = /^c_(-?\d{5,16})$/.exec(String(payload || ''));
  if (m) return panel.open(ctx, user, toInt(m[1]), place);
  const r = /^r_(-?\d{5,16})$/.exec(String(payload || ''));
  if (r) return showRules(ctx, user, toInt(r[1]));
  return start.welcome(ctx, user, from, place);
}

async function showRules(ctx, user, chatId) {
  const chat = await chats.get(chatId);
  const s = chat ? await settings.all(ctx, chatId) : null;
  const text = s && s.rules ? t(user.lang, 'adv.rules_text', { title: iso(chat.title || '', 48), rules: esc(s.rules) }) : t(user.lang, 'adv.no_rules');
  return send(ctx, user.user_id, text, await start.mainRows(ctx, user.lang, user.user_id), 'rules-pm');
}

/* After the picker or the join screen: a /start payload saved for later, else the main menu. */
async function resume(ctx, user, from, place) {
  const st = await state.get(user.user_id);
  if (st && st.kind === 'resume') {
    await state.clear(user.user_id);
    return openPayload(ctx, user, from, st.data.payload, place);
  }
  return start.welcome(ctx, user, from, place);
}

/* ---------- messages ---------- */

export function onMessage(message, pctx) {
  return run('message', pctx, (ctx) => handleMessage(ctx, message));
}

async function input(ctx, user, message, pending) {
  const lang = user.lang;
  if (pending.kind === 'adm_pick') return panel.pickInput(ctx, user, message, pending.data);
  if (panelMod.INPUTS.has(pending.kind)) return panelMod.input(ctx, user, message, pending);
  if (panelLocks.INPUTS.has(pending.kind)) return panelLocks.input(ctx, user, message, pending);
  if (panelFed.INPUTS.has(pending.kind)) return panelFed.input(ctx, user, message, pending);
  if (panelAdv.INPUTS.has(pending.kind)) return panelAdv.input(ctx, user, message, pending);
  if (panelTopics.INPUTS.has(pending.kind)) return panelTopics.input(ctx, user, message, pending);
  if (panelChannel.INPUTS.has(pending.kind)) return panelChannel.input(ctx, user, message, pending);
  if (panelPosts.INPUTS.has(pending.kind)) return panelPosts.input(ctx, user, message, pending);
  if (dashboard.INPUTS.has(pending.kind)) return dashboard.input(ctx, user, message, pending);
  if (pending.kind === 'join_add') return owner.joinAddInput(ctx, lang, message);
  if (pending.kind === 'bc_content') return ownerBc.contentInput(ctx, lang, message, pending.data);
  if (pending.kind === 'bc_buttons') return ownerBc.buttonsInput(ctx, lang, message, pending.data);
  await state.clear(user.user_id);
  return start.welcome(ctx, user, message.from);
}

async function handleMessage(ctx, message) {
  const chat = message.chat;
  if (!chat) return;
  ctx.chatId = chat.id;
  if (chat.is_direct_messages) {
    if (!ctx.shutdown) await channel.dmMessage(ctx, message);
    return;
  }
  if (chat.type === 'group' || chat.type === 'supergroup') {
    await handleGroupMessage(ctx, message);
    return;
  }
  if (chat.type !== 'private') return;
  const from = message.from;
  if (!from || from.is_bot) return;
  ctx.userId = from.id;
  const isOwner = from.id === OWNER_ID;
  if (ctx.shutdown && !isOwner) return;
  const user = await users.touch(from, { started: true });
  await syncCommands(ctx);
  const pending = await state.get(from.id);
  const isInput = !!pending && (isUserInput(pending.kind) || (isOwner && OWNER_INPUTS.has(pending.kind)));
  const cmd = parseCommand(message.text, { aliases: !isInput });
  if (cmd === 'cancel') {
    await state.clear(from.id);
    if (pending && hasKeyboard(pending.kind)) await send(ctx, from.id, t(user.lang, 'common.cancelled'), null, 'cancelled', { reply_markup: { remove_keyboard: true } });
    else await send(ctx, from.id, t(user.lang, 'common.cancelled'), await start.mainRows(ctx, user.lang, from.id), 'cancelled');
    return;
  }
  if (isInput && !cmd) {
    await input(ctx, user, message, pending);
    return;
  }
  if (isInput) await state.clear(from.id);
  const payload = cmd === 'start' ? startPayload(message.text) : null;
  if (!Number(user.lang_set) || cmd === 'language') {
    if (payload) await state.set(from.id, 'resume', { payload });
    await start.picker(ctx, user);
    return;
  }
  if (isOwner) await syncOwnerCommands(ctx, user.lang);
  const j = await join.status(ctx, from.id);
  if (!j.ok) {
    if (payload) await state.set(from.id, 'resume', { payload });
    await start.joinScreen(ctx, user, j.missing);
    return;
  }
  if (payload) await openPayload(ctx, user, from, payload);
  else if (cmd === 'help') await start.help(ctx, user);
  else if (cmd === 'config') await panel.chatsList(ctx, user);
  else if (isOwner && cmd === 'panel') await owner.panel(ctx, user.lang);
  else if (isOwner && cmd === 'status') await sys.status(ctx, user.lang);
  else if (isOwner && cmd === 'shutdown') await sys.askShutdown(ctx, user.lang);
  else if (isOwner && cmd === 'activate') await sys.activate(ctx, user.lang);
  else await start.welcome(ctx, user, from);
}

async function handleGroupMessage(ctx, message) {
  const chat = message.chat;
  if (message.migrate_to_chat_id) {
    await chats.migrate(chat.id, message.migrate_to_chat_id);
    return;
  }
  if (ctx.shutdown) return;
  if (message.from) ctx.userId = message.from.id;
  const known = await chats.get(chat.id);
  const lockDeleted = await enforce.check(ctx, known, message); /* deleted by a lock: no command acts on it */
  if (!lockDeleted && await channel.discussion(ctx, known, message)) return;
  if ((await advanced.service(ctx, known, message, { deleted: lockDeleted })) || lockDeleted) return;
  if (await security.onMessage(ctx, known, message)) return;
  if (await advanced.onMessage(ctx, known, message)) return;
  const cmd = parseCommand(message.text, { aliases: true });
  if (cmd === 'config') {
    const mention = mentionOf(message.text);
    if (mention && mention !== String((await me(ctx)).username).toLowerCase()) return;
    await group.configInGroup(ctx, message);
    return;
  }
  if ((await advanced.command(ctx, message)) || (await security.command(ctx, message)) || (await moderation.handle(ctx, message))) {
    await deleteCommand(ctx, known, message);
    return;
  }
  const row = await chats.get(chat.id);
  if (row) await group.onActivity(ctx, row);
}

/* An edited message: in a group the locks look at it again (and the edit lock catches any edit). */
export function onEditedMessage(message, pctx) {
  return run('edited_message', pctx, async (ctx) => {
    const chat = message && message.chat;
    if (!chat || (chat.type !== 'group' && chat.type !== 'supergroup') || ctx.shutdown) return;
    ctx.chatId = chat.id;
    if (message.from) ctx.userId = message.from.id;
    const known = await chats.get(chat.id);
    if (await enforce.check(ctx, known, message, { edited: true })) return;
    if (await security.onMessage(ctx, known, message, { edited: true })) return;
    await advanced.onMessage(ctx, known, message, { edited: true });
  });
}

/* A request to join: a channel's checks (ui/channel.js), or a group's captcha in the requester's private chat (ui/security.js). */
export function onJoinRequest(req, pctx) {
  return run('chat_join_request', pctx, async (ctx) => {
    if (!req || !req.chat || !req.from) return;
    ctx.chatId = req.chat.id;
    ctx.userId = req.from.id;
    if (ctx.shutdown) {
      /* Aegis is paused: a guard bot's query still needs an answer, so the admins decide */
      if (req.query_id) await tryCall(ctx, 'answerChatJoinRequestQuery', { chat_join_request_query_id: req.query_id, result: 'queue' }, 'guard-queue');
      return;
    }
    if (req.chat.type === 'channel') await channel.onJoinRequest(ctx, req);
    else await security.onJoinRequest(ctx, req);
  });
}

/* A channel's post, and its edits (ui/channel.js). */
export function onChannelPost(message, pctx) {
  return run('channel_post', pctx, async (ctx) => {
    if (!message || !message.chat || ctx.shutdown) return;
    ctx.chatId = message.chat.id;
    await channel.onPost(ctx, message);
  });
}

export function onEditedChannelPost(message, pctx) {
  return run('edited_channel_post', pctx, async (ctx) => {
    if (!message || !message.chat || ctx.shutdown) return;
    ctx.chatId = message.chat.id;
    await channel.onEditedPost(ctx, message);
  });
}

/* «Delete commands» (del_cmds): the command message goes once Aegis has acted on it. */
async function deleteCommand(ctx, chat, message) {
  if (!chat || message.sender_chat) return;
  const s = await settings.all(ctx, chat.chat_id);
  if (settings.flag(s, 'del_cmds')) await tryCall(ctx, 'deleteMessage', { chat_id: chat.chat_id, message_id: message.message_id }, 'delete-command');
}

/* ---------- buttons ---------- */

export function onCallback(cq, pctx) {
  return run('callback_query', pctx, (ctx) => handleCallback(ctx, cq), { callbackId: cq.id });
}

async function ownerCallback(ctx, user, parts, place) {
  const lang = user.lang;
  const head = parts[0];
  if (head === 'op') return owner.panel(ctx, lang, place);
  if (head === 'ox') {
    await state.clear(OWNER_ID);
    return owner.panel(ctx, lang, place);
  }
  if (head === 'os') return owner.stats(ctx, lang, place);
  if (head === 'oj') return owner.joinCallback(ctx, lang, parts, place);
  if (head === 'sy') return sys.callback(ctx, lang, parts, place);
  return ownerBc.callback(ctx, lang, parts, place);
}

async function handleCallback(ctx, cq) {
  const from = cq.from;
  const msg = cq.message;
  if (!from || !msg || !msg.chat) return null;
  const head0 = String(cq.data || '').split(':')[0];
  if (GROUP_HEADS.has(head0) && String(cq.data).length <= 64) {
    ctx.userId = from.id;
    ctx.chatId = msg.chat.id;
    if (ctx.shutdown && from.id !== OWNER_ID) {
      const u = await users.get(from.id);
      await answer(ctx, t(u && Number(u.lang_set) ? u.lang : pickLang(from.language_code), 'sys.paused_toast'), true);
      return null;
    }
    const parts = String(cq.data).split(':');
    if (advanced.HEADS.has(head0)) return advanced.callback(ctx, cq, parts, { roleOf: moderation.roleOf, security: security.command, moderation: moderation.handle });
    if (head0 === 'pq') return channel.queueCallback(ctx, cq, parts);
    return security.HEADS.has(head0) ? security.callback(ctx, cq, parts) : moderation.callback(ctx, cq, parts);
  }
  if (msg.chat.type !== 'private') return null;
  ctx.userId = from.id;
  ctx.chatId = msg.chat.id;
  const place = { chat_id: msg.chat.id, message_id: msg.message_id };
  const user = await users.touch(from);
  if (ctx.shutdown && from.id !== OWNER_ID) {
    await answer(ctx, t(user.lang, 'sys.paused_toast'), true);
    return null;
  }
  const data = String(cq.data || '');
  if (data.length > 64) return null;
  const parts = data.split(':');
  const head = parts[0];

  if (head === 'lg') {
    if (parts.length === 1) return start.picker(ctx, user, place);
    const lang = parts[1];
    if (!isLang(lang)) return null;
    await users.setLang(from.id, lang);
    user.lang = lang;
    user.lang_set = 1;
    await answer(ctx, t(lang, 'lang.saved'));
    if (from.id === OWNER_ID) await syncOwnerCommands(ctx, lang);
    const j = await join.status(ctx, from.id);
    if (!j.ok) return start.joinScreen(ctx, user, j.missing, place);
    return resume(ctx, user, from, place);
  }
  if (head === 'jc') {
    const j = await join.status(ctx, from.id, { force: true });
    if (!j.ok) {
      await answer(ctx, t(user.lang, 'join.missing_alert', { n: j.missing.length }), true);
      return start.joinScreen(ctx, user, j.missing, place);
    }
    await answer(ctx, t(user.lang, 'join.thanks'));
    return resume(ctx, user, from, place);
  }
  if (OWNER_HEADS.has(head)) {
    if (from.id !== OWNER_ID) return null;
    return ownerCallback(ctx, user, parts, place);
  }
  const j = await join.status(ctx, from.id);
  if (!j.ok) {
    await answer(ctx, t(user.lang, 'join.missing_alert', { n: j.missing.length }), true);
    return start.joinScreen(ctx, user, j.missing, place);
  }
  if (PANEL_HEADS.has(head)) return panel.callback(ctx, user, parts, place);
  if (DASH_HEADS.has(head)) return dashboard.callback(ctx, user, parts, place);
  if (head === 'hp') return start.help(ctx, user, place);
  return start.welcome(ctx, user, from, place);
}

/* ---------- membership ---------- */

export function onMyChatMember(upd, pctx) {
  return run('my_chat_member', pctx, (ctx) => handleMyChatMember(ctx, upd));
}

async function handleMyChatMember(ctx, upd) {
  const chat = upd.chat;
  if (!chat) return;
  ctx.chatId = chat.id;
  ctx.quiet = !!ctx.shutdown;
  const status = upd.new_chat_member && upd.new_chat_member.status;
  if (chat.type === 'private') {
    if (!upd.from) return;
    ctx.userId = upd.from.id;
    if (status === 'kicked') await users.markBlocked(upd.from.id);
    else if (status === 'member') await users.markUnblocked(upd.from);
    return;
  }
  if (!chats.isTracked(chat.type)) return;
  let lang = 'en';
  if (upd.from && !upd.from.is_bot) {
    ctx.userId = upd.from.id;
    const u = await users.get(upd.from.id);
    lang = u && Number(u.lang_set) ? u.lang : pickLang(upd.from.language_code);
  }
  await group.onBotMembership(ctx, upd, lang);
}

export function onChatMember(upd, pctx) {
  return run('chat_member', pctx, async (ctx) => {
    if (!upd.chat) return;
    ctx.chatId = upd.chat.id;
    ctx.quiet = !!ctx.shutdown;
    if (upd.from) ctx.userId = upd.from.id;
    await group.onMemberChange(ctx, upd);
    if (upd.chat.type === 'channel') await channel.onMemberChange(ctx, upd);
    await moderation.onMemberChange(ctx, upd);
  });
}
