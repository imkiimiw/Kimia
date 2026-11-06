// Groups (brief §8, Phase 5). In a group the bot:
//   • picks up links of the built platforms that are switched on (and allowed by the group) — up to
//     max_links per message — and replies with the media; every other link is ignored silently, so
//     ordinary chat never gets "unsupported link" noise;
//   • answers /settings (group admins only, re-checked on every button), /status (settings, usage,
//     and what the bot can see — privacy mode), /platforms and /help;
//   • introduces itself when it is added, saying plainly what it can and can't see.
// Cooldowns: one per member and one for the whole group (both claimed atomically); hits are
// silent. Forced membership in groups is off unless the owner switches it on ('switch.group_join');
// then a non-member gets one join prompt per GROUP_PROMPT_EVERY_S instead of the download.
// Channels never auto-download (channel posts and automatic forwards are ignored).
import { BOT_USERNAME, BUILT_PLATFORMS, JOIN_PASS_S, LANGS, MEDIA_PLATFORMS, PLATFORM_NAMES } from './config.js';
import * as channelsDb from './db/channels.js';
import * as groupsDb from './db/groups.js';
import * as system from './db/system.js';
import * as users from './db/users.js';
import { handleLink } from './download.js';
import { detectLang, LANG_NAMES, normLang, t, tp } from './i18n/index.js';
import { classifyMember } from './join.js';
import * as registry from './platforms/index.js';
import { platformState } from './policy.js';
import { actorOf, isOwnerId } from './roles.js';
import * as tg from './tg.js';
import * as ui from './ui.js';
import { extractLinks } from './url.js';
import { displayName, tehranDay } from './util.js';

export const GROUP_PROMPT_EVERY_S = 6 * 3600;
const GROUP_BUDGET_MS = 14000;
const ANONYMOUS_ADMIN = 1087968824; // @GroupAnonymousBot

const isGroup = (chat) => !!chat && (chat.type === 'group' || chat.type === 'supergroup');

/** "/settings@Wanger_mediabot" → "settings"; commands for other bots → null. */
export function groupCommand(text) {
  const m = /^\/([A-Za-z0-9_]{1,32})(?:@([A-Za-z0-9_]{3,64}))?(?:\s|$)/.exec(String(text || ''));
  if (!m) return null;
  if (m[2] && m[2].toLowerCase() !== BOT_USERNAME.toLowerCase()) return null;
  return m[1].toLowerCase();
}

/**
 * Does this group message concern the bot at all? (Checked before anything is written, so ordinary
 * chatter costs nothing.) Channel posts and automatic forwards from a linked channel never do.
 */
export function isRelevant(msg) {
  if (!msg || !isGroup(msg.chat)) return false;
  if (msg.is_automatic_forward) return false;
  if (msg.sender_chat && msg.sender_chat.type === 'channel') return false;
  if (msg.from && msg.from.is_bot && msg.from.id !== ANONYMOUS_ADMIN) return false;
  return !!groupCommand(msg.text || msg.caption) || extractLinks(msg, 1).length > 0;
}

/** Group admin? Anonymous admins (posting as the group) count; any API error means "no". */
export async function isGroupAdmin(ctx, chatId, from, senderChat = null) {
  if (senderChat && senderChat.id === chatId) return true;
  if (!from) return false;
  try {
    const m = await tg.call(ctx, 'group_admin_check', 'getChatMember', { chat_id: chatId, user_id: from.id });
    return m && (m.status === 'creator' || m.status === 'administrator');
  } catch {
    return false;
  }
}

/** The platforms that are built, switched on globally, and allowed by this group. */
async function usablePlatforms(gs) {
  const s = await system.loadSettings(['switch.downloads', ...BUILT_PLATFORMS.map((p) => 'platform:' + p)]);
  if (s['switch.downloads'] && s['switch.downloads'].value === false) return [];
  const allowed = allowedList(gs);
  return registry.ADAPTERS.filter((a) => {
    const st = platformState(s['platform:' + a.id] && s['platform:' + a.id].value);
    return !st.paused && a.methodOrder.some((m) => st.methods[m] === true) && allowed.includes(a.id);
  }).map((a) => a.id);
}

/**
 * The group's allowed platform list. null in the database = the platforms that send files
 * (MEDIA_PLATFORMS): information cards for every YouTube or Spotify link would flood a group, so
 * group admins switch those on themselves.
 */
export function allowedList(gs) {
  try {
    const v = gs.platforms ? JSON.parse(gs.platforms) : null;
    return Array.isArray(v) ? v.filter((p) => BUILT_PLATFORMS.includes(p)) : [...MEDIA_PLATFORMS];
  } catch {
    return [...MEDIA_PLATFORMS];
  }
}

async function ensureGroup(ctx, chat) {
  let g = await groupsDb.get(chat.id);
  if (!g) {
    const r = await groupsDb.recordStatus(chat, 'member', false, 0, ctx.now);
    if (r.activated) await system.count([['groups_active', '', 1], ['groups_joined', tehranDay(ctx.now), 1]]);
    g = await groupsDb.get(chat.id);
  }
  return g;
}

const reply = (ctx, view, msg, screen) => tg.send(ctx, view, msg.chat.id, screen, {
  reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true },
});

// ---- screens -----------------------------------------------------------------------------------

const onOff = (lang, v) => tp(lang, v ? 'adm.on' : 'adm.off');

export function settingsScreen(lang, chat, gs) {
  const allowed = allowedList(gs);
  const text = t(lang, 'g.settings', {
    title: chat.title || '', auto: onOff(lang, gs.auto_download), admin: onOff(lang, gs.admin_only), silent: onOff(lang, gs.silent),
    links: gs.max_links, mb: gs.max_mb, user: gs.user_cooldown_s, group: gs.group_cooldown_s,
    lang: LANG_NAMES[normLang(gs.lang) || 'en'],
    platforms: BUILT_PLATFORMS.map((p) => `${allowed.includes(p) ? '✅' : '⬜'} ${PLATFORM_NAMES[p]}`).join(' · '),
  });
  const platformButtons = BUILT_PLATFORMS.map((p) => ui.button(`${allowed.includes(p) ? '✅' : '⬜'} ${PLATFORM_NAMES[p]}`, 'G:p:' + p));
  const pick = (code, values, current, fmt = (v) => String(v)) => values.map((v) => ui.button((String(v) === String(current) ? '✓ ' : '') + fmt(v), `G:${code}:${v}`));
  const rows = [
    [ui.button(tp(lang, 'g.btn.auto', { v: onOff(lang, gs.auto_download) }), 'G:a'), ui.button(tp(lang, 'g.btn.admin', { v: onOff(lang, gs.admin_only) }), 'G:o')],
    [ui.button(tp(lang, 'g.btn.silent', { v: onOff(lang, gs.silent) }), 'G:s')],
    [ui.button(tp(lang, 'g.btn.links'), 'G'), ...pick('l', [1, 2, 3, 5], gs.max_links)],
    [ui.button(tp(lang, 'g.btn.mb'), 'G'), ...pick('m', [10, 20, 50], gs.max_mb)],
    [ui.button(tp(lang, 'g.btn.user_cd'), 'G'), ...pick('u', [0, 10, 30, 60], gs.user_cooldown_s)],
    [ui.button(tp(lang, 'g.btn.group_cd'), 'G'), ...pick('g', [0, 5, 15, 30], gs.group_cooldown_s)],
    LANGS.map((l) => ui.button((l === (normLang(gs.lang) || 'en') ? '✓ ' : '') + LANG_NAMES[l], 'G:L:' + l)),
    ...ui.pairs(platformButtons, 3),
    [ui.button(tp(lang, 'g.btn.close'), 'G:x')],
  ];
  return { text, reply_markup: ui.markup(rows) };
}

/** What the bot can see in the group — never claims more than is true (brief §5). */
export async function visibilityLine(ctx, lang, g) {
  if (g && g.is_admin) return t(lang, 'g.sees_all_admin');
  try {
    const me = await tg.call(ctx, 'group_getme', 'getMe', {});
    if (me && me.can_read_all_group_messages) return t(lang, 'g.sees_all_privacy_off');
  } catch { /* fall through: assume the stricter case */ }
  return t(lang, 'g.privacy_on');
}

async function statusText(ctx, lang, chat, g, gs) {
  const day = tehranDay(ctx.now);
  const v = await system.counterValues([[`g_ok:${chat.id}`, day], [`g_meta:${chat.id}`, day], [`g_failed:${chat.id}`, day]]);
  const usable = await usablePlatforms(gs);
  return [
    t(lang, 'g.status', {
      title: chat.title || '', auto: onOff(lang, gs.auto_download), admin: onOff(lang, gs.admin_only), silent: onOff(lang, gs.silent),
      links: gs.max_links, mb: gs.max_mb, user: gs.user_cooldown_s, group: gs.group_cooldown_s,
      ok: (v[`g_ok:${chat.id}|${day}`] || 0) + (v[`g_meta:${chat.id}|${day}`] || 0), failed: v[`g_failed:${chat.id}|${day}`] || 0,
    }),
    '', usable.length ? ui.platformLines(lang, usable) : t(lang, 'platforms.none'),
    '', await visibilityLine(ctx, lang, g),
  ].join('\n');
}

async function helpText(ctx, lang, gs) {
  const usable = await usablePlatforms(gs);
  return t(lang, 'g.help', { n: gs.max_links }).replace('{platforms}', usable.length ? ui.platformLines(lang, usable) : t(lang, 'platforms.none'));
}

// ---- messages ----------------------------------------------------------------------------------

/** Forced membership for a group member, cached per (group, member) for JOIN_PASS_S. */
async function memberJoined(ctx, chatId, userId) {
  const m = await groupsDb.member(chatId, userId);
  if (m && m.join_ok_until > ctx.now) return { pass: true };
  const list = await channelsDb.listEnabled();
  const missing = [];
  for (const ch of list) {
    let r;
    try {
      r = classifyMember(await tg.call(ctx, 'group_join_check', 'getChatMember', { chat_id: ch.chat_id || '@' + ch.username, user_id: userId }), null);
    } catch (err) {
      r = classifyMember(null, err);
    }
    if (r.state !== 'member') missing.push(ch); // unknown is never "member"
  }
  if (!missing.length) await groupsDb.setMemberPass(chatId, userId, ctx.now + JOIN_PASS_S);
  return { pass: !missing.length, missing };
}

export async function onGroupMessage(ctx, msg) {
  const chat = msg.chat;
  const g = await ensureGroup(ctx, chat);
  const gs = await groupsDb.settingsOf(chat.id, ctx.now);
  const lang = normLang(gs.lang) || 'en';
  const cmd = groupCommand(msg.text || msg.caption);

  if (cmd) {
    if (cmd === 'settings') {
      if (!(await isGroupAdmin(ctx, chat.id, msg.from, msg.sender_chat))) {
        await reply(ctx, 'group_only_admins', msg, { text: t(lang, 'g.only_admins') });
        return { view: 'group_only_admins' };
      }
      await reply(ctx, 'group_settings', msg, settingsScreen(lang, chat, gs));
      return { view: 'group_settings' };
    }
    if (cmd === 'status') {
      await reply(ctx, 'group_status', msg, { text: await statusText(ctx, lang, chat, g, gs) });
      return { view: 'group_status' };
    }
    if (cmd === 'platforms' || cmd === 'help' || cmd === 'start') {
      await reply(ctx, 'group_help', msg, { text: await helpText(ctx, lang, gs) });
      return { view: 'group_help' };
    }
    return { ignored: 'other_command' };
  }

  if (!gs.auto_download) return { ignored: 'auto_off' };
  const from = msg.from;
  if (!from) return { ignored: 'no_sender' };
  const st = (await users.standing(from.id)) || {};
  if (!isOwnerId(from.id) && st.ban_until != null && (st.ban_until === 0 || st.ban_until > ctx.now)) return { ignored: 'banned' };
  if (gs.admin_only && !(await isGroupAdmin(ctx, chat.id, from, msg.sender_chat))) return { ignored: 'admin_only' };

  const usable = await usablePlatforms(gs);
  const links = extractLinks(msg, 10).filter((l) => {
    const id = registry.identify(l);
    return id.kind === 'post' && usable.includes(id.adapter.id);
  }).slice(0, Math.max(1, Number(gs.max_links) || 1));
  if (!links.length) return { ignored: 'no_usable_link' };

  if (ctx.settings['switch.group_join'] && ctx.settings['switch.group_join'].value === true && from.id !== ANONYMOUS_ADMIN && !isOwnerId(from.id)) {
    const j = await memberJoined(ctx, chat.id, from.id);
    if (!j.pass) {
      if (await groupsDb.claimPrompt(chat.id, from.id, ctx.now, GROUP_PROMPT_EVERY_S)) {
        const rows = j.missing.map((ch) => {
          const url = ui.channelUrl(ch);
          return url ? [ui.urlButton(tp(lang, 'join.button', { title: ch.title || '@' + ch.username }), url)] : [];
        });
        await reply(ctx, 'group_join_prompt', msg, { text: t(lang, 'g.join_prompt', { name: displayName(from) }), reply_markup: ui.markup(rows) });
        return { view: 'group_join_prompt' };
      }
      return { ignored: 'join_prompted' };
    }
  }

  // The member's own cooldown is checked first (read-only), so a member who is still waiting never
  // uses up the group's slot; then both slots are claimed atomically.
  const userCd = Number(gs.user_cooldown_s) || 0;
  const mrow = await groupsDb.member(chat.id, from.id);
  if (mrow && mrow.last_dl_at > ctx.now - userCd) return { ignored: 'member_cooldown' };
  if (!(await groupsDb.claimGroupSlot(chat.id, ctx.now, Number(gs.group_cooldown_s) || 0))) return { ignored: 'group_cooldown' };
  if (!(await groupsDb.claimMemberSlot(chat.id, from.id, ctx.now, userCd))) return { ignored: 'member_cooldown' };

  const user = { id: from.id, lang, row: {}, name: displayName(from), actor: actorOf(from.id, st.role ? { role: st.role, perms: st.role_perms } : null) };
  const results = [];
  for (const link of links) {
    if (Date.now() - ctx.nowMs > GROUP_BUDGET_MS) break;
    const r = await handleLink(ctx, user, msg, link, { kind: 'group', settings: gs });
    results.push({ status: r.status, reason: r.reason || null, platform: r.platform || null });
  }
  return { view: 'group_download', downloads: results };
}

// ---- settings buttons --------------------------------------------------------------------------

/** A /settings button in a group: admins only, checked with Telegram on every press. */
export async function onSettingsButton(ctx, cq, d) {
  const msg = cq.message;
  const chat = msg.chat;
  const gs0 = await groupsDb.settingsOf(chat.id, ctx.now);
  const lang = normLang(gs0.lang) || 'en';
  if (!(await isGroupAdmin(ctx, chat.id, cq.from))) {
    await tg.answer(ctx, cq.id, tp(lang, 'g.only_admins'), true);
    return { ignored: 'not_group_admin' };
  }
  const [field, value] = d.args;
  const set = async (col, v) => {
    await groupsDb.setSetting(chat.id, col, v, cq.from.id, ctx.now);
    await system.audit(ctx.now, cq.from.id, 'group.setting', String(chat.id), { [col]: v });
  };
  if (field === 'x') {
    await tg.answer(ctx, cq.id);
    try { await tg.call(ctx, 'group_settings', 'deleteMessage', { chat_id: chat.id, message_id: msg.message_id }); } catch { /* already gone */ }
    return { view: 'group_settings_closed' };
  }
  if (field === 'a') await set('auto_download', gs0.auto_download ? 0 : 1);
  else if (field === 'o') await set('admin_only', gs0.admin_only ? 0 : 1);
  else if (field === 's') await set('silent', gs0.silent ? 0 : 1);
  else if (field === 'l') await set('max_links', Number(value));
  else if (field === 'm') await set('max_mb', Number(value));
  else if (field === 'u') await set('user_cooldown_s', Number(value));
  else if (field === 'g') await set('group_cooldown_s', Number(value));
  else if (field === 'L') await set('lang', value);
  else if (field === 'p') {
    const allowed = allowedList(gs0);
    const next = allowed.includes(value) ? allowed.filter((p) => p !== value) : [...allowed, value];
    await set('platforms', JSON.stringify(BUILT_PLATFORMS.filter((p) => next.includes(p))));
  }
  const gs = await groupsDb.settingsOf(chat.id, ctx.now);
  await tg.answer(ctx, cq.id);
  await tg.edit(ctx, 'group_settings', msg, settingsScreen(normLang(gs.lang) || 'en', chat, gs));
  return { view: 'group_settings' };
}

// ---- the bot added to a group ------------------------------------------------------------------

/** Introduces the bot after it was added: what it does, what it can see, /settings, responsibility. */
export async function introduce(ctx, chat, from) {
  const lang = normLang((from && (await users.langOf(from.id))) || null) || detectLang(from && from.language_code);
  const gs = await groupsDb.settingsOf(chat.id, ctx.now);
  if (!gs.lang) await groupsDb.setSetting(chat.id, 'lang', lang, from ? from.id : 0, ctx.now);
  const g = await groupsDb.get(chat.id);
  const text = [t(lang, 'g.intro'), '', await visibilityLine(ctx, lang, g)].join('\n');
  try {
    await tg.send(ctx, 'group_intro', chat.id, { text });
  } catch { /* the bot may not be allowed to write yet */ }
  return { introduced: true, lang };
}
