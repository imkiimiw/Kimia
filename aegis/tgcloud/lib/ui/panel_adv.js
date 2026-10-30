/*
 * The panel's ⚙\uFE0F Advanced section: the 26 advanced settings in four groups (cleanup, messages,
 * commands, join & identity) and the extra settings — welcome and goodbye, forced join/add,
 * night lock, scheduled cleanup, time zone, message length, reports, event channel, linked channel,
 * rules. Viewing needs View, changing needs Settings.
 *
 * callback_data (chat id c):
 *   g:c:V                    overview               g:c:V:g:<group>     a group of settings
 *   g:c:V:s:<key>            switch / next value     g:c:V:i:<key>       type a value (input)
 *   g:c:V:w  :j  :n  :c  :z  :l  :r  :e  :k  :u      welcome, forced join/add, night lock, cleanup,
 *                            time zone, length, reports, event channel, linked channel, rules
 *   g:c:V:wp                 preview the welcome     g:c:V:jr:<i>        remove forced-join channel i
 *   g:c:V:z:<i|auto>         time zone               g:c:V:cn → cny      clean now (asks first)
 *   g:c:V:ed                 event channel off
 * Pending input: adv_input { chat, key }.
 */
import { CLEAN_MAX_TIMES, FJ_MAX_CHANNELS } from '../config.js';
import { me } from '../core/bot.js';
import { TZ_OFFSETS, fmtTime, parseTimes, tzLabel, tzOf } from '../core/clock.js';
import * as state from '../core/state.js';
import { answer, btn, screen, send, tryCall } from '../core/tg.js';
import { esc, iso, normalizeWord, nowSec, parseJson, short } from '../core/util.js';
import * as admins from '../engines/admins.js';
import { parseButtons } from '../engines/buttons.js';
import * as gd from '../engines/groupdata.js';
import * as settings from '../engines/settings.js';
import * as users from '../engines/users.js';
import { dur, num, t } from '../i18n/index.js';
import { cleanup, plan } from './advanced.js';
import { compose } from './welcome.js';
import { back, guard, needLevel, pairs, removeKeyboard } from './guard.js';
import { logChatOf } from './panel_mod.js';

const { L } = admins;
export const INPUTS = new Set(['adv_input']);
export const KEYBOARD_INPUTS = new Set(['adv_input']);
export const GROUPS = {
  clean: ['del_join', 'del_leave', 'del_pin', 'del_chatinfo', 'del_videochat', 'del_cmds', 'del_bots', 'notice_ttl'],
  msg: ['slow', 'max_lines', 'max_mentions', 'caps', 'junk', 'edit_window', 'media_ttl'],
  cmd: ['rules', 'rules_btn', 'member_cmds', 'reply_private', 'admin_call', 'anon_cmds'],
  join: ['bot_kick', 'jr_mode', 'name_watch', 'title_lock', 'bot_alert'],
};
const SECONDS = new Set(['notice_ttl', 'slow', 'edit_window', 'media_ttl']);
const PLANNED = new Set(['night_on', 'clean_on', 'tz', 'night_from', 'night_to', 'clean_times']);
const title = (g) => iso(g.chat.title || '', 48);
/* Placeholders shown literally in the prompts that explain them. */
const LITERAL = { name: '{name}', mention: '{mention}', group: '{group}', count: '{count}' };
const onOff = (lang, on) => t(lang, on ? 'common.on' : 'common.off');

/* A setting's value as text. */
export function show(lang, key, v) {
  if (settings.isFlag(key)) return onOff(lang, v === '1');
  if (key === 'rules') return v ? t(lang, 'adv.v_rules_set', { n: [...v].length }) : t(lang, 'adv.v_none');
  if (SECONDS.has(key)) return Number(v) ? dur(lang, Number(v)) : t(lang, 'common.off');
  if (['max_lines', 'max_mentions', 'fa_n', 'min_len', 'max_len'].includes(key)) return Number(v) ? num(lang, Number(v)) : t(lang, 'common.off');
  return t(lang, `adv.v_${key}_${v}`);
}

async function overview(ctx, user, g, place, notice = '') {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const s = await settings.all(ctx, c);
  const lines = [];
  if (notice) lines.push(notice, '');
  lines.push(t(lang, 'adv.home_title', { title: title(g) }), t(lang, 'adv.home_intro'), '');
  for (const grp of Object.keys(GROUPS)) {
    const on = GROUPS[grp].filter((k) => (settings.isFlag(k) ? s[k] === '1' : s[k] && s[k] !== '0' && s[k] !== 'manual')).length;
    lines.push(t(lang, 'adv.group_line', { name: t(lang, `adv.g_${grp}`), n: on, total: GROUPS[grp].length }));
  }
  lines.push('', t(lang, 'adv.tz_line', { tz: tzLabel(tzOf(s.tz, g.chat.lang)) }));
  const kb = pairs(Object.keys(GROUPS).map((grp) => btn(t(lang, `adv.g_${grp}`), `g:${c}:V:g:${grp}`)));
  kb.push(...pairs(['w', 'j', 'n', 'c', 'z', 'l', 'r', 'e', 'k', 'u'].map((x) => btn(t(lang, `adv.x_${x}`), `g:${c}:V:${x}`))));
  kb.push(back(lang, `g:${c}`));
  return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'panel-advanced');
}

async function groupScreen(ctx, user, g, grp, place, notice = '') {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const s = await settings.all(ctx, c);
  const lines = [];
  if (notice) lines.push(notice, '');
  lines.push(t(lang, 'adv.group_title', { name: t(lang, `adv.g_${grp}`), title: title(g) }), '');
  for (const k of GROUPS[grp]) lines.push(t(lang, 'adv.setting_line', { name: t(lang, `adv.k_${k}`), value: show(lang, k, s[k]), hint: t(lang, `adv.h_${k}`) }));
  const kb = pairs(GROUPS[grp].map((k) => btn(t(lang, 'adv.setting_btn', { name: t(lang, `adv.k_${k}`), value: show(lang, k, s[k]) }),
    k === 'rules' ? `g:${c}:V:u` : `g:${c}:V:s:${k}`)));
  kb.push(back(lang, `g:${c}:V`));
  return screen(ctx, user.user_id, place, lines.join('\n'), kb, `advanced-${grp}`);
}

const groupOf = (key) => Object.keys(GROUPS).find((grp) => GROUPS[grp].includes(key)) || null;

/* Switches a flag or moves a choice to its next value. Gives the screen to show again. */
async function change(ctx, user, g, key, place) {
  const lang = user.lang;
  const c = g.chat.chat_id;
  if (!(await needLevel(ctx, user, g, L.settings))) return null;
  const s = await settings.all(ctx, c);
  let next;
  if (settings.isFlag(key)) next = s[key] === '1' ? '0' : '1';
  else if (settings.CHOICES[key]) {
    const list = settings.CHOICES[key].map(String);
    next = list[(list.indexOf(s[key]) + 1) % list.length];
  } else return overview(ctx, user, g, place);
  if (key === 'title_lock' && next === '1') {
    const info = await tryCall(ctx, 'getChat', { chat_id: c }, 'title-read');
    await settings.set(ctx, c, 'title_locked', (info && info.title) || g.chat.title || '', user.user_id);
  }
  await settings.set(ctx, c, key, next, user.user_id);
  if (PLANNED.has(key)) await plan(ctx, g.chat);
  const grp = groupOf(key);
  if (grp) return groupScreen(ctx, user, g, grp, place);
  return extra(ctx, user, g, EXTRA_OF[key] || 'w', [], place);
}

const EXTRA_OF = {
  welcome_on: 'w', welcome_clean: 'w', goodbye_on: 'w', fa_n: 'j', night_on: 'n', clean_on: 'c', clean_scope: 'c', min_len: 'l', max_len: 'l',
  reports: 'r', report_dest: 'r', ev_join: 'e', ev_leave: 'e', ev_admin: 'e', ev_names: 'e', linked: 'k',
};

/* ---------- the extra settings ---------- */

async function extra(ctx, user, g, x, parts, place, notice = '') {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const s = await settings.all(ctx, c);
  const lines = [];
  if (notice) lines.push(notice, '');
  lines.push(t(lang, `adv.x_title_${x}`, { title: title(g) }), t(lang, `adv.x_intro_${x}`, LITERAL), '');
  const kb = [];
  const sw = (key) => btn(t(lang, 'adv.setting_btn', { name: t(lang, `adv.k_${key}`), value: show(lang, key, s[key]) }), `g:${c}:V:s:${key}`);
  const input = (key) => btn(t(lang, `adv.btn_i_${key}`), `g:${c}:V:i:${key}`);
  if (x === 'w') {
    lines.push(t(lang, 'adv.w_state', { welcome: onOff(lang, s.welcome_on === '1'), goodbye: onOff(lang, s.goodbye_on === '1') }));
    lines.push(t(lang, 'adv.w_text', { text: s.welcome_text ? iso(s.welcome_text, 200) : t(lang, 'adv.v_standard') }));
    lines.push(t(lang, 'adv.w_buttons', { n: ((parseButtons(s.welcome_btns || '').rows) || []).flat().length }));
    lines.push(t(lang, 'adv.g_text', { text: s.goodbye_text ? iso(s.goodbye_text, 200) : t(lang, 'adv.v_standard') }));
    kb.push([sw('welcome_on'), sw('goodbye_on')], [input('welcome_text'), input('welcome_btns')], [input('goodbye_text'), sw('welcome_clean')],
      [btn(t(lang, 'adv.btn_preview'), `g:${c}:V:wp`)]);
  } else if (x === 'j') {
    const list = parseJson(s.fj_chats, []) || [];
    if (!list.length) lines.push(t(lang, 'adv.fj_none'));
    list.forEach((ch) => lines.push(t(lang, 'adv.fj_line', { title: iso(ch.title || ch.username || String(ch.id), 40) })));
    lines.push('', t(lang, 'adv.fa_line', { n: show(lang, 'fa_n', s.fa_n) }));
    kb.push(...pairs(list.map((ch, i) => btn(`❌ ${short(ch.title || ch.username || String(ch.id), 24)}`, `g:${c}:V:jr:${i}`))));
    if (list.length < FJ_MAX_CHANNELS) kb.push([input('fj_add')]);
    kb.push([sw('fa_n')]);
  } else if (x === 'n') {
    lines.push(t(lang, 'adv.n_line', { state: onOff(lang, s.night_on === '1'), from: fmtTime(Number(s.night_from)), to: fmtTime(Number(s.night_to)),
      tz: tzLabel(tzOf(s.tz, g.chat.lang)) }));
    if (g.chat.type !== 'supergroup') lines.push('', t(lang, 'sec.basic_group'));
    kb.push([sw('night_on'), input('night_times')], [btn(t(lang, 'adv.x_z'), `g:${c}:V:z`)]);
  } else if (x === 'c') {
    const times = parseJson(s.clean_times, []) || [];
    lines.push(t(lang, 'adv.c_line', { state: onOff(lang, s.clean_on === '1'), times: times.length ? times.map(fmtTime).join(', ') : '—',
      scope: show(lang, 'clean_scope', s.clean_scope), tz: tzLabel(tzOf(s.tz, g.chat.lang)) }));
    kb.push([sw('clean_on'), input('clean_times')], [sw('clean_scope'), btn(t(lang, 'adv.btn_clean_now'), `g:${c}:V:cn`)]);
  } else if (x === 'z') {
    lines.push(t(lang, 'adv.tz_line', { tz: tzLabel(tzOf(s.tz, g.chat.lang)) }), t(lang, 'adv.tz_note'));
    kb.push([btn(`${s.tz === 'auto' ? '✓ ' : ''}${t(lang, 'adv.tz_auto')}`, `g:${c}:V:z:auto`)]);
    const btns = TZ_OFFSETS.map((m, i) => btn(`${String(m) === s.tz ? '✓ ' : ''}${tzLabel(m)}`, `g:${c}:V:z:${i}`));
    for (let i = 0; i < btns.length; i += 3) kb.push(btns.slice(i, i + 3));
  } else if (x === 'l') {
    kb.push([sw('min_len'), sw('max_len')]);
  } else if (x === 'r') {
    lines.push(t(lang, 'adv.r_line', { state: onOff(lang, s.reports === '1'), dest: show(lang, 'report_dest', s.report_dest) }));
    const now = nowSec();
    for (const r of await gd.recentReports(c, 8)) {
      lines.push(t(lang, 'adv.r_item', { ago: dur(lang, now - Number(r.at)), who: iso(await users.displayName(Number(r.reporter_id))),
        target: Number(r.target_id) ? iso(await users.displayName(Number(r.target_id))) : '—', status: t(lang, `adv.rs_${r.status}`) }));
    }
    kb.push([sw('reports'), sw('report_dest')]);
  } else if (x === 'e') {
    const set = s.ev_chat !== '0';
    const info = set ? await tryCall(ctx, 'getChat', { chat_id: Number(s.ev_chat) }, 'ev-chat') : null;
    lines.push(set ? t(lang, 'adv.e_current', { name: iso((info && info.title) || s.ev_chat, 48) }) : t(lang, 'adv.e_none'));
    kb.push([input('ev_set')].concat(set ? [btn(t(lang, 'logs.btn_remove'), `g:${c}:V:ed`)] : []));
    kb.push([sw('ev_join'), sw('ev_leave')], [sw('ev_admin'), sw('ev_names')]);
  } else if (x === 'k') {
    kb.push([sw('linked')]);
  } else if (x === 'u') {
    lines.push(s.rules ? t(lang, 'adv.rules_current', { rules: esc(s.rules) }) : t(lang, 'adv.no_rules'));
    kb.push([input('rules')]);
    kb.push([btn(t(lang, 'adv.setting_btn', { name: t(lang, 'adv.k_rules_btn'), value: show(lang, 'rules_btn', s.rules_btn) }), `g:${c}:V:s:rules_btn`)]);
  }
  kb.push(back(lang, `g:${c}:V`));
  void parts;
  return screen(ctx, user.user_id, place, lines.join('\n'), kb, `advanced-x-${x}`);
}

const PROMPT_KEYBOARD = {
  fj_add: (lang) => [[{ text: t(lang, 'logs.pick_channel'), request_chat: { request_id: 51, chat_is_channel: true, bot_is_member: true } }],
    [{ text: t(lang, 'logs.pick_group'), request_chat: { request_id: 52, chat_is_channel: false, bot_is_member: true } }], [{ text: t(lang, 'common.cancel') }]],
  ev_set: (lang) => [[{ text: t(lang, 'logs.pick_channel'), request_chat: { request_id: 53, chat_is_channel: true, bot_is_member: true } }],
    [{ text: t(lang, 'logs.pick_group'), request_chat: { request_id: 54, chat_is_channel: false, bot_is_member: true } }], [{ text: t(lang, 'common.cancel') }]],
};

export async function callback(ctx, user, g, parts, place) {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const sub = parts[3];
  if (!sub) return overview(ctx, user, g, place);
  if (sub === 'g' && GROUPS[parts[4]]) return groupScreen(ctx, user, g, parts[4], place);
  if (sub === 's' && parts[4] in settings.DEFAULTS) return change(ctx, user, g, parts[4], place);
  if (sub === 'i') {
    if (!(await needLevel(ctx, user, g, L.settings))) return null;
    const key = parts[4];
    await state.set(user.user_id, 'adv_input', { chat: c, key });
    await answer(ctx);
    const kb = PROMPT_KEYBOARD[key] ? PROMPT_KEYBOARD[key](lang) : null;
    const extraOpts = kb ? { reply_markup: { keyboard: kb, resize_keyboard: true, one_time_keyboard: true } } : {};
    return send(ctx, user.user_id, t(lang, `adv.p_${key}`, { max: CLEAN_MAX_TIMES, ...LITERAL }), null, `ask-adv-${key}`, extraOpts);
  }
  if (sub === 'wp') {
    await answer(ctx, t(lang, 'adv.preview_sent'));
    const me2 = { id: user.user_id, first_name: (await users.displayName(user.user_id)) || 'Aegis' };
    const { text, rows } = await compose(ctx, g.chat, me2, await settings.all(ctx, c));
    return send(ctx, user.user_id, text, rows, 'welcome-preview');
  }
  if (sub === 'jr') {
    if (!(await needLevel(ctx, user, g, L.settings))) return null;
    const s = await settings.all(ctx, c);
    const list = parseJson(s.fj_chats, []) || [];
    list.splice(Number(parts[4]), 1);
    await settings.set(ctx, c, 'fj_chats', JSON.stringify(list), user.user_id);
    return extra(ctx, user, g, 'j', parts, place);
  }
  if (sub === 'z' && parts[4] !== undefined) {
    if (!(await needLevel(ctx, user, g, L.settings))) return null;
    const v = parts[4] === 'auto' ? 'auto' : String(TZ_OFFSETS[Number(parts[4])]);
    if (v !== 'undefined') await settings.set(ctx, c, 'tz', v, user.user_id);
    await plan(ctx, g.chat);
    return extra(ctx, user, g, 'z', parts, place);
  }
  if (sub === 'cn' || sub === 'cny') {
    if (!(await needLevel(ctx, user, g, L.settings))) return null;
    if (sub === 'cn') {
      const kb = [[btn(t(lang, 'adv.btn_clean_yes'), `g:${c}:V:cny`), btn(t(lang, 'common.back'), `g:${c}:V:c`)]];
      return screen(ctx, user.user_id, place, t(lang, 'adv.clean_q', { title: title(g) }), kb, 'advanced-clean?');
    }
    const n = await cleanup(ctx, g.chat, nowSec() - 48 * 3600);
    return extra(ctx, user, g, 'c', parts, place, t(lang, 'adv.cleaned', { n }));
  }
  if (sub === 'ed') {
    if (!(await needLevel(ctx, user, g, L.settings))) return null;
    await settings.set(ctx, c, 'ev_chat', '0', user.user_id);
    return extra(ctx, user, g, 'e', parts, place);
  }
  if (['w', 'j', 'n', 'c', 'z', 'l', 'r', 'e', 'k', 'u'].includes(sub)) return extra(ctx, user, g, sub, parts, place);
  return overview(ctx, user, g, place);
}

/* ---------- inputs ---------- */

async function chatTarget(ctx, user, message, lang) {
  const id = await logChatOf(ctx, message);
  if (!id) return { error: 'logs.set_bad' };
  const info = await tryCall(ctx, 'getChat', { chat_id: id }, 'adv-target');
  const bot = await tryCall(ctx, 'getChatMember', { chat_id: id, user_id: (await me(ctx)).id }, 'adv-target-bot');
  const mine = await tryCall(ctx, 'getChatMember', { chat_id: id, user_id: user.user_id }, 'adv-target-user');
  if (!info || !bot) return { error: 'logs.bot_not_there' };
  if (!mine || !['creator', 'administrator'].includes(mine.status)) return { error: 'logs.not_admin_there' };
  void lang;
  return { id, info, bot };
}

export async function input(ctx, user, message, pending) {
  const lang = user.lang;
  const text = String(message.text || '').trim();
  if (text && normalizeWord(text) === normalizeWord(t(lang, 'common.cancel'))) {
    await state.clear(user.user_id);
    return send(ctx, user.user_id, t(lang, 'common.cancelled'), null, 'input-cancelled', removeKeyboard);
  }
  const { key } = pending.data;
  const g = await guard(ctx, user, pending.data.chat, L.settings, null);
  if (!g) {
    await state.clear(user.user_id);
    return null;
  }
  const c = g.chat.chat_id;
  const again = (k, vars = {}) => send(ctx, user.user_id, t(lang, k, vars), null, `adv-${key}-again`);
  const done = async (x, noticeKey, vars = {}) => {
    await state.clear(user.user_id);
    await send(ctx, user.user_id, t(lang, noticeKey, vars), null, `adv-${key}-done`, removeKeyboard);
    return x === 'u' || x === 'w' || x === 'n' || x === 'c' || x === 'j' || x === 'e' ? extra(ctx, user, g, x, [], null) : overview(ctx, user, g, null);
  };
  if (['welcome_text', 'goodbye_text', 'rules', 'welcome_btns'].includes(key)) {
    if (!text) return again(`adv.p_${key}`, { max: CLEAN_MAX_TIMES, ...LITERAL });
    const value = text === '-' ? '' : text;
    if (key === 'welcome_btns' && value) {
      const p = parseButtons(value);
      if (p.error) return again(`bc.buttons_err_${p.error}`, { line: p.line });
    }
    if (!(await settings.set(ctx, c, key, value, user.user_id))) return again('adv.too_long');
    return done(key === 'rules' ? 'u' : 'w', 'adv.saved');
  }
  if (key === 'night_times') {
    const parts = text.split(/\s*[-–—تا]+\s*|\s+/).filter(Boolean);
    const from = parseTimes(parts[0] || '');
    const to = parseTimes(parts[1] || '');
    if (from.error || to.error || parts.length !== 2 || from.times[0] === to.times[0]) return again('adv.p_night_times', LITERAL);
    await settings.set(ctx, c, 'night_from', String(from.times[0]), user.user_id);
    await settings.set(ctx, c, 'night_to', String(to.times[0]), user.user_id);
    await plan(ctx, g.chat);
    return done('n', 'adv.saved');
  }
  if (key === 'clean_times') {
    const r = parseTimes(text, CLEAN_MAX_TIMES);
    if (r.error) return again(`adv.times_err_${r.error}`, { max: CLEAN_MAX_TIMES });
    await settings.set(ctx, c, 'clean_times', JSON.stringify(r.times), user.user_id);
    await plan(ctx, g.chat);
    return done('c', 'adv.saved');
  }
  if (key === 'fj_add' || key === 'ev_set') {
    const r = await chatTarget(ctx, user, message, lang);
    if (r.error) return again(r.error);
    if (r.id === c) return again('logs.same_chat');
    if (key === 'ev_set') {
      if (!(await send(ctx, r.id, t(g.chat.lang, 'adv.ev_connected', { title: title(g) }), null, 'ev-connected'))) return again('logs.test_failed');
      await settings.set(ctx, c, 'ev_chat', String(r.id), user.user_id);
      return done('e', 'adv.saved');
    }
    if (r.bot.status !== 'administrator') return again('adv.fj_bot_not_admin');
    const s = await settings.all(ctx, c);
    const list = parseJson(s.fj_chats, []) || [];
    if (list.some((ch) => ch.id === r.id)) return done('j', 'adv.saved');
    let url = r.info.username ? `https://t.me/${r.info.username}` : r.info.invite_link || null;
    if (!url) url = await tryCall(ctx, 'exportChatInviteLink', { chat_id: r.id }, 'fj-invite');
    list.push({ id: r.id, title: r.info.title || '', username: r.info.username || '', url });
    await settings.set(ctx, c, 'fj_chats', JSON.stringify(list.slice(0, FJ_MAX_CHANNELS)), user.user_id);
    return done('j', 'adv.fj_added', { title: iso(r.info.title || String(r.id), 40) });
  }
  await state.clear(user.user_id);
  return overview(ctx, user, g, null);
}
