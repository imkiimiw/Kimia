/*
 * The panel's Phase 3 sections: lists, punishments, warnings and steps, anti-betrayal, Audit Mode
 * and the log channel. Every action goes through guard() (live re-check) and its level:
 *   view      browse, search, history, export
 *   settings  change lists and warning settings, undo punishments, clear warnings
 *   full      the «mod» list, anti-betrayal, Audit Mode, the log channel
 * Adding to (or removing from) a list that punishes — muted, restricted, banned, blacklist,
 * quarantine, warned — also needs Telegram's "ban users" right (or being the creator): nobody does
 * through Aegis what Telegram wouldn't let them do themselves.
 *
 * callback_data (chat id c):
 *   g:c:L                    the 18 lists             g:c:L:k[:p:n]   list k, page n
 *   g:c:L:k:a                add (asks for entries)   g:c:L:k:s       search (asks for text)
 *   g:c:L:k:x                export as CSV            g:c:L:k:h       the list's history
 *   g:c:L:k:d:i              entry i                  g:c:L:k:n:i / v:i   edit its note / value
 *   g:c:L:k:r:i → ry:i       remove (confirm)
 *   g:c:P[:p:n]              punishments              g:c:P:u:i:n     undo punishment i
 *   g:c:P:x                  export punishments
 *   g:c:W                    warnings and steps       g:c:W:t|r|n     expiry, reset, notices
 *   g:c:W:s / sd             edit steps / default     g:c:W:u:m       member m's warnings
 *   g:c:W:m:m / c:m → cy:m   remove last / clear all
 *   g:c:B                    anti-betrayal            g:c:B:o|n|w|a   on/off, threshold, window, action
 *   g:c:U → U:y              Audit Mode (explained, then switched)
 *   g:c:O                    log channel              g:c:O:s|d|o|t   set, remove, on/off, test
 *   g:c:O:c:<cat>            a category on/off
 * Pending inputs: list_add, list_search, list_note, list_value { chat, code, id }, steps { chat },
 * log_set { chat }.
 */
import { InputFile } from 'sdk';
import { EXPORT_MAX_ROWS, LIST_ADD_MAX_LINES, LIST_MAX_ENTRIES, LIST_PAGE, PUNISH_PAGE, REASON_MAX } from '../config.js';
import * as audit from '../core/audit.js';
import { me } from '../core/bot.js';
import { csv, isoMinute, utf8Bytes } from '../core/csv.js';
import { parseDuration } from '../core/duration.js';
import * as state from '../core/state.js';
import { answer, btn, call, describeError, screen, send, tryCall } from '../core/tg.js';
import { fullName, iso, normalizeWord, nowSec, parseJson, short, toInt } from '../core/util.js';
import * as admins from '../engines/admins.js';
import * as betrayal from '../engines/betrayal.js';
import * as lists from '../engines/lists.js';
import * as logs from '../engines/logs.js';
import * as punish from '../engines/punish.js';
import * as settings from '../engines/settings.js';
import { DEFAULT_STEPS, parseSteps } from '../engines/steps.js';
import * as users from '../engines/users.js';
import { dur, num, t } from '../i18n/index.js';
import { back, guard, needLevel, pairs, removeKeyboard } from './guard.js';

const { L } = admins;
const EFFECT_KIND = { mute: 'mute', restrict: 'restrict', ban: 'ban', blacklist: 'blacklist', quarantine: 'quarantine', warn: 'warn' };
const isAdminStatus = (s) => s === 'creator' || s === 'administrator';
const listNeed = (def) => (def.code === 'mod' ? L.full : L.settings);
const onOff = (lang, on) => t(lang, on ? 'common.on' : 'common.off');
const title = (g) => iso(g.chat.title || '', 48);
export const INPUTS = new Set(['list_add', 'list_search', 'list_note', 'list_value', 'steps', 'log_set']);
export const KEYBOARD_INPUTS = new Set(['list_add', 'log_set']);

const canRestrict = (g) => g.acc.level === L.creator || (!!g.acc.member && g.acc.member.can_restrict_members === true);
const botCanRestrict = (g) => parseJson(g.chat.bot_rights, {}).can_restrict_members === true;

/* Telegram's "ban users" for the person and for Aegis; otherwise they are told and it gives false. */
async function needRestrict(ctx, user, g) {
  let key = null;
  if (!canRestrict(g)) key = 'chat.need_restrict';
  else if (!botCanRestrict(g)) key = 'chat.bot_cant_restrict';
  if (!key) return true;
  if (ctx.callbackId) await answer(ctx, t(user.lang, key), true);
  else await send(ctx, user.user_id, t(user.lang, key), null, 'need-restrict');
  return false;
}

async function who(lang, id) {
  return id ? iso(await users.displayName(Number(id))) : t(lang, 'log.system');
}

function nav(prefix, p, pages) {
  if (pages <= 1) return null;
  const row = [];
  if (p > 0) row.push(btn('◀️', `${prefix}:${p - 1}`));
  row.push(btn(`${p + 1}/${pages}`, `${prefix}:${p}`));
  if (p < pages - 1) row.push(btn('▶️', `${prefix}:${p + 1}`));
  return row;
}

/* A settings change, posted to the log channel (category settings). */
async function logSetting(ctx, g, user, what) {
  await logs.post(ctx, g.chat, 'settings', t(g.chat.lang, 'logs.setting', { who: iso(await users.displayName(user.user_id)), what }));
}

/* Protection weakened (anti-betrayal off, Audit Mode on): the creator hears about it privately. */
async function tellCreator(ctx, g, user, key) {
  const row = (await admins.listRows(g.chat.chat_id)).find((r) => r.status === 'creator');
  const cid = row ? Number(row.user_id) : 0;
  if (!cid || cid === user.user_id) return;
  const u = await users.get(cid);
  if (!u || !Number(u.started) || Number(u.blocked)) return;
  await send(ctx, cid, t(u.lang, key, { title: title(g), name: iso(await users.displayName(user.user_id)) }), [[btn(t(u.lang, 'group.btn_panel'), `g:${g.chat.chat_id}`)]], 'creator-alert');
}

async function sendCsv(ctx, user, rows, filename, caption) {
  const file = new InputFile(utf8Bytes(csv(rows)), filename, { type: 'text/csv' });
  try {
    await call(ctx, 'sendDocument', { chat_id: user.user_id, document: file, caption }, 'export');
    return true;
  } catch (err) {
    await send(ctx, user.user_id, t(user.lang, 'chat.tg_error', { error: describeError(err) }), null, 'export-error');
    return false;
  }
}

/* ---------- lists ---------- */

async function listsHome(ctx, user, g, place) {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const counts = await lists.counts(c);
  counts.wrn = (await punish.warned(ctx, c, 1, 0)).total;
  const lines = [t(lang, 'lists.home_title', { title: title(g) }), '', t(lang, 'lists.home_intro')];
  const kb = pairs(lists.LISTS.map((d) => btn(`${d.icon} ${t(lang, `lists.n_${d.code}`)} · ${num(lang, counts[d.code] || 0)}`, `g:${c}:L:${d.code}`)));
  kb.push(back(lang, `g:${c}`));
  return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'panel-lists');
}

function entryLine(lang, def, e) {
  const parts = [iso(e.value, 40)];
  if (lists.isUserKind(def) && Number(e.user_id)) parts.push(`<code>${Number(e.user_id)}</code>`);
  if (e.note) parts.push(iso(e.note, 40));
  if (Number(e.expires_at)) parts.push(t(lang, 'lists.expires_in', { time: dur(lang, Number(e.expires_at) - nowSec()) }));
  return t(lang, 'lists.line', { text: parts.join(' · ') });
}

async function listPage(ctx, user, g, def, p, place, notice = '') {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const code = def.code;
  const lines = [];
  if (notice) lines.push(notice, '');
  lines.push(t(lang, 'lists.title', { icon: def.icon, name: t(lang, `lists.n_${code}`), title: title(g) }), t(lang, `lists.d_${code}`));
  if (def.effect === 'none') lines.push(t(lang, def.kind === 'user' ? 'lists.later_user' : 'lists.later'));
  let rows;
  let total;
  if (code === 'wrn') ({ rows, total } = await punish.warned(ctx, c, LIST_PAGE, p * LIST_PAGE));
  else ({ rows, total } = await lists.page(c, code, p));
  const pages = Math.max(1, Math.ceil(total / LIST_PAGE));
  lines.push('', t(lang, 'lists.count', { n: total, max: LIST_MAX_ENTRIES }));
  if (!rows.length) lines.push(t(lang, 'lists.empty'));
  const buttons = [];
  for (const r of rows) {
    if (code === 'wrn') {
      const uid = Number(r.user_id);
      const name = await users.displayName(uid);
      lines.push(t(lang, 'lists.wrn_line', { name: iso(name), n: Number(r.n) }));
      buttons.push(btn(`⚠️ ${short(name, 24)} · ${num(lang, Number(r.n))}`, `g:${c}:W:u:${uid}`));
    } else {
      lines.push(entryLine(lang, def, r));
      buttons.push(btn(short(r.value, 28), `g:${c}:L:${code}:d:${r.id}`));
    }
  }
  const kb = pairs(buttons);
  const n = nav(`g:${c}:L:${code}:p`, Math.min(p, pages - 1), pages);
  if (n) kb.push(n);
  if (code === 'wrn') kb.push([btn(t(lang, 'lists.btn_add'), `g:${c}:L:${code}:a`), btn(t(lang, 'lists.btn_export'), `g:${c}:L:${code}:x`)]);
  else {
    kb.push([btn(t(lang, 'lists.btn_add'), `g:${c}:L:${code}:a`), btn(t(lang, 'lists.btn_search'), `g:${c}:L:${code}:s`)]);
    kb.push([btn(t(lang, 'lists.btn_export'), `g:${c}:L:${code}:x`), btn(t(lang, 'lists.btn_history'), `g:${c}:L:${code}:h`)]);
  }
  kb.push(back(lang, `g:${c}:L`));
  return screen(ctx, user.user_id, place, lines.join('\n'), kb, `list-${code}`);
}

async function historyLines(lang, rows) {
  const now = nowSec();
  const out = [];
  for (const h of rows) {
    out.push(t(lang, 'lists.h_line', { ago: dur(lang, now - Number(h.at)), action: t(lang, `lists.h_${h.action}`), value: iso(h.value || h.ekey, 40), who: await who(lang, Number(h.actor_id)) }));
  }
  return out;
}

async function entryScreen(ctx, user, g, def, id, place, notice = '') {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const e = await lists.entry(c, def.code, id);
  if (!e) return listPage(ctx, user, g, def, 0, place, t(lang, 'lists.gone'));
  const now = nowSec();
  const lines = [];
  if (notice) lines.push(notice, '');
  lines.push(t(lang, 'lists.entry_title', { icon: def.icon, name: t(lang, `lists.n_${def.code}`) }), '');
  lines.push(t(lang, 'lists.entry_value', { value: iso(e.value, 120) }));
  if (lists.isUserKind(def)) lines.push(t(lang, 'lists.entry_user', { id: `<code>${Number(e.user_id)}</code>` }));
  lines.push(t(lang, 'lists.entry_note', { note: e.note ? iso(e.note, REASON_MAX) : '—' }));
  lines.push(t(lang, 'lists.entry_added', { who: await who(lang, Number(e.added_by)), ago: dur(lang, now - Number(e.added_at)) }));
  if (Number(e.updated_at) !== Number(e.added_at)) lines.push(t(lang, 'lists.entry_updated', { who: await who(lang, Number(e.updated_by)), ago: dur(lang, now - Number(e.updated_at)) }));
  if (Number(e.expires_at)) lines.push(t(lang, 'lists.entry_expires', { time: dur(lang, Number(e.expires_at) - now) }));
  const hist = await lists.historyOf(c, def.code, e.ekey, 8);
  if (hist.length) lines.push('', t(lang, 'lists.history_title'), ...(await historyLines(lang, hist)));
  const row = [btn(t(lang, 'lists.btn_note'), `g:${c}:L:${def.code}:n:${id}`)];
  if (!lists.isUserKind(def)) row.push(btn(t(lang, 'lists.btn_value'), `g:${c}:L:${def.code}:v:${id}`));
  const kb = [row, [btn(t(lang, 'lists.btn_remove'), `g:${c}:L:${def.code}:r:${id}`)], back(lang, `g:${c}:L:${def.code}`)];
  return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'list-entry');
}

async function listHistory(ctx, user, g, def, place) {
  const lang = user.lang;
  const rows = await lists.historyOf(g.chat.chat_id, def.code, null, 15);
  const lines = [t(lang, 'lists.history_of', { icon: def.icon, name: t(lang, `lists.n_${def.code}`) }), ''];
  if (!rows.length) lines.push(t(lang, 'lists.history_empty'));
  lines.push(...(await historyLines(lang, rows)));
  return screen(ctx, user.user_id, place, lines.join('\n'), [back(lang, `g:${g.chat.chat_id}:L:${def.code}`)], 'list-history');
}

async function exportList(ctx, user, g, def) {
  const lang = user.lang;
  const c = g.chat.chat_id;
  let rows;
  if (def.code === 'wrn') {
    const w = await punish.warned(ctx, c, EXPORT_MAX_ROWS, 0);
    rows = [['user_id', 'name', 'warnings', 'last_warning_utc']];
    for (const r of w.rows) rows.push([Number(r.user_id), await users.displayName(Number(r.user_id)), Number(r.n), isoMinute(Number(r.last))]);
  } else {
    rows = [['value', 'key', 'user_id', 'note', 'added_by', 'added_at_utc', 'updated_at_utc', 'expires_at_utc']];
    for (const e of await lists.all(c, def.code, EXPORT_MAX_ROWS)) {
      rows.push([e.value, e.ekey, Number(e.user_id) || '', e.note || '', Number(e.added_by) || '', isoMinute(Number(e.added_at)), isoMinute(Number(e.updated_at)), isoMinute(Number(e.expires_at))]);
    }
  }
  await answer(ctx, t(lang, 'lists.exporting'));
  const ok = await sendCsv(ctx, user, rows, `aegis-${def.code}-${String(c).replace('-', 'm')}.csv`,
    t(lang, 'lists.export_caption', { name: t(lang, `lists.n_${def.code}`), title: title(g), n: rows.length - 1 }));
  if (ok) await audit.log(user.user_id, 'lists.export', { chatId: c, target: def.code, details: { n: rows.length - 1 } });
  return null;
}

async function askInput(ctx, user, g, kind, data, text, keyboard = null) {
  await state.set(user.user_id, kind, { chat: g.chat.chat_id, ...data });
  await answer(ctx);
  const extra = keyboard ? { reply_markup: { keyboard, resize_keyboard: true, one_time_keyboard: true } } : {};
  return send(ctx, user.user_id, text, null, `ask-${kind}`, extra);
}

async function startAdd(ctx, user, g, def) {
  const lang = user.lang;
  if (!(await needLevel(ctx, user, g, listNeed(def)))) return null;
  if (EFFECT_KIND[def.effect] && def.effect !== 'warn' && !(await needRestrict(ctx, user, g))) return null;
  if (['mute', 'restrict', 'quarantine'].includes(def.effect) && g.chat.type !== 'supergroup') {
    await answer(ctx, t(lang, 'mod.basic_group'), true);
    return null;
  }
  const name = t(lang, `lists.n_${def.code}`);
  if (lists.isUserKind(def)) {
    const timed = punish.TIMED.has(EFFECT_KIND[def.effect]);
    const keyboard = [[{ text: t(lang, 'lists.pick_users'), request_users: { request_id: 11, max_quantity: 10 } }], [{ text: t(lang, 'common.cancel') }]];
    return askInput(ctx, user, g, 'list_add', { code: def.code }, t(lang, timed ? 'lists.add_prompt_user_timed' : 'lists.add_prompt_user', { name, max: LIST_ADD_MAX_LINES }), keyboard);
  }
  return askInput(ctx, user, g, 'list_add', { code: def.code }, t(lang, `lists.add_prompt_${def.kind}`, { name, max: LIST_ADD_MAX_LINES }), [[{ text: t(lang, 'common.cancel') }]]);
}

/* One member into a user list. Gives 'added', 'updated' or { fail, name, error }. */
async function addUser(ctx, g, def, target, actorId) {
  const c = g.chat.chat_id;
  const fail = (code, name = String(target.id), error = '') => ({ fail: code, name, error });
  if (target.id === (await me(ctx)).id) return fail('bot');
  const member = await tryCall(ctx, 'getChatMember', { chat_id: c, user_id: target.id }, 'list-target');
  if (!member) return fail('unknown');
  await users.remember(member.user);
  const name = fullName(member.user) || target.name || String(target.id);
  const kind = EFFECT_KIND[def.effect];
  if ((kind || def.code === 'mod') && isAdminStatus(member.status)) return fail('admin', name);
  if (kind && target.id === actorId) return fail('self', name);
  if (kind && await lists.has(c, 'vip', String(target.id))) return fail('vip', name);
  if (kind) {
    const sec = punish.TIMED.has(kind) ? target.sec || 0 : 0;
    const res = await punish.apply(ctx, g.chat, { userId: target.id, name, kind, sec, reason: target.note, actorId, source: 'list' });
    if (!res.ok) return fail('tg', name, res.error);
    if (kind === 'ban' || kind === 'blacklist') await betrayal.after(ctx, g.chat, actorId, target.id, 'ban');
    return 'added';
  }
  const r = await lists.upsert(c, def.code, { ekey: String(target.id), value: name, userId: target.id, note: target.note }, actorId);
  return r === 'full' ? fail('full', name) : r;
}

/* The members in a list_add message: shared users, a forwarded message, or lines "id|@user [duration] [note]". */
async function targetsOf(def, message) {
  if (message.users_shared && Array.isArray(message.users_shared.users)) {
    return { targets: message.users_shared.users.map((u) => ({ id: u.user_id, name: [u.first_name, u.last_name].filter(Boolean).join(' ') || (u.username ? `@${u.username}` : '') })), bad: [] };
  }
  const o = message.forward_origin;
  if (o && o.type === 'user' && o.sender_user) return { targets: [{ id: o.sender_user.id, name: fullName(o.sender_user) }], bad: [] };
  if (o && o.type === 'hidden_user') return { targets: [], bad: [], hidden: true };
  const timed = punish.TIMED.has(EFFECT_KIND[def.effect]);
  const targets = [];
  const bad = [];
  const lines = String(message.text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const [i, line] of lines.slice(0, LIST_ADD_MAX_LINES).entries()) {
    const tokens = line.split(/\s+/);
    let id = null;
    if (/^\d{4,16}$/.test(tokens[0])) id = toInt(tokens[0]);
    else if (/^@[A-Za-z][A-Za-z0-9_]{3,31}$/.test(tokens[0])) {
      const known = await users.byUsername(tokens[0].slice(1));
      if (known) id = Number(known.user_id);
    }
    if (id === null) {
      bad.push(i + 1);
      continue;
    }
    let rest = tokens.slice(1);
    let sec = 0;
    if (timed && rest.length) {
      const d = parseDuration(rest);
      if (d && d.invalid) {
        bad.push(i + 1);
        continue;
      }
      if (d) {
        sec = d.sec;
        rest = rest.slice(d.used);
      }
    }
    const note = [...rest.join(' ')].slice(0, REASON_MAX).join('') || null;
    targets.push({ id, sec, note });
  }
  return { targets, bad, tooMany: lines.length > LIST_ADD_MAX_LINES };
}

async function addInput(ctx, user, message, data) {
  const lang = user.lang;
  const def = lists.get(data.code);
  const g = def ? await guard(ctx, user, data.chat, listNeed(def), null) : null;
  if (!g) {
    await state.clear(user.user_id);
    return null;
  }
  if (EFFECT_KIND[def.effect] && def.effect !== 'warn' && !(await needRestrict(ctx, user, g))) {
    await state.clear(user.user_id);
    return null;
  }
  const out = { added: 0, updated: 0, failed: [] };
  let bad = [];
  let tooMany = false;
  if (lists.isUserKind(def)) {
    const r = await targetsOf(def, message);
    if (r.hidden) return send(ctx, user.user_id, t(lang, 'chat.pick_hidden'), null, 'list-hidden');
    ({ bad } = r);
    tooMany = !!r.tooMany;
    if (!r.targets.length && !bad.length) return send(ctx, user.user_id, t(lang, 'lists.add_nothing'), null, 'list-add-nothing');
    for (const tg of r.targets) {
      const res = await addUser(ctx, g, def, tg, user.user_id);
      if (res === 'added') out.added += 1;
      else if (res === 'updated') out.updated += 1;
      else out.failed.push(res);
    }
  } else {
    const one = lists.entryFromMessage(def, message);
    const parsed = one ? { entries: [one], bad: [], tooMany: false } : lists.parseEntries(def.kind, message.text);
    ({ bad, tooMany } = parsed);
    if (!parsed.entries.length && !bad.length) return send(ctx, user.user_id, t(lang, 'lists.add_nothing'), null, 'list-add-nothing');
    for (const e of parsed.entries) {
      const r = await lists.upsert(g.chat.chat_id, def.code, e, user.user_id);
      if (r === 'added') out.added += 1;
      else if (r === 'updated') out.updated += 1;
      else out.failed.push({ fail: 'full', name: e.value });
    }
  }
  await state.clear(user.user_id);
  const lines = [t(lang, 'lists.add_result', { added: out.added, updated: out.updated, failed: out.failed.length + bad.length })];
  if (bad.length) lines.push(t(lang, 'lists.add_bad_lines', { lines: bad.slice(0, 15).map((n) => num(lang, n)).join(t(lang, 'common.sep')) }));
  if (tooMany) lines.push(t(lang, 'lists.add_too_many', { max: LIST_ADD_MAX_LINES }));
  for (const f of out.failed.slice(0, 10)) lines.push(t(lang, `lists.fail_${f.fail}`, { name: iso(f.name), error: iso(f.error || '', 120) }));
  await send(ctx, user.user_id, lines.join('\n'), null, 'list-add-result', removeKeyboard);
  if (out.added || out.updated) {
    await logs.post(ctx, g.chat, 'lists', t(g.chat.lang, 'logs.list_added', { who: iso(await users.displayName(user.user_id)), list: t(g.chat.lang, `lists.n_${def.code}`),
      added: out.added, updated: out.updated }));
  }
  return listPage(ctx, user, g, def, 0, null);
}

async function searchInput(ctx, user, message, data) {
  const lang = user.lang;
  const def = lists.get(data.code);
  const g = def ? await guard(ctx, user, data.chat, L.view, null) : null;
  await state.clear(user.user_id);
  if (!g) return null;
  const q = String(message.text || '').trim().slice(0, 60);
  if (!q) return send(ctx, user.user_id, t(lang, 'lists.add_nothing'), null, 'list-search-empty');
  const rows = await lists.search(g.chat.chat_id, def.code, q);
  const lines = [t(lang, 'lists.search_title', { q: iso(q, 60), n: rows.length }), ''];
  if (!rows.length) lines.push(t(lang, 'lists.search_none'));
  for (const r of rows) lines.push(entryLine(lang, def, r));
  const kb = pairs(rows.map((r) => btn(short(r.value, 28), `g:${g.chat.chat_id}:L:${def.code}:d:${r.id}`)));
  kb.push(back(lang, `g:${g.chat.chat_id}:L:${def.code}`));
  return screen(ctx, user.user_id, null, lines.join('\n'), kb, 'list-search');
}

async function noteInput(ctx, user, message, data) {
  const lang = user.lang;
  const def = lists.get(data.code);
  const g = def ? await guard(ctx, user, data.chat, listNeed(def), null) : null;
  if (!g) {
    await state.clear(user.user_id);
    return null;
  }
  const text = String(message.text || '').trim();
  if (!text) return send(ctx, user.user_id, t(lang, 'lists.note_prompt'), null, 'list-note-again');
  const note = text === '-' ? null : [...text].slice(0, REASON_MAX).join('');
  await state.clear(user.user_id);
  const ok = await lists.setNote(g.chat.chat_id, def.code, data.id, note, user.user_id);
  return entryScreen(ctx, user, g, def, data.id, null, t(lang, ok ? 'lists.note_done' : 'lists.gone'));
}

async function valueInput(ctx, user, message, data) {
  const lang = user.lang;
  const def = lists.get(data.code);
  const g = def ? await guard(ctx, user, data.chat, listNeed(def), null) : null;
  if (!g) {
    await state.clear(user.user_id);
    return null;
  }
  const e = lists.entryFromMessage(def, message) || lists.parseOne(def.kind, message.text);
  if (!e) return send(ctx, user.user_id, t(lang, 'lists.value_bad'), null, 'list-value-bad');
  const r = await lists.setValue(g.chat.chat_id, def.code, data.id, e, user.user_id);
  if (r === 'exists') return send(ctx, user.user_id, t(lang, 'lists.value_exists'), null, 'list-value-exists');
  await state.clear(user.user_id);
  return entryScreen(ctx, user, g, def, data.id, null, t(lang, r === 'ok' ? 'lists.value_done' : 'lists.gone'));
}

async function removeEntry(ctx, user, g, def, id, confirmed, place) {
  const lang = user.lang;
  const c = g.chat.chat_id;
  if (!(await needLevel(ctx, user, g, listNeed(def)))) return null;
  const kind = EFFECT_KIND[def.effect];
  if (kind && !(await needRestrict(ctx, user, g))) return null;
  const e = await lists.entry(c, def.code, id);
  if (!e) return listPage(ctx, user, g, def, 0, place, t(lang, 'lists.gone'));
  if (!confirmed) {
    const kb = [[btn(t(lang, 'lists.btn_remove_yes'), `g:${c}:L:${def.code}:ry:${id}`), btn(t(lang, 'common.back'), `g:${c}:L:${def.code}:d:${id}`)]];
    const text = [t(lang, 'lists.remove_q', { value: iso(e.value, 60), name: t(lang, `lists.n_${def.code}`) })];
    if (kind) text.push('', t(lang, `lists.remove_lifts_${kind}`));
    return screen(ctx, user.user_id, place, text.join('\n'), kb, 'list-remove?');
  }
  if (kind) {
    const r = await punish.lift(ctx, g.chat, Number(e.user_id), [kind], user.user_id);
    if (r && r.error) return screen(ctx, user.user_id, place, t(lang, 'chat.tg_error', { error: r.error }), [back(lang, `g:${c}:L:${def.code}:d:${id}`)], 'list-error');
  }
  await lists.remove(c, def.code, e.ekey, user.user_id);
  await logs.post(ctx, g.chat, 'lists', t(g.chat.lang, 'logs.list_removed', { who: iso(await users.displayName(user.user_id)), list: t(g.chat.lang, `lists.n_${def.code}`),
    value: iso(e.value, 60) }));
  return listPage(ctx, user, g, def, 0, place, t(lang, 'lists.removed', { value: iso(e.value, 60) }));
}

async function listsCallback(ctx, user, g, parts, place) {
  const lang = user.lang;
  const def = parts[3] ? lists.get(parts[3]) : null;
  if (!def) return listsHome(ctx, user, g, place);
  const action = parts[4];
  const arg = toInt(parts[5]);
  const name = t(lang, `lists.n_${def.code}`);
  if (!action) return listPage(ctx, user, g, def, 0, place);
  if (action === 'p') return listPage(ctx, user, g, def, Math.max(0, arg || 0), place);
  if (action === 'a') return startAdd(ctx, user, g, def);
  if (action === 's' && def.code !== 'wrn') return askInput(ctx, user, g, 'list_search', { code: def.code }, t(lang, 'lists.search_prompt', { name }));
  if (action === 'x') return exportList(ctx, user, g, def);
  if (action === 'h' && def.code !== 'wrn') return listHistory(ctx, user, g, def, place);
  if (def.code === 'wrn' || arg === null) return listPage(ctx, user, g, def, 0, place);
  if (action === 'd') return entryScreen(ctx, user, g, def, arg, place);
  if (action === 'n' || action === 'v') {
    if (!(await needLevel(ctx, user, g, listNeed(def)))) return null;
    if (action === 'v' && lists.isUserKind(def)) return entryScreen(ctx, user, g, def, arg, place);
    if (!(await lists.entry(g.chat.chat_id, def.code, arg))) return listPage(ctx, user, g, def, 0, place, t(lang, 'lists.gone'));
    return action === 'n'
      ? askInput(ctx, user, g, 'list_note', { code: def.code, id: arg }, t(lang, 'lists.note_prompt'))
      : askInput(ctx, user, g, 'list_value', { code: def.code, id: arg }, t(lang, 'lists.value_prompt', { name }));
  }
  if (action === 'r' || action === 'ry') return removeEntry(ctx, user, g, def, arg, action === 'ry', place);
  return listPage(ctx, user, g, def, 0, place);
}

/* ---------- punishments ---------- */

const statusOf = (r) => (r.status === 'active' && punish.isExpired(r) ? 'expired' : r.status);

/* May this person undo `row` from the panel? (Settings level, plus what the kind needs in Telegram.) */
function mayUndoHere(g, row) {
  if (g.acc.level < L.settings) return false;
  if (g.acc.level === L.creator || row.kind === 'warn') return true;
  if (row.kind === 'demote') return admins.canManageAdmins(g.acc);
  return canRestrict(g);
}

async function punishScreen(ctx, user, g, p, place, notice = '') {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const total = await punish.countAll(c);
  const pages = Math.max(1, Math.ceil(total / PUNISH_PAGE));
  const pg = Math.min(Math.max(0, p), pages - 1);
  const rows = await punish.recent(c, PUNISH_PAGE, pg * PUNISH_PAGE);
  const lines = [];
  if (notice) lines.push(notice, '');
  lines.push(t(lang, 'pun.title', { title: title(g) }), t(lang, 'pun.total', { n: total }), '');
  if (!rows.length) lines.push(t(lang, 'pun.empty'));
  const now = nowSec();
  const buttons = [];
  for (const r of rows) {
    const name = await users.displayName(Number(r.user_id));
    const sec = Number(r.until) ? Number(r.until) - Number(r.created_at) : 0;
    lines.push(t(lang, 'pun.row', {
      id: Number(r.id), icon: t(lang, `pun.icon_${r.kind}`), kind: t(lang, `pun.k_${r.kind}`), target: iso(name), actor: await who(lang, Number(r.actor_id)),
      ago: dur(lang, now - Number(r.created_at)), status: t(lang, `pun.s_${statusOf(r)}`), source: t(lang, `pun.src_${r.source}`),
    }));
    if (punish.TIMED.has(r.kind)) lines.push(t(lang, 'pun.row_time', { time: sec ? dur(lang, sec) : t(lang, 'pun.forever') }));
    if (r.reason) lines.push(t(lang, 'pun.row_reason', { reason: iso(r.reason, 100) }));
    if (punish.undoable(r)) buttons.push(btn(`↩️ #${r.id} ${short(name, 18)}`, `g:${c}:P:u:${r.id}:${pg}`));
  }
  const kb = pairs(buttons);
  const n = nav(`g:${c}:P:p`, pg, pages);
  if (n) kb.push(n);
  kb.push([btn(t(lang, 'lists.btn_export'), `g:${c}:P:x`)], back(lang, `g:${c}`));
  return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'panel-punish');
}

async function exportPunishments(ctx, user, g) {
  const c = g.chat.chat_id;
  const rows = [['id', 'kind', 'user_id', 'actor_id', 'source', 'status', 'reason', 'created_at_utc', 'until_utc', 'undone_by', 'undone_at_utc']];
  for (const r of await punish.recent(c, EXPORT_MAX_ROWS, 0)) {
    rows.push([Number(r.id), r.kind, Number(r.user_id), Number(r.actor_id) || '', r.source, statusOf(r), r.reason || '', isoMinute(Number(r.created_at)),
      isoMinute(Number(r.until)), Number(r.undone_by) || '', isoMinute(Number(r.undone_at))]);
  }
  await answer(ctx, t(user.lang, 'lists.exporting'));
  await sendCsv(ctx, user, rows, `aegis-punishments-${String(c).replace('-', 'm')}.csv`, t(user.lang, 'pun.export_caption', { title: title(g), n: rows.length - 1 }));
  await audit.log(user.user_id, 'punish.export', { chatId: c, details: { n: rows.length - 1 } });
  return null;
}

async function punishCallback(ctx, user, g, parts, place) {
  const lang = user.lang;
  const action = parts[3];
  if (action === 'x') return exportPunishments(ctx, user, g);
  if (action === 'p') return punishScreen(ctx, user, g, toInt(parts[4]) || 0, place);
  if (action !== 'u') return punishScreen(ctx, user, g, 0, place);
  const id = toInt(parts[4]);
  const pg = toInt(parts[5]) || 0;
  const row = id ? await punish.get(id) : null;
  if (!row || Number(row.chat_id) !== Number(g.chat.chat_id)) return punishScreen(ctx, user, g, pg, place, t(lang, 'pun.undo_gone'));
  if (!(await needLevel(ctx, user, g, L.settings))) return null;
  if (!mayUndoHere(g, row)) {
    await answer(ctx, t(lang, 'pun.undo_denied'), true);
    return null;
  }
  const r = await punish.undo(ctx, g.chat, id, user.user_id);
  let msg;
  if (r === 'ok') msg = t(lang, 'pun.undone_panel', { id, kind: t(lang, `pun.k_${row.kind}`), target: iso(await users.displayName(Number(row.user_id))) });
  else if (r && r.error) msg = t(lang, 'pun.undo_failed', { error: iso(r.error, 120) });
  else msg = t(lang, r === 'not_undoable' ? 'pun.undo_kick' : 'pun.undo_not_active');
  return punishScreen(ctx, user, g, pg, place, msg);
}

/* ---------- warnings and steps ---------- */

function stepLines(lang, ladder) {
  return ladder.map((st) => t(lang, 'warns.step_line', { n: st.n, icon: t(lang, `pun.icon_${st.a}`), kind: t(lang, `pun.k_${st.a}`),
    time: st.a === 'kick' ? '—' : (st.d ? dur(lang, st.d) : t(lang, 'pun.forever')) }));
}

async function warnsScreen(ctx, user, g, place, notice = '') {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const s = await settings.all(ctx, c);
  const ttl = Number(s.warn_ttl);
  const warned = (await punish.warned(ctx, c, 1, 0)).total;
  const lines = [];
  if (notice) lines.push(notice, '');
  lines.push(t(lang, 'warns.title', { title: title(g) }), t(lang, 'warns.intro'), '');
  lines.push(t(lang, 'warns.ttl', { time: ttl ? dur(lang, ttl) : t(lang, 'warns.never') }));
  lines.push(t(lang, 'warns.reset', { state: onOff(lang, settings.flag(s, 'warn_reset')) }));
  lines.push(t(lang, 'warns.notify', { state: onOff(lang, settings.flag(s, 'notify')) }));
  lines.push('', t(lang, 'warns.steps_title'), ...stepLines(lang, settings.steps(s)));
  if (settings.flag(s, 'audit')) lines.push('', t(lang, 'warns.audit_note'));
  const kb = [
    [btn(t(lang, 'warns.btn_ttl', { time: ttl ? dur(lang, ttl) : t(lang, 'warns.never') }), `g:${c}:W:t`), btn(t(lang, 'warns.btn_reset', { state: onOff(lang, settings.flag(s, 'warn_reset')) }), `g:${c}:W:r`)],
    [btn(t(lang, 'warns.btn_steps'), `g:${c}:W:s`), btn(t(lang, 'warns.btn_default'), `g:${c}:W:sd`)],
    [btn(t(lang, 'warns.btn_notify', { state: onOff(lang, settings.flag(s, 'notify')) }), `g:${c}:W:n`)],
    [btn(t(lang, 'warns.btn_warned', { n: warned }), `g:${c}:L:wrn`)],
    back(lang, `g:${c}`),
  ];
  return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'panel-warns');
}

async function memberWarns(ctx, user, g, uid, place, notice = '') {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const s = await settings.all(ctx, c);
  const ladder = settings.steps(s);
  const name = await users.displayName(uid);
  const n = await punish.warnCount(ctx, c, uid);
  const rows = await punish.warningsOf(c, uid, 15);
  const now = nowSec();
  const lines = [];
  if (notice) lines.push(notice, '');
  lines.push(t(lang, 'warns.member_title', { name: iso(name), n, max: ladder[ladder.length - 1].n }), '');
  if (!rows.length) lines.push(t(lang, 'warns.member_none'));
  for (const r of rows) {
    lines.push(t(lang, 'warns.member_line', { ago: dur(lang, now - Number(r.created_at)), who: await who(lang, Number(r.actor_id)),
      reason: r.reason ? iso(r.reason, 80) : '—', status: t(lang, `pun.s_${statusOf(r)}`) }));
  }
  const kb = [];
  if (n) kb.push([btn(t(lang, 'warns.btn_remove_last'), `g:${c}:W:m:${uid}`), btn(t(lang, 'warns.btn_clear'), `g:${c}:W:c:${uid}`)]);
  kb.push(back(lang, `g:${c}:L:wrn`));
  return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'panel-member-warns');
}

async function warnsCallback(ctx, user, g, parts, place) {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const action = parts[3];
  const uid = toInt(parts[4]);
  if (!action) return warnsScreen(ctx, user, g, place);
  if (action === 'u' && uid) return memberWarns(ctx, user, g, uid, place);
  if (!(await needLevel(ctx, user, g, L.settings))) return null;
  const s = await settings.all(ctx, c);
  if (action === 't') {
    const i = settings.WARN_TTLS.indexOf(Number(s.warn_ttl));
    const next = settings.WARN_TTLS[(i + 1) % settings.WARN_TTLS.length];
    await settings.set(ctx, c, 'warn_ttl', String(next), user.user_id);
    await logSetting(ctx, g, user, t(g.chat.lang, 'logs.s_warn_ttl', { time: next ? dur(g.chat.lang, next) : t(g.chat.lang, 'warns.never') }));
    return warnsScreen(ctx, user, g, place);
  }
  if (action === 'r' || action === 'n') {
    const key = action === 'r' ? 'warn_reset' : 'notify';
    const on = await settings.toggle(ctx, c, key, user.user_id);
    await logSetting(ctx, g, user, t(g.chat.lang, `logs.s_${key}`, { state: onOff(g.chat.lang, on) }));
    return warnsScreen(ctx, user, g, place);
  }
  if (action === 's') {
    return askInput(ctx, user, g, 'steps', {}, [t(lang, 'warns.steps_prompt'), '', t(lang, 'warns.steps_current'), ...stepLines(lang, settings.steps(s))].join('\n'));
  }
  if (action === 'sd') {
    await settings.set(ctx, c, 'steps', JSON.stringify(DEFAULT_STEPS), user.user_id);
    await logSetting(ctx, g, user, t(g.chat.lang, 'logs.s_steps'));
    return warnsScreen(ctx, user, g, place, t(lang, 'warns.steps_done'));
  }
  if (!uid) return warnsScreen(ctx, user, g, place);
  const name = await users.displayName(uid);
  if (action === 'm') {
    const r = await punish.removeLastWarning(ctx, g.chat, uid, user.user_id);
    return memberWarns(ctx, user, g, uid, place, t(lang, r === 'ok' ? 'warns.removed_last' : 'warns.member_none', { name: iso(name) }));
  }
  if (action === 'c') {
    const kb = [[btn(t(lang, 'warns.btn_clear_yes'), `g:${c}:W:cy:${uid}`), btn(t(lang, 'common.back'), `g:${c}:W:u:${uid}`)]];
    return screen(ctx, user.user_id, place, t(lang, 'warns.clear_q', { name: iso(name) }), kb, 'warns-clear?');
  }
  if (action === 'cy') {
    const n = await punish.clearWarnings(ctx, g.chat, uid, user.user_id);
    return memberWarns(ctx, user, g, uid, place, t(lang, 'warns.cleared', { name: iso(name), n }));
  }
  return warnsScreen(ctx, user, g, place);
}

async function stepsInput(ctx, user, message, data) {
  const lang = user.lang;
  const g = await guard(ctx, user, data.chat, L.settings, null);
  if (!g) {
    await state.clear(user.user_id);
    return null;
  }
  const r = parseSteps(message.text);
  if (r.error) return send(ctx, user.user_id, t(lang, `warns.steps_err_${r.error}`, { line: r.line }), null, 'steps-bad');
  await state.clear(user.user_id);
  await settings.set(ctx, g.chat.chat_id, 'steps', JSON.stringify(r.steps), user.user_id);
  await logSetting(ctx, g, user, t(g.chat.lang, 'logs.s_steps'));
  return warnsScreen(ctx, user, g, null, t(lang, 'warns.steps_done'));
}

/* ---------- anti-betrayal ---------- */

async function betrayScreen(ctx, user, g, place, notice = '') {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const s = await settings.all(ctx, c);
  const lines = [];
  if (notice) lines.push(notice, '');
  lines.push(t(lang, 'betray.panel_title', { title: title(g) }), t(lang, 'betray.panel_intro'), '');
  lines.push(t(lang, 'betray.p_state', { state: onOff(lang, settings.flag(s, 'betray_on')) }));
  lines.push(t(lang, 'betray.p_rule', { n: Number(s.betray_n), time: dur(lang, Number(s.betray_sec)) }));
  lines.push(t(lang, 'betray.p_action', { action: t(lang, `betray.a_${s.betray_action}`) }));
  if (settings.flag(s, 'audit')) lines.push(t(lang, 'betray.p_audit'));
  lines.push('', t(lang, 'betray.p_limits'));
  const incidents = await betrayal.recent(c, 5);
  const kb = [
    [btn(t(lang, 'betray.btn_state', { state: onOff(lang, settings.flag(s, 'betray_on')) }), `g:${c}:B:o`)],
    [btn(t(lang, 'betray.btn_n', { n: Number(s.betray_n) }), `g:${c}:B:n`), btn(t(lang, 'betray.btn_window', { time: dur(lang, Number(s.betray_sec)) }), `g:${c}:B:w`)],
    [btn(t(lang, 'betray.btn_action', { action: t(lang, `betray.a_${s.betray_action}`) }), `g:${c}:B:a`)],
  ];
  if (incidents.length) {
    lines.push('', t(lang, 'betray.p_incidents'));
    const now = nowSec();
    for (const inc of incidents) {
      lines.push(t(lang, 'betray.p_incident', { ago: dur(lang, now - Number(inc.at)), name: await who(lang, Number(inc.actor_id)), n: Number(inc.count),
        action: t(lang, `betray.short_${inc.action}`) }));
    }
    for (const inc of incidents.slice(0, 3)) {
      const b = betrayal.buttons(lang, inc);
      if (b) kb.push(...b);
    }
  }
  kb.push(back(lang, `g:${c}`));
  return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'panel-betrayal');
}

async function betrayCallback(ctx, user, g, parts, place) {
  const c = g.chat.chat_id;
  const action = parts[3];
  if (!action) return betrayScreen(ctx, user, g, place);
  if (!(await needLevel(ctx, user, g, L.full))) return null;
  const s = await settings.all(ctx, c);
  const cycle = (list, cur) => list[(list.indexOf(Number(cur)) + 1) % list.length];
  const lc = g.chat.lang;
  if (action === 'o') {
    const on = await settings.toggle(ctx, c, 'betray_on', user.user_id);
    await logSetting(ctx, g, user, t(lc, 'logs.s_betray_on', { state: onOff(lc, on) }));
    if (!on) await tellCreator(ctx, g, user, 'betray.creator_off');
  } else if (action === 'n') {
    const n = cycle(settings.BETRAY_NS, s.betray_n);
    await settings.set(ctx, c, 'betray_n', String(n), user.user_id);
    await logSetting(ctx, g, user, t(lc, 'logs.s_betray_rule', { n, time: dur(lc, Number(s.betray_sec)) }));
  } else if (action === 'w') {
    const sec = cycle(settings.BETRAY_SECS, s.betray_sec);
    await settings.set(ctx, c, 'betray_sec', String(sec), user.user_id);
    await logSetting(ctx, g, user, t(lc, 'logs.s_betray_rule', { n: Number(s.betray_n), time: dur(lc, sec) }));
  } else if (action === 'a') {
    const next = s.betray_action === 'demote' ? 'alert' : 'demote';
    await settings.set(ctx, c, 'betray_action', next, user.user_id);
    await logSetting(ctx, g, user, t(lc, 'logs.s_betray_action', { action: t(lc, `betray.a_${next}`) }));
  }
  return betrayScreen(ctx, user, g, place);
}

/* ---------- Audit Mode ---------- */

async function auditCallback(ctx, user, g, parts, place) {
  const lang = user.lang;
  const c = g.chat.chat_id;
  if (parts[3] === 'y') {
    if (!(await needLevel(ctx, user, g, L.full))) return null;
    const on = await settings.toggle(ctx, c, 'audit', user.user_id);
    await logSetting(ctx, g, user, t(g.chat.lang, 'logs.s_audit', { state: onOff(g.chat.lang, on) }));
    if (on) await tellCreator(ctx, g, user, 'audit.creator_on');
  }
  const on = settings.flag(await settings.all(ctx, c), 'audit');
  const lines = [t(lang, 'audit.title', { title: title(g) }), '', t(lang, 'audit.body'), '', t(lang, on ? 'audit.state_on' : 'audit.state_off')];
  const kb = [[btn(t(lang, on ? 'audit.btn_off' : 'audit.btn_on'), `g:${c}:U:y`)], back(lang, `g:${c}`)];
  return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'panel-audit');
}

/* ---------- log channel ---------- */

async function chatLabel(ctx, id) {
  const ch = await tryCall(ctx, 'getChat', { chat_id: id }, 'log-chat');
  if (!ch) return String(id);
  return ch.title || (ch.username ? `@${ch.username}` : String(id));
}

async function logsScreen(ctx, user, g, place, notice = '') {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const s = await settings.all(ctx, c);
  const set = s.log_chat !== '0';
  const lines = [];
  if (notice) lines.push(notice, '');
  lines.push(t(lang, 'logs.panel_title', { title: title(g) }), t(lang, 'logs.panel_intro'), '');
  lines.push(set ? t(lang, 'logs.current', { name: iso(await chatLabel(ctx, Number(s.log_chat)), 48) }) : t(lang, 'logs.none'));
  lines.push(t(lang, 'logs.state', { state: onOff(lang, settings.flag(s, 'log_on')) }));
  for (const cat of logs.CATEGORIES) lines.push(t(lang, 'logs.cat_line', { mark: settings.flag(s, `log_${cat}`) ? '✅' : '▫️', name: t(lang, `logs.c_${cat}`) }));
  const kb = [[btn(t(lang, set ? 'logs.btn_change' : 'logs.btn_set'), `g:${c}:O:s`)]];
  if (set) kb[0].push(btn(t(lang, 'logs.btn_remove'), `g:${c}:O:d`));
  kb.push([btn(t(lang, 'logs.btn_state', { state: onOff(lang, settings.flag(s, 'log_on')) }), `g:${c}:O:o`)]);
  kb.push(...pairs(logs.CATEGORIES.map((cat) => btn(`${settings.flag(s, `log_${cat}`) ? '✅' : '▫️'} ${t(lang, `logs.c_${cat}`)}`, `g:${c}:O:c:${cat}`))));
  if (set) kb.push([btn(t(lang, 'logs.btn_test'), `g:${c}:O:t`)]);
  kb.push(back(lang, `g:${c}`));
  return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'panel-logs');
}

async function logsCallback(ctx, user, g, parts, place) {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const action = parts[3];
  if (!action) return logsScreen(ctx, user, g, place);
  if (!(await needLevel(ctx, user, g, L.full))) return null;
  const s = await settings.all(ctx, c);
  const lc = g.chat.lang;
  if (action === 's') {
    const keyboard = [
      [{ text: t(lang, 'logs.pick_channel'), request_chat: { request_id: 21, chat_is_channel: true, bot_is_member: true } }],
      [{ text: t(lang, 'logs.pick_group'), request_chat: { request_id: 22, chat_is_channel: false, bot_is_member: true } }],
      [{ text: t(lang, 'common.cancel') }],
    ];
    return askInput(ctx, user, g, 'log_set', {}, t(lang, 'logs.set_prompt'), keyboard);
  }
  if (action === 'd' && s.log_chat !== '0') {
    await logSetting(ctx, g, user, t(lc, 'logs.s_removed'));
    await settings.set(ctx, c, 'log_chat', '0', user.user_id);
    return logsScreen(ctx, user, g, place, t(lang, 'logs.removed'));
  }
  if (action === 'o') {
    const on = await settings.toggle(ctx, c, 'log_on', user.user_id);
    if (on) await logSetting(ctx, g, user, t(lc, 'logs.s_on'));
    return logsScreen(ctx, user, g, place);
  }
  if (action === 'c' && logs.CATEGORIES.includes(parts[4])) {
    const on = await settings.toggle(ctx, c, `log_${parts[4]}`, user.user_id);
    await logSetting(ctx, g, user, t(lc, 'logs.s_category', { name: t(lc, `logs.c_${parts[4]}`), state: onOff(lc, on) }));
    return logsScreen(ctx, user, g, place);
  }
  if (action === 't' && s.log_chat !== '0') {
    const ok = await send(ctx, Number(s.log_chat), t(lc, 'logs.test', { title: title(g) }), null, 'log-test');
    await answer(ctx, t(lang, ok ? 'logs.test_ok' : 'logs.test_failed'), !ok);
    return null;
  }
  return logsScreen(ctx, user, g, place);
}

/* The log channel in a log_set message: a picked chat, a forwarded channel post, @username or -100… id. */
export async function logChatOf(ctx, message) {
  if (message.chat_shared && message.chat_shared.chat_id) return message.chat_shared.chat_id;
  const o = message.forward_origin;
  if (o && (o.type === 'channel' || o.type === 'chat') && (o.chat || o.sender_chat)) return (o.chat || o.sender_chat).id;
  const text = String(message.text || '').trim();
  if (/^-100\d{6,16}$/.test(text)) return toInt(text);
  const m = /^(?:https?:\/\/)?(?:t\.me\/|@)([A-Za-z][A-Za-z0-9_]{3,31})\/?$/.exec(text);
  if (m) {
    const ch = await tryCall(ctx, 'getChat', { chat_id: `@${m[1]}` }, 'log-resolve');
    return ch ? ch.id : null;
  }
  return null;
}

async function logSetInput(ctx, user, message, data) {
  const lang = user.lang;
  const id = await logChatOf(ctx, message);
  if (!id) return send(ctx, user.user_id, t(lang, 'logs.set_bad'), null, 'log-set-bad');
  const g = await guard(ctx, user, data.chat, L.full, null);
  if (!g) {
    await state.clear(user.user_id);
    return null;
  }
  const c = g.chat.chat_id;
  const fail = (key) => send(ctx, user.user_id, t(lang, key), null, 'log-set-fail');
  if (id === c) return fail('logs.same_chat');
  const bot = await me(ctx);
  const botMember = await tryCall(ctx, 'getChatMember', { chat_id: id, user_id: bot.id }, 'log-bot');
  const target = await tryCall(ctx, 'getChat', { chat_id: id }, 'log-chat');
  if (!botMember || !target) return fail('logs.bot_not_there');
  const canPost = target.type === 'channel'
    ? botMember.status === 'administrator' && botMember.can_post_messages === true
    : ['administrator', 'member'].includes(botMember.status) || (botMember.status === 'restricted' && botMember.can_send_messages === true);
  if (!canPost) return fail(target.type === 'channel' ? 'logs.bot_cant_post_channel' : 'logs.bot_not_there');
  const mine = await tryCall(ctx, 'getChatMember', { chat_id: id, user_id: user.user_id }, 'log-user');
  if (!mine || !isAdminStatus(mine.status)) return fail('logs.not_admin_there');
  const ok = await send(ctx, id, t(g.chat.lang, 'logs.connected', { title: title(g) }), null, 'log-connected');
  if (!ok) return fail('logs.test_failed');
  await state.clear(user.user_id);
  await settings.set(ctx, c, 'log_chat', String(id), user.user_id);
  await logSetting(ctx, g, user, t(g.chat.lang, 'logs.s_set', { name: iso(target.title || String(id), 48) }));
  await send(ctx, user.user_id, t(lang, 'logs.set_done', { name: iso(target.title || String(id), 48) }), null, 'log-set-done', removeKeyboard);
  return logsScreen(ctx, user, g, null);
}

/* ---------- entry points ---------- */

export async function callback(ctx, user, g, parts, place) {
  switch (parts[2]) {
    case 'L': return listsCallback(ctx, user, g, parts, place);
    case 'P': return punishCallback(ctx, user, g, parts, place);
    case 'W': return warnsCallback(ctx, user, g, parts, place);
    case 'B': return betrayCallback(ctx, user, g, parts, place);
    case 'U': return auditCallback(ctx, user, g, parts, place);
    default: return logsCallback(ctx, user, g, parts, place);
  }
}

/* A pending panel input (INPUTS). The cancel button (or /cancel in the router) ends it. */
export async function input(ctx, user, message, pending) {
  const text = String(message.text || '').trim();
  if (text && normalizeWord(text) === normalizeWord(t(user.lang, 'common.cancel'))) {
    await state.clear(user.user_id);
    return send(ctx, user.user_id, t(user.lang, 'common.cancelled'), null, 'input-cancelled', removeKeyboard);
  }
  const d = pending.data;
  if (pending.kind === 'list_add') return addInput(ctx, user, message, d);
  if (pending.kind === 'list_search') return searchInput(ctx, user, message, d);
  if (pending.kind === 'list_note') return noteInput(ctx, user, message, d);
  if (pending.kind === 'list_value') return valueInput(ctx, user, message, d);
  if (pending.kind === 'steps') return stepsInput(ctx, user, message, d);
  return logSetInput(ctx, user, message, d);
}
