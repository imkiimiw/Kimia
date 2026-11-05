/*
 * The panel's 🌐 Federation section: create one, join one with its code, or — inside one — its
 * groups, admins, bans (with unban and CSV export), join code, rename, leave, delete.
 * Creating, joining and leaving need Full access in this group (or being its creator). Managing
 * the federation (admins, code, rename, delete) is for its owner; fed admins may unban here.
 * Leaving or deleting asks first.
 *
 * callback_data (chat id c):
 *   g:c:F                     overview                    g:c:F:n / j        create / join (input)
 *   g:c:F:b[:p]               fed bans, page p            g:c:F:u:u          unban u everywhere
 *   g:c:F:x                   export bans (CSV)           g:c:F:g            member groups
 *   g:c:F:a                   fed admins                  g:c:F:a:n / a:r:u  add (input) / remove
 *   g:c:F:rn                  rename (input)              g:c:F:code         new join code
 *   g:c:F:l → l:y             leave                       g:c:F:d → d:y      delete
 * Pending inputs: fed_name, fed_join, fed_rename, fed_admin { chat }.
 */
import { InputFile } from 'sdk';
import { EXPORT_MAX_ROWS, FED_BAN_PAGE, FED_MAX_CHATS, FED_NAME_MAX } from '../config.js';
import { csv, fullName, iso, isoMinute, normalizeWord, nowSec, short, toInt, utf8Bytes } from '../core/util.js';
import * as state from '../core/state.js';
import { answer, btn, call, describeError, screen, send, tryCall } from '../core/tg.js';
import * as admins from '../engines/admins.js';
import * as feds from '../engines/feds.js';
import * as users from '../engines/users.js';
import { dur, t } from '../i18n/index.js';
import { back, guard, needLevel, pairs, removeKeyboard } from './guard.js';

const { L } = admins;
export const INPUTS = new Set(['fed_name', 'fed_join', 'fed_rename', 'fed_admin']);
export const KEYBOARD_INPUTS = new Set(['fed_admin']);
const title = (g) => iso(g.chat.title || '', 48);

async function overview(ctx, user, g, place, notice = '') {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const fed = await feds.ofChat(c);
  const lines = [];
  if (notice) lines.push(notice, '');
  if (!fed) {
    lines.push(t(lang, 'fed.none_title', { title: title(g) }), '', t(lang, 'fed.none_intro'));
    const kb = [[btn(t(lang, 'fed.btn_create'), `g:${c}:F:n`), btn(t(lang, 'fed.btn_join'), `g:${c}:F:j`)], back(lang, `g:${c}`)];
    return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'panel-fed-none');
  }
  const owner = Number(fed.owner_id) === user.user_id;
  const banCount = (await feds.bans(fed.id, 0)).total;
  lines.push(t(lang, 'fed.title', { name: iso(fed.name) }), '');
  lines.push(t(lang, 'fed.owner', { name: iso(await users.displayName(Number(fed.owner_id))) }));
  lines.push(t(lang, 'fed.counts', { chats: await feds.chatCount(fed.id), max: FED_MAX_CHATS, admins: (await feds.admins(fed.id)).length, bans: banCount }));
  if (owner) lines.push('', t(lang, 'fed.code', { code: `<code>${fed.code}</code>` }), t(lang, 'fed.code_hint'));
  lines.push('', t(lang, 'fed.how'));
  const kb = [[btn(t(lang, 'fed.btn_bans', { n: banCount }), `g:${c}:F:b`), btn(t(lang, 'fed.btn_groups'), `g:${c}:F:g`)],
    [btn(t(lang, 'fed.btn_admins'), `g:${c}:F:a`)]];
  if (owner) kb.push([btn(t(lang, 'fed.btn_rename'), `g:${c}:F:rn`), btn(t(lang, 'fed.btn_code'), `g:${c}:F:code`)]);
  kb.push([btn(t(lang, 'fed.btn_leave'), `g:${c}:F:l`)]);
  if (owner) kb.push([btn(t(lang, 'fed.btn_delete'), `g:${c}:F:d`)]);
  kb.push(back(lang, `g:${c}`));
  return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'panel-fed');
}

async function bansScreen(ctx, user, g, fed, p, place, notice = '') {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const { rows, total } = await feds.bans(fed.id, p);
  const pages = Math.max(1, Math.ceil(total / FED_BAN_PAGE));
  const canUnban = await feds.isAdmin(fed, user.user_id);
  const now = nowSec();
  const lines = [];
  if (notice) lines.push(notice, '');
  lines.push(t(lang, 'fed.bans_title', { name: iso(fed.name), n: total }), '');
  if (!rows.length) lines.push(t(lang, 'fed.bans_none'));
  const buttons = [];
  for (const r of rows) {
    const nm = r.name || await users.displayName(Number(r.user_id));
    lines.push(t(lang, 'fed.ban_line', { name: iso(nm), id: `<code>${Number(r.user_id)}</code>`, reason: r.reason ? iso(r.reason, 80) : '—',
      who: iso(await users.displayName(Number(r.by_id))), ago: dur(lang, now - Number(r.at)) }));
    if (canUnban) buttons.push(btn(`♻️ ${short(nm, 22)}`, `g:${c}:F:u:${Number(r.user_id)}`));
  }
  const kb = pairs(buttons);
  if (pages > 1) {
    const nav = [];
    if (p > 0) nav.push(btn('◀️', `g:${c}:F:b:${p - 1}`));
    nav.push(btn(`${p + 1}/${pages}`, `g:${c}:F:b:${p}`));
    if (p < pages - 1) nav.push(btn('▶️', `g:${c}:F:b:${p + 1}`));
    kb.push(nav);
  }
  kb.push([btn(t(lang, 'lists.btn_export'), `g:${c}:F:x`)], back(lang, `g:${c}:F`));
  return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'panel-fed-bans');
}

async function groupsScreen(ctx, user, g, fed, place) {
  const lang = user.lang;
  const list = await feds.chats(fed.id);
  const lines = [t(lang, 'fed.groups_title', { name: iso(fed.name), n: list.length }), ''];
  for (const r of list) lines.push(t(lang, 'fed.group_line', { title: iso(r.title || String(r.chat_id), 40) }));
  return screen(ctx, user.user_id, place, lines.join('\n'), [back(lang, `g:${g.chat.chat_id}:F`)], 'panel-fed-groups');
}

async function adminsScreen(ctx, user, g, fed, place, notice = '') {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const owner = Number(fed.owner_id) === user.user_id;
  const list = await feds.admins(fed.id);
  const lines = [];
  if (notice) lines.push(notice, '');
  lines.push(t(lang, 'fed.admins_title', { name: iso(fed.name) }), '', t(lang, 'fed.admin_owner', { name: iso(await users.displayName(Number(fed.owner_id))) }));
  const buttons = [];
  for (const r of list) {
    const nm = await users.displayName(Number(r.user_id));
    lines.push(t(lang, 'fed.admin_line', { name: iso(nm) }));
    if (owner) buttons.push(btn(`❌ ${short(nm, 22)}`, `g:${c}:F:a:r:${Number(r.user_id)}`));
  }
  if (!list.length) lines.push(t(lang, 'fed.admins_none'));
  const kb = pairs(buttons);
  if (owner) kb.push([btn(t(lang, 'fed.btn_admin_add'), `g:${c}:F:a:n`)]);
  kb.push(back(lang, `g:${c}:F`));
  return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'panel-fed-admins');
}

async function exportBans(ctx, user, g, fed) {
  const rows = [['user_id', 'name', 'reason', 'banned_by', 'banned_at_utc']];
  for (const r of await feds.allBans(fed.id, EXPORT_MAX_ROWS)) rows.push([Number(r.user_id), r.name || '', r.reason || '', Number(r.by_id), isoMinute(Number(r.at))]);
  await answer(ctx, t(user.lang, 'lists.exporting'));
  try {
    await call(ctx, 'sendDocument', { chat_id: user.user_id, document: new InputFile(utf8Bytes(csv(rows)), `aegis-fed-${fed.id}-bans.csv`, { type: 'text/csv' }),
      caption: t(user.lang, 'fed.export_caption', { name: iso(fed.name), n: rows.length - 1 }) }, 'fed-export');
  } catch (err) {
    await send(ctx, user.user_id, t(user.lang, 'chat.tg_error', { error: describeError(err) }), null, 'fed-export-error');
  }
  return null;
}

async function ask(ctx, user, g, kind, key, vars = {}, keyboard = null) {
  await state.set(user.user_id, kind, { chat: g.chat.chat_id });
  await answer(ctx);
  const extra = keyboard ? { reply_markup: { keyboard, resize_keyboard: true, one_time_keyboard: true } } : {};
  return send(ctx, user.user_id, t(user.lang, key, vars), null, `ask-${kind}`, extra);
}

export async function callback(ctx, user, g, parts, place) {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const sub = parts[3];
  const fed = await feds.ofChat(c);
  if (!sub) return overview(ctx, user, g, place);
  if (!fed) {
    if (sub !== 'n' && sub !== 'j') return overview(ctx, user, g, place);
    if (!(await needLevel(ctx, user, g, L.full))) return null;
    return sub === 'n' ? ask(ctx, user, g, 'fed_name', 'fed.name_prompt', { max: FED_NAME_MAX }) : ask(ctx, user, g, 'fed_join', 'fed.join_prompt');
  }
  const owner = Number(fed.owner_id) === user.user_id;
  if (sub === 'b') return bansScreen(ctx, user, g, fed, Math.max(0, toInt(parts[4]) || 0), place);
  if (sub === 'g') return groupsScreen(ctx, user, g, fed, place);
  if (sub === 'x') return exportBans(ctx, user, g, fed);
  if (sub === 'u') {
    if (!(await feds.isAdmin(fed, user.user_id))) {
      await answer(ctx, t(lang, 'fed.not_fed_admin'), true);
      return null;
    }
    const uid = toInt(parts[4]);
    if (uid && await feds.unban(fed, uid, user.user_id, c)) {
      for (const fc of await feds.chats(fed.id)) await tryCall(ctx, 'unbanChatMember', { chat_id: Number(fc.chat_id), user_id: uid, only_if_banned: true }, 'fed-unban-all');
    }
    return bansScreen(ctx, user, g, fed, 0, place, t(lang, 'fed.unbanned', { name: iso(await users.displayName(uid)) }));
  }
  if (sub === 'a') {
    if (parts[4] === 'n' || parts[4] === 'r') {
      if (!owner) {
        await answer(ctx, t(lang, 'fed.owner_only'), true);
        return null;
      }
      if (parts[4] === 'r') {
        await feds.removeAdmin(fed, toInt(parts[5]), user.user_id, c);
        return adminsScreen(ctx, user, g, fed, place);
      }
      const keyboard = [[{ text: t(lang, 'lists.pick_users'), request_users: { request_id: 41, max_quantity: 1 } }], [{ text: t(lang, 'common.cancel') }]];
      return ask(ctx, user, g, 'fed_admin', 'fed.admin_prompt', { name: iso(fed.name) }, keyboard);
    }
    return adminsScreen(ctx, user, g, fed, place);
  }
  if (sub === 'rn' || sub === 'code' || sub === 'd') {
    if (!owner) {
      await answer(ctx, t(lang, 'fed.owner_only'), true);
      return null;
    }
    if (sub === 'rn') return ask(ctx, user, g, 'fed_rename', 'fed.name_prompt', { max: FED_NAME_MAX });
    if (sub === 'code') {
      await feds.newJoinCode(fed, user.user_id, c);
      return overview(ctx, user, g, place, t(lang, 'fed.code_new'));
    }
    if (parts[4] !== 'y') {
      const kb = [[btn(t(lang, 'fed.btn_delete_yes'), `g:${c}:F:d:y`), btn(t(lang, 'common.back'), `g:${c}:F`)]];
      return screen(ctx, user.user_id, place, t(lang, 'fed.delete_q', { name: iso(fed.name) }), kb, 'fed-delete?');
    }
    await feds.remove(fed, user.user_id, c);
    return overview(ctx, user, g, place, t(lang, 'fed.deleted', { name: iso(fed.name) }));
  }
  if (sub === 'l') {
    if (!(await needLevel(ctx, user, g, L.full))) return null;
    if (parts[4] !== 'y') {
      const kb = [[btn(t(lang, 'fed.btn_leave_yes'), `g:${c}:F:l:y`), btn(t(lang, 'common.back'), `g:${c}:F`)]];
      return screen(ctx, user.user_id, place, t(lang, 'fed.leave_q', { name: iso(fed.name), title: title(g) }), kb, 'fed-leave?');
    }
    await feds.leave(c, user.user_id);
    return overview(ctx, user, g, place, t(lang, 'fed.left', { name: iso(fed.name) }));
  }
  return overview(ctx, user, g, place);
}

/* ---------- inputs ---------- */

export async function input(ctx, user, message, pending) {
  const lang = user.lang;
  const text = String(message.text || '').trim();
  if (text && normalizeWord(text) === normalizeWord(t(lang, 'common.cancel'))) {
    await state.clear(user.user_id);
    return send(ctx, user.user_id, t(lang, 'common.cancelled'), null, 'input-cancelled', removeKeyboard);
  }
  const need = pending.kind === 'fed_admin' || pending.kind === 'fed_rename' ? L.view : L.full;
  const g = await guard(ctx, user, pending.data.chat, need, null);
  if (!g) {
    await state.clear(user.user_id);
    return null;
  }
  const c = g.chat.chat_id;
  const fed = await feds.ofChat(c);
  if (pending.kind === 'fed_name' || pending.kind === 'fed_rename') {
    if (!text || [...text].length > FED_NAME_MAX) return send(ctx, user.user_id, t(lang, 'fed.name_prompt', { max: FED_NAME_MAX }), null, 'fed-name-again');
    await state.clear(user.user_id);
    if (pending.kind === 'fed_name') {
      if (fed) return overview(ctx, user, g, null);
      const made = await feds.create(text, user.user_id, c);
      return overview(ctx, user, g, null, t(lang, 'fed.created', { name: iso(made.name) }));
    }
    if (!fed || Number(fed.owner_id) !== user.user_id) return overview(ctx, user, g, null);
    await feds.rename(fed, text, user.user_id, c);
    return overview(ctx, user, g, null, t(lang, 'fed.renamed'));
  }
  if (pending.kind === 'fed_join') {
    const target = await feds.byCode(text);
    if (!target) return send(ctx, user.user_id, t(lang, 'fed.join_bad'), null, 'fed-join-bad');
    await state.clear(user.user_id);
    const r = await feds.join(Number(target.id), c, user.user_id);
    return overview(ctx, user, g, null, t(lang, `fed.join_${r}`, { name: iso(target.name) }));
  }
  /* fed_admin */
  if (!fed || Number(fed.owner_id) !== user.user_id) {
    await state.clear(user.user_id);
    return overview(ctx, user, g, null);
  }
  let id = null;
  if (message.users_shared && Array.isArray(message.users_shared.users) && message.users_shared.users.length) id = message.users_shared.users[0].user_id;
  else if (message.forward_origin && message.forward_origin.type === 'user') id = message.forward_origin.sender_user.id;
  else if (/^\d{4,16}$/.test(text)) id = toInt(text);
  else if (/^@[A-Za-z][A-Za-z0-9_]{3,31}$/.test(text)) {
    const known = await users.byUsername(text.slice(1));
    if (known) id = Number(known.user_id);
  }
  if (!id) return send(ctx, user.user_id, t(lang, 'lists.add_nothing'), null, 'fed-admin-bad');
  await state.clear(user.user_id);
  const m = await tryCall(ctx, 'getChatMember', { chat_id: c, user_id: id }, 'fed-admin-member');
  if (m) await users.remember(m.user);
  const r = await feds.addAdmin(fed, id, user.user_id, c);
  await send(ctx, user.user_id, t(lang, `fed.admin_${r}`, { name: iso(m ? fullName(m.user) : String(id)) }), null, 'fed-admin-done', removeKeyboard);
  return adminsScreen(ctx, user, g, fed, null);
}
