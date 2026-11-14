// The public gallery (Phase 5, brief §5 / §13): packs whose publication was approved and posted
// enter it; anyone can browse (newest / most liked), like once, and report with a reason. When a
// pack reaches `gallery.hide_reports` open reports it is hidden at once and the moderators (the
// owner and the reviewers) get a card: show again, remove from the gallery, or (owner only) ban the
// creator from publishing. Likes earn the creator Wanger Points (capped, once per person).
import { gallery as gdb } from '../db/community.js';
import { users } from '../db/users.js';
import { system } from '../db/system.js';
import { UserError, PermissionError } from '../core/util.js';
import { btn, urlBtn, markup } from '../core/codec.js';
import { packUrl } from '../core/packs.js';
import { t } from '../i18n/index.js';
import { OWNER_ID, T } from '../config.js';

export const REPORT_REASONS = Object.freeze(['spam', 'sexual', 'hate', 'violence', 'copyright', 'other']);

/** @param {any} app */
export function createGallery(app) {
  const { clock } = app;

  async function moderators() {
    const staff = await system.listStaff();
    return [OWNER_ID, ...staff.filter((s) => s.role === 'reviewer').map((s) => s.tg_id)];
  }

  /** The moderation card (owner and reviewers; «ban» only works for the owner). */
  async function card(pack, lang) {
    const reasons = (await gdb.reasons(pack.id)).map((r) => `${t(lang, `gl.reason.${r.reason}`)} ×${r.n}`).join('، ') || '—';
    return {
      text: t(lang, 'gl.mod_card', { title: pack.title, n: pack.reports, reasons, id: pack.tg_id }),
      keyboard: markup([
        [urlBtn(t(lang, 'pk.btn_open_tg').replace(/<[^>]+>/g, ''), packUrl(pack))],
        [btn(t(lang, 'gl.btn_restore'), 'g', 'mok', pack.id), btn(t(lang, 'gl.btn_remove'), 'g', 'mrm', pack.id)],
        [btn(t(lang, 'gl.btn_ban'), 'g', 'mban', pack.id)],
      ]),
    };
  }

  return {
    REPORT_REASONS,
    card,
    async page(sort, page) {
      const per = T.pageSize;
      const total = await gdb.count();
      const p = Math.max(0, Math.min(page, Math.max(0, Math.ceil(total / per) - 1)));
      return { items: await gdb.page(sort === 'top' ? 'top' : 'new', p * per, per), total, page: p, per };
    },
    get: (packId) => gdb.get(packId),
    liked: (packId, userId) => gdb.liked(packId, userId),

    /** Like or unlike; a first like from a person earns the creator points (not for one's own pack). */
    async toggleLike(user, packId) {
      const pack = await gdb.get(packId);
      if (!pack || pack.gallery_hidden) throw new UserError('gl.err.gone');
      if (await gdb.liked(pack.id, user.tg_id)) {
        await gdb.unlike(pack.id, user.tg_id);
        return { liked: false, likes: Math.max(0, pack.likes - 1) };
      }
      await gdb.like(pack.id, user.tg_id, clock.now());
      if (pack.tg_id !== user.tg_id) await app.account.award(pack.tg_id, 'like_received', `${pack.id}:${user.tg_id}`);
      app.stats.count('gallery.like');
      return { liked: true, likes: pack.likes + 1 };
    },

    /** One report per person per pack; enough open reports hide the pack and alert the moderators. */
    async report(user, packId, reason) {
      if (!REPORT_REASONS.includes(reason)) throw new UserError('common.expired');
      const pack = await gdb.get(packId);
      if (!pack) throw new UserError('gl.err.gone');
      if (pack.tg_id === user.tg_id) throw new UserError('gl.err.own');
      const n = await gdb.report(pack.id, user.tg_id, reason, clock.now());
      if (n === null) return { already: true };
      app.stats.count('gallery.report');
      if (n >= Number(app.settings.get('gallery.hide_reports')) && (await gdb.hide(pack.id))) {
        const fresh = { ...pack, reports: n, gallery_hidden: 1 };
        for (const id of await moderators()) {
          try {
            const u = await users.get(id);
            await app.tg.send(id, await card(fresh, (u && u.lang) || 'fa'), 'gallery_mod');
          } catch {
            /* a moderator who blocked the bot misses this card; the panel lists it */
          }
        }
        return { hidden: true };
      }
      return { reported: true };
    },

    /** @param {'restore'|'remove'|'ban'} action */
    async moderate(actorId, role, packId, action) {
      if (role !== 'owner' && role !== 'reviewer') throw new PermissionError('gallery.moderate');
      if (action === 'ban' && role !== 'owner') throw new PermissionError('gallery.ban');
      const pack = await app.packs.get(packId);
      if (!pack) throw new UserError('gl.err.gone');
      if (action === 'restore') await gdb.restore(pack.id);
      else {
        await gdb.remove(pack.id);
        if (action === 'ban') await users.setPublishBanned(pack.tg_id, true);
      }
      await app.audit(actorId, `gallery.${action}`, String(pack.id), pack.title.slice(0, 64));
      return pack;
    },
    reported: (n = 20) => gdb.reported(n),
    totals: () => gdb.totals(),
  };
}
