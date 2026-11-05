// Routing for private-chat messages, button presses and my_chat_member.
// Order (spec §5): user upsert → ban check → /cancel → force-join gate → flow step → command → text.
import { t, tp } from '../i18n/index.js';
import { decode, parseArgs } from './codec.js';
import { findRoute, FLOWS } from './routes.js';
import { parseCommand, parseStartPayload, ensureCommandMenus } from './commands.js';
import { can, isStaff, isOwner, PermissionError } from '../permissions/policy.js';
import { UserError } from '../core/util.js';
import { LIMITS } from '../config/static.js';
import { continueStart, sendJoinPrompt, helpView, langView } from './user.js';
import { openPanel } from '../admin/panel.js';
import { handleMedia } from '../admin/import_ui.js';
import { searchFromText } from './search_ui.js';
import { promptBotAdded } from '../admin/sources_ui.js';
import { botBecameAdmin } from '../publishing/sources.js';
export { onInlineQuery, onChosenInlineResult } from './search_ui.js';

/** Plain text of an i18n message for a toast (no HTML tags). */
const toastText = (lang, key, vars) => tp(lang, key, vars).replace(/<[^>]+>/g, '');

/** @param {any} app @param {any} message */
export async function onMessage(app, message) {
  if (!message || !message.chat || message.chat.type !== 'private' || !message.from || message.from.is_bot) return 'ignored';
  const user = await app.users.touch(message.from);
  app.user = user;
  app.lang = await app.users.languageOf(user);
  const chat = user.telegram_id;
  const text = typeof message.text === 'string' ? message.text : '';
  const cmd = parseCommand(text);

  if (user.is_banned) {
    if (cmd && cmd.name === 'start') await app.tg.send(chat, { text: t(app.lang, 'start.banned') }, 'banned');
    return 'banned';
  }
  if (cmd && cmd.name === 'cancel') {
    const n = await app.flows.clear(chat);
    await app.tg.send(chat, { text: t(app.lang, n ? 'common.cancelled' : 'common.nothing_to_cancel') }, 'cancel');
    return 'cancel';
  }

  const verdict = await app.forcejoin.check(user);
  if (!verdict.passed) {
    if (cmd && cmd.name === 'start' && parseStartPayload(cmd.args).kind !== 'none' && !(await app.flows.get(chat))) {
      await app.flows.start(chat, 'fj_pending', { payload: cmd.args });
    }
    await sendJoinPrompt(app, user, verdict.missing);
    return 'gated';
  }

  if (isOwner(user)) await ensureCommandMenus(app);

  if (!cmd) {
    const flow = await app.flows.get(chat);
    const def = flow ? FLOWS[flow.flow] : null;
    if (def) {
      if (def.perm && !can(user, def.perm)) {
        await app.flows.clear(chat);
        return 'flow_denied';
      }
      try {
        if (text.length > (def.maxInput || LIMITS.flowInputMax)) throw new UserError('common.input_too_long', { max: def.maxInput || LIMITS.flowInputMax });
        await def.run(app, user, message, flow);
      } catch (e) {
        if (!(e instanceof UserError)) throw e;
        await app.tg.send(chat, { text: t(app.lang, e.key, e.vars) + '\n\n' + t(app.lang, 'common.cancel_hint') }, 'flow_error');
      }
      return `flow:${flow.flow}`;
    }
  }

  if (cmd) {
    switch (cmd.name) {
      case 'start':
        await continueStart(app, user, cmd.args);
        return 'start';
      case 'help':
        await app.tg.send(chat, helpView(app.lang, user), 'help');
        return 'help';
      case 'lang':
        await app.tg.send(chat, langView(app.lang), 'lang');
        return 'lang';
      case 'search':
        await searchFromText(app, user, cmd.args);
        return 'search';
      case 'admin':
        if (can(user, 'panel.open')) {
          await openPanel(app, user);
          return 'admin';
        }
        break;
      default:
        break;
    }
    await app.tg.send(chat, { text: t(app.lang, 'common.unknown_command') }, 'unknown_command');
    return 'unknown_command';
  }

  if ((message.audio || message.voice || message.document) && (await handleMedia(app, user, message))) return 'import';
  if (text) {
    await searchFromText(app, user, text);
    return 'search';
  }
  await app.tg.send(chat, helpView(app.lang, user), 'help');
  return 'other';
}

/** @param {any} app @param {any} cq CallbackQuery — always answered exactly once */
export async function onCallback(app, cq) {
  let answered = false;
  const answer = async (opts = {}) => {
    if (answered) return;
    answered = true;
    await app.tg.answer(cq.id, opts);
  };
  try {
    if (!cq || !cq.from || cq.from.is_bot) return answer();
    const user = await app.users.touch(cq.from);
    app.user = user;
    app.lang = await app.users.languageOf(user);
    const staff = isStaff(user);
    const expired = () => answer({ text: tp(app.lang, staff ? 'common.expired' : 'common.expired_user'), alert: true });
    if (user.is_banned) return answer({ text: tp(app.lang, 'start.banned') });

    const d = decode(cq.data);
    const route = d && findRoute(d.ns, d.action);
    const args = route ? parseArgs(d.args, route.args) : null;
    if (!route || !args) return expired();

    if (route.perm) {
      if (!can(user, route.perm)) return staff ? answer({ text: tp(app.lang, 'common.denied'), alert: true }) : expired();
      if (!cq.message || !cq.message.chat || cq.message.chat.type !== 'private') return answer({ text: tp(app.lang, 'common.private_only'), alert: true });
    }
    if (route.gate !== false) {
      const verdict = await app.forcejoin.check(user);
      if (!verdict.passed) {
        await sendJoinPrompt(app, user, verdict.missing);
        return answer({ text: tp(app.lang, 'fj.still_missing') });
      }
    }
    try {
      const res = (await route.run(app, user, args, cq)) || {};
      return answer(res.toast ? { text: res.toast, alert: !!res.alert } : {});
    } catch (e) {
      if (e instanceof UserError) return answer({ text: toastText(app.lang, e.key, e.vars), alert: true });
      if (e instanceof PermissionError) return answer({ text: tp(app.lang, 'common.denied'), alert: true });
      throw e;
    }
  } catch (e) {
    await answer({ text: tp(app.lang || 'fa', 'common.error') });
    throw e;
  }
}

/** my_chat_member: block/unblock in private chats; the bot's status in force-join channels. */
export async function onMyChatMember(app, upd) {
  if (!upd || !upd.chat || !upd.new_chat_member) return 'ignored';
  const status = upd.new_chat_member.status;
  if (upd.chat.type === 'private') {
    if (upd.from && !upd.from.is_bot) await app.users.markBlocked(upd.from.id, status === 'kicked');
    return status === 'kicked' ? 'blocked' : 'unblocked';
  }
  const forceJoin = await app.forcejoin.onBotStatusChange(upd.chat, upd.new_chat_member);
  const source = await app.sources.onBotStatusChange(upd.chat, upd.new_chat_member);
  const destination = await app.destinations.onBotStatusChange(upd.chat, upd.new_chat_member);
  app.log.info('bot_chat_status', { chat_id: upd.chat.id, status });
  if (forceJoin || source || destination) return destination ? 'destination_channel' : forceJoin ? 'forcejoin_channel' : 'source_channel';
  if (botBecameAdmin(upd) && (await promptBotAdded(app, upd.chat, upd.from))) return 'owner_asked';
  return 'other_chat';
}

/** channel_post: only registered, enabled sources import; everything else is ignored. */
export const onChannelPost = (app, post) => app.sources.handlePost(post);
