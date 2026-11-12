// Owner panel → «📢 کانال انتشار» (Kimi 2026-11-12: a new channel she defines here; manual
// approval; reviewers she adds can approve). Sections: the destination channel (set / check /
// clear), rules (minimum stickers, gap between posts, re-publish wait, daily limit), reviewers
// (add / remove), and the queue (pending, waiting, recent) — the queue is also open to reviewers.
import { btn, markup } from '../core/codec.js';
import { esc, code } from '../core/html.js';
import { UserError } from '../core/util.js';
import { assertOwner } from './panel.js';
import { system } from '../db/system.js';
import { posts as postDb } from '../db/packs.js';
import { BOT_USERNAME } from '../config.js';

const show = (app, cq, view, name) => app.tg.show(app.user.tg_id, cq && cq.message ? cq.message.message_id : null, view, name);
const RULES = ['publish.min_stickers', 'publish.gap_sec', 'publish.republish_days', 'quota.publish'];

async function homeView(app) {
  const ch = app.publish.channel();
  const staff = await system.listStaff();
  const on = app.flag('pack_publish');
  const rules = RULES.map((k) => `• ${app.tp(`set.${k}`)}: ${app.settings.get(k)}`).join('\n');
  const rows = [
    [btn(app.tp(ch ? 'pc.btn_change' : 'pc.btn_set'), 'a', 'pcset'), ch ? btn(app.tp('pc.btn_check'), 'a', 'pcchk') : null],
    ch ? [btn(app.tp('pc.btn_clear'), 'a', 'pcclr')] : null,
    [btn(app.tp(on ? 'pc.btn_off' : 'pc.btn_on'), 'a', 'pctog')],
    [btn(app.tp('pc.btn_rules'), 'a', 'set')],
    [btn(app.tp('st.btn_list', { n: staff.length }), 'a', 'rv')],
    [btn(app.tp('adm.queue'), 'a', 'q')],
    [btn(app.tp('common.back'), 'a', 'home')],
  ].filter(Boolean);
  return {
    text: app.t('pc.home', {
      channel: ch ? `${ch.title || ''} ${ch.username ? '@' + ch.username : ''}`.trim() : app.tp('pc.none'),
      state: app.tp(on ? 'common.on' : 'common.off'),
      del: app.tp(ch && ch.can_delete ? 'common.yes' : 'common.no'),
      reviewers: staff.length,
      rules: { __html: esc(rules) },
      bot: BOT_USERNAME,
    }),
    keyboard: markup(rows),
  };
}

async function reviewersView(app) {
  const staff = await system.listStaff();
  const lines = staff.map((s, i) => `${i + 1}. ${esc(s.first_name || '?')} ${s.username ? '@' + esc(s.username) : ''} ${code(s.tg_id)}`).join('\n') || app.t('st.none');
  const rows = staff.map((s) => [btn(app.tp('st.btn_remove', { name: s.first_name || s.username || String(s.tg_id) }), 'a', 'rvdel', s.tg_id)]);
  rows.push([btn(app.tp('st.btn_add'), 'a', 'rvadd')]);
  rows.push([btn(app.tp('common.back'), 'a', 'pub')]);
  return { text: app.t('st.list', { lines: { __html: lines } }), keyboard: markup(rows) };
}

async function queueView(app) {
  const pending = await postDb.byStatus(['pending'], 10);
  const waiting = await postDb.byStatus(['approved', 'posting'], 10);
  const failed = await postDb.byStatus(['failed'], 5);
  const line = (p) => `#${p.id} · <b>${esc(p.title || '?')}</b> (${p.sticker_count || 0})`;
  const rows = pending.map((p) => [btn(app.tp('pq.btn_review', { id: p.id, title: p.title || '?' }), 'a', 'qv', p.id)]);
  if (waiting.length && app.role === 'owner') rows.push([btn(app.tp('pq.btn_post_now'), 'a', 'qpost')]);
  rows.push([btn(app.tp('common.refresh'), 'a', 'q'), btn(app.tp('common.back'), 'a', 'home')]);
  return {
    text: app.t('pq.text', {
      pending: { __html: pending.map(line).join('\n') || '—' },
      waiting: { __html: waiting.map(line).join('\n') || '—' },
      failed: { __html: failed.map((p) => `${line(p)} — ${esc(p.reason || '')}`).join('\n') || '—' },
    }),
    keyboard: markup(rows),
  };
}

const owner = (fn) => async (app, args, cq) => {
  assertOwner(app);
  return fn(app, args, cq);
};

export const routes = {
  'a:pub': { args: [], perm: 'admin', run: owner(async (app, _a, cq) => show(app, cq, await homeView(app), 'admin_publish')) },
  'a:pcset': { args: [], perm: 'admin', run: owner(async (app) => { await app.state.set(app.user.tg_id, 'a_pcset', {}); await app.tg.send(app.user.tg_id, { text: app.t('pc.ask_channel', { bot: BOT_USERNAME }) }, 'ask_publish_channel'); }) },
  'a:pcchk': {
    args: [], perm: 'admin',
    run: owner(async (app, _a, cq) => {
      const ch = app.publish.channel();
      if (!ch) throw new UserError('pub.err.no_channel');
      const info = await app.tg.inspectChannel(ch.chat_id);
      if (!info.ok || !info.isAdmin || !info.canPost) throw new UserError('pc.err.rights', { bot: BOT_USERNAME, title: ch.title || '' });
      await app.settings.set(app.user.tg_id, 'publish.chat', { ...ch, title: String(info.chat.title || ch.title || '').slice(0, 128), username: info.chat.username || null, can_delete: !!info.canDelete });
      await show(app, cq, await homeView(app), 'admin_publish');
      return { toast: app.tp('pc.check_ok') };
    }),
  },
  'a:pcclr': { args: [], perm: 'admin', run: owner(async (app, _a, cq) => { await app.publish.clearChannel(app.user.tg_id); await show(app, cq, await homeView(app), 'admin_publish'); }) },
  'a:pctog': { args: [], perm: 'admin', run: owner(async (app, _a, cq) => { await app.settings.set(app.user.tg_id, 'flags.pack_publish', !app.flag('pack_publish')); await show(app, cq, await homeView(app), 'admin_publish'); }) },

  'a:rv': { args: [], perm: 'admin', run: owner(async (app, _a, cq) => show(app, cq, await reviewersView(app), 'admin_reviewers')) },
  'a:rvadd': { args: [], perm: 'admin', run: owner(async (app) => { await app.state.set(app.user.tg_id, 'a_rvadd', {}); await app.tg.send(app.user.tg_id, { text: app.t('st.ask_add') }, 'ask_reviewer'); }) },
  'a:rvdel': { args: ['uint'], perm: 'admin', run: owner(async (app, [id], cq) => { await app.publish.removeReviewer(app.user.tg_id, id); await show(app, cq, await reviewersView(app), 'admin_reviewers'); return { toast: app.tp('st.removed') }; }) },

  /* the queue: owner and reviewers */
  'a:q': { args: [], perm: 'publish.queue', run: async (app, _a, cq) => show(app, cq, await queueView(app), 'publish_queue') },
  'a:qv': {
    args: ['uint'], perm: 'publish.queue',
    run: async (app, [id]) => {
      const post = await postDb.get(id);
      if (!post) throw new UserError('pub.err.gone');
      const m = await app.tg.send(app.user.tg_id, await app.publish.cardFor(post, app.lang), 'review_card');
      if (m && m.message_id && post.status === 'pending') await postDb.addReviewMsg(post.id, app.user.tg_id, m.message_id);
    },
  },
  'a:qpost': {
    args: [], perm: 'admin',
    run: owner(async (app, _a, cq) => {
      const r = await app.publish.drain();
      await show(app, cq, await queueView(app), 'publish_queue');
      return { toast: app.tp(`pq.drain.${r}`) };
    }),
  },
};

/** @returns {Promise<string|null>} */
export async function onPublishAdminStep(app, step, payload, message) {
  const text = typeof message.text === 'string' ? message.text.trim() : '';
  if (step === 'a_pcset') {
    assertOwner(app);
    const ch = await app.publish.setChannel(app.user.tg_id, text, message);
    await app.state.clear(app.user.tg_id);
    await app.tg.send(app.user.tg_id, { text: app.t('pc.set_ok', { title: ch.title || ch.username || '' }), keyboard: markup([[btn(app.tp('adm.publish'), 'a', 'pub')]]) }, 'publish_channel_set');
    return step;
  }
  if (step === 'a_rvadd') {
    assertOwner(app);
    await app.publish.addReviewer(app.user.tg_id, text, message);
    await app.state.clear(app.user.tg_id);
    await app.tg.send(app.user.tg_id, await reviewersView(app), 'admin_reviewers');
    return step;
  }
  return null;
}

