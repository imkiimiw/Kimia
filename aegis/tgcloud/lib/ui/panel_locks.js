/*
 * The panel's 🔐 Locks section: the 42 locks in four groups, each with its own settings.
 * Viewing needs View; changing needs Settings; a punishment stronger than a warning also needs
 * Telegram's "ban users" right (or being the creator) — nobody makes Aegis do what Telegram wouldn't
 * let them do themselves.
 *
 * callback_data (chat id c, lock code k):
 *   g:c:K                 groups, how many locks are on   g:c:K:w        «new member» window
 *   g:c:K:z → K:zy        all locks off (asks first)
 *   g:c:K:c:<group>       the locks of a group
 *   g:c:K:l:k             one lock and its settings
 *   g:c:K:l:k:o|a|d|x|n|g|s|w|et|em   on/off, punishment, duration, delete, notice, log,
 *                         sensitivity, scope, trusted exempt, moderators exempt
 *   g:c:K:l:k:t           custom notice text (input)   g:c:K:l:k:h   recent hits
 *   g:c:K:l:k:e           members exempted by hand     g:c:K:l:k:ea / er:u   add (input) / remove
 * Pending inputs: lock_text, lock_ex { chat, code }.
 */
import { LOCK_DURATIONS, LOCK_EXEMPT_MAX, LOCK_TEXT_MAX, NEW_WINDOWS } from '../config.js';
import * as state from '../core/state.js';
import { answer, btn, screen, send, tryCall } from '../core/tg.js';
import { esc, iso, normalizeWord, nowSec, short, toInt } from '../core/util.js';
import * as admins from '../engines/admins.js';
import * as locks from '../engines/locks.js';
import * as settings from '../engines/settings.js';
import * as users from '../engines/users.js';
import { dur, num, t } from '../i18n/index.js';
import { rightsProblem } from './enforce.js';
import { back, guard, needLevel, pairs, removeKeyboard } from './guard.js';

const { L } = admins;
export const INPUTS = new Set(['lock_text', 'lock_ex']);
export const KEYBOARD_INPUTS = new Set(['lock_ex']);
const title = (g) => iso(g.chat.title || '', 48);
const yes = (lang, on) => t(lang, on ? 'common.on' : 'common.off');
const name = (lang, code) => t(lang, `locks.n_${code}`);
const canRestrict = (g) => g.acc.level === L.creator || (!!g.acc.member && g.acc.member.can_restrict_members === true);
const sensFamily = (def) => (def.script ? 'lang' : def.code);
/* Which settings a lock has (the service lock is only on/off; a channel's message can't be punished). */
const has = (def, what) => {
  if (def.code === 'service') return what === 'on';
  if (what === 'punish' || what === 'scope' || what === 'exempt') return def.punish || (def.code === 'bots' && what !== 'punish');
  if (what === 'delete') return def.code !== 'bots';
  if (what === 'sens') return def.sens;
  return true;
};
const timeOf = (lang, sec) => (sec ? dur(lang, sec) : t(lang, 'pun.forever'));

async function home(ctx, user, g, place, notice = '') {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const counts = await locks.countOn(c);
  const s = await settings.all(ctx, c);
  const lines = [];
  if (notice) lines.push(notice, '');
  lines.push(t(lang, 'locks.home_title', { title: title(g) }), t(lang, 'locks.home_intro'), '');
  for (const cat of locks.CATEGORIES) {
    lines.push(t(lang, 'locks.cat_line', { name: t(lang, `locks.cat_${cat}`), n: counts[cat], total: locks.LOCKS.filter((l) => l.cat === cat).length }));
  }
  lines.push('', t(lang, 'locks.window', { time: dur(lang, Number(s.new_window)) }));
  const problem = rightsProblem(g.chat);
  if (problem) lines.push('', t(lang, problem));
  if (settings.flag(s, 'audit')) lines.push('', t(lang, 'locks.audit_note'));
  const kb = pairs(locks.CATEGORIES.map((cat) => btn(`${t(lang, `locks.cat_${cat}`)} · ${num(lang, counts[cat])}`, `g:${c}:K:c:${cat}`)));
  kb.push([btn(t(lang, 'locks.btn_window', { time: dur(lang, Number(s.new_window)) }), `g:${c}:K:w`)]);
  if (Object.values(counts).some(Boolean)) kb.push([btn(t(lang, 'locks.btn_all_off'), `g:${c}:K:z`)]);
  kb.push(back(lang, `g:${c}`));
  return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'panel-locks');
}

async function category(ctx, user, g, cat, place) {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const cfgs = await locks.all(c);
  const defs = locks.LOCKS.filter((l) => l.cat === cat);
  const lines = [t(lang, 'locks.cat_title', { name: t(lang, `locks.cat_${cat}`), title: title(g) }), '', t(lang, 'locks.cat_hint')];
  const kb = pairs(defs.map((d) => btn(`${(cfgs.get(d.code) || {}).on ? '🔒' : '🔓'} ${d.icon} ${name(lang, d.code)}`, `g:${c}:K:l:${d.code}`)));
  kb.push(back(lang, `g:${c}:K`));
  return screen(ctx, user.user_id, place, lines.join('\n'), kb, `panel-locks-${cat}`);
}

async function lockScreen(ctx, user, g, def, place, notice = '') {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const k = def.code;
  const cfg = await locks.config(c, k);
  const s = await settings.all(ctx, c);
  const lines = [];
  if (notice) lines.push(notice, '');
  lines.push(t(lang, cfg.on ? 'locks.title_on' : 'locks.title_off', { icon: def.icon, name: name(lang, k) }), t(lang, `locks.d_${k}`), '');
  if (has(def, 'punish')) {
    const time = locks.TIMED_ACTIONS.has(cfg.a) ? timeOf(lang, cfg.d) : '—';
    lines.push(t(lang, 'locks.l_punish', { action: t(lang, `locks.a_${cfg.a}`), time }));
  }
  if (has(def, 'delete')) lines.push(t(lang, cfg.del ? 'locks.l_delete_on' : 'locks.l_delete_off'));
  if (k !== 'service') {
    lines.push(cfg.n === 'custom' && cfg.txt ? t(lang, 'locks.l_notice_custom', { text: iso(cfg.txt, 80) }) : t(lang, `locks.l_notice_${cfg.n === 'custom' ? 'default' : cfg.n}`));
    lines.push(t(lang, 'locks.l_log', { state: yes(lang, cfg.log) }));
  }
  if (has(def, 'scope')) lines.push(t(lang, cfg.sc === 'new' ? 'locks.l_scope_new' : 'locks.l_scope_all', { time: dur(lang, Number(s.new_window)) }));
  if (has(def, 'exempt')) lines.push(t(lang, 'locks.l_exempt', { trusted: yes(lang, cfg.exT), mods: yes(lang, cfg.exM), n: cfg.ex.length }));
  if (has(def, 'sens')) lines.push(t(lang, 'locks.l_sens', { level: t(lang, `locks.sens_${cfg.s}`), meaning: t(lang, `locks.s_${sensFamily(def)}_${cfg.s}`) }));
  if (def.allow) lines.push(t(lang, `locks.allow_${def.allow}`));
  lines.push('', t(lang, 'locks.l_hits', { n: await locks.hitCount(c, k, nowSec() - 86400) }));
  const problem = rightsProblem(g.chat);
  if (problem) lines.push(t(lang, problem));
  if (settings.flag(s, 'audit')) lines.push(t(lang, 'locks.audit_note'));
  const p = `g:${c}:K:l:${k}`;
  const kb = [[btn(t(lang, cfg.on ? 'locks.btn_turn_off' : 'locks.btn_turn_on'), `${p}:o`)]];
  if (has(def, 'punish')) {
    const row = [btn(t(lang, 'locks.btn_punish', { action: t(lang, `locks.a_${cfg.a}`) }), `${p}:a`)];
    if (locks.TIMED_ACTIONS.has(cfg.a)) row.push(btn(t(lang, 'locks.btn_time', { time: timeOf(lang, cfg.d) }), `${p}:d`));
    kb.push(row);
  }
  if (k !== 'service') {
    const row = [];
    if (has(def, 'delete')) row.push(btn(t(lang, cfg.del ? 'locks.btn_delete_on' : 'locks.btn_delete_off'), `${p}:x`));
    row.push(btn(t(lang, 'locks.btn_notice', { mode: t(lang, `locks.notice_${cfg.n}`) }), `${p}:n`));
    kb.push(row);
    kb.push([btn(t(lang, 'locks.btn_text'), `${p}:t`), btn(t(lang, 'locks.btn_log', { state: yes(lang, cfg.log) }), `${p}:g`)]);
  }
  const row2 = [];
  if (has(def, 'sens')) row2.push(btn(t(lang, 'locks.btn_sens', { level: t(lang, `locks.sens_${cfg.s}`) }), `${p}:s`));
  if (has(def, 'scope')) row2.push(btn(t(lang, cfg.sc === 'new' ? 'locks.btn_scope_new' : 'locks.btn_scope_all'), `${p}:w`));
  if (row2.length) kb.push(row2);
  if (has(def, 'exempt')) {
    kb.push([btn(t(lang, 'locks.btn_ex_trusted', { state: yes(lang, cfg.exT) }), `${p}:et`), btn(t(lang, 'locks.btn_ex_mods', { state: yes(lang, cfg.exM) }), `${p}:em`)]);
    kb.push([btn(t(lang, 'locks.btn_ex_members', { n: cfg.ex.length }), `${p}:e`), btn(t(lang, 'locks.btn_hits'), `${p}:h`)]);
  } else kb.push([btn(t(lang, 'locks.btn_hits'), `${p}:h`)]);
  kb.push(back(lang, `g:${c}:K:c:${def.cat}`));
  return screen(ctx, user.user_id, place, lines.join('\n'), kb, `lock-${k}`);
}

async function exemptScreen(ctx, user, g, def, place, notice = '') {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const cfg = await locks.config(c, def.code);
  const lines = [];
  if (notice) lines.push(notice, '');
  lines.push(t(lang, 'locks.ex_title', { name: name(lang, def.code), n: cfg.ex.length, max: LOCK_EXEMPT_MAX }), '', t(lang, 'locks.ex_hint'));
  const buttons = [];
  for (const id of cfg.ex) {
    const nm = await users.displayName(id);
    lines.push(t(lang, 'locks.ex_line', { name: iso(nm), id: `<code>${id}</code>` }));
    buttons.push(btn(`❌ ${short(nm, 24)}`, `g:${c}:K:l:${def.code}:er:${id}`));
  }
  const kb = pairs(buttons);
  if (cfg.ex.length < LOCK_EXEMPT_MAX) kb.push([btn(t(lang, 'locks.btn_ex_add'), `g:${c}:K:l:${def.code}:ea`)]);
  kb.push(back(lang, `g:${c}:K:l:${def.code}`));
  return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'lock-exempt');
}

async function hitsScreen(ctx, user, g, def, place) {
  const lang = user.lang;
  const rows = await locks.hits(g.chat.chat_id, def.code, 12);
  const now = nowSec();
  const lines = [t(lang, 'locks.hits_title', { icon: def.icon, name: name(lang, def.code) }), ''];
  if (!rows.length) lines.push(t(lang, 'locks.hits_none'));
  for (const r of rows) {
    const who = Number(r.user_id) ? iso(await users.displayName(Number(r.user_id))) : t(lang, 'locks.hidden_sender');
    const action = t(lang, `locks.h_${r.action}`);
    lines.push(t(lang, 'locks.hit_line', { ago: dur(lang, now - Number(r.at)), who, action: r.punishment ? `${action} · ${t(lang, `pun.k_${r.punishment}`)}` : action }));
  }
  return screen(ctx, user.user_id, place, lines.join('\n'), [back(lang, `g:${g.chat.chat_id}:K:l:${def.code}`)], 'lock-hits');
}

const cycle = (list, cur) => list[(list.indexOf(cur) + 1) % list.length];

async function lockAction(ctx, user, g, def, parts, place) {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const k = def.code;
  const action = parts[5];
  if (!action) return lockScreen(ctx, user, g, def, place);
  if (action === 'h') return hitsScreen(ctx, user, g, def, place);
  if (action === 'e') return exemptScreen(ctx, user, g, def, place);
  if (!(await needLevel(ctx, user, g, L.settings))) return null;
  const cfg = await locks.config(c, k);
  const set = (patch) => locks.update(c, k, patch, user.user_id);
  switch (action) {
    case 'o': await set({ on: cfg.on ? 0 : 1 }); break;
    case 'a': {
      if (!has(def, 'punish')) break;
      const allowed = canRestrict(g) ? locks.ACTIONS : ['none', 'warn'];
      if (!canRestrict(g)) await answer(ctx, t(lang, 'locks.need_restrict'));
      await set({ a: allowed[(allowed.indexOf(cfg.a) + 1) % allowed.length] });
      break;
    }
    case 'd': await set({ d: cycle(LOCK_DURATIONS, cfg.d) }); break;
    case 'x': await set({ del: cfg.del ? 0 : 1 }); break;
    case 'n': await set({ n: cycle(cfg.txt ? locks.NOTICES : ['default', 'off'], cfg.n) }); break;
    case 'g': await set({ log: cfg.log ? 0 : 1 }); break;
    case 's': if (def.sens) await set({ s: cycle(locks.SENS, cfg.s) }); break;
    case 'w': await set({ sc: cfg.sc === 'new' ? 'all' : 'new' }); break;
    case 'et': await set({ exT: cfg.exT ? 0 : 1 }); break;
    case 'em': await set({ exM: cfg.exM ? 0 : 1 }); break;
    case 't': {
      await state.set(user.user_id, 'lock_text', { chat: c, code: k });
      await answer(ctx);
      return send(ctx, user.user_id, t(lang, 'locks.text_prompt', { name: name(lang, k), max: LOCK_TEXT_MAX, user: '{user}', lock: '{lock}' }), null, 'ask-lock-text');
    }
    case 'ea': {
      await state.set(user.user_id, 'lock_ex', { chat: c, code: k });
      await answer(ctx);
      const keyboard = [[{ text: t(lang, 'lists.pick_users'), request_users: { request_id: 31, max_quantity: 10 } }], [{ text: t(lang, 'common.cancel') }]];
      return send(ctx, user.user_id, t(lang, 'locks.ex_prompt', { name: name(lang, k) }), null, 'ask-lock-ex',
        { reply_markup: { keyboard, resize_keyboard: true, one_time_keyboard: true } });
    }
    case 'er': {
      const id = toInt(parts[6]);
      await set({ ex: cfg.ex.filter((x) => x !== id) });
      return exemptScreen(ctx, user, g, def, place, t(lang, 'locks.ex_removed', { name: iso(await users.displayName(id)) }));
    }
    default: break;
  }
  return lockScreen(ctx, user, g, def, place);
}

export async function callback(ctx, user, g, parts, place) {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const sub = parts[3];
  if (sub === 'c' && locks.CATEGORIES.includes(parts[4])) return category(ctx, user, g, parts[4], place);
  if (sub === 'l') {
    const def = locks.get(parts[4]);
    return def ? lockAction(ctx, user, g, def, parts, place) : home(ctx, user, g, place);
  }
  if (sub === 'w' || sub === 'z' || sub === 'zy') {
    if (!(await needLevel(ctx, user, g, L.settings))) return null;
    if (sub === 'w') {
      const s = await settings.all(ctx, c);
      await settings.set(ctx, c, 'new_window', String(cycle(NEW_WINDOWS, Number(s.new_window))), user.user_id);
      return home(ctx, user, g, place);
    }
    if (sub === 'z') {
      const kb = [[btn(t(lang, 'locks.btn_all_off_yes'), `g:${c}:K:zy`), btn(t(lang, 'common.back'), `g:${c}:K`)]];
      return screen(ctx, user.user_id, place, t(lang, 'locks.all_off_q', { title: title(g) }), kb, 'locks-off?');
    }
    const n = await locks.allOff(c, user.user_id);
    return home(ctx, user, g, place, t(lang, 'locks.all_off_done', { n }));
  }
  return home(ctx, user, g, place);
}

/* ---------- inputs ---------- */

async function textInput(ctx, user, message, data) {
  const lang = user.lang;
  const def = locks.get(data.code);
  const g = def ? await guard(ctx, user, data.chat, L.settings, null) : null;
  if (!g) {
    await state.clear(user.user_id);
    return null;
  }
  const text = String(message.text || '').trim();
  if (!text) return send(ctx, user.user_id, t(lang, 'locks.text_prompt', { name: name(lang, def.code), max: LOCK_TEXT_MAX, user: '{user}', lock: '{lock}' }), null, 'lock-text-again');
  if ([...text].length > LOCK_TEXT_MAX) return send(ctx, user.user_id, t(lang, 'locks.text_too_long', { max: LOCK_TEXT_MAX }), null, 'lock-text-long');
  await state.clear(user.user_id);
  const patch = text === '-' ? { n: 'default', txt: null } : { n: 'custom', txt: text };
  await locks.update(g.chat.chat_id, def.code, patch, user.user_id);
  return lockScreen(ctx, user, g, def, null, t(lang, text === '-' ? 'locks.text_reset' : 'locks.text_done', { preview: esc(text) }));
}

async function exInput(ctx, user, message, data) {
  const lang = user.lang;
  const def = locks.get(data.code);
  const g = def ? await guard(ctx, user, data.chat, L.settings, null) : null;
  if (!g) {
    await state.clear(user.user_id);
    return null;
  }
  const ids = [];
  if (message.users_shared && Array.isArray(message.users_shared.users)) ids.push(...message.users_shared.users.map((u) => u.user_id));
  else if (message.forward_origin && message.forward_origin.type === 'user' && message.forward_origin.sender_user) ids.push(message.forward_origin.sender_user.id);
  else {
    for (const tok of String(message.text || '').split(/\s+/).filter(Boolean)) {
      if (/^\d{4,16}$/.test(tok) && toInt(tok) !== null) ids.push(toInt(tok));
      else if (/^@[A-Za-z][A-Za-z0-9_]{3,31}$/.test(tok)) {
        const known = await users.byUsername(tok.slice(1));
        if (known) ids.push(Number(known.user_id));
      }
    }
  }
  if (!ids.length) return send(ctx, user.user_id, t(lang, 'lists.add_nothing'), null, 'lock-ex-nothing');
  for (const id of ids) {
    const m = await tryCall(ctx, 'getChatMember', { chat_id: g.chat.chat_id, user_id: id }, 'lock-ex-member');
    if (m) await users.remember(m.user);
  }
  await state.clear(user.user_id);
  const cfg = await locks.config(g.chat.chat_id, def.code);
  const next = [...new Set([...cfg.ex, ...ids])].slice(0, LOCK_EXEMPT_MAX);
  await locks.update(g.chat.chat_id, def.code, { ex: next }, user.user_id);
  await send(ctx, user.user_id, t(lang, 'locks.ex_added', { n: next.length - cfg.ex.length }), null, 'lock-ex-done', removeKeyboard);
  return exemptScreen(ctx, user, g, def, null);
}

export async function input(ctx, user, message, pending) {
  const text = String(message.text || '').trim();
  if (text && normalizeWord(text) === normalizeWord(t(user.lang, 'common.cancel'))) {
    await state.clear(user.user_id);
    return send(ctx, user.user_id, t(user.lang, 'common.cancelled'), null, 'input-cancelled', removeKeyboard);
  }
  if (pending.kind === 'lock_text') return textInput(ctx, user, message, pending.data);
  return exInput(ctx, user, message, pending.data);
}
