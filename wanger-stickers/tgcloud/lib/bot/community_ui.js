// Community screens (Phase 5): the public gallery (browse newest / most liked, like, report,
// moderation cards), Wanger Points (balance, how to earn, spend: a quota boost or a week of Pro,
// the invite link) and the Pro subscription button (Telegram Stars, only when the owner set a
// price). Pack ids from callback_data are re-read; moderation is checked in the service too.
import { btn, urlBtn, markup } from '../core/codec.js';
import { UserError, dayKey } from '../core/util.js';
import { packUrl } from '../core/packs.js';
import { users } from '../db/users.js';
import { ledger } from '../db/community.js';
import { REPORT_REASONS } from '../packs/gallery.js';
import { POINTS, BOT_USERNAME } from '../config.js';

const u = (app) => app.user;
const show = (app, cq, view, name) => app.tg.show(u(app).tg_id, cq && cq.message && !cq.message.sticker ? cq.message.message_id : null, view, name);
const WEEK = 7 * 86400;

/* ------------------------------------------------------------------ gallery */

export async function galleryView(app, sort = 'new', page = 0) {
  const g = await app.gallery.page(sort, page);
  const rows = g.items.map((p) => [btn(app.tp('gl.item', { title: p.title, likes: p.likes, n: p.sticker_count }), 'g', 'open', p.id)]);
  const nav = [];
  if (g.page > 0) nav.push(btn(app.tp('common.prev'), 'g', 'list', sort, g.page - 1));
  if ((g.page + 1) * g.per < g.total) nav.push(btn(app.tp('common.next'), 'g', 'list', sort, g.page + 1));
  rows.push(nav);
  rows.push([btn(`${sort === 'new' ? '• ' : ''}${app.tp('gl.sort_new')}`, 'g', 'list', 'new', 0), btn(`${sort === 'top' ? '• ' : ''}${app.tp('gl.sort_top')}`, 'g', 'list', 'top', 0)]);
  rows.push([btn(app.tp('common.menu'), 'm', 'home')]);
  return { text: g.total ? app.t('gl.list', { n: g.total }) : app.t('gl.empty'), keyboard: markup(rows) };
}

function itemKeyboard(app, pack, liked) {
  return markup([
    [urlBtn(app.tp('gl.btn_add', { title: pack.title }), packUrl(pack))],
    [btn(`${liked ? '❤️' : '🤍'} ${app.tp('gl.likes', { n: pack.likes })}`, 'g', 'like', pack.id), btn(app.tp('gl.btn_report'), 'g', 'rep', pack.id)],
    [btn(app.tp('gl.btn_back'), 'g', 'list', 'new', 0)],
  ]);
}

async function openItem(app, packId, cq) {
  const pack = await app.gallery.get(packId);
  if (!pack || pack.gallery_hidden) throw new UserError('gl.err.gone');
  const items = await app.packs.items(pack.id);
  if (!items.length) throw new UserError('gl.err.gone');
  if (cq && cq.message && cq.message.sticker) await app.tg.remove(u(app).tg_id, cq.message.message_id);
  await app.tg.sticker(u(app).tg_id, items[0].file_id, itemKeyboard(app, pack, await app.gallery.liked(pack.id, u(app).tg_id)), 'gallery_item');
  return { toast: app.tp('gl.toast', { title: pack.title, n: pack.sticker_count }) };
}

const onSticker = (cq) => (cq && cq.message ? cq.message.message_id : null);

/* ------------------------------------------------------------------ points */

export async function pointsView(app) {
  const acc = await app.account.getAccount(u(app).tg_id);
  const recent = await ledger.recent(u(app).tg_id, 5);
  const lines = recent.map((e) => app.t('pt.line', { delta: e.delta > 0 ? `+${e.delta}` : String(e.delta), reason: app.tp(`pt.reason.${e.reason in POINTS || ['boost', 'pro_week', 'admin'].includes(e.reason) ? e.reason : 'other'}`) })).join('\n');
  const earn = Object.keys(POINTS).map((r) => app.t('pt.earn_line', { reason: app.tp(`pt.reason.${r}`), n: Number(app.settings.get(`points.${r}`)) || 0, cap: POINTS[r].dailyCap })).join('\n');
  const s = app.settings;
  const rows = [
    [btn(app.tp('pt.btn_boost', { cost: s.get('points.cost_boost'), stickers: s.get('points.boost_stickers'), media: s.get('points.boost_media') }), 'pt', 'boost')],
    [btn(app.tp('pt.btn_pro', { cost: s.get('points.cost_pro_week') }), 'pt', 'pro')],
    [btn(app.tp('pt.btn_invite'), 'pt', 'inv')],
    [btn(app.tp('menu.account'), 'm', 'acct')],
  ];
  return { text: app.t('pt.view', { points: acc ? acc.points : 0, earn: { __html: earn }, recent: { __html: lines || app.t('pt.none') } }), keyboard: markup(rows) };
}

/* ------------------------------------------------------------------ routes */

export const routes = {
  'g:list': { args: ['word', 'uint'], run: async (app, [sort, page], cq) => {
    if (!app.flag('gallery')) throw new UserError('common.feature_off');
    if (cq && cq.message && cq.message.sticker) {
      await app.tg.send(u(app).tg_id, await galleryView(app, sort === 'top' ? 'top' : 'new', page), 'gallery');
      return undefined;
    }
    await show(app, cq, await galleryView(app, sort === 'top' ? 'top' : 'new', page), 'gallery');
  } },
  'g:open': { args: ['uint'], run: async (app, [id], cq) => openItem(app, id, cq) },
  'g:like': {
    args: ['uint'],
    run: async (app, [id], cq) => {
      const r = await app.gallery.toggleLike(u(app), id);
      const pack = await app.gallery.get(id);
      const mid = onSticker(cq);
      if (mid && pack) await app.tg.editMarkup(u(app).tg_id, mid, itemKeyboard(app, pack, r.liked), 'gallery_like');
      return { toast: app.tp(r.liked ? 'gl.liked' : 'gl.unliked') };
    },
  },
  'g:rep': {
    args: ['uint'],
    run: async (app, [id], cq) => {
      const pack = await app.gallery.get(id);
      if (!pack) throw new UserError('gl.err.gone');
      const rows = REPORT_REASONS.map((r, i) => [btn(app.tp(`gl.reason.${r}`), 'g', 'rr', id, i)]);
      rows.push([btn(app.tp('common.cancel'), 'g', 'open', id)]);
      const mid = onSticker(cq);
      if (mid) await app.tg.editMarkup(u(app).tg_id, mid, markup(rows), 'gallery_report');
      return { toast: app.tp('gl.ask_reason') };
    },
  },
  'g:rr': {
    args: ['uint', 'uint'],
    run: async (app, [id, i], cq) => {
      const r = await app.gallery.report(u(app), id, REPORT_REASONS[i]);
      const pack = await app.gallery.get(id);
      const mid = onSticker(cq);
      if (mid && pack) await app.tg.editMarkup(u(app).tg_id, mid, r.hidden ? markup([[btn(app.tp('gl.btn_back'), 'g', 'list', 'new', 0)]]) : itemKeyboard(app, pack, await app.gallery.liked(id, u(app).tg_id)), 'gallery_report');
      return { toast: app.tp(r.already ? 'gl.reported_already' : 'gl.reported'), alert: true };
    },
  },
  /* moderation (owner and reviewers; the service checks again, ban is owner-only) */
  'g:mcard': { args: ['uint'], perm: 'gallery.moderate', run: async (app, [id]) => {
    const pack = await app.packs.get(id);
    if (!pack) throw new UserError('gl.err.gone');
    await app.tg.send(u(app).tg_id, await app.gallery.card(pack, app.lang), 'gallery_mod');
  } },
  'g:mok': { args: ['uint'], perm: 'gallery.moderate', run: async (app, [id], cq) => moderate(app, id, 'restore', cq) },
  'g:mrm': { args: ['uint'], perm: 'gallery.moderate', run: async (app, [id], cq) => moderate(app, id, 'remove', cq) },
  'g:mban': { args: ['uint'], perm: 'gallery.moderate', run: async (app, [id], cq) => moderate(app, id, 'ban', cq) },
  'a:mod': { args: [], perm: 'gallery.moderate', run: async (app, _a, cq) => show(app, cq, await reportsView(app), 'gallery_reports') },

  /* points */
  'pt:menu': { args: [], run: async (app, _a, cq) => {
    if (!app.flag('points')) throw new UserError('common.feature_off');
    await show(app, cq, await pointsView(app), 'points');
  } },
  'pt:boost': {
    args: [],
    run: async (app, _a, cq) => {
      if (!app.flag('points')) throw new UserError('common.feature_off');
      const s = app.settings;
      const r = await app.account.spendCredits(u(app).tg_id, Number(s.get('points.cost_boost')), 'boost', `boost:${cq.id}`);
      if (!r.ok) throw new UserError('pt.err.short', { cost: s.get('points.cost_boost') });
      if (!r.duplicate) {
        const day = dayKey(app.clock.now());
        await users.addUsage(u(app).tg_id, day, 'bonus.sticker_add', Number(s.get('points.boost_stickers')));
        await users.addUsage(u(app).tg_id, day, 'bonus.media_send', Number(s.get('points.boost_media')));
      }
      await show(app, cq, await pointsView(app), 'points');
      return { toast: app.tp('pt.boost_ok'), alert: true };
    },
  },
  'pt:pro': {
    args: [],
    run: async (app, _a, cq) => {
      if (!app.flag('points')) throw new UserError('common.feature_off');
      const cost = Number(app.settings.get('points.cost_pro_week'));
      const r = await app.account.spendCredits(u(app).tg_id, cost, 'pro_week', `pro:${cq.id}`);
      if (!r.ok) throw new UserError('pt.err.short', { cost });
      const acc = await app.account.getAccount(u(app).tg_id);
      if (!r.duplicate) await users.extendPro(u(app).tg_id, Math.max(app.clock.now(), acc.planUntil || 0) + WEEK);
      await show(app, cq, await pointsView(app), 'points');
      return { toast: app.tp('pt.pro_ok'), alert: true };
    },
  },
  'pt:inv': {
    args: [],
    run: async (app) => {
      const link = `https://t.me/${BOT_USERNAME}?start=ref_${u(app).tg_id}`;
      await app.tg.send(u(app).tg_id, { text: app.t('pt.invite', { link, n: Number(app.settings.get('points.referral')) || 0 }), keyboard: markup([[urlBtn(app.tp('pk.btn_share_send'), `https://t.me/share/url?url=${encodeURIComponent(link)}`)]]) }, 'invite');
    },
  },

  /* Pro with Telegram Stars (lib/payments/stars.js) */
  'pay:pro': {
    args: [],
    run: async (app) => {
      const link = await app.stars.invoiceLink(u(app));
      await app.tg.send(u(app).tg_id, { text: app.t('pay.offer', { price: app.settings.get('pro.price_stars'), quota: 5 }), keyboard: markup([[urlBtn(app.tp('pay.btn_pay', { price: app.settings.get('pro.price_stars') }), link)]]) }, 'pro_offer');
    },
  },
};

async function moderate(app, id, action, cq) {
  const pack = await app.gallery.moderate(u(app).tg_id, app.role, id, action);
  await show(app, cq, { text: app.t(`gl.done_${action}`, { title: pack.title }) }, 'gallery_mod_done');
  return { toast: app.tp('gl.mod_ok') };
}

async function reportsView(app) {
  const list = await app.gallery.reported(20);
  const rows = list.map((p) => [btn(app.tp('gl.rep_item', { title: p.title, n: p.reports, hidden: p.gallery_hidden ? '🙈' : '' }), 'g', 'mcard', p.id)]);
  rows.push([btn(app.tp('common.back'), 'a', 'home')]);
  return { text: list.length ? app.t('gl.reports', { n: list.length }) : app.t('gl.reports_none'), keyboard: markup(rows) };
}
