// Publishing a pack to the community channel (DECISIONS D11; Kimi's choices 2026-11-12):
// - a NEW channel the owner sets in the admin panel; the bot must be an admin that can post;
// - MANUAL approval: by the owner or a reviewer the owner added;
// - the creator's name and @username are shown only if the creator turns them on.
//
// One post per pack: sendSticker (the pack's first sticker) with URL buttons. The pack_posts row is
// the idempotency key: approved → posting is claimed with a lease, the message_id is stored right
// after the send, and a row whose lease expired without a message_id is "uncertain" — it is shown
// to the owner and never re-sent automatically.
import { posts as postDb, packs as pdb } from '../db/packs.js';
import { users } from '../db/users.js';
import { system } from '../db/system.js';
import { UserError, PermissionError, dayStart, parseJson, truncate } from '../core/util.js';
import { classify } from '../core/errors.js';
import { parseChatRef } from '../core/chatref.js';
import { addStickersUrl } from '../core/packs.js';
import { btn, urlBtn, markup } from '../core/codec.js';
import { esc } from '../core/html.js';
import { t, tp, normLang } from '../i18n/index.js';
import { OWNER_ID, BOT_USERNAME, T } from '../config.js';
import { TELEGRAM } from '../core/limits.js';

/** The channel post's keyboard (pure). Labels in the channel's language (Persian). */
export function postKeyboard(post, pack, creator, lang = 'fa') {
  const rows = [[urlBtn(tp(lang, 'pub.post_add', { title: truncate(pack.title, 40) }), addStickersUrl(pack.tg_name))]];
  const name = post.show_name && creator && creator.first_name ? truncate(creator.first_name, 32) : '';
  const uname = post.show_username && creator && creator.username ? '@' + creator.username : '';
  if (name || uname) {
    const text = tp(lang, 'pub.post_by', { who: [name, uname].filter(Boolean).join(' · ') });
    rows.push([urlBtn(text, uname ? `https://t.me/${creator.username}` : addStickersUrl(pack.tg_name))]);
  }
  rows.push([urlBtn(tp(lang, 'pub.post_make'), `https://t.me/${BOT_USERNAME}?start=pub_${post.id}`)]);
  return markup(rows);
}

/** The review card for the owner and reviewers (pure). */
export function reviewCard(lang, post, pack, creator, foreign) {
  const who = creator ? `${esc(creator.first_name || '?')}${creator.username ? ' @' + esc(creator.username) : ''} · <code>${creator.tg_id}</code>` : '?';
  const text = t(lang, 'pub.card', {
    id: post.id,
    title: pack ? pack.title : '?',
    n: pack ? pack.sticker_count : 0,
    foreign: foreign || 0,
    who: { __html: who },
    credit: tp(lang, post.show_name || post.show_username ? 'pub.card_credit_yes' : 'pub.card_credit_no'),
    status: tp(lang, `pub.status.${post.status}`),
  });
  const open = pack ? urlBtn(tp(lang, 'pub.btn_open'), addStickersUrl(pack.tg_name)) : null;
  const rows = post.status === 'pending'
    ? [[open], [btn(tp(lang, 'pub.btn_approve'), 'pr', 'ok', post.id), btn(tp(lang, 'pub.btn_reject'), 'pr', 'no', post.id)], [btn(tp(lang, 'pub.btn_ban'), 'pr', 'ban', post.id)]]
    : post.status === 'published' ? [[open], [btn(tp(lang, 'pub.btn_remove'), 'pr', 'rm', post.id)]] : [[open]];
  return { text, keyboard: markup(rows) };
}

/** @param {any} app */
export function createPublish(app) {
  const { clock, tg, settings, log } = app;
  const channel = () => settings.get('publish.chat') || null;

  async function reviewers() {
    const staff = await system.listStaff();
    return [OWNER_ID, ...staff.filter((s) => s.role === 'reviewer').map((s) => s.tg_id)];
  }

  async function cardFor(post, lang) {
    const pack = await pdb.get(post.pack_id);
    const creator = await users.get(post.tg_id);
    const oc = pack ? await pdb.originCount(pack.id) : null;
    return reviewCard(lang, post, pack, creator, oc ? Number(oc.foreign_n) || 0 : 0);
  }

  /** Re-renders every review card of a post (best effort). */
  async function refreshCards(post) {
    for (const [chatId, messageId] of parseJson(post.review_msgs, [])) {
      try {
        const u = await users.get(chatId);
        await tg.edit(chatId, messageId, await cardFor(post, normLang(u && u.lang)), 'review_card');
      } catch (e) {
        log.warn('review_card_update_failed', { chat_id: chatId, error: String(e && (e.description || e.message)).slice(0, 120) });
      }
    }
  }

  async function notifyCreator(post, key, vars = {}) {
    const u = await users.get(post.tg_id);
    if (!u || u.blocked_bot) return;
    try {
      await tg.send(u.tg_id, { text: t(normLang(u.lang), key, vars) }, 'publish_notice');
    } catch (e) {
      log.warn('publish_notice_failed', { user_id: u.tg_id, error: String(e && e.description).slice(0, 120) });
    }
  }

  function postLink(post) {
    const ch = channel();
    return ch && ch.username && post.message_id ? `https://t.me/${ch.username}/${post.message_id}` : null;
  }

  /** Takes the channel message away: delete (< 48 h) or strip its buttons (older). */
  async function takeDown(post) {
    if (!post.message_id || !post.chat_id) return 'none';
    const age = clock.now() - (post.published_at || 0);
    if (age < TELEGRAM.deleteMessageMaxAgeSec - 60 && (await tg.remove(post.chat_id, post.message_id))) return 'deleted';
    try {
      await tg.editMarkup(post.chat_id, post.message_id, null, 'post_strip');
      return 'stripped';
    } catch (e) {
      log.warn('post_strip_failed', { post_id: post.id, error: String(e && e.description).slice(0, 120) });
      return 'failed';
    }
  }

  const api = {
    channel,
    reviewers,
    cardFor,

    /** Why this user can't publish this pack now (an i18n key), or null. */
    async refusal(user, pack) {
      if (!app.flag('pack_publish')) return 'pub.err.off';
      if (!channel()) return 'pub.err.no_channel';
      if (user.publish_banned) return 'pub.err.banned';
      if (pack.sticker_count < Number(settings.get('publish.min_stickers'))) return 'pub.err.min';
      if (await postDb.liveOf(pack.id)) return 'pub.err.live';
      const last = await postDb.lastOf(pack.id);
      const days = Number(settings.get('publish.republish_days'));
      if (last && days > 0 && last.status === 'withdrawn' && clock.now() - (last.removed_at || 0) < days * 86400) return 'pub.err.cooldown';
      const { quotas } = await app.account.getEntitlements(user.tg_id);
      if ((await postDb.countSince(user.tg_id, dayStart(clock.now()))) >= quotas.publish) return 'pub.err.daily';
      return null;
    },

    /** The creator asks to publish; review cards go to the owner and every reviewer. */
    async request(user, pack, { showName, showUsername }) {
      const why = await api.refusal(user, pack);
      if (why) throw new UserError(why, { min: Number(settings.get('publish.min_stickers')), days: Number(settings.get('publish.republish_days')) });
      const post = await postDb.create({ pack_id: pack.id, tg_id: user.tg_id, show_name: showName, show_username: showUsername && !!user.username }, clock.now());
      if (!post) throw new UserError('pub.err.live');
      await app.account.recordEvent(user.tg_id, 'publish_requested');
      app.stats.count('pub.requested');
      for (const rid of await reviewers()) {
        const r = await users.get(rid);
        if (!r || r.blocked_bot) continue;
        try {
          const m = await tg.send(rid, await cardFor(post, normLang(r.lang)), 'review_card');
          if (m && m.message_id) await postDb.addReviewMsg(post.id, rid, m.message_id);
        } catch (e) {
          log.warn('review_card_failed', { user_id: rid, error: String(e && e.description).slice(0, 120) });
        }
      }
      return post;
    },

    /**
     * A reviewer's decision. Permission is checked here AND in the router.
     * @param {'ok'|'no'|'ban'} decision
     */
    async decide(actorId, actorRole, postId, decision, reason = null) {
      const allowed = actorRole === 'owner' || (actorRole === 'reviewer' && decision !== 'ban');
      if (!allowed) throw new PermissionError('publish.review');
      const to = decision === 'ok' ? 'approved' : 'rejected';
      const post = await postDb.transition(postId, ['pending'], to, { by: actorId, reason: reason ? String(reason).slice(0, 200) : null, chat_id: decision === 'ok' && channel() ? channel().chat_id : null }, clock.now());
      if (!post) throw new UserError('pub.err.decided');
      if (decision === 'ban') await users.setPublishBanned(post.tg_id, true);
      await app.audit(actorId, `publish.${decision}`, postId, reason);
      app.stats.count(`pub.${to}`);
      await refreshCards(post);
      if (to === 'rejected') {
        await notifyCreator(post, decision === 'ban' ? 'pub.n_banned' : 'pub.n_rejected', { title: (await pdb.get(post.pack_id) || {}).title || '', reason: reason || '' });
        return post;
      }
      await api.tryPost(post.id);
      return postDb.get(post.id);
    },

    /** Sends one approved post if the channel gap allows. @returns {Promise<'posted'|'waiting'|'failed'|'skipped'>} */
    async tryPost(postId) {
      const ch = channel();
      if (!ch) return 'skipped';
      const now = clock.now();
      if (now - (await postDb.lastPublishedAt()) < Number(settings.get('publish.gap_sec'))) return 'waiting';
      const post = await postDb.claimPost(postId, now, now + T.postLeaseSec);
      if (!post) return 'skipped';
      const pack = await pdb.get(post.pack_id);
      const items = pack ? await pdb.items(pack.id) : [];
      if (!pack || !items.length) {
        await postDb.transition(post.id, ['posting'], 'failed', { reason: 'pack_gone' }, now);
        return 'failed';
      }
      const creator = await users.get(post.tg_id);
      try {
        const m = await tg.sticker(ch.chat_id, items[0].file_id, postKeyboard(post, pack, creator), 'channel_post');
        const done = await postDb.published(post.id, m.message_id, clock.now());
        await pdb.setPublic(pack.id, true);
        app.stats.count('pub.published');
        const link = postLink(done);
        await notifyCreator(done, link ? 'pub.n_published_link' : 'pub.n_published', { title: pack.title, link: link || '' });
        await refreshCards(done);
        return 'posted';
      } catch (e) {
        const c = classify(e);
        if (c.kind === 'rate_limit' || c.kind === 'transient') {
          await postDb.transition(post.id, ['posting'], 'approved', {}, clock.now()); // back to the queue
          return 'waiting';
        }
        if (c.kind === 'no_rights' || c.kind === 'chat_gone') {
          await postDb.transition(post.id, ['posting'], 'approved', {}, clock.now());
          await app.alerts.owner('pub:channel', (lang) => t(lang, 'alert.pub_channel', { title: ch.title || ch.username || ch.chat_id }), 3600);
          return 'failed';
        }
        await postDb.transition(post.id, ['posting'], 'failed', { reason: c.kind }, clock.now());
        await app.alerts.recordError('publish', post.tg_id, e);
        return 'failed';
      }
    },

    /** Background: posts the oldest approved post (one per call: channel gap) and marks expired leases. */
    async drain() {
      for (const p of await postDb.expiredPosting(clock.now(), 5)) {
        // the send may or may not have happened: never re-send automatically
        const r = await postDb.transition(p.id, ['posting'], 'failed', { reason: 'uncertain' }, clock.now());
        if (r) await app.alerts.owner(`pub:uncertain:${p.id}`, (lang) => t(lang, 'alert.pub_uncertain', { id: p.id }), 86400);
      }
      const next = await postDb.nextApproved();
      return next ? api.tryPost(next.id) : 'none';
    },

    /** The creator withdraws, or the owner/a reviewer removes. */
    async takeBack(actorId, actorRole, postId) {
      const post = await postDb.get(postId);
      if (!post) throw new UserError('pub.err.gone');
      const isCreator = post.tg_id === actorId;
      if (!isCreator && !(actorRole === 'owner' || actorRole === 'reviewer')) throw new PermissionError('publish.remove');
      const to = isCreator ? 'withdrawn' : 'removed';
      const done = await postDb.transition(post.id, ['pending', 'approved', 'published'], to, {}, clock.now());
      if (!done) throw new UserError('pub.err.decided');
      const how = post.status === 'published' ? await takeDown(post) : 'none';
      const pack = await pdb.get(post.pack_id);
      if (pack) await pdb.setPublic(pack.id, false);
      await app.audit(actorId, `publish.${to}`, postId, how);
      app.stats.count(`pub.${to}`);
      await refreshCards(done);
      if (!isCreator) await notifyCreator(done, 'pub.n_removed', { title: pack ? pack.title : '' });
      return { post: done, how };
    },

    /** /deletemydata and pack deletion: take every live post of a user down. */
    async takeBackAll(userId) {
      for (const p of await postDb.liveOfUser(userId)) {
        const done = await postDb.transition(p.id, ['pending', 'approved', 'published'], 'withdrawn', {}, clock.now());
        if (done && p.status === 'published') await takeDown(p);
      }
    },

    /* ---- owner: channel and reviewers ---- */

    async setChannel(actorId, text, message) {
      if (actorId !== OWNER_ID) throw new PermissionError('publish.channel');
      const ref = parseChatRef(text, message);
      if (!ref || ref.kind === 'invite') throw new UserError('pc.err.ref');
      const info = await tg.inspectChannel(ref.kind === 'username' ? '@' + ref.value : ref.value);
      if (!info.ok) throw new UserError(info.error === 'not_channel' ? 'pc.err.not_channel' : info.error === 'transient' ? 'gm.err.transient' : 'pc.err.not_found');
      if (!info.isAdmin || !info.canPost) throw new UserError('pc.err.rights', { bot: BOT_USERNAME, title: info.chat.title || '' });
      const value = { chat_id: info.chat.id, username: info.chat.username || null, title: String(info.chat.title || '').slice(0, 128), can_delete: !!info.canDelete };
      await settings.set(actorId, 'publish.chat', value);
      return value;
    },
    async clearChannel(actorId) {
      if (actorId !== OWNER_ID) throw new PermissionError('publish.channel');
      await settings.set(actorId, 'publish.chat', null);
    },

    /** Adds a reviewer by numeric id, @username (must have started the bot) or a forwarded message. */
    async addReviewer(actorId, text, message) {
      if (actorId !== OWNER_ID) throw new PermissionError('staff');
      let target = null;
      const fo = message && message.forward_origin;
      if (fo && fo.type === 'user' && fo.sender_user) target = await users.get(fo.sender_user.id);
      else if (fo) throw new UserError('st.err.hidden');
      else {
        const s = String(text || '').trim();
        if (/^\d{5,15}$/.test(s)) target = await users.get(Number(s));
        else if (/^@?[A-Za-z][A-Za-z0-9_]{3,31}$/.test(s)) target = await users.getByUsername(s.replace(/^@/, ''));
        else throw new UserError('st.err.ref');
      }
      if (!target) throw new UserError('st.err.unknown');
      if (target.tg_id === OWNER_ID) throw new UserError('st.err.owner');
      if (!(await system.addStaff(target.tg_id, 'reviewer', actorId, clock.now()))) throw new UserError('st.err.duplicate');
      await app.audit(actorId, 'staff.add', target.tg_id, 'reviewer');
      try {
        await tg.send(target.tg_id, { text: t(normLang(target.lang), 'st.n_added') }, 'staff_notice');
      } catch {
        /* they blocked the bot: still a reviewer */
      }
      return target;
    },
    async removeReviewer(actorId, id) {
      if (actorId !== OWNER_ID) throw new PermissionError('staff');
      const n = await system.removeStaff(id);
      if (n) await app.audit(actorId, 'staff.remove', id);
      return n > 0;
    },

    /** my_chat_member for the publish channel. @returns {Promise<boolean>} ours */
    async onBotStatusChange(chat, member) {
      const ch = channel();
      if (!ch || ch.chat_id !== chat.id) return false;
      const ok = member && (member.status === 'administrator' || member.status === 'creator') && (member.status === 'creator' || member.can_post_messages !== false);
      if (!ok) await app.alerts.owner('pub:channel', (lang) => t(lang, 'alert.pub_channel', { title: ch.title || ch.username || ch.chat_id }), 60);
      return true;
    },
  };
  return api;
}
