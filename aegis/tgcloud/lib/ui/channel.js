/*
 * Channels at work (Phase 7). The panel is ui/panel_channel.js and ui/panel_posts.js.
 *
 * onPost() (channel_post): the channel's info changes (title lock, alerts); posts held for approval
 *   (ch_approval: the post is copied into the queue, removed from the channel and sent to the
 *   approvers); the footer and default buttons; the archive; self-destructing posts; the backup copy.
 * onEditedPost() (edited_channel_post): every edit becomes a version; with ch_edit_lock a late edit is
 *   put back to the previous version; ch_al_edits tells the owner.
 * onJoinRequest(): blacklist, known fakes, suspicious names/bios, request bursts, captcha (in the
 *   requester's private chat, or the guard bot's Mini App when Telegram sends a query), then the
 *   request mode (admins decide / approve / decline). Every request is recorded for the panel.
 * onMemberChange() (chat_member in a channel): subscribers per day and per invite link, the
 *   impersonation and known fakes on joins, bursts of joins, and alerts about admins and their rights.
 * discussion(): the channel's discussion group — comments as other channels, impersonation, known
 *   fakes, «first comment» bots, comments from non-subscribers (settings dg_* of the channel).
 * dmMessage(): the channel's direct messages chat — blocked users, links, scams, fakes, floods,
 *   suggested posts (settings dm_*); offending messages are deleted (or a suggested post declined).
 * sweep() (at most once a minute): scheduled posts, and one step of copying older posts to backup.
 * Audit Mode (of the channel): nothing is held, reverted, declined, removed or deleted by Aegis on
 * its own; it is logged instead.
 */
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { APP_URL, BACKUP_BATCH, DM_WINDOW_SEC, JR_FLOOD_HOLD_SEC, QUEUE_MAX } from '../config.js';
import * as audit from '../core/audit.js';
import { answer, btn, call, describeError, isFlood, me, retryAfter, send, tryCall, urlBtn } from '../core/tg.js';
import { canPublish, contentOf, editTo, hasCaption, parseButtons, publish, same, withFooter } from '../core/content.js';
import { linksOf, scan } from '../core/msgscan.js';
import { dangerousFile, fingerprint, makeCaptcha, nameSignals, scamHits, skeleton } from '../core/signals.js';
import { esc, fullName, iso, nowSec, parseJson, short, toInt } from '../core/util.js';
import * as admins from '../engines/admins.js';
import * as backup from '../engines/backup.js';
import * as channels from '../engines/channels.js';
import * as chats from '../engines/chats.js';
import * as guards from '../engines/guards.js';
import * as invites from '../engines/invites.js';
import * as lists from '../engines/lists.js';
import * as logs from '../engines/logs.js';
import * as members from '../engines/members.js';
import * as msglog from '../engines/msglog.js';
import * as posts from '../engines/posts.js';
import * as punish from '../engines/punish.js';
import { rightsOf } from '../engines/rights.js';
import * as settings from '../engines/settings.js';
import * as users from '../engines/users.js';
import { pickLang, t } from '../i18n/index.js';
import { deleteMessage, isAdmin, postNotice } from './enforce.js';
import { requestCaptcha } from './security.js';

const { L } = admins;
const flag = settings.flag;
const auditOn = (s) => flag(s, 'audit');
const title = (chat) => iso(chat.title || '', 48);
const inChat = (m) => !!m && (['member', 'administrator', 'creator'].includes(m.status) || (m.status === 'restricted' && m.is_member === true));
const isAdminStatus = (st) => st === 'creator' || st === 'administrator';
/* Rights an alert names; the dangerous ones are marked. */
const WATCHED = ['can_change_info', 'can_post_messages', 'can_edit_messages', 'can_delete_messages', 'can_invite_users', 'can_restrict_members',
  'can_pin_messages', 'can_manage_video_chats', 'can_promote_members', 'can_manage_direct_messages'];
const DANGEROUS = new Set(['can_promote_members', 'can_change_info', 'can_delete_messages', 'can_restrict_members', 'can_invite_users']);

export const isChannel = (chat) => !!chat && chat.type === 'channel' && Number(chat.active) === 1 && Number(chat.registered) === 1;

/* A post's public link (public channel) or the members-only one. */
export function postLink(chat, msgId) {
  return chat.username ? `https://t.me/${chat.username}/${msgId}` : `https://t.me/c/${String(chat.chat_id).replace(/^-100/, '')}/${msgId}`;
}

async function langOf(from) {
  const u = await users.get(from.id);
  return u && Number(u.lang_set) ? u.lang : pickLang(from.language_code);
}

async function creatorId(chatId) {
  const r = (await admins.listRows(chatId)).find((x) => x.status === 'creator');
  return r ? Number(r.user_id) : 0;
}

/* The creator and the admins with Full access (who decide on held posts). */
export async function approvers(chatId) {
  const rows = await admins.listRows(chatId);
  const ov = await admins.overrides(chatId);
  const out = [];
  for (const r of rows) {
    if (Number(r.is_bot)) continue;
    const o = ov.get(Number(r.user_id));
    if (admins.effectiveLevel(admins.memberOfRow(r), o ? o.level : null) >= L.full) out.push(Number(r.user_id));
  }
  return out;
}

/*
 * An alert about a channel: the log channel (when set and the category is on) and the creator's
 * private chat. text(lang) builds it in the reader's language. Counted for the dashboard.
 */
export async function alert(ctx, chat, category, text, rows = null) {
  if (ctx.quiet) return;
  await logs.post(ctx, chat, category, text(chat.lang), rows ? rows(chat.lang) : null);
  const id = await creatorId(chat.chat_id);
  const u = id ? await users.get(id) : null;
  if (u && Number(u.started) && !Number(u.blocked)) {
    await send(ctx, id, `${t(u.lang, 'logs.header', { title: iso(chat.title || '', 40) })}\n${text(u.lang)}`, rows ? rows(u.lang) : null, `ch-alert-${category}`);
  }
  await audit.log(0, 'channel.alert', { chatId: chat.chat_id, details: { category } });
}

/* ---------- names and fakes ---------- */

const norm = (x) => String(x || '').trim().replace(/^@/, '').toLowerCase();

/* Is this account (or a chat) on the channel's list of known fakes? */
export function isFake(s, ref) {
  const list = (parseJson(s.ch_fakes, []) || []).map(norm);
  if (!list.length || !ref) return false;
  return (ref.username && list.includes(norm(ref.username))) || list.includes(String(ref.id));
}

/* Known fakes named in a text (@username, t.me/username). */
function fakesIn(s, text) {
  const list = (parseJson(s.ch_fakes, []) || []).map(norm).filter((x) => !/^-?\d+$/.test(x));
  if (!list.length || !text) return false;
  const found = [...String(text).matchAll(/(?:@|t\.me\/|telegram\.me\/)([A-Za-z0-9_]{4,})/gi)].map((m) => m[1].toLowerCase());
  return found.some((u) => list.includes(u));
}

async function adminNames(chatId) {
  return (await admins.listRows(chatId)).filter((r) => !Number(r.is_bot)).map((r) => [r.first_name, r.last_name].filter(Boolean).join(' ')).filter(Boolean);
}

/*
 * Why a person looks suspicious for this channel: impersonating it or its admins (look-alike name
 * or username), links or invisible characters in the name, look-alike letters, a scam bio, a name
 * on the «names» list. Gives a list of reasons (empty = fine).
 */
export async function suspicious(chat, user, bio = null) {
  const out = nameSignals(user, [chat.title || '', ...(await adminNames(chat.chat_id))]).filter((x) => x !== 'no_username');
  if (user.username && chat.username && user.username.toLowerCase() !== chat.username.toLowerCase()
    && skeleton(user.username) === skeleton(chat.username)) out.push('impersonation');
  if (bio && scamHits(bio).length) out.push('scam_bio');
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ').toLowerCase();
  for (const p of await lists.all(chat.chat_id, 'nam', 100)) if (p.ekey && name.includes(String(p.ekey).toLowerCase())) out.push('name_pattern');
  return [...new Set(out)];
}

const reasonText = (lang, reasons) => reasons.map((r) => t(lang, `ch.why_${r}`)).join(t(lang, 'common.sep'));

/* ---------- posts ---------- */

const SERVICE = ['pinned_message', 'channel_chat_created', 'message_auto_delete_timer_changed', 'video_chat_scheduled', 'video_chat_started',
  'video_chat_ended', 'video_chat_participants_invited', 'boost_added', 'chat_background_set', 'paid_message_price_changed',
  'direct_message_price_changed', 'giveaway_created', 'giveaway_completed', 'forum_topic_created'];

export async function onPost(ctx, m) {
  const chat = await chats.get(m.chat.id);
  if (!isChannel(chat)) return;
  const s = await settings.all(ctx, chat.chat_id);
  if (m.new_chat_title || m.new_chat_photo || m.delete_chat_photo) {
    await infoChange(ctx, chat, m, s);
    return;
  }
  if (SERVICE.some((k) => m[k] !== undefined)) return;
  const { kind, c } = contentOf(m);
  if (flag(s, 'ch_approval') && await hold(ctx, chat, s, m, kind, c)) return;
  let cur = c;
  if (s.ch_footer && hasCaption(kind) && !(c.t || '').endsWith(s.ch_footer)) {
    const next = withFooter(kind, c.t, s.ch_footer);
    if (next !== (c.t || '')) {
      try {
        await editTo(ctx, chat.chat_id, m.message_id, kind, c, { ...c, t: next }, 'post-footer');
        cur = { ...c, t: next };
      } catch (err) {
        console.warn(`footer ${chat.chat_id}: ${describeError(err)}`);
      }
    }
  }
  if (s.ch_buttons && !m.media_group_id && !m.reply_markup) {
    const rows = buttonRows(s);
    if (rows.length) await tryCall(ctx, 'editMessageReplyMarkup', { chat_id: chat.chat_id, message_id: m.message_id, reply_markup: { inline_keyboard: rows } }, 'post-buttons');
  }
  await afterPublish(ctx, chat, s, m.message_id, kind, cur, { signature: m.author_signature || null, album: m.media_group_id || null, at: Number(m.date) || nowSec() });
}

export function buttonRows(s) {
  const p = s.ch_buttons ? parseButtons(s.ch_buttons) : { rows: [] };
  return (p.rows || []).map((r) => r.map((b) => urlBtn(b.text, b.url)));
}

/* What follows every post: the archive, its self-destruct time, the copy in the backup chat. */
export async function afterPublish(ctx, chat, s, msgId, kind, c, meta = {}) {
  const id = chat.chat_id;
  if (flag(s, 'ch_archive')) await posts.save(id, msgId, kind, c, meta);
  const ttl = Number(s.ch_post_ttl);
  if (ttl) await msglog.add(id, msgId, 0, 'post', nowSec() + ttl);
  if (s.ch_mirror !== '0') await tryCall(ctx, 'copyMessage', { chat_id: Number(s.ch_mirror), from_chat_id: id, message_id: msgId, disable_notification: true }, 'mirror');
}

/* Approval on: a post that didn't come through Aegis waits in the queue. Gives true when it was held. */
async function hold(ctx, chat, s, m, kind, c) {
  const id = chat.chat_id;
  const link = postLink(chat, m.message_id);
  if (auditOn(s)) {
    await alert(ctx, chat, 'security', (l) => t(l, 'ch.hold_audit', { link }));
    return false;
  }
  if (!canPublish(kind)) {
    await alert(ctx, chat, 'security', (l) => t(l, 'ch.hold_cant', { link }));
    return false;
  }
  if (await posts.countWaiting(id) >= QUEUE_MAX) {
    await alert(ctx, chat, 'security', (l) => t(l, 'ch.queue_full', { link }));
    return false;
  }
  if (!(await deleteMessage(ctx, id, m.message_id, 'post-hold'))) {
    await alert(ctx, chat, 'security', (l) => t(l, 'ch.hold_failed', { link }));
    return false;
  }
  const qid = await posts.enqueue(id, kind, c, { origin: 'channel', options: { signature: m.author_signature || '' } });
  await audit.log(0, 'post.held', { chatId: id, details: { id: qid } });
  await notifyApprovers(ctx, chat, qid);
  return true;
}

const queueRows = (lang, id) => [[btn(t(lang, 'ch.btn_q_publish'), `pq:${id}:a`), btn(t(lang, 'ch.btn_q_reject'), `pq:${id}:r`)]];

/* The approvers get the post itself and a message with Publish / Reject. */
export async function notifyApprovers(ctx, chat, id, exceptId = 0) {
  const item = await posts.item(id);
  if (!item) return 0;
  const c = posts.unpack(item);
  const opts = parseJson(item.options, {}) || {};
  let n = 0;
  for (const uid of (await approvers(chat.chat_id)).slice(0, 10)) {
    if (uid === exceptId) continue;
    const u = await users.get(uid);
    if (!u || !Number(u.started) || Number(u.blocked)) continue;
    try {
      await publish(ctx, uid, item.kind, c, {}, 'queue-preview');
    } catch (err) {
      console.warn(`queue preview ${uid}: ${describeError(err)}`);
      continue;
    }
    const who = item.origin === 'channel'
      ? t(u.lang, 'ch.q_from_channel', { signature: opts.signature ? iso(opts.signature, 40) : '—' })
      : t(u.lang, 'ch.q_from', { user: iso(await users.displayName(Number(item.author_id))) });
    const when = Number(item.publish_at) ? [t(u.lang, 'ch.q_when', { time: fmtWhen(Number(item.publish_at)) })] : [];
    if (await send(ctx, uid, [t(u.lang, 'ch.q_title', { title: title(chat) }), who, ...when].join('\n'), queueRows(u.lang, id), 'queue-ask')) n += 1;
  }
  return n;
}

/* A moment as «2026-10-30 21:00 UTC». */
export function fmtWhen(at) {
  const d = new Date(at * 1000);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

async function dropButtons(ctx, msg) {
  if (msg && msg.reply_markup) await tryCall(ctx, 'editMessageReplyMarkup', { chat_id: msg.chat.id, message_id: msg.message_id, reply_markup: { inline_keyboard: [] } }, 'drop-buttons');
}

/* pq:<id>:a|r — an approver decides on a held or submitted post. */
export async function queueCallback(ctx, cq, parts) {
  const from = cq.from;
  const lang = await langOf(from);
  const item = await posts.item(toInt(parts[1]));
  const chat = item ? await chats.get(Number(item.chat_id)) : null;
  if (!item || !isChannel(chat)) return answer(ctx, t(lang, 'sec.cp_gone'), true);
  const acc = await admins.liveAccess(ctx, chat.chat_id, from.id);
  if (!acc.member || acc.level < L.full) return answer(ctx, t(lang, 'ch.q_denied'), true);
  const r = await decideItem(ctx, chat, item, parts[2] === 'a', from.id);
  await dropButtons(ctx, cq.message);
  return answer(ctx, t(lang, `ch.q_${r}`), true);
}

/* Approve (publish now, or at its time) or reject a waiting post, once. Gives published, scheduled, rejected, failed or done. */
export async function decideItem(ctx, chat, item, approve, byId) {
  if (item.status !== 'pending') return 'done';
  if (!approve) {
    if (!(await posts.claim(item.id, 'pending', 'rejected', byId))) return 'done';
    await audit.log(byId, 'post.rejected', { chatId: chat.chat_id, details: { id: Number(item.id) } });
    await tellAuthor(ctx, chat, item, 'rejected', byId);
    return 'rejected';
  }
  if (Number(item.publish_at) > nowSec()) {
    if (!(await posts.claim(item.id, 'pending', 'scheduled', byId))) return 'done';
    await tellAuthor(ctx, chat, item, 'scheduled', byId);
    return 'scheduled';
  }
  if (!(await posts.claim(item.id, 'pending', 'publishing', byId))) return 'done';
  return publishItem(ctx, chat, item, byId);
}

async function tellAuthor(ctx, chat, item, status, byId) {
  const author = Number(item.author_id);
  if (item.origin !== 'aegis' || !author || author === byId) return;
  const u = await users.get(author);
  if (u && Number(u.started) && !Number(u.blocked)) await send(ctx, author, t(u.lang, `ch.q_author_${status}`, { title: title(chat) }), null, 'queue-author');
}

/* Publishes a waiting post (already claimed) with the channel's footer, buttons and options. */
export async function publishItem(ctx, chat, item, byId) {
  const s = await settings.all(ctx, chat.chat_id);
  const opts = parseJson(item.options, {}) || {};
  const c = posts.unpack(item);
  try {
    const m = await publish(ctx, chat.chat_id, item.kind, c, { rows: buttonRows(s), silent: !!opts.silent || flag(s, 'ch_silent'),
      protect: !!opts.protect || flag(s, 'ch_protect'), footer: s.ch_footer }, 'queue-publish');
    await posts.finish(item.id, 'published', m.message_id);
    await afterPublish(ctx, chat, s, m.message_id, item.kind, { ...c, t: withFooter(item.kind, c.t, s.ch_footer) },
      { viaAegis: true, signature: opts.signature || null });
    await audit.log(byId, 'post.published', { chatId: chat.chat_id, details: { id: Number(item.id), msg: m.message_id } });
    await tellAuthor(ctx, chat, item, 'published', byId);
    return 'published';
  } catch (err) {
    await posts.finish(item.id, 'failed');
    await alert(ctx, chat, 'security', (l) => t(l, 'ch.publish_failed', { error: esc(describeError(err)) }));
    return 'failed';
  }
}

export async function onEditedPost(ctx, m) {
  const chat = await chats.get(m.chat.id);
  if (!isChannel(chat)) return;
  const id = chat.chat_id;
  const s = await settings.all(ctx, id);
  const { kind, c } = contentOf(m);
  const post = await posts.byMsg(id, m.message_id);
  if (!post) {
    if (flag(s, 'ch_archive')) await posts.save(id, m.message_id, kind, c, { signature: m.author_signature || null, album: m.media_group_id || null, at: Number(m.date) || nowSec() });
    return;
  }
  const cur = posts.unpack(post);
  if (same(cur, c)) return;
  const link = postLink(chat, m.message_id);
  const late = (Number(m.edit_date) || nowSec()) - Number(post.posted_at) > Number(s.ch_edit_grace);
  await posts.newVersion(post, c, 'edit');
  if (flag(s, 'ch_edit_lock') && late && canPublish(kind)) {
    if (auditOn(s)) {
      await alert(ctx, chat, 'security', (l) => t(l, 'ch.al_revert_audit', { link }));
      return;
    }
    try {
      await editTo(ctx, id, m.message_id, kind, c, cur, 'post-revert');
      await posts.newVersion(await posts.get(post.id), cur, 'revert');
      await alert(ctx, chat, 'security', (l) => t(l, 'ch.al_reverted', { link, text: iso(c.t || '—', 120) }));
    } catch (err) {
      await alert(ctx, chat, 'security', (l) => t(l, 'ch.al_revert_failed', { link, error: esc(describeError(err)) }));
    }
    return;
  }
  if (flag(s, 'ch_al_edits')) await alert(ctx, chat, 'security', (l) => t(l, 'ch.al_edited', { link, old: iso(cur.t || '—', 120), now: iso(c.t || '—', 120) }));
}

/* The channel's title or photo changed (a service post: Telegram doesn't say by whom). */
async function infoChange(ctx, chat, m, s) {
  const id = chat.chat_id;
  if (m.new_chat_title) {
    await db.run(sql`UPDATE aegis_chats SET title = ${m.new_chat_title} WHERE chat_id = ${id}`);
    if (flag(s, 'ch_title_lock') && s.ch_title_locked && m.new_chat_title !== s.ch_title_locked) {
      if (auditOn(s)) {
        await alert(ctx, chat, 'security', (l) => t(l, 'ch.al_title_audit', { title: iso(m.new_chat_title, 60), locked: iso(s.ch_title_locked, 60) }));
        return;
      }
      const ok = await tryCall(ctx, 'setChatTitle', { chat_id: id, title: s.ch_title_locked }, 'ch-title-restore');
      if (ok) await db.run(sql`UPDATE aegis_chats SET title = ${s.ch_title_locked} WHERE chat_id = ${id}`);
      await alert(ctx, chat, 'security', (l) => t(l, ok ? 'ch.al_title_restored' : 'ch.al_title_restore_failed', { title: iso(m.new_chat_title, 60),
        locked: iso(s.ch_title_locked, 60) }));
      return;
    }
    if (flag(s, 'ch_al_info')) await alert(ctx, chat, 'security', (l) => t(l, 'ch.al_title', { title: iso(m.new_chat_title, 60) }));
    return;
  }
  if (flag(s, 'ch_al_info')) await alert(ctx, chat, 'security', (l) => t(l, m.new_chat_photo ? 'ch.al_photo' : 'ch.al_photo_removed'));
}

/* ---------- join requests ---------- */

/* What to do with a request: { act: approve | decline | captcha | manual, reason }. */
async function judge(ctx, chat, s, user, bio) {
  const c = chat.chat_id;
  const now = nowSec();
  const key = String(user.id);
  if (await lists.has(c, 'vip', key)) return { act: 'approve', reason: 'vip' };
  if (await lists.has(c, 'blk', key) || await lists.has(c, 'ban', key)) return { act: 'decline', reason: 'blacklist' };
  if (isFake(s, user)) return { act: 'decline', reason: 'fake' };
  if (flag(s, 'ch_jr_names')) {
    const why = await suspicious(chat, user, bio);
    if (why.length) return { act: 'decline', reason: 'name', why };
  }
  const limit = Number(s.ch_jr_flood);
  if (limit) {
    const fresh = await chats.get(c);
    if (Number(fresh.jr_hold_until) > now) return { act: 'manual', reason: 'flood' };
    const recent = await channels.requestsSince(c, now - 60);
    if (recent > limit) {
      const r = await db.run(sql`UPDATE aegis_chats SET jr_hold_until = ${now + JR_FLOOD_HOLD_SEC} WHERE chat_id = ${c} AND jr_hold_until <= ${now}`);
      if (r.rowsAffected) await alert(ctx, chat, 'security', (l) => t(l, 'ch.al_jr_flood', { n: recent, time: Math.round(JR_FLOOD_HOLD_SEC / 60) }));
      return { act: 'manual', reason: 'flood' };
    }
  }
  if (flag(s, 'ch_jr_captcha')) return { act: 'captcha', reason: 'captcha' };
  if (s.ch_jr_mode === 'approve') return { act: 'approve', reason: 'mode' };
  if (s.ch_jr_mode === 'decline') return { act: 'decline', reason: 'mode' };
  return { act: 'manual', reason: 'mode' };
}

export async function onJoinRequest(ctx, req) {
  const chat = await chats.get(req.chat.id);
  if (!isChannel(chat)) return;
  const c = chat.chat_id;
  const s = await settings.all(ctx, c);
  const user = req.from;
  const q = req.query_id || null;
  await users.remember(user);
  const id = await channels.addRequest(c, user, req.bio, invites.label(req.invite_link), q);
  await invites.count(c, req.invite_link, 'asked');
  let d = await judge(ctx, chat, s, user, req.bio);
  if (d.act === 'decline' && auditOn(s)) {
    await logs.post(ctx, chat, 'security', t(chat.lang, 'ch.log_decline_audit', { user: iso(fullName(user)), reason: t(chat.lang, `ch.jr_${d.reason}`) }));
    d = { act: 'manual', reason: d.reason };
  }
  if (d.act === 'captcha') {
    const cfg = (await guards.all(ctx, c)).captcha;
    let sent = false;
    if (q) {
      const cap = makeCaptcha(cfg.mode);
      await guards.newCaptcha(c, user.id, 'guard', cap, cap.target, nowSec() + Math.min(cfg.to, 300));
      sent = !!(await tryCall(ctx, 'sendChatJoinRequestWebApp', { chat_join_request_query_id: q, web_app_url: `${APP_URL}join` }, 'guard-webapp'));
    } else sent = await requestCaptcha(ctx, chat, user, req.user_chat_id, cfg);
    if (sent) {
      await channels.setRequestStatus(id, 'captcha');
      return;
    }
    d = s.ch_jr_mode === 'manual' ? { act: 'manual', reason: 'mode' } : { act: s.ch_jr_mode, reason: 'mode' };
  }
  if (d.act === 'approve' || d.act === 'decline') {
    const ok = q
      ? await tryCall(ctx, 'answerChatJoinRequestQuery', { chat_join_request_query_id: q, result: d.act }, 'guard-answer')
      : await tryCall(ctx, d.act === 'approve' ? 'approveChatJoinRequest' : 'declineChatJoinRequest', { chat_id: c, user_id: user.id }, `jr-${d.act}`);
    if (ok) await channels.decide(id, d.act === 'approve' ? 'approved' : 'declined', d.reason, 0);
    if (ok && d.act === 'decline') {
      const why = d.why ? ` — ${reasonText(chat.lang, d.why)}` : '';
      await logs.post(ctx, chat, 'security', `${t(chat.lang, 'ch.log_declined', { user: iso(fullName(user)), reason: t(chat.lang, `ch.jr_${d.reason}`) })}${why}`);
    }
    return;
  }
  if (q) await tryCall(ctx, 'answerChatJoinRequestQuery', { chat_join_request_query_id: q, result: 'queue' }, 'guard-queue');
}

/* An admin decides on a recorded request from the panel. Gives ok, done (already decided) or an error text. */
export async function decideRequest(ctx, chat, row, approve, byId) {
  if (!['pending', 'captcha'].includes(row.status)) return 'done';
  const params = { chat_id: chat.chat_id, user_id: Number(row.user_id) };
  try {
    if (row.query) {
      try {
        await call(ctx, 'answerChatJoinRequestQuery', { chat_join_request_query_id: row.query, result: approve ? 'approve' : 'decline' }, 'guard-answer');
      } catch (err) {
        await call(ctx, approve ? 'approveChatJoinRequest' : 'declineChatJoinRequest', params, 'jr-admin');
      }
    } else await call(ctx, approve ? 'approveChatJoinRequest' : 'declineChatJoinRequest', params, 'jr-admin');
  } catch (err) {
    if (/HIDE_REQUESTER_MISSING|USER_ALREADY_PARTICIPANT|not found/i.test(describeError(err))) {
      await channels.decide(Number(row.id), 'expired', 'gone', byId);
      return 'done';
    }
    return describeError(err);
  }
  const pending = await guards.pendingCaptcha(chat.chat_id, Number(row.user_id));
  if (pending && ['request', 'guard'].includes(pending.kind)) await guards.finishCaptcha(Number(pending.id), approve ? 'approved' : 'removed');
  await channels.decide(Number(row.id), approve ? 'approved' : 'declined', 'admin', byId);
  await audit.log(byId, approve ? 'channel.request_approved' : 'channel.request_declined', { chatId: chat.chat_id, target: Number(row.user_id) });
  return 'ok';
}

/* ---------- joins, leaves, admins ---------- */

export async function onMemberChange(ctx, upd) {
  const chat = await chats.get(upd.chat.id);
  if (!isChannel(chat)) return;
  const before = upd.old_chat_member || {};
  const after = upd.new_chat_member || {};
  const user = after.user;
  const bot = await me(ctx);
  if (!user || user.id === bot.id) return;
  const c = chat.chat_id;
  const s = await settings.all(ctx, c);
  if (isAdminStatus(before.status) || isAdminStatus(after.status)) {
    if (flag(s, 'ch_al_admins') && (!upd.from || upd.from.id !== bot.id)) await adminAlert(ctx, chat, upd, before, after);
    return;
  }
  const was = inChat(before);
  const is = inChat(after);
  if (was && !is) {
    await channels.bump(c, 'leaves');
    return;
  }
  if (was || !is) return;
  /* join times and the blacklist are handled for every chat in ui/moderation.js */
  await channels.bump(c, 'joins');
  await invites.count(c, upd.invite_link, 'joins');
  const byAdmin = upd.from && upd.from.id !== user.id;
  if (!byAdmin && flag(s, 'ch_imp') && !(await lists.has(c, 'vip', String(user.id))) && !(await lists.has(c, 'blk', String(user.id)))) {
    const why = await suspicious(chat, user);
    const fake = isFake(s, user);
    if (why.length || fake) {
      const reasons = fake ? ['fake', ...why] : why;
      let removed = false;
      if (s.ch_imp_action === 'remove') {
        await users.remember(user);
        const r = await punish.apply(ctx, chat, { userId: user.id, name: fullName(user), kind: 'kick', sec: 0, reason: reasonText(chat.lang, reasons), actorId: 0, source: 'security' });
        removed = !!(r && r.ok && !r.auditOnly);
      }
      await alert(ctx, chat, 'security', (l) => t(l, removed ? 'ch.al_imp_removed' : 'ch.al_imp_join', { user: iso(fullName(user)), id: String(user.id),
        reasons: reasonText(l, reasons) }));
    }
  }
  const limit = Number(s.ch_jr_flood);
  if (limit) {
    const n = await guards.recentJoins(c, 60);
    if (n > limit) {
      const now = nowSec();
      const r = await db.run(sql`UPDATE aegis_chats SET burst_at = ${now} WHERE chat_id = ${c} AND burst_at <= ${now - 1800}`);
      if (r.rowsAffected) await alert(ctx, chat, 'security', (l) => t(l, 'ch.al_join_burst', { n }), (l) => [[btn(t(l, 'ch.btn_open_crisis'), `g:${c}:Z`)]]);
    }
  }
}

async function adminAlert(ctx, chat, upd, before, after) {
  const user = after.user;
  const was = isAdminStatus(before.status);
  const is = isAdminStatus(after.status);
  const a = rightsOf(before);
  const b = rightsOf(after);
  const added = WATCHED.filter((r) => b[r] && !a[r]);
  const removed = WATCHED.filter((r) => a[r] && !b[r]);
  let kind = 'changed';
  if (!was && is) kind = 'promoted';
  else if (was && !is) kind = 'demoted';
  else if (!added.length && !removed.length) return;
  const by = upd.from ? iso(fullName(upd.from)) : '—';
  const outside = is && after.status === 'administrator' && !after.can_be_edited;
  const danger = added.filter((r) => DANGEROUS.has(r));
  await alert(ctx, chat, 'admin', (l) => {
    const rname = (r) => t(l, `rights.${r}`);
    const lines = [t(l, `ch.al_admin_${kind}`, { user: iso(fullName(user)), by })];
    if (added.length) lines.push(t(l, 'ch.al_rights_added', { list: added.map(rname).join(t(l, 'common.sep')) }));
    if (removed.length) lines.push(t(l, 'ch.al_rights_removed', { list: removed.map(rname).join(t(l, 'common.sep')) }));
    if (danger.length) lines.push(t(l, 'ch.al_rights_danger'));
    if (outside) lines.push(t(l, 'ch.al_outside'));
    return lines.join('\n');
  });
}

/* Aegis itself lost or got rights in a channel, or was removed from it. */
export async function botAlert(ctx, chat, missing, gone = false) {
  if (!chat || chat.type !== 'channel' || !Number(chat.registered)) return;
  const s = await settings.all(ctx, chat.chat_id);
  if (!flag(s, 'ch_al_bot')) return;
  const id = await creatorId(chat.chat_id);
  const u = id ? await users.get(id) : null;
  if (!u || !Number(u.started) || Number(u.blocked) || ctx.quiet) return;
  const text = gone ? t(u.lang, 'ch.al_bot_gone', { title: title(chat) })
    : t(u.lang, missing.length ? 'ch.al_bot_rights' : 'ch.al_bot_rights_ok', { title: title(chat), list: missing.map((m) => t(u.lang, `rights.req_${m}`)).join(t(u.lang, 'common.sep')) });
  await send(ctx, id, text, gone ? null : [[btn(t(u.lang, 'group.btn_panel'), `g:${chat.chat_id}`)]], 'ch-bot-alert');
}

/* ---------- the discussion group ---------- */

const DG_KEYS = ['dg_members', 'dg_as_channel', 'dg_imp', 'dg_first'];

/* A message in a group that may be a channel's discussion group. Gives true when it was removed. */
export async function discussion(ctx, chat, message) {
  if (!chat || !Number(chat.registered) || chat.type === 'channel') return false;
  const sender = message.sender_chat;
  if (message.is_automatic_forward && sender && sender.type === 'channel') {
    if (Number(chat.linked_id) !== sender.id) {
      await channels.setLinked(chat.chat_id, sender.id);
      if (await chats.get(sender.id)) await channels.setLinked(sender.id, chat.chat_id);
    }
    await db.run(sql`UPDATE aegis_chats SET last_post_at = ${nowSec()} WHERE chat_id = ${chat.chat_id}`);
    return false;
  }
  const chId = Number(chat.linked_id);
  if (!chId) return false;
  const channel = await chats.get(chId);
  if (!isChannel(channel)) return false;
  const s = await settings.all(ctx, chId);
  if (!DG_KEYS.some((k) => flag(s, k))) return false;
  if (!message.text && !message.caption && contentOf(message).kind === 'other' && !message.poll && !message.contact && !message.location) return false;
  if (sender && (sender.id === chId || sender.id === chat.chat_id)) return false;
  const user = message.from;
  if (sender) return flag(s, 'dg_as_channel') ? stopComment(ctx, chat, channel, s, message, 'as_channel', iso(sender.title || '', 40)) : false;
  if (!user || user.is_bot) return false;
  if (await isAdmin(chat.chat_id, user.id) || await isAdmin(chId, user.id)) return false;
  if (await lists.has(chat.chat_id, 'vip', String(user.id)) || await lists.has(chat.chat_id, 'tru', String(user.id))) return false;
  const who = iso(fullName(user));
  if (flag(s, 'dg_imp')) {
    const origin = message.forward_origin;
    const fromFake = origin && (origin.chat || origin.sender_user) && isFake(s, origin.chat || origin.sender_user);
    if (isFake(s, user) || fromFake || fakesIn(s, message.text || message.caption)) return stopComment(ctx, chat, channel, s, message, 'fake', who);
    const why = (await suspicious(channel, user)).filter((r) => r === 'impersonation' || r === 'name_link' || r === 'name_pattern');
    if (why.length) return stopComment(ctx, chat, channel, s, message, 'imp', who);
  }
  if (flag(s, 'dg_first')) {
    const lp = Number(chat.last_post_at);
    if (lp && nowSec() - lp < 30) {
      const joined = await members.joinedAt(chat.chat_id, user.id);
      if (!joined || nowSec() - joined < 86400) return stopComment(ctx, chat, channel, s, message, 'first', who);
    }
  }
  if (flag(s, 'dg_members')) {
    const m = await tryCall(ctx, 'getChatMember', { chat_id: chId, user_id: user.id }, 'dg-member');
    if (m && !inChat(m)) {
      const url = channel.username ? `https://t.me/${channel.username}` : null;
      const rows = url ? [[urlBtn(t(chat.lang, 'ch.btn_dg_join', { title: short(channel.title || '', 30) }), url)]] : null;
      return stopComment(ctx, chat, channel, s, message, 'members', who, rows);
    }
  }
  return false;
}

async function stopComment(ctx, group, channel, s, message, key, who, rows = null) {
  const gs = await settings.all(ctx, group.chat_id);
  if (auditOn(s) || auditOn(gs)) {
    await logs.post(ctx, channel, 'security', t(channel.lang, 'ch.dg_log_audit', { user: who, rule: t(channel.lang, `ch.dg_rule_${key}`) }));
    return false;
  }
  const deleted = await deleteMessage(ctx, group.chat_id, message.message_id, `dg-${key}`);
  if (key === 'as_channel' && message.sender_chat) {
    await tryCall(ctx, 'banChatSenderChat', { chat_id: group.chat_id, sender_chat_id: message.sender_chat.id }, 'dg-ban-sender');
  }
  if (!ctx.quiet) await postNotice(ctx, group, t(group.lang, `ch.dg_stop_${key}`, { user: who }), rows);
  await logs.post(ctx, channel, 'security', t(channel.lang, 'ch.dg_log', { user: who, rule: t(channel.lang, `ch.dg_rule_${key}`) }));
  return deleted;
}

/* ---------- the channel's direct messages ---------- */

async function dmRule(ctx, channel, s, message, user, dmId) {
  const key = String(user.id);
  if (await lists.has(channel.chat_id, 'blk', key) || await lists.has(channel.chat_id, 'ban', key)) return 'blocked';
  const f = scan(message);
  const links = linksOf(f, 'medium');
  const suggested = !!message.suggested_post_info;
  if (suggested && flag(s, 'dm_suggest') && links.length) return 'suggest';
  if (flag(s, 'dm_fakes') && (isFake(s, (message.forward_origin || {}).chat) || fakesIn(s, f.text))) return 'fake';
  if (flag(s, 'dm_scam') && (scamHits(f.text).length || (message.document && dangerousFile(message.document)))) return 'scam';
  if (flag(s, 'dm_links') && links.length) return 'link';
  const limit = Number(s.dm_flood);
  if (limit) {
    const r = await guards.countMessage(dmId, user.id, fingerprint(f.text || String(message.message_id)), DM_WINDOW_SEC);
    if (r.n > limit) return 'flood';
  }
  return null;
}

/* A message in a channel's direct messages chat (a supergroup Telegram made for it). */
export async function dmMessage(ctx, message) {
  const dm = message.chat;
  let chId = await channels.channelOfDm(dm.id);
  if (!chId) {
    const info = await tryCall(ctx, 'getChat', { chat_id: dm.id }, 'dm-parent');
    chId = info && info.parent_chat ? Number(info.parent_chat.id) : 0;
    if (chId) await channels.rememberDm(dm.id, chId);
  }
  const channel = chId ? await chats.get(chId) : null;
  if (!isChannel(channel)) return;
  const s = await settings.all(ctx, chId);
  const user = message.from;
  if (!flag(s, 'dm_on') || !user || user.is_bot || await isAdmin(chId, user.id)) return;
  const rule = await dmRule(ctx, channel, s, message, user, dm.id);
  if (!rule) return;
  const who = iso(fullName(user));
  if (auditOn(s)) {
    await logs.post(ctx, channel, 'security', t(channel.lang, 'ch.dm_log_audit', { user: who, rule: t(channel.lang, `ch.dm_rule_${rule}`) }));
    return;
  }
  if (rule === 'suggest') {
    await tryCall(ctx, 'declineSuggestedPost', { chat_id: dm.id, message_id: message.message_id, comment: t(channel.lang, 'ch.dm_decline_comment').slice(0, 128) },
      'dm-decline');
  } else await deleteMessage(ctx, dm.id, message.message_id, `dm-${rule}`);
  await logs.post(ctx, channel, 'security', t(channel.lang, 'ch.dm_log', { user: who, rule: t(channel.lang, `ch.dm_rule_${rule}`) }));
  if (rule === 'scam') await alert(ctx, channel, 'security', (l) => t(l, 'ch.al_dm_scam', { user: who, id: String(user.id) }));
}

/* ---------- timed work ---------- */

/* One step of copying older posts into the backup chat. Gives ok, done, wait or failed (null: someone else runs it). */
export async function backupStep(ctx, job) {
  const now = nowSec();
  if (!(await backup.claimStep(job, now))) return null;
  const from = Number(job.next_id);
  const last = Number(job.last_id);
  if (from > last) {
    await backup.progress(job.chat_id, from, 0, true);
    return 'done';
  }
  const to = Math.min(last, from + BACKUP_BATCH - 1);
  const ids = [];
  for (let i = from; i <= to; i += 1) ids.push(i);
  try {
    const r = await call(ctx, 'copyMessages', { chat_id: Number(job.target), from_chat_id: Number(job.chat_id), message_ids: ids, disable_notification: true }, 'backup-copy');
    await backup.progress(job.chat_id, to + 1, Array.isArray(r) ? r.length : 0, to >= last);
    return to >= last ? 'done' : 'ok';
  } catch (err) {
    if (isFlood(err)) {
      await backup.setJob(job.chat_id, { retryAt: now + retryAfter(err) });
      return 'wait';
    }
    if (/not found|no messages|can't be (?:copied|forwarded)|MESSAGE_ID_INVALID/i.test(describeError(err))) {
      await backup.progress(job.chat_id, to + 1, 0, to >= last);
      return to >= last ? 'done' : 'ok';
    }
    await backup.setJob(job.chat_id, { status: 'failed', error: describeError(err).slice(0, 200) });
    return 'failed';
  }
}

/* Scheduled posts that are due, and a step of a backup job (lib/jobs.js, at most once a minute). */
export async function sweep(ctx) {
  const now = nowSec();
  for (const item of await posts.due(now, 5)) {
    const chat = await chats.get(Number(item.chat_id));
    if (!isChannel(chat)) {
      await posts.finish(item.id, 'failed');
      continue;
    }
    if (!(await posts.claim(item.id, 'scheduled', 'publishing'))) continue;
    await publishItem(ctx, chat, item, Number(item.decided_by) || Number(item.author_id));
  }
  for (const job of await backup.runnable(now, 1)) await backupStep(ctx, job);
}
