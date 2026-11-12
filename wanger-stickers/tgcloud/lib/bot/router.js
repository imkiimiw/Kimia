// Routing for private messages, button presses and my_chat_member.
//
// Order of checks (brief §6): maintenance → ban → flood → first-start language → forced-join gate
// → conversation step → command → media / text. Exempt from the gate: the owner, the language
// choice, the gate's own «عضو شدم» button, and my_chat_member. A gated user's action is kept for
// 15 minutes (pending_actions) and resumed right after the gate passes.
//
// callback_data table (ns:action:args, ≤ 64 bytes; see each module):
//   m:*  menu         l:set  language     fj:check  gate        dm:*  delete my data
//   st:* a sticker the user sent          pk:* packs  imp:* import  cp:* copy  mg:* merge  op:* bulk ops
//   pb:* publishing (creator)             pr:* review (owner + reviewers)
//   a:*  admin panel (owner; a:home and a:q/a:qv also reviewers)
import { decode, parseArgs } from '../core/codec.js';
import { UserError, PermissionError } from '../core/util.js';
import { users } from '../db/users.js';
import { system } from '../db/system.js';
import { menuView, helpView, accountView, langView, deleteAskView, deleteMyData } from './ui.js';
import * as packsUi from './packs_ui.js';
import * as publishUi from './publish_ui.js';
import * as panel from '../admin/panel.js';
import * as channelsUi from '../admin/channels_ui.js';
import * as broadcastUi from '../admin/broadcast_ui.js';
import * as publishAdmin from '../admin/publish_ui.js';
import { OWNER_ID, T, LANGS, APP_URL } from '../config.js';
import { markup } from '../core/codec.js';
import { tp } from '../i18n/index.js';

/* ------------------------------------------------------------------ routes */

const send = (app, view, name) => app.tg.send(app.user.tg_id, view, name);
const show = (app, cq, view, name) => app.tg.show(app.user.tg_id, cq && cq.message && !cq.message.sticker ? cq.message.message_id : null, view, name);

const coreRoutes = {
  'm:home': { args: [], run: async (app, _a, cq) => show(app, cq, menuView(app), 'menu') },
  'm:help': { args: [], run: async (app, _a, cq) => show(app, cq, helpView(app), 'help') },
  'm:acct': { args: [], run: async (app, _a, cq) => show(app, cq, await accountView(app), 'account') },
  'm:lang': { args: [], run: async (app, _a, cq) => show(app, cq, langView(app, app.lang), 'lang') },
  'l:set': { args: ['lang'], gate: false, run: async (app, [lang], cq) => setLanguage(app, lang, cq) },
  'fj:check': { args: [], gate: false, run: async (app, _a, cq) => recheckGate(app, cq) },
  'dm:ask': { args: [], run: async (app, _a, cq) => show(app, cq, deleteAskView(app), 'delete_ask') },
  'dm:no': { args: [], run: async (app, _a, cq) => show(app, cq, menuView(app), 'menu') },
  'dm:yes': {
    args: [],
    run: async (app, _a, cq) => {
      await deleteMyData(app);
      await show(app, cq, { text: app.t('dm.done') }, 'delete_done');
    },
  },
};

export const ROUTES = Object.freeze({
  ...coreRoutes,
  ...packsUi.routes,
  ...publishUi.routes,
  ...panel.routes,
  ...channelsUi.routes,
  ...broadcastUi.routes,
  ...publishAdmin.routes,
});

const STEP_HANDLERS = [packsUi.onStep, publishUi.onReviewStep, panel.onAdminStep, channelsUi.onChannelStep, broadcastUi.onBroadcastStep, publishAdmin.onPublishAdminStep];

/* ------------------------------------------------------------------ helpers */

function parseCommand(text) {
  const m = /^\/([a-z_]{1,32})(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/i.exec(String(text || '').trim());
  return m ? { name: m[1].toLowerCase(), args: (m[2] || '').trim() } : null;
}

/** Token bucket per user (brief §13): returns false when the user is too fast. */
async function allow(app, bucket = 'msg') {
  if (app.user.tg_id === OWNER_ID) return true;
  const now = app.clock.now();
  const row = await system.getBucket(app.user.tg_id, bucket);
  const cap = T.floodBurst;
  const tokens = row ? Math.min(cap, row.tokens + (now - row.updated_at) * T.floodRefillPerSec) : cap;
  if (tokens < 1) return false;
  await system.setBucket(app.user.tg_id, bucket, tokens - 1, now);
  return true;
}

/** The parts of a message worth keeping while the user joins the channels. */
const keepMessage = (m) => {
  const keep = { message_id: m.message_id, chat: { id: m.chat.id, type: m.chat.type } };
  for (const k of ['text', 'caption', 'sticker', 'document', 'photo', 'video', 'animation', 'video_note', 'forward_origin']) if (m[k] !== undefined) keep[k] = m[k];
  return keep;
};

async function keepPending(app, action) {
  await system.setPending(app.user.tg_id, action, app.clock.now() + T.pendingTtlSec);
}

/** Registers the command lists once per version (default per language + the owner's chat with /admin). */
const COMMANDS_VERSION = 2; // 2: the Studio menu button (Phase 2)
async function ensureCommands(app) {
  if (Number(app.settings.get('boot.commands') || 0) >= COMMANDS_VERSION) return;
  if (!(await system.claimSetting(`boot.commands.${COMMANDS_VERSION}`, 1, app.clock.now()))) return;
  const list = (lang) => ['start', 'menu', ...(app.flag('studio') ? ['studio'] : []), 'packs', 'lang', 'help', 'cancel', 'deletemydata'].map((c) => ({ command: c, description: tp(lang, `cmd.${c}`) }));
  try {
    await app.tg.call('setMyCommands', { commands: list('fa') }, 'commands');
    await app.tg.call('setMyCommands', { commands: list('fa'), language_code: 'fa' }, 'commands');
    await app.tg.call('setMyCommands', { commands: list('en'), language_code: 'en' }, 'commands');
    await app.tg.call('setMyCommands', { commands: [...list('fa'), { command: 'admin', description: tp('fa', 'cmd.admin') }], scope: { type: 'chat', chat_id: OWNER_ID } }, 'commands');
    if (app.flag('studio')) {
      // the persistent chat menu button opens the Studio (brief §8); the owner's Phase 0 «Spike» button goes
      await app.tg.call('setChatMenuButton', { menu_button: { type: 'web_app', text: tp('fa', 'menu.button'), web_app: { url: `${APP_URL}?mode=sticker` } } }, 'menu_button');
      await app.tg.call('setChatMenuButton', { chat_id: OWNER_ID, menu_button: { type: 'default' } }, 'menu_button');
    }
    await app.settings.set(0, 'boot.commands', COMMANDS_VERSION);
  } catch (e) {
    app.log.warn('set_commands_failed', { error: String(e && e.description).slice(0, 120) });
  }
}

/* ------------------------------------------------------------------ gate & language */

async function gateOrPass(app, pendingAction) {
  const verdict = await app.gate.check(app.user);
  if (verdict.passed) return true;
  if (pendingAction) await keepPending(app, pendingAction);
  await send(app, app.gate.view(app.lang, verdict.missing), 'gate');
  return false;
}

async function resumePending(app) {
  const raw = await system.takePending(app.user.tg_id, app.clock.now());
  const action = raw ? JSON.parse(raw) : null;
  if (!action) return false;
  if (action.kind === 'message') await handleMessage(app, action.message, { resumed: true });
  else if (action.kind === 'start') await startCommand(app, action.payload || '');
  else if (action.kind === 'callback') await runRoute(app, { id: null, from: { id: app.user.tg_id }, data: action.data, message: null }, { resumed: true });
  return true;
}

async function recheckGate(app, cq) {
  const verdict = await app.gate.check(app.user, { useCache: false });
  if (!verdict.passed) {
    await show(app, cq, app.gate.view(app.lang, verdict.missing), 'gate');
    return { toast: app.tp('gate.still_missing'), alert: true };
  }
  await show(app, cq, { text: app.t('gate.passed') }, 'gate_passed');
  if (!(await resumePending(app))) await send(app, menuView(app), 'menu');
  return { toast: app.tp('gate.passed_toast') };
}

async function setLanguage(app, lang, cq) {
  const first = !app.user.lang;
  if (!LANGS.includes(lang)) throw new UserError('common.expired');
  await users.setLang(app.user.tg_id, lang);
  app.user.lang = lang;
  await app.setUser(app.user);
  await show(app, cq, { text: app.t('lang.set') }, 'lang_set');
  if (!first) {
    await send(app, menuView(app), 'menu');
    return { toast: app.tp('lang.set') };
  }
  if (!(await gateOrPass(app, null))) return { toast: app.tp('lang.set') };
  if (!(await resumePending(app))) await send(app, menuView(app), 'menu');
  return { toast: app.tp('lang.set') };
}

/* ------------------------------------------------------------------ messages */

async function startCommand(app, payload) {
  const p = String(payload || '');
  if (/^ref_[A-Za-z0-9_]{1,32}$/.test(p) && app.user.is_new) {
    const ref = Number(p.slice(4));
    if (Number.isSafeInteger(ref) && ref !== app.user.tg_id && (await users.get(ref))) {
      await system.audit({ at: app.clock.now(), actor_id: app.user.tg_id, action: 'referral', target: String(ref), details: null });
      app.stats.count('user.referred');
    }
  }
  if (/^pub_\d{1,12}$/.test(p)) app.stats.count('pub.deeplink');
  await send(app, menuView(app), 'menu');
  return 'start';
}

async function handleMessage(app, message, { resumed = false } = {}) {
  const text = typeof message.text === 'string' ? message.text : '';
  const cmd = parseCommand(text);
  const chat = app.user.tg_id;

  if (cmd && cmd.name === 'cancel') {
    const n = (await app.state.clear(chat)) + 0;
    await system.clearPending(chat);
    await send(app, { text: app.t(n ? 'common.cancelled' : 'common.nothing_to_cancel') }, 'cancel');
    return 'cancel';
  }

  if (!cmd) {
    const st = await app.state.get(chat);
    if (st) {
      if (st.step.startsWith('a_') && app.role !== 'owner') {
        await app.state.clear(chat);
      } else {
        for (const h of STEP_HANDLERS) {
          try {
            const done = await h(app, st.step, st.payload, message);
            if (done) return `step:${st.step}`;
          } catch (e) {
            if (e instanceof UserError) {
              await send(app, { text: `${app.t(e.key, e.vars)}\n\n${app.t('common.cancel_hint')}` }, 'step_error');
              return `step_error:${st.step}`;
            }
            if (e instanceof PermissionError) {
              await app.state.clear(chat);
              return 'denied';
            }
            throw e;
          }
        }
      }
    }
  }

  if (cmd) {
    switch (cmd.name) {
      case 'start':
        return startCommand(app, cmd.args);
      case 'menu':
        await send(app, menuView(app), 'menu');
        return 'menu';
      case 'packs':
        await send(app, await packsUi.listView(app, 0), 'packs');
        return 'packs';
      case 'studio':
        if (!app.flag('studio')) {
          await send(app, { text: app.t('media.studio_soon') }, 'studio');
          return 'studio';
        }
        await send(app, { text: app.t('media.open_studio'), keyboard: markup([[{ text: app.tp('menu.studio'), web_app: { url: `${APP_URL}?mode=sticker` } }]]) }, 'studio');
        return 'studio';
      case 'lang':
        await send(app, langView(app, app.lang), 'lang');
        return 'lang';
      case 'help':
        await send(app, helpView(app), 'help');
        return 'help';
      case 'deletemydata':
        await send(app, deleteAskView(app), 'delete_ask');
        return 'deletemydata';
      case 'admin':
        if (app.can('panel.open')) {
          await panel.openPanel(app, null);
          return 'admin';
        }
        break;
      default:
        break;
    }
    await send(app, { text: app.t('common.unknown_command') }, 'unknown_command');
    return 'unknown_command';
  }

  if (message.sticker) return packsUi.onSticker(app, message);
  if (message.photo || message.video || message.animation || message.video_note || message.document) return packsUi.onOtherMedia(app, message);
  await send(app, menuView(app), 'menu');
  return resumed ? 'resumed_text' : 'text';
}

/** @param {any} app @param {any} message */
export async function onMessage(app, message) {
  if (!message || !message.chat || message.chat.type !== 'private' || !message.from || message.from.is_bot) return 'ignored';
  const row = await app.account.ensureAccount(message.from);
  await app.setUser(row);
  const isOwner = row.tg_id === OWNER_ID;
  const text = typeof message.text === 'string' ? message.text : '';
  const cmd = parseCommand(text);
  await ensureCommands(app);

  if (app.settings.get('maintenance.on') && !isOwner) {
    const custom = String(app.settings.get('maintenance.text') || '').trim();
    await send(app, { text: custom ? custom.replace(/[<>&]/g, '') : app.t('common.maintenance') }, 'maintenance');
    return 'maintenance';
  }
  if (row.banned && !isOwner) {
    if (cmd && cmd.name === 'start') await send(app, { text: app.t('common.banned') }, 'banned');
    return 'banned';
  }
  if (!(await allow(app))) {
    if ((await system.claimAlert(`flood:${row.tg_id}`, app.clock.now(), 30))) await send(app, { text: app.t('common.too_fast') }, 'too_fast');
    return 'flood';
  }
  // first start: the language choice comes before everything else (exempt from the gate)
  if (!row.lang) {
    await keepPending(app, cmd && cmd.name === 'start' ? { kind: 'start', payload: cmd.args } : { kind: 'message', message: keepMessage(message) });
    const suggested = String(row.lang_code || '').startsWith('en') ? 'en' : 'fa';
    await send(app, langView(app, suggested), 'lang_first');
    return 'lang_first';
  }
  if (!isOwner && !(cmd && cmd.name === 'cancel')) {
    const pending = cmd && cmd.name === 'start' ? { kind: 'start', payload: cmd.args } : { kind: 'message', message: keepMessage(message) };
    if (!(await gateOrPass(app, pending))) return 'gated';
  }
  return handleMessage(app, message);
}

/* ------------------------------------------------------------------ callbacks */

async function runRoute(app, cq, { resumed = false } = {}) {
  const d = decode(cq.data);
  const route = d && ROUTES[`${d.ns}:${d.action}`];
  const args = route ? parseArgs(d.args, route.args) : null;
  const staff = app.role !== 'user';
  if (!route || !args) return { toast: app.tp(staff ? 'common.expired' : 'common.expired_user'), alert: true };
  if (route.perm) {
    // permission on EVERY press, never only when drawing the button
    if (!app.can(route.perm)) return staff ? { toast: app.tp('common.denied'), alert: true } : { toast: app.tp('common.expired_user'), alert: true };
    if (cq.message && cq.message.chat && cq.message.chat.type !== 'private') return { toast: app.tp('common.private_only'), alert: true };
  }
  if (route.gate !== false && app.role !== 'owner' && !resumed) {
    const verdict = await app.gate.check(app.user);
    if (!verdict.passed) {
      await keepPending(app, { kind: 'callback', data: cq.data });
      await send(app, app.gate.view(app.lang, verdict.missing), 'gate');
      return { toast: app.tp('gate.still_missing') };
    }
  }
  try {
    return (await route.run(app, args, cq)) || {};
  } catch (e) {
    if (e instanceof UserError) return { toast: app.tp(e.key, e.vars).replace(/<[^>]+>/g, ''), alert: true, error: e.key };
    if (e instanceof PermissionError) return { toast: app.tp('common.denied'), alert: true };
    throw e;
  }
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
    const row = await app.account.ensureAccount(cq.from);
    await app.setUser(row);
    const isOwner = row.tg_id === OWNER_ID;
    if (app.settings.get('maintenance.on') && !isOwner) return answer({ text: app.tp('common.maintenance_short'), alert: true });
    if (row.banned && !isOwner) return answer({ text: app.tp('common.banned_short') });
    if (!(await allow(app))) return answer({ text: app.tp('common.too_fast_short') });
    const res = await runRoute(app, cq);
    await answer(res && res.toast ? { text: res.toast, alert: !!res.alert } : {});
    return res && res.error ? `refused:${res.error}` : 'ok';
  } catch (e) {
    await answer({ text: app.tp('common.error') });
    throw e;
  }
}

/** my_chat_member: block/unblock in private chats; the bot's status in gate / publish channels. */
export async function onMyChatMember(app, upd) {
  if (!upd || !upd.chat || !upd.new_chat_member) return 'ignored';
  const status = upd.new_chat_member.status;
  if (upd.chat.type === 'private') {
    if (upd.from && !upd.from.is_bot) await users.markBlocked(upd.from.id, status === 'kicked');
    return status === 'kicked' ? 'blocked' : 'unblocked';
  }
  const g = await app.gate.onBotStatusChange(upd.chat, upd.new_chat_member);
  const p = await app.publish.onBotStatusChange(upd.chat, upd.new_chat_member);
  return g ? 'gate_channel' : p ? 'publish_channel' : 'other_chat';
}
