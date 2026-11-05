/*
 * The Super Admin panel's management sections (Phase 10) and the global switch — the owner's private
 * chat; the same sections, limited by level, are the bot team's own panel (/staff, «ستاد»). The owner
 * panel itself (ui/owner.js), broadcasts and /status /shutdown /activate stay OWNER_ID only.
 * Who may do what is read from aegis_staff on every press and every input (engines/system.js
 * staff.levelOf) — a member who was removed or lowered loses the access at once:
 *   viewer   chats (list, search, details), version, health, errors, queues
 *   support  + refresh a chat, an error's details, the audit log, its seals (verify)
 *   manager  + suspend / resume / leave a chat, a chat's backup, message a chat, the log as CSV,
 *              seal now, pause / resume timed work, run the sweeps now, release stuck locks
 *   owner    + the team, system settings, the global backup and restore, the global switch
 *
 * callback_data — sa: home · sa:x (cancel an input)
 *   sa:c:f:<filter>:<offset> chats (a all · g groups · c channels · n bot not admin / missing rights · l left · s suspended) ·
 *   sa:c:q search · sa:c:i:<id> details · sa:c:r:<id> refresh · sa:c:s:<id> suspend? · sa:c:sy:<id> suspend! ·
 *   sa:c:u:<id> resume · sa:c:l:<id> leave? · sa:c:ly:<id> leave! · sa:c:b:<id> backup file · sa:c:m:<id> message it
 *   sa:s team · sa:s:a add · sa:s:i:<user> member · sa:s:v:<user>:<level> · sa:s:r:<user> remove? · sa:s:ry:<user> remove!
 *   sa:l:<a|p|s>:<before id> audit log (all · people · system) · sa:l:x CSV · sa:k seals · sa:k:v:<from> verify · sa:k:n seal now
 *   sa:g settings · sa:g:t:<key> toggle · sa:g:lc set the global log channel · sa:g:lx clear it
 *   sa:v version · sa:h health · sa:e:<before id> errors · sa:e:i:<id> one error
 *   sa:b backups · sa:b:g the global file · sa:b:c:<offset> a part of the chats · sa:b:r restore · sa:b:y apply · sa:b:n:<offset> next chats
 *   sa:q queues · sa:q:p pause / resume timed work · sa:q:s run the sweeps now · sa:q:u release stuck locks
 *   sy:st status · sy:off shut down? · sy:offy shut down! · sy:on activate     (owner only — lib/router.js)
 * Pending inputs (aegis_states): sa_find, sa_say {chat}, sa_staff, sa_restore, sa_logchat. A checked
 * restore file waits in aegis_kv restore_file ({ file, part, at }) until applied (30 min).
 */
import { db, InputFile } from 'sdk';
import { sql } from 'sdk/db';
import { ADMIN_PAGE, APP_URL, AUDIT_PAGE, EXPORT_MAX_ROWS, GLOBAL_BACKUP_CHATS, GLOBAL_BACKUP_MAX, LANGS, OWNER_ID, PHASE, RELEASED, STAFF_MAX, VERSION } from '../config.js';
import * as audit from '../core/audit.js';
import { COMMANDS_REV, syncStaffCommands } from '../core/commands.js';
import { LATEST } from '../core/migrations.js';
import * as kv from '../core/kv.js';
import * as state from '../core/state.js';
import { answer, btn, call, describeError, me, screen, send, tryCall } from '../core/tg.js';
import { csv, esc, fullName, iso, isoMinute, nowSec, parseJson, RLM, short, toInt, utf8Bytes, utf8Text } from '../core/util.js';
import * as backup from '../engines/backup.js';
import * as chats from '../engines/chats.js';
import * as system from '../engines/system.js';
import { allChats, globalBackup, globals, seals, staff } from '../engines/system.js';
import * as users from '../engines/users.js';
import { dur, isRtl, t } from '../i18n/index.js';

export const INPUTS = new Set(['sa_find', 'sa_say', 'sa_staff', 'sa_restore', 'sa_logchat']);
const RESTORE_TTL = 30 * 60;

/* The level each action needs: "<section>:<action>" first, then "<section>". */
const NEED = {
  '': 'viewer', x: 'viewer', c: 'viewer', 'c:f': 'viewer', 'c:q': 'viewer', 'c:i': 'viewer', 'c:r': 'support',
  'c:s': 'manager', 'c:sy': 'manager', 'c:u': 'manager', 'c:l': 'manager', 'c:ly': 'manager', 'c:b': 'manager', 'c:m': 'manager',
  s: 'owner', l: 'support', 'l:x': 'manager', k: 'support', 'k:v': 'support', 'k:n': 'manager', g: 'owner',
  v: 'viewer', h: 'viewer', e: 'viewer', 'e:i': 'support', b: 'owner', q: 'viewer', 'q:p': 'manager', 'q:s': 'manager', 'q:u': 'manager',
};
const needOf = (parts) => NEED[`${parts[1] || ''}:${parts[2] || ''}`] || NEED[parts[1] || ''] || 'owner';
const INPUT_NEED = { sa_find: 'viewer', sa_say: 'manager', sa_staff: 'owner', sa_restore: 'owner', sa_logchat: 'owner' };

const home = (lang) => [btn(t(lang, 'sa.btn_home'), 'sa')];
const lvl = (lang, level) => t(lang, `sa.level_${level}`);
const onOff = (lang, on) => t(lang, on ? 'common.on' : 'common.off');
const ago = (lang, at) => (Number(at) ? t(lang, 'sa.ago', { d: dur(lang, nowSec() - Number(at)) }) : '—');
const idText = (id) => `<code>${String(id)}</code>`;
const mark = (lang) => (isRtl(lang) ? RLM : ''); /* a line not made by t() still starts right-to-left in Persian */

/* ---------- home ---------- */

export async function homeScreen(ctx, user, level, place = null, notice = '') {
  const lang = user.lang;
  await state.clear(user.user_id);
  const s = await kv.all(ctx);
  const c = await chats.counts();
  const lines = [];
  if (notice) lines.push(notice, '');
  lines.push(t(lang, level === 'owner' ? 'sa.title_owner' : 'sa.title_staff'), t(lang, 'sa.your_level', { level: lvl(lang, level) }), '');
  lines.push(t(lang, 'sa.home_version', { version: VERSION, phase: PHASE }));
  lines.push(t(lang, 'sa.home_chats', { groups: c.groups, channels: c.channels, suspended: Object.keys(globals.suspended(s)).length }));
  lines.push(t(lang, 'sa.home_errors', { n: Number((await db.get(sql`SELECT count(*) AS n FROM aegis_errors WHERE at >= ${nowSec() - 86400}`)).n) }));
  if (system.isShutdown(s)) lines.push(t(lang, 'sa.home_shutdown'));
  if (!globals.on(s, 'g_jobs')) lines.push(t(lang, 'sa.home_jobs_paused'));
  const rows = [
    [btn(t(lang, 'sa.btn_chats'), 'sa:c:f:a:0'), btn(t(lang, 'sa.btn_health'), 'sa:h')],
    [btn(t(lang, 'sa.btn_errors'), 'sa:e'), btn(t(lang, 'sa.btn_queues'), 'sa:q')],
  ];
  const r3 = [btn(t(lang, 'sa.btn_version'), 'sa:v')];
  if (staff.can(level, 'support')) r3.push(btn(t(lang, 'sa.btn_log'), 'sa:l:a:0'));
  rows.push(r3);
  if (level === 'owner') {
    rows.push([btn(t(lang, 'sa.btn_staff'), 'sa:s'), btn(t(lang, 'sa.btn_settings'), 'sa:g')]);
    rows.push([btn(t(lang, 'sa.btn_backups'), 'sa:b'), btn(t(lang, 'sa.btn_switch'), 'sy:st')]);
    rows.push([btn(t(lang, 'owner.title_short'), 'op')]);
  } else rows.push([btn(t(lang, 'owner.btn_main'), 'mm')]);
  return screen(ctx, user.user_id, place, lines.join('\n'), rows, 'sa-home');
}

/* /staff in private: the panel for the owner and the team; anyone else gets nothing from here. */
export async function command(ctx, user) {
  const level = await staff.levelOf(user.user_id);
  if (!level) return false;
  await homeScreen(ctx, user, level);
  return true;
}

/* ---------- chats ---------- */

const chatIcon = (c) => (c.type === 'channel' ? '📢' : '👥');
const chatTitle = (c) => c.title || (c.username ? `@${c.username}` : String(c.chat_id));

async function chatsScreen(ctx, user, filter, offset, place) {
  const lang = user.lang;
  const f = allChats.FILTERS.includes(filter) ? filter : 'a';
  const off = Math.max(0, offset || 0);
  const { rows, total } = await allChats.page(ctx, f, off, ADMIN_PAGE);
  const susp = globals.suspendedSet(await kv.all(ctx));
  const lines = [t(lang, 'sa.chats_title', { filter: t(lang, `sa.filter_${f}`), n: total }), ''];
  if (!rows.length) lines.push(t(lang, 'sa.chats_empty'));
  rows.forEach((c, i) => {
    const flags = `${Number(c.active) ? '' : ' 🚪'}${susp.has(Number(c.chat_id)) ? ' ⏸' : ''}${c.bot_status && c.bot_status !== 'administrator' && Number(c.active) ? ' ⚠️' : ''}`;
    lines.push(t(lang, 'sa.chats_item', { i: off + i + 1, icon: chatIcon(c), title: iso(chatTitle(c), 36), n: Number(c.member_count) || 0, flags }));
  });
  lines.push('', t(lang, 'sa.chats_hint'));
  const kb = [];
  for (let i = 0; i < rows.length; i += 4) kb.push(rows.slice(i, i + 4).map((c, j) => btn(String(off + i + j + 1), `sa:c:i:${c.chat_id}`)));
  const nav = [];
  if (off > 0) nav.push(btn('◀️', `sa:c:f:${f}:${Math.max(0, off - ADMIN_PAGE)}`));
  if (off + ADMIN_PAGE < total) nav.push(btn('▶️', `sa:c:f:${f}:${off + ADMIN_PAGE}`));
  if (nav.length) kb.push(nav);
  const fl = allChats.FILTERS.filter((x) => x !== f).map((x) => btn(t(lang, `sa.filter_${x}`), `sa:c:f:${x}:0`));
  kb.push(fl.slice(0, 3), fl.slice(3));
  kb.push([btn(t(lang, 'sa.btn_search'), 'sa:c:q')], home(lang));
  return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'sa-chats');
}

async function chatScreen(ctx, user, level, chatId, place, notice = '') {
  const lang = user.lang;
  const info = await allChats.info(chatId);
  if (!info) return chatsScreen(ctx, user, 'a', 0, place);
  const c = info.chat;
  const susp = globals.suspended(await kv.all(ctx))[String(chatId)];
  const lines = [];
  if (notice) lines.push(notice, '');
  lines.push(t(lang, 'sa.chat_title', { icon: chatIcon(c), title: iso(chatTitle(c), 64) }));
  lines.push(t(lang, 'sa.chat_id', { id: idText(c.chat_id), type: esc(c.type), uname: c.username ? `@${esc(c.username)}` : '—' }));
  lines.push(t(lang, 'sa.chat_bot', { status: esc(c.bot_status || '—'), active: onOff(lang, !!Number(c.active)), setup: t(lang, Number(c.registered) ? 'sa.setup_yes' : 'sa.setup_no') }));
  lines.push(t(lang, 'sa.chat_members', { n: Number(c.member_count) || 0, admins: info.admins, lang: esc(c.lang || '') }));
  lines.push(t(lang, 'sa.chat_added', { ago: ago(lang, c.joined_at), by: idText(Number(c.added_by) || 0) }));
  lines.push(t(lang, 'sa.chat_data', { settings: info.settings, punishments: info.punishments, lockdown: info.lockdown, events: info.events }));
  const missing = parseJson(c.missing, []);
  if (missing.length) lines.push(t(lang, 'sa.chat_missing', { n: missing.length }));
  if (susp) lines.push('', t(lang, 'sa.chat_suspended', { ago: ago(lang, susp[0]), by: idText(susp[1]) }));
  const kb = [];
  const id = c.chat_id;
  if (staff.can(level, 'support')) kb.push([btn(t(lang, 'sa.btn_refresh_chat'), `sa:c:r:${id}`)]);
  if (staff.can(level, 'manager')) {
    kb.push([susp ? btn(t(lang, 'sa.btn_resume'), `sa:c:u:${id}`) : btn(t(lang, 'sa.btn_suspend'), `sa:c:s:${id}`)]);
    if (Number(c.active)) {
      kb.push([btn(t(lang, 'sa.btn_backup_chat'), `sa:c:b:${id}`), btn(t(lang, 'sa.btn_message'), `sa:c:m:${id}`)]);
      kb.push([btn(t(lang, 'sa.btn_leave'), `sa:c:l:${id}`)]);
    }
  }
  kb.push([btn(t(lang, 'sa.btn_chats'), 'sa:c:f:a:0')], home(lang));
  return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'sa-chat');
}

async function chatsCallback(ctx, user, level, parts, place) {
  const lang = user.lang;
  const [, , action, arg, arg2] = parts;
  if (!action || action === 'f') return chatsScreen(ctx, user, arg || 'a', toInt(arg2) || 0, place);
  if (action === 'q') {
    await state.set(user.user_id, 'sa_find');
    return screen(ctx, user.user_id, place, t(lang, 'sa.search_prompt'), [[btn(t(lang, 'common.cancel'), 'sa:x')]], 'sa-search');
  }
  const id = toInt(arg);
  const chat = id === null ? null : await chats.get(id);
  if (!chat) return chatsScreen(ctx, user, 'a', 0, place);
  if (action === 'i') return chatScreen(ctx, user, level, id, place);
  if (action === 'r') {
    const r = await allChats.refresh(ctx, chat);
    await audit.log(user.user_id, 'chat.refresh', { chatId: id, details: { result: short(r, 80) } });
    const notice = r === 'ok' ? t(lang, 'sa.refreshed') : (r === 'gone' ? t(lang, 'sa.refresh_gone') : t(lang, 'sa.refresh_failed', { error: esc(r) }));
    return chatScreen(ctx, user, level, id, place, notice);
  }
  if (action === 's') {
    const rows = [[btn(t(lang, 'sa.btn_suspend_yes'), `sa:c:sy:${id}`), btn(t(lang, 'common.cancel'), `sa:c:i:${id}`)]];
    return screen(ctx, user.user_id, place, t(lang, 'sa.suspend_q', { title: iso(chatTitle(chat), 48) }), rows, 'sa-suspend?');
  }
  if (action === 'sy' || action === 'u') {
    const r = await globals.suspend(ctx, user.user_id, id, action === 'sy');
    const notice = r === 'full' ? t(lang, 'sa.suspend_full') : t(lang, action === 'sy' ? 'sa.suspended' : 'sa.resumed');
    return chatScreen(ctx, user, level, id, place, notice);
  }
  if (action === 'l') {
    const rows = [[btn(t(lang, 'sa.btn_leave_yes'), `sa:c:ly:${id}`), btn(t(lang, 'common.cancel'), `sa:c:i:${id}`)]];
    return screen(ctx, user.user_id, place, t(lang, 'sa.leave_q', { title: iso(chatTitle(chat), 48) }), rows, 'sa-leave?');
  }
  if (action === 'ly') {
    const ok = await allChats.leave(ctx, user.user_id, chat);
    return chatScreen(ctx, user, level, id, place, t(lang, ok ? 'sa.left' : 'sa.left_failed'));
  }
  if (action === 'b') {
    const data = await backup.make(chat);
    const name = `aegis-${chat.type === 'channel' ? 'channel' : 'group'}-${String(id).replace('-', '')}.json`;
    const ok = await tryCall(ctx, 'sendDocument', { chat_id: user.user_id, document: new InputFile(utf8Bytes(JSON.stringify(data, null, 1)), name, { type: 'application/json' }),
      caption: t(lang, 'sa.backup_chat_caption', { title: iso(chatTitle(chat), 48) }), parse_mode: 'HTML' }, 'sa-chat-backup');
    await audit.log(user.user_id, 'chat.backup', { chatId: id, details: { by: 'team' } });
    await answer(ctx, t(lang, ok ? 'sa.file_sent' : 'sa.file_failed'));
    return null;
  }
  if (action === 'm') {
    await state.set(user.user_id, 'sa_say', { chat: id });
    return screen(ctx, user.user_id, place, t(lang, 'sa.say_prompt', { title: iso(chatTitle(chat), 48) }), [[btn(t(lang, 'common.cancel'), `sa:c:i:${id}`)]], 'sa-say');
  }
  return chatScreen(ctx, user, level, id, place);
}

/* ---------- the team ---------- */

async function staffScreen(ctx, user, place, notice = '') {
  const lang = user.lang;
  const list = await staff.list();
  const lines = [];
  if (notice) lines.push(notice, '');
  lines.push(t(lang, 'sa.staff_title', { n: list.length }), '', t(lang, 'sa.staff_levels'), '');
  if (!list.length) lines.push(t(lang, 'sa.staff_empty'));
  list.forEach((r, i) => lines.push(t(lang, 'sa.staff_item', { i: i + 1, name: iso(r.name || String(r.user_id), 32), id: idText(r.user_id), level: lvl(lang, r.level) })));
  const kb = [];
  for (let i = 0; i < list.length; i += 4) kb.push(list.slice(i, i + 4).map((r, j) => btn(String(i + j + 1), `sa:s:i:${r.user_id}`)));
  kb.push([btn(t(lang, 'sa.btn_staff_add'), 'sa:s:a')], home(lang));
  return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'sa-staff');
}

async function memberScreen(ctx, user, uid, place, notice = '') {
  const lang = user.lang;
  const r = await staff.get(uid);
  if (!r) return staffScreen(ctx, user, place, t(lang, 'sa.staff_gone'));
  const lines = [];
  if (notice) lines.push(notice, '');
  lines.push(t(lang, 'sa.member_title', { name: iso(r.name || String(uid), 48), id: idText(uid) }));
  lines.push(t(lang, 'sa.member_level', { level: lvl(lang, r.level), ago: ago(lang, r.added_at) }));
  lines.push('', t(lang, `sa.level_${r.level}_can`));
  const kb = [staff.LEVELS.map((l) => btn(`${l === r.level ? '✅ ' : ''}${lvl(lang, l)}`, `sa:s:v:${uid}:${l}`))];
  kb.push([btn(t(lang, 'sa.btn_staff_remove'), `sa:s:r:${uid}`)], [btn(t(lang, 'sa.btn_staff'), 'sa:s')]);
  return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'sa-member');
}

/* Tells the member (if they opened the bot) and sets their command menu. */
async function tellMember(ctx, uid, level) {
  const u = await users.get(uid);
  if (!u || !Number(u.started) || Number(u.blocked)) return;
  await syncStaffCommands(ctx, uid, u.lang, !!level);
  const text = level ? t(u.lang, 'sa.member_notice', { level: lvl(u.lang, level) }) : t(u.lang, 'sa.member_removed_notice');
  await send(ctx, uid, text, level ? [[btn(t(u.lang, 'sa.btn_open_staff'), 'sa')]] : null, 'sa-member-notice');
}

async function staffCallback(ctx, user, parts, place) {
  const lang = user.lang;
  const [, , action, arg, arg2] = parts;
  if (action === 'a') {
    if ((await staff.total()) >= STAFF_MAX) return staffScreen(ctx, user, place, t(lang, 'sa.staff_full'));
    await state.set(user.user_id, 'sa_staff');
    return screen(ctx, user.user_id, place, t(lang, 'sa.staff_prompt'), [[btn(t(lang, 'common.cancel'), 'sa:s')]], 'sa-staff-add');
  }
  const uid = toInt(arg);
  if (!action || uid === null) return staffScreen(ctx, user, place);
  if (action === 'i') return memberScreen(ctx, user, uid, place);
  if (action === 'v') {
    const r = await staff.set(user.user_id, uid, arg2, null);
    if (r === 'changed') await tellMember(ctx, uid, arg2);
    return memberScreen(ctx, user, uid, place, r === 'changed' ? t(lang, 'sa.level_set', { level: lvl(lang, arg2) }) : '');
  }
  if (action === 'r') {
    const r = await staff.get(uid);
    if (!r) return staffScreen(ctx, user, place, t(lang, 'sa.staff_gone'));
    const rows = [[btn(t(lang, 'common.yes_remove'), `sa:s:ry:${uid}`), btn(t(lang, 'common.no'), `sa:s:i:${uid}`)]];
    return screen(ctx, user.user_id, place, t(lang, 'sa.staff_remove_q', { name: iso(r.name || String(uid), 48) }), rows, 'sa-staff-remove?');
  }
  if (action === 'ry') {
    const done = await staff.remove(user.user_id, uid);
    if (done) await tellMember(ctx, uid, null);
    return staffScreen(ctx, user, place, done ? t(lang, 'sa.staff_removed') : t(lang, 'sa.staff_gone'));
  }
  return staffScreen(ctx, user, place);
}

/* The owner's message while sa_staff is pending: a numeric id, @username (someone who opened the bot) or a forwarded message. */
async function staffInput(ctx, user, message) {
  const lang = user.lang;
  let uid = null;
  let name = null;
  const o = message.forward_origin;
  if (o && o.type === 'user' && o.sender_user) {
    uid = o.sender_user.id;
    name = fullName(o.sender_user);
  } else if (o) {
    return send(ctx, user.user_id, t(lang, 'sa.staff_hidden'), [[btn(t(lang, 'common.cancel'), 'sa:s')]], 'sa-staff-bad');
  } else {
    const s = String(message.text || '').trim();
    if (/^\d{4,16}$/.test(s)) uid = toInt(s);
    else if (/^@?[A-Za-z][A-Za-z0-9_]{3,31}$/.test(s)) {
      const u = await users.byUsername(s.replace(/^@/, ''));
      if (u) uid = Number(u.user_id);
    }
  }
  if (!uid || uid === OWNER_ID) return send(ctx, user.user_id, t(lang, 'sa.staff_bad'), [[btn(t(lang, 'common.cancel'), 'sa:s')]], 'sa-staff-bad');
  const known = await users.get(uid);
  if (!name && known) name = [known.first_name, known.last_name].filter(Boolean).join(' ') || (known.username ? `@${known.username}` : null);
  const r = await staff.set(user.user_id, uid, 'viewer', name);
  await state.clear(user.user_id);
  if (r === 'full') return staffScreen(ctx, user, null, t(lang, 'sa.staff_full'));
  if (r === 'added') await tellMember(ctx, uid, 'viewer');
  const notice = r === 'added' ? t(lang, known && Number(known.started) ? 'sa.staff_added' : 'sa.staff_added_unstarted') : t(lang, 'sa.staff_exists');
  return memberScreen(ctx, user, uid, null, notice);
}

/* ---------- the audit log and its seals ---------- */

const actorText = (lang, id) => (Number(id) === 0 ? t(lang, 'sa.actor_system') : (Number(id) === OWNER_ID ? t(lang, 'sa.actor_owner') : idText(id)));

async function logScreen(ctx, user, level, filter, before, place) {
  const lang = user.lang;
  const f = ['a', 'p', 's'].includes(filter) ? filter : 'a';
  const b = before > 0 ? before : 9007199254740991;
  const cond = f === 'p' ? sql`actor_id <> 0` : (f === 's' ? sql`actor_id = 0` : sql`1 = 1`);
  const list = await db.all(sql`SELECT * FROM aegis_audit WHERE id < ${b} AND ${cond} ORDER BY id DESC LIMIT ${AUDIT_PAGE}`);
  const lines = [t(lang, 'sa.log_title', { filter: t(lang, `sa.log_filter_${f}`) }), t(lang, 'sa.log_note'), ''];
  if (!list.length) lines.push(t(lang, 'sa.log_empty'));
  for (const r of list) {
    lines.push(t(lang, 'sa.log_item', {
      id: String(r.id), ago: ago(lang, r.at), actor: actorText(lang, r.actor_id), action: esc(r.action),
      chat: Number(r.chat_id) ? ` · ${idText(r.chat_id)}` : '', target: r.target ? ` · ${esc(short(r.target, 24))}` : '',
    }));
  }
  const kb = [];
  if (list.length === AUDIT_PAGE) kb.push([btn(t(lang, 'sa.btn_older'), `sa:l:${f}:${list[list.length - 1].id}`)]);
  kb.push(['a', 'p', 's'].filter((x) => x !== f).map((x) => btn(t(lang, `sa.log_filter_${x}`), `sa:l:${x}:0`)));
  const tools = [btn(t(lang, 'sa.btn_seals'), 'sa:k')];
  if (staff.can(level, 'manager')) tools.push(btn(t(lang, 'sa.btn_csv'), 'sa:l:x'));
  kb.push(tools, home(lang));
  return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'sa-log');
}

async function logCsv(ctx, user) {
  const list = await db.all(sql`SELECT * FROM aegis_audit ORDER BY id DESC LIMIT ${EXPORT_MAX_ROWS}`);
  const rows = [['id', 'time_utc', 'actor_id', 'chat_id', 'action', 'target', 'details']];
  for (const r of list) rows.push([r.id, isoMinute(r.at), r.actor_id, r.chat_id, r.action, r.target, r.details]);
  const ok = await tryCall(ctx, 'sendDocument', { chat_id: user.user_id, document: new InputFile(utf8Bytes(csv(rows)), 'aegis-audit-log.csv', { type: 'text/csv' }) }, 'sa-log-csv');
  await audit.log(user.user_id, 'system.log_export', { details: { rows: list.length } });
  await answer(ctx, t(user.lang, ok ? 'sa.file_sent' : 'sa.file_failed'));
  return null;
}

async function sealsScreen(ctx, user, level, place, notice = '') {
  const lang = user.lang;
  const sm = await seals.summary();
  const s = await kv.all(ctx);
  const lines = [];
  if (notice) lines.push(notice, '');
  lines.push(t(lang, 'sa.seals_title'), '', t(lang, 'sa.seals_explain'), '');
  lines.push(t(lang, 'sa.seals_rows', { rows: sm.rows, seals: sm.seals, unsealed: sm.unsealed }));
  if (sm.last) lines.push(t(lang, 'sa.seals_last', { id: String(sm.last.id), to: String(sm.last.to), ago: ago(lang, sm.last.at), hash: `<code>${sm.last.hash}</code>` }));
  lines.push(t(lang, sm.guard ? 'sa.seals_guard_on' : 'sa.seals_guard_off'));
  lines.push(globals.logChat(s) ? t(lang, 'sa.seals_channel', { id: idText(globals.logChat(s)) }) : t(lang, 'sa.seals_no_channel'));
  const kb = [[btn(t(lang, 'sa.btn_verify'), 'sa:k:v:1')]];
  if (staff.can(level, 'manager')) kb[0].push(btn(t(lang, 'sa.btn_seal_now'), 'sa:k:n'));
  kb.push([btn(t(lang, 'sa.btn_log'), 'sa:l:a:0')], home(lang));
  return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'sa-seals');
}

async function sealsCallback(ctx, user, level, parts, place) {
  const lang = user.lang;
  const action = parts[2];
  if (action === 'n') {
    const made = await seals.sealNow(ctx);
    if (made.length) await audit.log(user.user_id, 'system.seal', { details: { seals: made.length } });
    return sealsScreen(ctx, user, level, place, made.length ? t(lang, 'sa.sealed', { n: made.length }) : t(lang, 'sa.seal_nothing'));
  }
  if (action === 'v') {
    const r = await seals.verify(Math.max(1, toInt(parts[3]) || 1));
    const lines = [t(lang, 'sa.verify_title'), '', t(lang, 'sa.verify_checked', { seals: r.checked, rows: r.rows })];
    if (!r.checked) lines.push(t(lang, 'sa.verify_none'));
    else if (!r.bad.length) lines.push(t(lang, 'sa.verify_ok'));
    else for (const b of r.bad.slice(0, 10)) lines.push(t(lang, 'sa.verify_bad', { id: String(b.id), why: t(lang, `sa.why_${b.why}`) }));
    if (!r.next) lines.push('', t(lang, 'sa.verify_tail'));
    await audit.log(user.user_id, 'system.verify', { details: { from: toInt(parts[3]) || 1, checked: r.checked, bad: r.bad.length } });
    const kb = [];
    if (r.next) kb.push([btn(t(lang, 'sa.btn_verify_more'), `sa:k:v:${r.next}`)]);
    kb.push([btn(t(lang, 'sa.btn_seals'), 'sa:k')], home(lang));
    return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'sa-verify');
  }
  return sealsScreen(ctx, user, level, place);
}

/* ---------- system settings ---------- */

async function settingsScreen(ctx, user, place, notice = '') {
  const lang = user.lang;
  const s = await kv.all(ctx);
  const lines = [];
  if (notice) lines.push(notice, '');
  lines.push(t(lang, 'sa.settings_title'), '');
  for (const k of globals.FLAGS) lines.push(t(lang, `sa.set_${k}`, { state: onOff(lang, globals.on(s, k)) }), t(lang, `sa.set_${k}_note`), '');
  lines.push(globals.logChat(s) ? t(lang, 'sa.set_log_chat', { id: idText(globals.logChat(s)) }) : t(lang, 'sa.set_log_chat_none'), t(lang, 'sa.set_log_chat_note'));
  const kb = globals.FLAGS.map((k) => [btn(t(lang, `sa.btn_${k}`, { state: onOff(lang, globals.on(s, k)) }), `sa:g:t:${k}`)]);
  kb.push(globals.logChat(s) ? [btn(t(lang, 'sa.btn_log_chat'), 'sa:g:lc'), btn(t(lang, 'sa.btn_log_chat_clear'), 'sa:g:lx')] : [btn(t(lang, 'sa.btn_log_chat'), 'sa:g:lc')]);
  kb.push(home(lang));
  return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'sa-settings');
}

async function settingsCallback(ctx, user, parts, place) {
  const lang = user.lang;
  const [, , action, key] = parts;
  if (action === 't' && globals.FLAGS.includes(key)) {
    const on = !globals.on(await kv.all(ctx), key);
    await globals.setFlag(ctx, user.user_id, key, on);
    return settingsScreen(ctx, user, place, t(lang, 'sa.setting_saved'));
  }
  if (action === 'lc') {
    await state.set(user.user_id, 'sa_logchat');
    return screen(ctx, user.user_id, place, t(lang, 'sa.log_chat_prompt'), [[btn(t(lang, 'common.cancel'), 'sa:g')]], 'sa-log-chat');
  }
  if (action === 'lx') {
    await globals.setLogChat(ctx, user.user_id, 0);
    return settingsScreen(ctx, user, place, t(lang, 'sa.setting_saved'));
  }
  return settingsScreen(ctx, user, place);
}

/* A channel (forwarded post, @name or -100… id) where Aegis can post: the global log channel. */
async function logChatInput(ctx, user, message) {
  const lang = user.lang;
  const o = message.forward_origin;
  let ref = null;
  if (o && o.type === 'channel' && o.chat) ref = o.chat.id;
  else {
    const s = String(message.text || '').trim();
    if (/^-100\d{6,16}$/.test(s)) ref = toInt(s);
    else if (/^@[A-Za-z][A-Za-z0-9_]{3,31}$/.test(s)) ref = s;
  }
  const retry = [[btn(t(lang, 'common.cancel'), 'sa:g')]];
  if (ref === null) return send(ctx, user.user_id, t(lang, 'sa.log_chat_bad'), retry, 'sa-log-chat-bad');
  let chat;
  try {
    chat = await call(ctx, 'getChat', { chat_id: ref }, 'sa-log-chat-get');
    const probe = await call(ctx, 'sendMessage', { chat_id: chat.id, text: t(lang, 'sa.log_chat_probe'), disable_notification: true }, 'sa-log-chat-probe');
    if (!probe) throw new Error('no message');
  } catch (err) {
    return send(ctx, user.user_id, t(lang, 'sa.log_chat_failed', { error: esc(describeError(err)) }), retry, 'sa-log-chat-fail');
  }
  await state.clear(user.user_id);
  await globals.setLogChat(ctx, user.user_id, chat.id);
  return settingsScreen(ctx, user, null, t(lang, 'sa.log_chat_set', { title: iso(chat.title || String(chat.id), 48) }));
}

/* ---------- version, health, errors ---------- */

async function versionScreen(ctx, user, place) {
  const lang = user.lang;
  const s = await kv.all(ctx);
  const bot = await me(ctx);
  let tables = '—';
  try {
    tables = Number((await db.get(sql`SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name LIKE 'aegis_%'`)).n);
  } catch (err) {
    tables = '—';
  }
  const lines = [
    t(lang, 'sa.version_title'), '',
    t(lang, 'sa.version_line', { version: VERSION, phase: PHASE, released: RELEASED }),
    t(lang, 'sa.version_data', { data: Number(s.data_version || 0), latest: LATEST, cmd: COMMANDS_REV }),
    t(lang, 'sa.version_bot', { uname: `@${esc(bot.username)}`, id: idText(bot.id) }),
    t(lang, 'sa.version_db', { tables }),
    t(lang, 'sa.version_langs', { n: LANGS.length, list: LANGS.join(', ') }),
    t(lang, 'sa.version_app', { url: esc(APP_URL || '—') }),
    '', t(lang, 'sa.version_platform'),
  ];
  return screen(ctx, user.user_id, place, lines.join('\n'), [home(lang)], 'sa-version');
}

const qLine = (lang, key, vars, late) => t(lang, `sa.q_${key}`, vars) + (late ? ` ${t(lang, 'sa.q_late', { n: late })}` : '');

function queueLines(lang, q) {
  return [
    qLine(lang, 'broadcasts', { running: q.broadcasts.running, queued: q.broadcasts.queued }, 0),
    qLine(lang, 'posts', { pending: q.posts.pending, scheduled: q.posts.scheduled }, q.posts.late),
    qLine(lang, 'schedules', { n: q.schedules.total }, q.schedules.late),
    qLine(lang, 'backups', { running: q.backups.running, failed: q.backups.failed }, 0),
    qLine(lang, 'captchas', { n: q.captchas.pending }, q.captchas.late),
    qLine(lang, 'lockdowns', { n: q.lockdowns.active }, q.lockdowns.late),
    qLine(lang, 'contests', { contests: q.contests.running, polls: q.polls.open }, q.contests.late + q.polls.late),
    qLine(lang, 'games', { n: q.games.running }, q.games.late),
    qLine(lang, 'misc', { media: q.media, inputs: q.inputs }, 0),
  ];
}

async function healthScreen(ctx, user, place) {
  const lang = user.lang;
  const h = await system.health(ctx);
  const now = nowSec();
  const lines = [t(lang, 'sa.health_title'), ''];
  lines.push(h.problems.length ? t(lang, 'sa.health_bad', { n: h.problems.length }) : t(lang, 'sa.health_ok'));
  for (const p of h.problems) lines.push(t(lang, `sa.problem_${p}`));
  lines.push('', t(lang, h.api ? 'sa.health_api_ok' : 'sa.health_api_bad'));
  if (h.webhook && h.webhook.managed) lines.push(t(lang, 'sa.health_webhook_managed'));
  else if (h.webhook) {
    lines.push(t(lang, 'sa.health_webhook', { state: onOff(lang, h.webhook.set), pending: h.webhook.pending, types: h.webhook.types }));
    if (h.webhook.lastError) lines.push(t(lang, 'sa.health_webhook_error', { ago: ago(lang, h.webhook.lastErrorAt), message: esc(short(h.webhook.lastError, 120)) }));
  } else lines.push(t(lang, 'sa.health_webhook_unknown'));
  lines.push(t(lang, 'sa.health_errors', { h1: h.errors1h, h24: h.errors24h }));
  lines.push(t(lang, 'sa.health_updates', { n: h.stuck }));
  lines.push(t(lang, 'sa.health_sweeps', { gc: ago(lang, h.gcAt), sweep: ago(lang, h.sweepAt) }));
  lines.push(t(lang, 'sa.health_join', { state: onOff(lang, h.join.on), n: h.join.n, bad: h.join.bad }));
  lines.push(t(lang, 'sa.health_jobs', { state: onOff(lang, h.jobs) }), t(lang, 'sa.health_switch', { state: t(lang, h.shutdown ? 'sa.switch_off' : 'sa.switch_on') }));
  lines.push(t(lang, 'sa.health_seals', { unsealed: h.seals.unsealed, guard: onOff(lang, h.seals.guard) }));
  lines.push('', t(lang, 'sa.health_queues', { late: system.lateTotal(h.queues) }), '', t(lang, 'sa.health_note', { at: isoMinute(now) }));
  return screen(ctx, user.user_id, place, lines.join('\n'), [[btn(t(lang, 'common.refresh'), 'sa:h'), btn(t(lang, 'sa.btn_queues'), 'sa:q')], home(lang)], 'sa-health');
}

async function errorsScreen(ctx, user, level, before, place) {
  const lang = user.lang;
  const now = nowSec();
  const n = async (since) => Number((await db.get(sql`SELECT count(*) AS n FROM aegis_errors WHERE at >= ${since}`)).n);
  const b = before > 0 ? before : 9007199254740991;
  const list = await db.all(sql`SELECT id, at, source, code, message FROM aegis_errors WHERE id < ${b} ORDER BY id DESC LIMIT ${ADMIN_PAGE}`);
  const top = await db.all(sql`SELECT source, count(*) AS n FROM aegis_errors WHERE at >= ${now - 7 * 86400} GROUP BY source ORDER BY n DESC LIMIT 5`);
  const lines = [t(lang, 'sa.errors_title'), '', t(lang, 'sa.errors_counts', { h1: await n(now - 3600), h24: await n(now - 86400), d7: await n(now - 7 * 86400) })];
  if (top.length) lines.push(t(lang, 'sa.errors_top', { list: top.map((r) => `<code>${esc(r.source)}</code> ${Number(r.n)}`).join(' · ') }));
  lines.push('');
  if (!list.length) lines.push(t(lang, 'sa.errors_empty'));
  list.forEach((r, i) => lines.push(t(lang, 'sa.errors_item', { i: i + 1, ago: ago(lang, r.at), source: esc(r.source), message: esc(short(r.message || '', 90)) })));
  const kb = [];
  if (staff.can(level, 'support')) for (let i = 0; i < list.length; i += 4) kb.push(list.slice(i, i + 4).map((r, j) => btn(String(i + j + 1), `sa:e:i:${r.id}`)));
  const nav = [];
  if (before > 0) nav.push(btn(t(lang, 'sa.btn_newest'), 'sa:e'));
  if (list.length === ADMIN_PAGE) nav.push(btn(t(lang, 'sa.btn_older'), `sa:e:${list[list.length - 1].id}`));
  if (nav.length) kb.push(nav);
  kb.push(home(lang));
  return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'sa-errors');
}

async function errorScreen(ctx, user, id, place) {
  const lang = user.lang;
  const r = await db.get(sql`SELECT * FROM aegis_errors WHERE id = ${id}`);
  if (!r) return errorsScreen(ctx, user, 'support', 0, place);
  const lines = [
    t(lang, 'sa.error_title', { id: String(r.id) }), '',
    t(lang, 'sa.error_when', { at: isoMinute(r.at), ago: ago(lang, r.at) }),
    t(lang, 'sa.error_where', { source: esc(r.source), code: esc(r.code || '—') }),
    t(lang, 'sa.error_who', { chat: idText(Number(r.chat_id) || 0), user: idText(Number(r.user_id) || 0), update: idText(Number(r.update_id) || 0) }),
    '', `${mark(lang)}<code>${esc(short(r.message || '', 500))}</code>`,
  ];
  if (r.stack) lines.push('', `<pre>${String(r.stack).slice(0, 900).split('\n').map((l) => mark(lang) + esc(l)).join('\n')}</pre>`);
  return screen(ctx, user.user_id, place, lines.join('\n'), [[btn(t(lang, 'sa.btn_errors'), 'sa:e')], home(lang)], 'sa-error');
}

/* ---------- queues and timed work ---------- */

async function queuesScreen(ctx, user, level, place, notice = '') {
  const lang = user.lang;
  const s = await kv.all(ctx);
  const q = await system.queues();
  const on = globals.on(s, 'g_jobs');
  const lines = [];
  if (notice) lines.push(notice, '');
  lines.push(t(lang, 'sa.queues_title'), '', t(lang, on ? 'sa.jobs_on' : 'sa.jobs_off'), '', ...queueLines(lang, q));
  lines.push('', t(lang, 'sa.queues_sweeps', { gc: ago(lang, s.gc_at), sweep: ago(lang, s.sec_sweep_at) }), t(lang, 'sa.queues_note'));
  const kb = [[btn(t(lang, 'common.refresh'), 'sa:q')]];
  if (staff.can(level, 'manager')) {
    kb.push([btn(t(lang, on ? 'sa.btn_jobs_pause' : 'sa.btn_jobs_resume'), 'sa:q:p')]);
    kb.push([btn(t(lang, 'sa.btn_sweep_now'), 'sa:q:s'), btn(t(lang, 'sa.btn_release'), 'sa:q:u')]);
  }
  if (level === 'owner') kb.push([btn(t(lang, 'owner.btn_bc'), 'ob')]);
  kb.push(home(lang));
  return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'sa-queues');
}

async function queuesCallback(ctx, user, level, parts, place) {
  const lang = user.lang;
  const action = parts[2];
  if (action === 'p') {
    const on = globals.on(await kv.all(ctx), 'g_jobs');
    await globals.setFlag(ctx, user.user_id, 'g_jobs', !on);
    return queuesScreen(ctx, user, level, place, t(lang, on ? 'sa.jobs_paused' : 'sa.jobs_resumed'));
  }
  if (action === 's') {
    await system.sweepSoon(ctx, user.user_id);
    return queuesScreen(ctx, user, level, place, t(lang, 'sa.sweep_started'));
  }
  if (action === 'u') {
    const n = await system.releaseLocks(user.user_id);
    return queuesScreen(ctx, user, level, place, t(lang, 'sa.released', { n }));
  }
  return queuesScreen(ctx, user, level, place);
}

/* ---------- global backup and restore ---------- */

async function backupsScreen(ctx, user, place, notice = '') {
  const lang = user.lang;
  const total = Number((await db.get(sql`SELECT count(*) AS n FROM aegis_chats WHERE active = 1`)).n);
  const parts = Math.max(1, Math.ceil(total / GLOBAL_BACKUP_CHATS));
  const lines = [];
  if (notice) lines.push(notice, '');
  lines.push(t(lang, 'sa.backups_title'), '', t(lang, 'sa.backups_explain', { chats: total, parts, per: GLOBAL_BACKUP_CHATS }));
  const kb = [[btn(t(lang, 'sa.btn_backup_globals'), 'sa:b:g'), btn(t(lang, 'sa.btn_backup_chats'), 'sa:b:c:0')], [btn(t(lang, 'sa.btn_restore'), 'sa:b:r')], home(lang)];
  return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'sa-backups');
}

async function sendJson(ctx, user, data, name, caption, rows, view) {
  const params = { chat_id: user.user_id, document: new InputFile(utf8Bytes(JSON.stringify(data)), name, { type: 'application/json' }), caption, parse_mode: 'HTML' };
  if (rows) params.reply_markup = { inline_keyboard: rows };
  return tryCall(ctx, 'sendDocument', params, view);
}

async function restoreReady(ctx) {
  const r = parseJson(await kv.get('restore_file'), null);
  return r && r.file && nowSec() - Number(r.at) <= RESTORE_TTL ? r : null;
}

async function loadRestore(ctx, file) {
  const bytes = await call(ctx, 'getFileContent', { file_id: file }, 'sa-restore-get');
  if (bytes.length > GLOBAL_BACKUP_MAX) return { error: 'too_big' };
  return globalBackup.check(utf8Text(bytes));
}

async function backupsCallback(ctx, user, parts, place) {
  const lang = user.lang;
  const [, , action, arg] = parts;
  const stamp = isoMinute(nowSec()).replace(/[ :]/g, '-');
  if (action === 'g') {
    const data = await globalBackup.makeGlobals(ctx);
    const ok = await sendJson(ctx, user, data, `aegis-global-${stamp}.json`, t(lang, 'sa.backup_globals_caption', { join: data.join.length, staff: data.staff.length }), null, 'sa-backup-globals');
    await audit.log(user.user_id, 'system.backup', { details: { part: 'globals' } });
    await answer(ctx, t(lang, ok ? 'sa.file_sent' : 'sa.file_failed'));
    return null;
  }
  if (action === 'c') {
    const off = Math.max(0, toInt(arg) || 0);
    const data = await globalBackup.makeChats(off, GLOBAL_BACKUP_CHATS);
    const next = off + GLOBAL_BACKUP_CHATS < data.total ? [[btn(t(lang, 'sa.btn_backup_next'), `sa:b:c:${off + GLOBAL_BACKUP_CHATS}`)]] : null;
    const caption = t(lang, 'sa.backup_chats_caption', { from: Math.min(off + 1, data.total), to: off + data.chats.length, total: data.total });
    const ok = await sendJson(ctx, user, data, `aegis-chats-${off / GLOBAL_BACKUP_CHATS + 1}-${stamp}.json`, caption, next, 'sa-backup-chats');
    await audit.log(user.user_id, 'system.backup', { details: { part: 'chats', offset: off, chats: data.chats.length } });
    await answer(ctx, t(lang, ok ? 'sa.file_sent' : 'sa.file_failed'));
    return null;
  }
  if (action === 'r') {
    await state.set(user.user_id, 'sa_restore');
    return screen(ctx, user.user_id, place, t(lang, 'sa.restore_prompt'), [[btn(t(lang, 'common.cancel'), 'sa:b')]], 'sa-restore');
  }
  if (action === 'y' || action === 'n') {
    const ready = await restoreReady(ctx);
    if (!ready) return backupsScreen(ctx, user, place, t(lang, 'sa.restore_expired'));
    const c = await loadRestore(ctx, ready.file);
    if (c.error) return backupsScreen(ctx, user, place, t(lang, `sa.restore_err_${c.error}`));
    if (c.part === 'globals') {
      const r = await globalBackup.applyGlobals(ctx, user.user_id, c.data);
      await kv.set(ctx, 'restore_file', null);
      return backupsScreen(ctx, user, place, t(lang, 'sa.restored_globals', r));
    }
    const r = await globalBackup.applyChats(ctx, user.user_id, c.data, action === 'n' ? Math.max(0, toInt(arg) || 0) : 0);
    if (!r.next) await kv.set(ctx, 'restore_file', null);
    const lines = [t(lang, 'sa.restored_chats', { applied: r.applied, skipped: r.skipped, values: r.values })];
    lines.push(r.next ? t(lang, 'sa.restore_more', { done: r.next, total: r.total }) : t(lang, 'sa.restore_done'));
    const kb = r.next ? [[btn(t(lang, 'sa.btn_restore_next'), `sa:b:n:${r.next}`)], [btn(t(lang, 'common.cancel'), 'sa:b')]] : [[btn(t(lang, 'sa.btn_backups'), 'sa:b')], home(lang)];
    return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'sa-restore-step');
  }
  return backupsScreen(ctx, user, place);
}

/* The owner's message while sa_restore is pending: the JSON file. */
async function restoreInput(ctx, user, message) {
  const lang = user.lang;
  const retry = [[btn(t(lang, 'common.cancel'), 'sa:b')]];
  const doc = message.document;
  if (!doc) return send(ctx, user.user_id, t(lang, 'sa.restore_need_file'), retry, 'sa-restore-bad');
  if (Number(doc.file_size || 0) > GLOBAL_BACKUP_MAX) return send(ctx, user.user_id, t(lang, 'sa.restore_err_too_big'), retry, 'sa-restore-bad');
  let c;
  try {
    c = await loadRestore(ctx, doc.file_id);
  } catch (err) {
    return send(ctx, user.user_id, t(lang, 'sa.restore_download_failed', { error: esc(describeError(err)) }), retry, 'sa-restore-bad');
  }
  if (c.error) return send(ctx, user.user_id, t(lang, `sa.restore_err_${c.error}`), retry, 'sa-restore-bad');
  await state.clear(user.user_id);
  await kv.set(ctx, 'restore_file', JSON.stringify({ file: doc.file_id, part: c.part, at: nowSec() }));
  const text = c.part === 'globals' ? t(lang, 'sa.restore_q_globals', c.counts) : t(lang, 'sa.restore_q_chats', c.counts);
  return send(ctx, user.user_id, text, [[btn(t(lang, 'sa.btn_restore_yes'), 'sa:b:y'), btn(t(lang, 'common.cancel'), 'sa:b')]], 'sa-restore?');
}

/* ---------- entry points ---------- */

/* A press on sa:… — the level is read now; nobody outside the team gets an answer. */
export async function callback(ctx, user, parts, place) {
  const level = await staff.levelOf(user.user_id);
  if (!level) return null;
  if (!staff.can(level, needOf(parts))) {
    await answer(ctx, t(user.lang, 'sa.denied', { level: lvl(user.lang, level) }), true);
    return null;
  }
  const section = parts[1];
  if (section === 'c') return chatsCallback(ctx, user, level, parts, place);
  if (section === 's') return staffCallback(ctx, user, parts, place);
  if (section === 'l') {
    if (parts[2] === 'x') return logCsv(ctx, user);
    return logScreen(ctx, user, level, parts[2], toInt(parts[3]) || 0, place);
  }
  if (section === 'k') return sealsCallback(ctx, user, level, parts, place);
  if (section === 'g') return settingsCallback(ctx, user, parts, place);
  if (section === 'v') return versionScreen(ctx, user, place);
  if (section === 'h') return healthScreen(ctx, user, place);
  if (section === 'e') {
    if (parts[2] === 'i') return errorScreen(ctx, user, toInt(parts[3]) || 0, place);
    return errorsScreen(ctx, user, level, toInt(parts[2]) || 0, place);
  }
  if (section === 'b') return backupsCallback(ctx, user, parts, place);
  if (section === 'q') return queuesCallback(ctx, user, level, parts, place);
  return homeScreen(ctx, user, level, place);
}

/* A message while one of INPUTS is pending — the level is checked again. */
export async function input(ctx, user, message, pending) {
  const lang = user.lang;
  const level = await staff.levelOf(user.user_id);
  if (!level || !staff.can(level, INPUT_NEED[pending.kind] || 'owner')) {
    await state.clear(user.user_id);
    return send(ctx, user.user_id, t(lang, 'sa.denied', { level: level ? lvl(lang, level) : '—' }), null, 'sa-denied');
  }
  if (pending.kind === 'sa_staff') return staffInput(ctx, user, message);
  if (pending.kind === 'sa_restore') return restoreInput(ctx, user, message);
  if (pending.kind === 'sa_logchat') return logChatInput(ctx, user, message);
  if (pending.kind === 'sa_find') {
    const found = await allChats.find(message.text, ADMIN_PAGE);
    const lines = [t(lang, 'sa.search_title', { q: iso(String(message.text || ''), 32), n: found.length }), ''];
    if (!found.length) lines.push(t(lang, 'sa.search_none'));
    found.forEach((c, i) => lines.push(t(lang, 'sa.chats_item', { i: i + 1, icon: chatIcon(c), title: iso(chatTitle(c), 36), n: Number(c.member_count) || 0, flags: Number(c.active) ? '' : ' 🚪' })));
    const kb = [];
    for (let i = 0; i < found.length; i += 4) kb.push(found.slice(i, i + 4).map((c, j) => btn(String(i + j + 1), `sa:c:i:${c.chat_id}`)));
    kb.push([btn(t(lang, 'sa.btn_search'), 'sa:c:q'), btn(t(lang, 'sa.btn_chats'), 'sa:c:f:a:0')]);
    await state.clear(user.user_id);
    return send(ctx, user.user_id, lines.join('\n'), kb, 'sa-search-result');
  }
  if (pending.kind === 'sa_say') {
    const chat = await chats.get(toInt(pending.data.chat));
    const text = String(message.text || '').trim();
    if (!chat || !Number(chat.active)) {
      await state.clear(user.user_id);
      return send(ctx, user.user_id, t(lang, 'sa.say_gone'), [home(lang)], 'sa-say-gone');
    }
    if (!text) return send(ctx, user.user_id, t(lang, 'sa.say_text_only'), [[btn(t(lang, 'common.cancel'), `sa:c:i:${chat.chat_id}`)]], 'sa-say-bad');
    await state.clear(user.user_id);
    const m = await send(ctx, chat.chat_id, t(chat.lang, 'sa.say_header', { text: esc(text.slice(0, 3500)) }), null, 'sa-say-post');
    await audit.log(user.user_id, 'chat.message', { chatId: chat.chat_id, details: { ok: !!m, length: text.length } });
    return chatScreen(ctx, user, level, Number(chat.chat_id), null, t(lang, m ? 'sa.said' : 'sa.say_failed'));
  }
  await state.clear(user.user_id);
  return homeScreen(ctx, user, level);
}

/* ---------- the global switch (owner only; was ui/system.js) ---------- */

export async function status(ctx, lang, place = null, notice = '') {
  const s = await system.status(ctx);
  const now = nowSec();
  const lines = [];
  if (notice) lines.push(notice, '');
  lines.push(t(lang, 'sys.status_title'), '');
  if (s.shutdown) lines.push(t(lang, 'sys.state_off', { ago: dur(lang, now - s.since) }));
  else lines.push(t(lang, s.since ? 'sys.state_on_since' : 'sys.state_on', { ago: dur(lang, now - s.since) }));
  lines.push(t(lang, 'sys.version', { version: s.version, phase: s.phase, data: s.dataVersion }));
  lines.push(t(lang, 'sys.counts', { users: s.users, groups: s.groups, channels: s.channels, registered: s.registered }));
  lines.push(s.broadcast ? t(lang, 'sys.broadcast', { id: s.broadcast.id, status: t(lang, `bc.st_${s.broadcast.status}`) }) : t(lang, 'sys.broadcast_none'));
  lines.push(t(lang, 'sys.errors', { n: s.errors24h }));
  if (s.lastError) lines.push(t(lang, 'sys.last_error', { ago: dur(lang, now - s.lastError.at), source: esc(s.lastError.source), message: esc(short(s.lastError.message, 160)) }));
  if (s.webhook && s.webhook.managed) lines.push(t(lang, 'sys.webhook_managed'));
  else if (s.webhook) {
    lines.push(t(lang, 'sys.webhook', { pending: s.webhook.pending }));
    if (s.webhook.lastError) lines.push(t(lang, 'sys.webhook_error', { ago: dur(lang, now - s.webhook.lastErrorAt), message: esc(short(s.webhook.lastError, 160)) }));
  } else lines.push(t(lang, 'sys.webhook_unknown'));
  const rows = [[btn(t(lang, 'common.refresh'), 'sy:st')]];
  rows.push([s.shutdown ? btn(t(lang, 'sys.btn_activate'), 'sy:on') : btn(t(lang, 'sys.btn_shutdown'), 'sy:off')]);
  rows.push([btn(t(lang, 'sa.btn_home'), 'sa'), btn(t(lang, 'owner.title_short'), 'op')]);
  return screen(ctx, OWNER_ID, place, lines.join('\n'), rows, 'sys-status');
}

export async function askShutdown(ctx, lang, place = null) {
  const s = await system.status(ctx);
  if (s.shutdown) return status(ctx, lang, place, t(lang, 'sys.already_off'));
  const rows = [[btn(t(lang, 'sys.btn_shutdown_yes'), 'sy:offy'), btn(t(lang, 'common.cancel'), 'sy:st')]];
  return screen(ctx, OWNER_ID, place, t(lang, 'sys.shutdown_q'), rows, 'sys-shutdown?');
}

export async function shutdown(ctx, lang, place = null) {
  const done = await system.shutdown(ctx, OWNER_ID);
  return status(ctx, lang, place, t(lang, done ? 'sys.shutdown_done' : 'sys.already_off'));
}

export async function activate(ctx, lang, place = null) {
  const done = await system.activate(ctx, OWNER_ID);
  return status(ctx, lang, place, t(lang, done ? 'sys.activate_done' : 'sys.already_on'));
}

export async function sysCallback(ctx, lang, parts, place) {
  const action = parts[1];
  if (action === 'off') return askShutdown(ctx, lang, place);
  if (action === 'offy') return shutdown(ctx, lang, place);
  if (action === 'on') return activate(ctx, lang, place);
  return status(ctx, lang, place);
}
