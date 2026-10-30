/*
 * A channel's panel, part 2 (Phase 7): posts (protection settings, writing a post through Aegis —
 * now, at a time, or for approval —, the waiting queue, the archive with every version and restore),
 * the crisis / SOS screen and backups. Behaviour lives in ui/channel.js.
 * Levels: viewing View; settings, writing and restoring Settings; publishing without approval,
 * deciding on waiting posts, crisis and restoring a backup Full.
 *
 * callback_data (channel id c):
 *   g:c:C[:s:<key>]       posts and their settings  g:c:C:n             write a post (input)
 *   g:c:C:d:<id>:p|t|x|o:<silent|protect>   a draft: publish / send for approval, at a time (input),
 *                         discard, an option
 *   g:c:C:q[:page]        waiting posts             g:c:C:i:<id>[:v|a|r|c]   one: show, publish, reject, cancel
 *   g:c:C:a[:page]        the archive               g:c:C:p:<id>[:v:<n>|:r:<n>|:ry:<n>]   a post's versions,
 *                         show one, restore one → confirm
 *   g:c:Z[:s|:sy|:l|:ly|:d|:dy|:e|:ey]   crisis: start, revoke links + new primary link, demote
 *                         admins appointed through Aegis, end — each asks first
 *   g:c:Y[:x|:r|:ry|:m|:md|:j|:jy|:js|:jp|:jr|:a]   backups: export, restore (file input) → apply,
 *                         backup chat (input) / remove, copy older posts → start, step, pause, resume,
 *                         the archive as CSV
 * Pending inputs: post_input { chat, step: content | time, id? }; bk_input { chat, step: file | mirror, file? }.
 */
import { InputFile } from 'sdk';
import { BACKUP_FILE_MAX, POSTS_PAGE, QUEUE_MAX, QUEUE_PAGE } from '../config.js';
import * as audit from '../core/audit.js';
import { me } from '../core/bot.js';
import { nextTime, parseTimes, tzLabel, tzOf } from '../core/clock.js';
import { canPublish, contentOf, editTo, publish } from '../core/content.js';
import { csv, isoMinute, utf8Bytes, utf8Text } from '../core/csv.js';
import * as state from '../core/state.js';
import { answer, btn, call, describeError, screen, send, tryCall } from '../core/tg.js';
import { asciiDigits } from '../core/duration.js';
import { esc, iso, normalizeWord, nowSec, parseJson, short, toInt } from '../core/util.js';
import * as admins from '../engines/admins.js';
import * as backup from '../engines/backup.js';
import * as chats from '../engines/chats.js';
import * as crisis from '../engines/crisis.js';
import * as guards from '../engines/guards.js';
import * as invites from '../engines/invites.js';
import * as posts from '../engines/posts.js';
import { grantable, rightsOf } from '../engines/rights.js';
import * as settings from '../engines/settings.js';
import * as users from '../engines/users.js';
import { dur, num, t } from '../i18n/index.js';
import { alert, backupStep, decideItem, fmtWhen, notifyApprovers, postLink, publishItem } from './channel.js';
import { back, guard, needLevel, pairs, removeKeyboard } from './guard.js';
import { linkedGroup, settingBtn, toggle } from './panel_channel.js';
import { lockChat, unlockChat } from './security.js';

const { L } = admins;
export const INPUTS = new Set(['post_input', 'bk_input']);
export const KEYBOARD_INPUTS = new Set(['bk_input']);
const flag = settings.flag;
const title = (g) => iso(g.chat.title || '', 48);
const ago = (lang, at) => dur(lang, Math.max(0, nowSec() - Number(at)));
const ICON = { text: '📝', photo: '🖼', video: '🎬', animation: '🎞', document: '📎', audio: '🎵', voice: '🎤', video_note: '⏺', sticker: '🎭', other: '📦' };
const snippet = (c, max = 60) => iso(c.t || '—', max);
const botRights = (g) => parseJson(g.chat.bot_rights, {}) || {};

/* ---------- posts ---------- */

async function postsScreen(ctx, user, g, place, notice = '') {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const s = await settings.all(ctx, c);
  const lines = [];
  if (notice) lines.push(notice, '');
  lines.push(t(lang, 'post.title', { title: title(g) }), t(lang, 'post.intro'), '');
  lines.push(t(lang, 'post.counts', { waiting: num(lang, await posts.countWaiting(c)), archived: num(lang, (await posts.recent(c, 0)).total) }));
  const r = botRights(g);
  if (r.can_post_messages !== true || r.can_edit_messages !== true || r.can_delete_messages !== true) lines.push('', t(lang, 'post.need_rights'));
  const kb = [[settingBtn(lang, c, s, 'ch_archive', 'C'), settingBtn(lang, c, s, 'ch_approval', 'C')],
    [settingBtn(lang, c, s, 'ch_edit_lock', 'C'), settingBtn(lang, c, s, 'ch_edit_grace', 'C')],
    [btn(t(lang, 'post.btn_new'), `g:${c}:C:n`)],
    [btn(t(lang, 'post.btn_queue'), `g:${c}:C:q`), btn(t(lang, 'post.btn_archive'), `g:${c}:C:a`)], back(lang, `g:${c}`)];
  return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'channel-posts');
}

async function draftScreen(ctx, user, g, item, place, notice = '') {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const o = parseJson(item.options, {}) || {};
  const full = g.acc.level >= L.full;
  const lines = [];
  if (notice) lines.push(notice, '');
  lines.push(t(lang, 'post.draft_title', { title: title(g) }), t(lang, full ? 'post.draft_full' : 'post.draft_approval'));
  if (Number(item.publish_at)) lines.push(t(lang, 'post.draft_when', { time: fmtWhen(Number(item.publish_at)) }));
  const p = `g:${c}:C:d:${item.id}`;
  const onOff = (v) => t(lang, v ? 'common.on' : 'common.off');
  const kb = [[btn(t(lang, full ? 'post.btn_publish' : 'post.btn_send_approval'), `${p}:p`)], [btn(t(lang, 'post.btn_time'), `${p}:t`)],
    [btn(t(lang, 'post.btn_silent', { v: onOff(o.silent) }), `${p}:o:silent`), btn(t(lang, 'post.btn_protect', { v: onOff(o.protect) }), `${p}:o:protect`)],
    [btn(t(lang, 'post.btn_discard'), `${p}:x`)]];
  return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'channel-draft');
}

/* Publishes a draft now (Full) or sends it to the approvers. */
async function submit(ctx, user, g, item) {
  const lang = user.lang;
  if (g.acc.level >= L.full) {
    if (Number(item.publish_at) > nowSec()) {
      if (!(await posts.claim(item.id, 'draft', 'scheduled', user.user_id))) return t(lang, 'post.gone');
      return t(lang, 'post.scheduled', { time: fmtWhen(Number(item.publish_at)) });
    }
    if (!(await posts.claim(item.id, 'draft', 'publishing', user.user_id))) return t(lang, 'post.gone');
    const r = await publishItem(ctx, g.chat, await posts.item(item.id), user.user_id);
    return t(lang, r === 'published' ? 'post.published' : 'post.failed');
  }
  if (await posts.countWaiting(g.chat.chat_id) >= QUEUE_MAX) return t(lang, 'post.queue_full', { max: QUEUE_MAX });
  if (!(await posts.claim(item.id, 'draft', 'pending', 0))) return t(lang, 'post.gone');
  const n = await notifyApprovers(ctx, g.chat, item.id, user.user_id);
  return t(lang, n ? 'post.sent_approval' : 'post.sent_approval_none');
}

async function queueScreen(ctx, user, g, page, place, notice = '') {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const { total, rows } = await posts.waiting(c, page);
  const lines = [];
  if (notice) lines.push(notice, '');
  lines.push(t(lang, 'post.queue_title', { title: title(g), n: num(lang, total) }), '');
  if (!rows.length) lines.push(t(lang, 'post.queue_none'));
  for (const r of rows) {
    const who = r.origin === 'channel' ? t(lang, 'post.from_channel') : iso(await users.displayName(Number(r.author_id)), 24);
    const when = r.status === 'scheduled' || Number(r.publish_at) ? fmtWhen(Number(r.publish_at)) : t(lang, 'post.st_pending');
    lines.push(t(lang, 'post.queue_line', { id: String(r.id), icon: ICON[r.kind] || ICON.other, text: snippet(posts.unpack(r), 40), who, when }));
  }
  const kb = pairs(rows.map((r) => btn(`${ICON[r.kind] || ICON.other} #${r.id}`, `g:${c}:C:i:${r.id}`)));
  const nav = [];
  if (page > 0) nav.push(btn('◀\uFE0F', `g:${c}:C:q:${page - 1}`));
  if ((page + 1) * QUEUE_PAGE < total) nav.push(btn('▶\uFE0F', `g:${c}:C:q:${page + 1}`));
  if (nav.length) kb.push(nav);
  kb.push(back(lang, `g:${c}:C`));
  return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'channel-queue');
}

async function itemScreen(ctx, user, g, item, place, notice = '') {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const lines = [];
  if (notice) lines.push(notice, '');
  const who = item.origin === 'channel' ? t(lang, 'post.from_channel') : iso(await users.displayName(Number(item.author_id)), 32);
  lines.push(t(lang, 'post.item_title', { id: String(item.id) }), t(lang, 'post.item_from', { who, ago: ago(lang, item.at) }),
    t(lang, `post.st_${item.status}`));
  if (Number(item.publish_at)) lines.push(t(lang, 'post.draft_when', { time: fmtWhen(Number(item.publish_at)) }));
  lines.push('', snippet(posts.unpack(item), 300));
  const p = `g:${c}:C:i:${item.id}`;
  const kb = [[btn(t(lang, 'post.btn_show'), `${p}:v`)]];
  if (['pending', 'scheduled'].includes(item.status)) {
    if (item.status === 'pending') kb.push([btn(t(lang, 'post.btn_publish'), `${p}:a`), btn(t(lang, 'post.btn_reject'), `${p}:r`)]);
    else kb.push([btn(t(lang, 'post.btn_cancel_time'), `${p}:c`)]);
  }
  kb.push(back(lang, `g:${c}:C:q`));
  return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'channel-item');
}

async function archiveScreen(ctx, user, g, page, place) {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const { total, rows } = await posts.recent(c, page);
  const lines = [t(lang, 'post.archive_title', { title: title(g), n: num(lang, total) }), ''];
  if (!rows.length) lines.push(t(lang, 'post.archive_none'));
  for (const r of rows) {
    lines.push(t(lang, 'post.archive_line', { icon: ICON[r.kind] || ICON.other, ago: ago(lang, r.posted_at), text: snippet(posts.unpack(r), 40), n: num(lang, Number(r.versions)) }));
  }
  const kb = pairs(rows.map((r) => btn(`${ICON[r.kind] || ICON.other} ${short(posts.unpack(r).t || `#${r.msg_id}`, 20)}`, `g:${c}:C:p:${r.id}`)));
  const nav = [];
  if (page > 0) nav.push(btn('◀\uFE0F', `g:${c}:C:a:${page - 1}`));
  if ((page + 1) * POSTS_PAGE < total) nav.push(btn('▶\uFE0F', `g:${c}:C:a:${page + 1}`));
  if (nav.length) kb.push(nav);
  kb.push(back(lang, `g:${c}:C`));
  return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'channel-archive');
}

async function postScreen(ctx, user, g, post, place, notice = '') {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const lines = [];
  if (notice) lines.push(notice, '');
  lines.push(t(lang, 'post.post_title', { icon: ICON[post.kind] || ICON.other, ago: ago(lang, post.posted_at) }), postLink(g.chat, Number(post.msg_id)));
  if (post.signature) lines.push(t(lang, 'post.signature', { name: iso(post.signature, 40) }));
  lines.push('', t(lang, 'post.current', { text: snippet(posts.unpack(post), 200) }));
  const vs = await posts.versions(post.id);
  if (vs.length) lines.push('', t(lang, 'post.versions', { n: num(lang, vs.length) }));
  for (const v of vs.slice(0, 8)) lines.push(t(lang, 'post.version_line', { n: num(lang, Number(v.n)), ago: ago(lang, v.at), source: t(lang, `post.src_${v.source}`),
    text: snippet(parseJson(v.content, {}) || {}, 40) }));
  const p = `g:${c}:C:p:${post.id}`;
  const kb = vs.slice(0, 8).map((v) => [btn(t(lang, 'post.btn_view_v', { n: num(lang, Number(v.n)) }), `${p}:v:${v.n}`),
    btn(t(lang, 'post.btn_restore_v', { n: num(lang, Number(v.n)) }), `${p}:r:${v.n}`)]);
  kb.push(back(lang, `g:${c}:C:a`));
  return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'channel-post');
}

async function postsAction(ctx, user, g, parts, place) {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const a = parts[3];
  if (!a) return postsScreen(ctx, user, g, place);
  if (a === 's') {
    await toggle(ctx, user, g, parts[4]);
    return postsScreen(ctx, user, g, place);
  }
  if (a === 'q') return queueScreen(ctx, user, g, toInt(parts[4]) || 0, place);
  if (a === 'a') return archiveScreen(ctx, user, g, toInt(parts[4]) || 0, place);
  if (a === 'n') {
    if (!(await needLevel(ctx, user, g, L.settings))) return null;
    await state.set(user.user_id, 'post_input', { chat: c, step: 'content' });
    await answer(ctx);
    return send(ctx, user.user_id, t(lang, 'post.compose_prompt', { title: title(g) }), null, 'post-compose');
  }
  if (a === 'd') {
    const item = await posts.item(toInt(parts[4]));
    if (!item || Number(item.chat_id) !== c || item.status !== 'draft' || Number(item.author_id) !== user.user_id) return postsScreen(ctx, user, g, place, t(lang, 'post.gone'));
    if (!(await needLevel(ctx, user, g, L.settings))) return null;
    const act = parts[5];
    if (act === 'o' && ['silent', 'protect'].includes(parts[6])) {
      const o = parseJson(item.options, {}) || {};
      o[parts[6]] = !o[parts[6]];
      await posts.setOptions(item.id, o);
      return draftScreen(ctx, user, g, await posts.item(item.id), place);
    }
    if (act === 't') {
      await state.set(user.user_id, 'post_input', { chat: c, step: 'time', id: Number(item.id) });
      await answer(ctx);
      const s = await settings.all(ctx, c);
      return send(ctx, user.user_id, t(lang, 'post.time_prompt', { tz: tzLabel(tzOf(s.tz, g.chat.lang)) }), null, 'post-time');
    }
    if (act === 'x') {
      await posts.finish(item.id, 'rejected');
      return postsScreen(ctx, user, g, place, t(lang, 'post.discarded'));
    }
    if (act === 'p') return postsScreen(ctx, user, g, place, await submit(ctx, user, g, item));
    return draftScreen(ctx, user, g, item, place);
  }
  if (a === 'i') {
    const item = await posts.item(toInt(parts[4]));
    if (!item || Number(item.chat_id) !== c) return queueScreen(ctx, user, g, 0, place);
    const act = parts[5];
    if (act === 'v') {
      await answer(ctx, t(lang, 'post.shown'));
      try {
        await publish(ctx, user.user_id, item.kind, posts.unpack(item), {}, 'post-show');
      } catch (err) {
        console.warn(`show ${item.id}: ${describeError(err)}`);
      }
      return null;
    }
    if (act === 'a' || act === 'r') {
      if (!(await needLevel(ctx, user, g, L.full))) return null;
      const r = await decideItem(ctx, g.chat, item, act === 'a', user.user_id);
      return queueScreen(ctx, user, g, 0, place, t(lang, `ch.q_${r}`));
    }
    if (act === 'c') {
      if (Number(item.author_id) !== user.user_id && !(await needLevel(ctx, user, g, L.full))) return null;
      if (await posts.claim(item.id, 'scheduled', 'rejected', user.user_id)) await audit.log(user.user_id, 'post.cancelled', { chatId: c, details: { id: Number(item.id) } });
      return queueScreen(ctx, user, g, 0, place, t(lang, 'post.cancelled'));
    }
    return itemScreen(ctx, user, g, item, place);
  }
  if (a === 'p') {
    const post = await posts.get(toInt(parts[4]));
    if (!post || Number(post.chat_id) !== c) return archiveScreen(ctx, user, g, 0, place);
    const act = parts[5];
    const n = toInt(parts[6]);
    const v = n !== null ? await posts.version(post.id, n) : null;
    if (act === 'v' && v) {
      await answer(ctx, t(lang, 'post.shown'));
      try {
        await publish(ctx, user.user_id, post.kind, parseJson(v.content, { t: '' }), {}, 'post-version');
      } catch (err) {
        await send(ctx, user.user_id, snippet(parseJson(v.content, { t: '' }), 3000), null, 'post-version-text');
      }
      return null;
    }
    if ((act === 'r' || act === 'ry') && v) {
      if (!(await needLevel(ctx, user, g, L.settings))) return null;
      if (act === 'r') {
        const kb = [[btn(t(lang, 'post.btn_restore_yes'), `g:${c}:C:p:${post.id}:ry:${n}`), btn(t(lang, 'common.back'), `g:${c}:C:p:${post.id}`)]];
        return screen(ctx, user.user_id, place, t(lang, 'post.restore_q', { n: num(lang, n) }), kb, 'post-restore?');
      }
      const cur = posts.unpack(post);
      const next = parseJson(v.content, { t: '' });
      try {
        if (!canPublish(post.kind)) throw new Error(t(lang, 'post.cant_restore'));
        await editTo(ctx, c, Number(post.msg_id), post.kind, cur, next, 'post-restore');
        await posts.newVersion(post, next, 'restore');
        await audit.log(user.user_id, 'post.restored', { chatId: c, details: { msg: Number(post.msg_id), n } });
        return postScreen(ctx, user, g, await posts.get(post.id), place, t(lang, 'post.restored', { n: num(lang, n) }));
      } catch (err) {
        return postScreen(ctx, user, g, post, place, t(lang, 'chat.tg_error', { error: esc(describeError(err)) }));
      }
    }
    return postScreen(ctx, user, g, post, place);
  }
  return postsScreen(ctx, user, g, place);
}

/* ---------- crisis ---------- */

async function crisisScreen(ctx, user, g, place, notice = '') {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const cur = await crisis.active(c);
  const lines = [];
  if (notice) lines.push(notice, '');
  lines.push(t(lang, 'post.crisis_title', { title: title(g) }), '');
  const kb = [];
  if (cur) {
    lines.push(t(lang, 'post.crisis_on', { ago: ago(lang, cur.started_at), by: iso(await users.displayName(Number(cur.by_id)), 32) }));
    const rep = parseJson(cur.report, {}) || {};
    lines.push(t(lang, 'post.crisis_report', { links: num(lang, rep.links || 0), admins: num(lang, rep.admins || 0),
      group: t(lang, rep.group ? 'common.on' : 'common.off') }));
    kb.push([btn(t(lang, 'post.btn_crisis_end'), `g:${c}:Z:e`)]);
  } else {
    lines.push(t(lang, 'post.crisis_intro'));
    kb.push([btn(t(lang, 'post.btn_crisis_start'), `g:${c}:Z:s`)]);
    kb.push([btn(t(lang, 'post.btn_crisis_links'), `g:${c}:Z:l`)], [btn(t(lang, 'post.btn_crisis_admins'), `g:${c}:Z:d`)]);
  }
  kb.push(back(lang, `g:${c}`));
  return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'channel-crisis');
}

/* Revokes every live link made through Aegis and makes a new primary link (the old one stops working). */
async function revokeLinks(ctx, chat) {
  let n = 0;
  for (const row of await invites.list(chat.chat_id)) {
    const ok = await tryCall(ctx, 'revokeChatInviteLink', { chat_id: chat.chat_id, invite_link: row.link }, 'crisis-revoke');
    await invites.markRevoked(row.id);
    if (ok) n += 1;
  }
  const primary = !!(await tryCall(ctx, 'exportChatInviteLink', { chat_id: chat.chat_id }, 'crisis-primary'));
  return { links: n, primary };
}

/* Demotes the admins appointed through Aegis (not the person asking, not the creator). Gives [{ id, rights }]. */
async function demoteAegisAdmins(ctx, g) {
  const out = [];
  const allowed = grantable(g.chat.type);
  for (const r of await admins.listRows(g.chat.chat_id)) {
    const uid = Number(r.user_id);
    if (r.status !== 'administrator' || !Number(r.via_aegis) || Number(r.is_bot) || uid === g.acc.id) continue;
    const rights = Object.keys(rightsOf(admins.memberOfRow(r))).filter((x) => allowed.includes(x));
    try {
      await admins.demote(ctx, g.chat, g.acc.id, uid);
      out.push({ id: uid, rights });
    } catch (err) {
      console.warn(`crisis demote ${uid}: ${describeError(err)}`);
    }
  }
  return out;
}

async function startCrisis(ctx, user, g) {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const s = await settings.all(ctx, c);
  const saved = { settings: { ch_jr_mode: s.ch_jr_mode, ch_approval: s.ch_approval, ch_edit_lock: s.ch_edit_lock, ch_edit_grace: s.ch_edit_grace },
    admins: [], group: 0, lockdown: 0 };
  const id = await crisis.start(c, user.user_id, saved);
  if (!id) return t(lang, 'post.crisis_already');
  await settings.set(ctx, c, 'ch_jr_mode', 'decline', user.user_id);
  await settings.set(ctx, c, 'ch_approval', '1', user.user_id);
  await settings.set(ctx, c, 'ch_edit_lock', '1', user.user_id);
  await settings.set(ctx, c, 'ch_edit_grace', '0', user.user_id);
  const links = await revokeLinks(ctx, g.chat);
  if (admins.canManageAdmins(g.acc) && botRights(g).can_promote_members === true) saved.admins = await demoteAegisAdmins(ctx, g);
  const gid = await linkedGroup(ctx, g.chat);
  const grp = gid ? await chats.get(gid) : null;
  if (grp && Number(grp.registered) && grp.type === 'supergroup') {
    const r = await lockChat(ctx, grp, 'emergency', { byId: user.user_id, reason: 'crisis' });
    if (r.ok && !r.already) {
      saved.group = gid;
      saved.lockdown = r.id;
    }
  }
  const report = { links: links.links, primary: links.primary, admins: saved.admins.length, group: !!saved.lockdown };
  await crisis.update(id, saved, report);
  await audit.log(user.user_id, 'channel.crisis_start', { chatId: c, details: report });
  const by = iso(await users.displayName(user.user_id), 32);
  await alert(ctx, g.chat, 'security', (l) => t(l, 'post.crisis_alert', { by, links: num(l, report.links), admins: num(l, report.admins) }));
  return t(lang, 'post.crisis_started');
}

async function endCrisis(ctx, user, g) {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const cur = await crisis.active(c);
  const row = cur ? await crisis.end(cur.id, user.user_id) : null;
  if (!row) return t(lang, 'post.crisis_none');
  const saved = row.saved || {};
  for (const [k, v] of Object.entries(saved.settings || {})) await settings.set(ctx, c, k, v, user.user_id);
  let back2 = 0;
  for (const a of saved.admins || []) {
    try {
      await admins.applyRights(ctx, g.chat, user.user_id, Number(a.id), a.rights || [], 'promote');
      back2 += 1;
    } catch (err) {
      console.warn(`crisis restore ${a.id}: ${describeError(err)}`);
    }
  }
  if (saved.lockdown) {
    const ld = await guards.lockdownById(Number(saved.lockdown));
    const grp = await chats.get(Number(saved.group));
    if (ld && grp && !Number(ld.ended_at)) await unlockChat(ctx, grp, ld, user.user_id);
  }
  await audit.log(user.user_id, 'channel.crisis_end', { chatId: c, details: { admins: back2 } });
  const by = iso(await users.displayName(user.user_id), 32);
  await alert(ctx, g.chat, 'security', (l) => t(l, 'post.crisis_end_alert', { by }));
  return t(lang, 'post.crisis_ended', { n: num(lang, back2), total: num(lang, (saved.admins || []).length) });
}

async function crisisAction(ctx, user, g, parts, place) {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const a = parts[3];
  if (!a) return crisisScreen(ctx, user, g, place);
  if (!(await needLevel(ctx, user, g, L.full))) return null;
  const ask = { s: 'post.crisis_start_q', l: 'post.crisis_links_q', d: 'post.crisis_admins_q', e: 'post.crisis_end_q' };
  if (ask[a]) {
    const kb = [[btn(t(lang, 'chat.btn_confirm'), `g:${c}:Z:${a}y`), btn(t(lang, 'common.back'), `g:${c}:Z`)]];
    return screen(ctx, user.user_id, place, t(lang, ask[a]), kb, 'crisis?');
  }
  if (a === 'sy') return crisisScreen(ctx, user, g, place, await startCrisis(ctx, user, g));
  if (a === 'ey') return crisisScreen(ctx, user, g, place, await endCrisis(ctx, user, g));
  if (a === 'ly') {
    const r = await revokeLinks(ctx, g.chat);
    await audit.log(user.user_id, 'channel.links_revoked', { chatId: c, details: r });
    return crisisScreen(ctx, user, g, place, t(lang, 'post.links_revoked', { n: num(lang, r.links), primary: t(lang, r.primary ? 'common.on' : 'common.off') }));
  }
  if (a === 'dy') {
    if (!admins.canManageAdmins(g.acc) || botRights(g).can_promote_members !== true) return crisisScreen(ctx, user, g, place, t(lang, 'post.cant_demote'));
    const list = await demoteAegisAdmins(ctx, g);
    await audit.log(user.user_id, 'channel.admins_demoted', { chatId: c, details: { n: list.length } });
    return crisisScreen(ctx, user, g, place, t(lang, 'post.admins_demoted', { n: num(lang, list.length) }));
  }
  return crisisScreen(ctx, user, g, place);
}

/* ---------- backups ---------- */

async function backupScreen(ctx, user, g, place, notice = '') {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const s = await settings.all(ctx, c);
  const lines = [];
  if (notice) lines.push(notice, '');
  lines.push(t(lang, 'post.backup_title', { title: title(g) }), t(lang, 'post.backup_intro'), '');
  const mirror = s.ch_mirror !== '0' ? await tryCall(ctx, 'getChat', { chat_id: Number(s.ch_mirror) }, 'mirror-chat') : null;
  lines.push(s.ch_mirror !== '0' ? t(lang, 'post.mirror_on', { name: iso((mirror && mirror.title) || s.ch_mirror, 48) }) : t(lang, 'post.mirror_off'));
  const job = await backup.job(c);
  if (job) {
    lines.push(t(lang, `post.job_${job.status}`, { next: num(lang, Math.min(Number(job.next_id), Number(job.last_id))), last: num(lang, Number(job.last_id)),
      copied: num(lang, Number(job.copied)), error: esc(job.error || '') }));
  }
  const kb = [[btn(t(lang, 'post.btn_export'), `g:${c}:Y:x`), btn(t(lang, 'post.btn_restore'), `g:${c}:Y:r`)],
    [btn(t(lang, 'post.btn_mirror'), `g:${c}:Y:m`)].concat(s.ch_mirror !== '0' ? [btn(t(lang, 'logs.btn_remove'), `g:${c}:Y:md`)] : [])];
  if (s.ch_mirror !== '0') {
    if (job && job.status === 'running') kb.push([btn(t(lang, 'post.btn_job_step'), `g:${c}:Y:js`), btn(t(lang, 'post.btn_job_pause'), `g:${c}:Y:jp`)]);
    else if (job && job.status === 'paused') kb.push([btn(t(lang, 'post.btn_job_resume'), `g:${c}:Y:jr`)]);
    else kb.push([btn(t(lang, 'post.btn_job_start'), `g:${c}:Y:j`)]);
  }
  kb.push([btn(t(lang, 'post.btn_archive_csv'), `g:${c}:Y:a`)], back(lang, `g:${c}`));
  return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'channel-backups');
}

const MIRROR_KEYBOARD = (lang) => ({ keyboard: [[{ text: t(lang, 'logs.pick_channel'), request_chat: { request_id: 61, chat_is_channel: true, bot_is_member: true } }],
  [{ text: t(lang, 'logs.pick_group'), request_chat: { request_id: 62, chat_is_channel: false, bot_is_member: true } }], [{ text: t(lang, 'common.cancel') }]],
resize_keyboard: true, one_time_keyboard: true });

async function backupAction(ctx, user, g, parts, place) {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const a = parts[3];
  if (!a) return backupScreen(ctx, user, g, place);
  if (!(await needLevel(ctx, user, g, a === 'r' || a === 'ry' ? L.full : L.settings))) return null;
  if (a === 'x') {
    await answer(ctx, t(lang, 'post.export_sent'));
    const data = await backup.make(g.chat);
    const file = new InputFile(utf8Bytes(JSON.stringify(data, null, 1)), `aegis-backup-${String(c).replace('-', '')}.json`, { type: 'application/json' });
    await tryCall(ctx, 'sendDocument', { chat_id: user.user_id, document: file, caption: t(lang, 'post.export_caption', { title: title(g) }), parse_mode: 'HTML' }, 'backup-export');
    await audit.log(user.user_id, 'channel.backup_export', { chatId: c });
    return null;
  }
  if (a === 'a') {
    await answer(ctx, t(lang, 'post.export_sent'));
    const rows = [['message_id', 'date', 'kind', 'text', 'link', 'versions']];
    for (const p of await posts.all(c, 2000)) rows.push([p.msg_id, isoMinute(Number(p.posted_at)), p.kind, posts.unpack(p).t || '', postLink(g.chat, Number(p.msg_id)), p.versions]);
    const file = new InputFile(utf8Bytes(csv(rows)), `aegis-posts-${String(c).replace('-', '')}.csv`, { type: 'text/csv' });
    await tryCall(ctx, 'sendDocument', { chat_id: user.user_id, document: file }, 'backup-archive');
    return null;
  }
  if (a === 'r' || a === 'm') {
    await state.set(user.user_id, 'bk_input', { chat: c, step: a === 'r' ? 'file' : 'mirror' });
    await answer(ctx);
    if (a === 'm') return send(ctx, user.user_id, t(lang, 'post.mirror_prompt'), null, 'mirror-ask', { reply_markup: MIRROR_KEYBOARD(lang) });
    return send(ctx, user.user_id, t(lang, 'post.restore_prompt'), null, 'restore-ask');
  }
  if (a === 'ry') {
    const st = await state.get(user.user_id);
    if (!st || st.kind !== 'bk_input' || st.data.step !== 'confirm' || st.data.chat !== c) return backupScreen(ctx, user, g, place, t(lang, 'post.gone'));
    await state.clear(user.user_id);
    const checked = await readBackup(ctx, st.data.file, g.chat);
    if (checked.error) return backupScreen(ctx, user, g, place, t(lang, `post.restore_err_${checked.error}`));
    const n = await backup.apply(ctx, g.chat, checked.data, user.user_id);
    await audit.log(user.user_id, 'channel.backup_restore', { chatId: c, details: { n } });
    return backupScreen(ctx, user, g, place, t(lang, 'post.restore_done', { n: num(lang, n) }));
  }
  if (a === 'md') {
    await settings.set(ctx, c, 'ch_mirror', '0', user.user_id);
    return backupScreen(ctx, user, g, place, t(lang, 'post.mirror_removed'));
  }
  if (a === 'j') {
    const last = await posts.lastMsgId(c);
    if (!last) return backupScreen(ctx, user, g, place, t(lang, 'post.job_no_last'));
    const kb = [[btn(t(lang, 'chat.btn_confirm'), `g:${c}:Y:jy`), btn(t(lang, 'common.back'), `g:${c}:Y`)]];
    return screen(ctx, user.user_id, place, t(lang, 'post.job_q', { last: num(lang, last) }), kb, 'backup-job?');
  }
  if (a === 'jy') {
    const s = await settings.all(ctx, c);
    const last = await posts.lastMsgId(c);
    if (s.ch_mirror === '0' || !last) return backupScreen(ctx, user, g, place);
    await backup.startJob(c, Number(s.ch_mirror), last, user.user_id);
    await audit.log(user.user_id, 'channel.backup_job', { chatId: c, details: { last } });
    await backupStep(ctx, await backup.job(c));
    return backupScreen(ctx, user, g, place, t(lang, 'post.job_started'));
  }
  if (a === 'js') {
    const job = await backup.job(c);
    const r = job ? await backupStep(ctx, job) : null;
    return backupScreen(ctx, user, g, place, r ? t(lang, `post.step_${r}`) : '');
  }
  if (a === 'jp' || a === 'jr') {
    await backup.setJob(c, { status: a === 'jp' ? 'paused' : 'running' });
    if (a === 'jr') await backup.setJob(c, { retryAt: 0 });
    return backupScreen(ctx, user, g, place);
  }
  return backupScreen(ctx, user, g, place);
}

/* Downloads a backup file and checks it for the chat. */
async function readBackup(ctx, fileId, chat) {
  try {
    const bytes = await call(ctx, 'getFileContent', { file_id: fileId }, 'restore-file');
    if (!bytes || bytes.length > BACKUP_FILE_MAX) return { error: 'size' };
    return backup.check(utf8Text(bytes), chat);
  } catch (err) {
    console.warn(`backup file: ${describeError(err)}`);
    return { error: 'file' };
  }
}

/* ---------- entry points ---------- */

export async function callback(ctx, user, g, parts, place) {
  if (g.chat.type !== 'channel') return null;
  if (parts[2] === 'C') return postsAction(ctx, user, g, parts, place);
  if (parts[2] === 'Z') return crisisAction(ctx, user, g, parts, place);
  if (parts[2] === 'Y') return backupAction(ctx, user, g, parts, place);
  return null;
}

/* «12:30» today/tomorrow, or «2026-11-02 08:00», in the chat's time zone. Gives a unix time or 0. */
export function parseWhen(text, now, tz) {
  const s = asciiDigits(String(text || '')).trim();
  const full = /^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2})[:.](\d{2})$/.exec(s);
  if (full) {
    const [, y, mo, d, h, mi] = full.map(Number);
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return 0;
    const at = Math.floor(Date.UTC(y, mo - 1, d, h, mi) / 1000) - Number(tz) * 60;
    return at > now ? at : 0;
  }
  const r = parseTimes(s, 1);
  if (r.error) return 0;
  return nextTime(r.times, now, tz);
}

export async function input(ctx, user, message, pending) {
  const lang = user.lang;
  const text = String(message.text || '').trim();
  if (text && normalizeWord(text) === normalizeWord(t(lang, 'common.cancel'))) {
    await state.clear(user.user_id);
    return send(ctx, user.user_id, t(lang, 'common.cancelled'), null, 'input-cancelled', removeKeyboard);
  }
  const d = pending.data;
  const g = await guard(ctx, user, d.chat, pending.kind === 'bk_input' && d.step === 'file' ? L.full : L.settings, null);
  if (!g || g.chat.type !== 'channel') {
    await state.clear(user.user_id);
    return null;
  }
  const c = g.chat.chat_id;
  if (pending.kind === 'post_input' && d.step === 'content') {
    const { kind, c: content } = contentOf(message);
    if (!canPublish(kind) || message.media_group_id) return send(ctx, user.user_id, t(lang, 'post.compose_bad'), null, 'post-compose-bad');
    await state.clear(user.user_id);
    const id = await posts.enqueue(c, kind, content, { authorId: user.user_id, status: 'draft' });
    return draftScreen(ctx, user, g, await posts.item(id), null);
  }
  if (pending.kind === 'post_input' && d.step === 'time') {
    const item = await posts.item(Number(d.id));
    if (!item || item.status !== 'draft' || Number(item.author_id) !== user.user_id) {
      await state.clear(user.user_id);
      return postsScreen(ctx, user, g, null, t(lang, 'post.gone'));
    }
    const s = await settings.all(ctx, c);
    const tz = tzOf(s.tz, g.chat.lang);
    const at = parseWhen(text, nowSec(), tz);
    if (!at || at > nowSec() + 30 * 86400) return send(ctx, user.user_id, t(lang, 'post.time_bad', { tz: tzLabel(tz) }), null, 'post-time-bad');
    await state.clear(user.user_id);
    await posts.setTime(item.id, at);
    return draftScreen(ctx, user, g, await posts.item(item.id), null, t(lang, 'post.time_set', { time: fmtWhen(at) }));
  }
  if (pending.kind === 'bk_input' && d.step === 'file') {
    const doc = message.document;
    if (!doc) return send(ctx, user.user_id, t(lang, 'post.restore_prompt'), null, 'restore-again');
    if (Number(doc.file_size) > BACKUP_FILE_MAX) return send(ctx, user.user_id, t(lang, 'post.restore_err_size'), null, 'restore-big');
    const checked = await readBackup(ctx, doc.file_id, g.chat);
    if (checked.error) return send(ctx, user.user_id, t(lang, `post.restore_err_${checked.error}`), null, 'restore-bad');
    await state.set(user.user_id, 'bk_input', { chat: c, step: 'confirm', file: doc.file_id });
    const k = checked.counts;
    const lines = [t(lang, 'post.restore_summary', { settings: num(lang, k.settings), entries: num(lang, k.entries), locks: num(lang, k.locks + k.guards) })];
    if (checked.other) lines.push(t(lang, 'post.restore_other'));
    const kb = [[btn(t(lang, 'post.btn_restore_apply'), `g:${c}:Y:ry`), btn(t(lang, 'common.back'), `g:${c}:Y`)]];
    return send(ctx, user.user_id, lines.join('\n'), kb, 'restore-confirm');
  }
  if (pending.kind === 'bk_input' && d.step === 'mirror') {
    const id = (message.chat_shared && message.chat_shared.chat_id) || null;
    const ref = id || fakeChat(message);
    if (!ref) return send(ctx, user.user_id, t(lang, 'logs.set_bad'), null, 'mirror-bad');
    const target = await tryCall(ctx, 'getChat', { chat_id: ref }, 'mirror-target');
    const bot = target ? await tryCall(ctx, 'getChatMember', { chat_id: target.id, user_id: (await me(ctx)).id }, 'mirror-bot') : null;
    const mine = target ? await tryCall(ctx, 'getChatMember', { chat_id: target.id, user_id: user.user_id }, 'mirror-user') : null;
    if (!target || !bot) return send(ctx, user.user_id, t(lang, 'logs.bot_not_there'), null, 'mirror-bad');
    if (target.id === c) return send(ctx, user.user_id, t(lang, 'logs.same_chat'), null, 'mirror-same');
    if (!mine || !['creator', 'administrator'].includes(mine.status)) return send(ctx, user.user_id, t(lang, 'logs.not_admin_there'), null, 'mirror-bad');
    if (!(await send(ctx, target.id, t(g.chat.lang, 'post.mirror_connected', { title: title(g) }), null, 'mirror-connected'))) {
      return send(ctx, user.user_id, t(lang, 'logs.test_failed'), null, 'mirror-bad');
    }
    await state.clear(user.user_id);
    await settings.set(ctx, c, 'ch_mirror', String(target.id), user.user_id);
    await send(ctx, user.user_id, t(lang, 'adv.saved'), null, 'mirror-done', removeKeyboard);
    return backupScreen(ctx, user, g, null);
  }
  await state.clear(user.user_id);
  return null;
}

/* @username, t.me/… or a -100… id typed instead of picking a chat. */
function fakeChat(message) {
  const o = message.forward_origin;
  if (o && o.type === 'channel' && o.chat) return o.chat.id;
  const text = String(message.text || '').trim();
  if (/^-100\d{6,16}$/.test(text)) return toInt(text);
  const m = /^(?:https?:\/\/)?(?:t\.me\/|@)([A-Za-z][A-Za-z0-9_]{3,31})\/?$/.exec(text);
  return m ? `@${m[1]}` : null;
}

