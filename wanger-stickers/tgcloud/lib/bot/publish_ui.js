// Publishing screens. The creator: confirm screen with two optional credits (name, @username —
// both off by default, Kimi's choice), then «ارسال برای بررسی»; withdraw. Reviewers (owner and the
// reviewers she added): approve / reject (optional reason) / ban from publishing / remove.
import { btn, markup } from '../core/codec.js';
import { UserError } from '../core/util.js';
import { postKeyboard } from '../packs/publish.js';
import { posts as postDb, packs as pdb } from '../db/packs.js';
import { packView } from './packs_ui.js';

/** flags: bit 1 = show name, bit 2 = show @username. */
const has = (flags, bit) => (flags & bit) === bit;

async function confirmView(app, pack, flags) {
  const user = app.user;
  const preview = postKeyboard({ id: 0, show_name: has(flags, 1), show_username: has(flags, 2) }, pack, user, 'fa').inline_keyboard.map((r) => `▫\ufe0f ${r[0].text}`).join('\n');
  const toggle = (bit, key) => btn(app.tp(key, { state: app.tp(has(flags, bit) ? 'common.on' : 'common.off') }), 'pb', 'opt', pack.id, flags ^ bit);
  const rows = [[toggle(1, 'pub.toggle_name')]];
  if (user.username) rows.push([toggle(2, 'pub.toggle_username')]);
  rows.push([btn(app.tp('pub.btn_send'), 'pb', 'send', pack.id, flags)]);
  rows.push([btn(app.tp('common.cancel'), 'pk', 'open', pack.id)]);
  const ch = app.publish.channel();
  return {
    text: app.t('pub.confirm', { title: pack.title, channel: ch ? ch.title || '@' + ch.username : '', preview }),
    keyboard: markup(rows),
  };
}

const show = (app, cq, view, name) => app.tg.show(app.user.tg_id, cq && cq.message ? cq.message.message_id : null, view, name);

export const routes = {
  'pb:ask': {
    args: ['uint'],
    run: async (app, [packId], cq) => {
      const pack = await app.packs.mustOwn(app.user.tg_id, packId);
      await app.packs.sync(pack);
      const why = await app.publish.refusal(app.user, pack);
      if (why) throw new UserError(why, { min: Number(app.settings.get('publish.min_stickers')), days: Number(app.settings.get('publish.republish_days')) });
      await show(app, cq, await confirmView(app, pack, 0), 'publish_confirm');
    },
  },
  'pb:opt': {
    args: ['uint', 'uint'],
    run: async (app, [packId, flags], cq) => {
      const pack = await app.packs.mustOwn(app.user.tg_id, packId);
      await show(app, cq, await confirmView(app, pack, flags & 3), 'publish_confirm');
    },
  },
  'pb:send': {
    args: ['uint', 'uint'],
    run: async (app, [packId, flags], cq) => {
      const pack = await app.packs.mustOwn(app.user.tg_id, packId);
      // the gate is re-checked without cache before publishing (like pack creation)
      const v = await app.gate.check(app.user, { useCache: false });
      if (!v.passed) throw new UserError('gate.still_missing');
      await app.publish.request(app.user, pack, { showName: has(flags, 1), showUsername: has(flags, 2) });
      await show(app, cq, { text: app.t('pub.sent'), keyboard: markup([[btn(app.tp('pk.btn_back_pack'), 'pk', 'open', pack.id)]]) }, 'publish_sent');
      return { toast: app.tp('pub.sent_toast') };
    },
  },
  'pb:back': {
    args: ['uint'],
    run: async (app, [postId], cq) => {
      const post = await postDb.get(postId);
      if (!post || post.tg_id !== app.user.tg_id) throw new UserError('pub.err.gone');
      await show(app, cq, { text: app.t('pub.ask_withdraw'), keyboard: markup([[btn(app.tp('pub.btn_withdraw_yes'), 'pb', 'backok', postId), btn(app.tp('common.cancel'), 'pk', 'open', post.pack_id)]]) }, 'publish_withdraw');
    },
  },
  'pb:backok': {
    args: ['uint'],
    run: async (app, [postId], cq) => {
      const post = await postDb.get(postId);
      if (!post || post.tg_id !== app.user.tg_id) throw new UserError('pub.err.gone');
      const { how } = await app.publish.takeBack(app.user.tg_id, 'user', postId);
      const pack = await pdb.getOwned(post.pack_id, app.user.tg_id);
      if (pack) await show(app, cq, await packView(app, pack), 'pack');
      return { toast: app.tp(how === 'stripped' ? 'pub.withdrawn_old' : 'pub.withdrawn'), alert: how === 'stripped' };
    },
  },

  /* ---- reviewers (perm publish.review; checked in the router and again in the service) ---- */
  'pr:ok': { args: ['uint'], perm: 'publish.review', run: async (app, [id]) => decided(app, await app.publish.decide(app.user.tg_id, app.role, id, 'ok')) },
  'pr:no': {
    args: ['uint'],
    perm: 'publish.review',
    run: async (app, [id]) => {
      const post = await postDb.get(id);
      if (!post || post.status !== 'pending') throw new UserError('pub.err.decided');
      await app.state.set(app.user.tg_id, 'pr_reason', { id });
      await app.tg.send(app.user.tg_id, { text: app.t('pub.ask_reason'), keyboard: markup([[btn(app.tp('pub.btn_no_reason'), 'pr', 'nor', id)]]) }, 'ask_reason');
    },
  },
  'pr:nor': {
    args: ['uint'],
    perm: 'publish.review',
    run: async (app, [id]) => {
      await app.state.clear(app.user.tg_id);
      return decided(app, await app.publish.decide(app.user.tg_id, app.role, id, 'no'));
    },
  },
  'pr:ban': { args: ['uint'], perm: 'publish.review', run: async (app, [id]) => decided(app, await app.publish.decide(app.user.tg_id, app.role, id, 'ban')) },
  'pr:rm': {
    args: ['uint'],
    perm: 'publish.remove',
    run: async (app, [id]) => {
      const { how } = await app.publish.takeBack(app.user.tg_id, app.role, id);
      return { toast: app.tp(how === 'stripped' ? 'pub.removed_old' : 'pub.removed'), alert: how === 'stripped' };
    },
  },
};

function decided(app, post) {
  const key = post.status === 'published' ? 'pub.t_published' : post.status === 'approved' ? 'pub.t_queued' : post.status === 'failed' ? 'pub.t_failed' : 'pub.t_rejected';
  return { toast: app.tp(key) };
}

/** pr_reason step: the reviewer typed a reason for rejecting. */
export async function onReviewStep(app, step, payload, message) {
  if (step !== 'pr_reason') return null;
  if (!app.can('publish.review')) {
    await app.state.clear(app.user.tg_id);
    return 'denied';
  }
  const reason = String(message.text || '').trim().slice(0, 200);
  if (!reason) throw new UserError('pub.err.reason');
  await app.state.clear(app.user.tg_id);
  await app.publish.decide(app.user.tg_id, app.role, payload.id, 'no', reason);
  await app.tg.send(app.user.tg_id, { text: app.t('pub.rejected_with_reason') }, 'rejected');
  return step;
}
