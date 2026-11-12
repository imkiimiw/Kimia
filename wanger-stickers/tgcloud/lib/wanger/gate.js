// Forced-join gate (brief §6): parallel getChatMember per enabled channel, a 10-minute pass cache
// (never for failures), broken channels skipped + owner alerted (≤ once an hour per channel), and
// the owner's channel management. (Adapted from wanger-music lib/forcejoin/service.js.)
//
// The isolate has no timers, so "a timeout per channel" can't be set by us: each check has its own
// error handling, and one quick retry on a transient error.
import { gate as gateDb } from '../db/gate.js';
import { outcomeOf, evaluate, joinUrl } from '../core/gate.js';
import { parseChatRef, isValidInviteLink } from '../core/chatref.js';
import { UserError, PermissionError } from '../core/util.js';
import { btn, urlBtn, markup } from '../core/codec.js';
import { t, tp } from '../i18n/index.js';
import { OWNER_ID, MAX_GATE_CHANNELS, BOT_USERNAME, T } from '../config.js';

const label = (ch) => ch.title || (ch.username ? '@' + ch.username : String(ch.chat_id));

/** @param {any} app */
export function createGate(app) {
  const { clock, tg, settings, log } = app;
  const version = () => Number(settings.get('gate.version') || 0);

  async function checkOne(ch, userId) {
    let result = null;
    let error = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        result = await tg.getChatMember(ch.chat_id, userId);
        error = null;
        break;
      } catch (e) {
        error = e;
        if (!outcomeOf(null, e).transient) break;
      }
    }
    return { channel: ch, ...outcomeOf(result, error) };
  }

  async function recordHealth(results) {
    const now = clock.now();
    await Promise.all(results.map(async (r) => {
      const ch = r.channel;
      if (ch.health !== r.health || now - ch.checked_at >= 3600) await gateDb.setHealth(ch.id, r.health, now);
      if (r.outcome === 'error' && (r.health === 'bot_not_admin' || r.health === 'not_found')) {
        log.warn('gate_channel_broken', { chat_id: ch.chat_id, status: r.health });
        if (settings.get('notify.gate')) {
          await app.alerts.owner(`gate:${ch.chat_id}`, (lang) => t(lang, 'alert.gate_broken', { title: label(ch), reason: tp(lang, `alert.reason.${r.health}`), bot: BOT_USERNAME }), T.alertGateEverySec);
        }
      }
    }));
  }

  const invalidate = () => settings.set(0, 'gate.version', version() + 1);
  const assertOwner = (actorId) => {
    if (actorId !== OWNER_ID) throw new PermissionError('gate.manage');
  };
  async function mustGet(id) {
    const row = await gateDb.get(id);
    if (!row) throw new UserError('gm.err.gone');
    return row;
  }

  return {
    invalidate,
    list: () => gateDb.list(),

    /**
     * @param {any} user users row @param {{useCache?: boolean}} [opts]
     * @returns {Promise<{passed: boolean, missing: any[], broken: any[], cached?: boolean}>}
     */
    async check(user, { useCache = true } = {}) {
      if (user.tg_id === OWNER_ID || !settings.get('gate.enabled')) return { passed: true, missing: [], broken: [] };
      const now = clock.now();
      if (useCache) {
        const pass = await gateDb.getPass(user.tg_id);
        if (pass && pass.ok_until > now && pass.version === version()) return { passed: true, missing: [], broken: [], cached: true };
      }
      const channels = await gateDb.listEnabled();
      if (!channels.length) return { passed: true, missing: [], broken: [] };
      const results = await Promise.all(channels.map((ch) => checkOne(ch, user.tg_id)));
      await recordHealth(results);
      const verdict = evaluate(results);
      if (verdict.passed) {
        const ttl = Number(settings.get('gate.cache_sec'));
        if (ttl > 0) await gateDb.setPass(user.tg_id, now + ttl, version());
        app.stats.count('gate.pass');
      } else {
        await gateDb.clearPass(user.tg_id);
        app.stats.count('gate.blocked');
      }
      return verdict;
    },

    /** The gate message: one URL button per missing channel (owner's order) + «عضو شدم». */
    view(lang, missing) {
      const rows = missing.map((ch) => {
        const url = joinUrl(ch);
        return url ? [urlBtn(tp(lang, 'gate.btn_join', { title: label(ch) }), url)] : null;
      });
      rows.push([btn(tp(lang, 'gate.btn_check'), 'fj', 'check')]);
      return { text: t(lang, 'gate.prompt'), keyboard: markup(rows.filter(Boolean)) };
    },

    /* ---- owner management (private chat only; checked in the router AND here) ---- */

    async add(actorId, text, message) {
      assertOwner(actorId);
      if ((await gateDb.count()) >= MAX_GATE_CHANNELS) throw new UserError('gm.err.max', { max: MAX_GATE_CHANNELS });
      const ref = parseChatRef(text, message);
      if (!ref) throw new UserError('gm.err.ref');
      if (ref.kind === 'invite') throw new UserError('gm.err.invite');
      const info = await tg.inspectChannel(ref.kind === 'username' ? '@' + ref.value : ref.value);
      if (!info.ok) throw new UserError({ not_channel: 'gm.err.not_channel', transient: 'gm.err.transient' }[info.error] || 'gm.err.not_found');
      if (!info.isAdmin) throw new UserError('gm.err.not_admin', { title: info.chat.title || '', bot: BOT_USERNAME });
      if (await gateDb.getByChatId(info.chat.id)) throw new UserError('gm.err.duplicate');
      const row = await gateDb.insert({
        chat_id: info.chat.id,
        username: info.chat.username || null,
        title: String(info.chat.title || '').slice(0, 128),
        invite_link: info.chat.username ? null : info.chat.invite_link || null,
      }, MAX_GATE_CHANNELS, clock.now());
      if (!row) throw new UserError((await gateDb.getByChatId(info.chat.id)) ? 'gm.err.duplicate' : 'gm.err.max', { max: MAX_GATE_CHANNELS });
      await app.audit(actorId, 'gate.add', row.chat_id, row.title);
      await invalidate();
      return row;
    },

    async remove(actorId, id) {
      assertOwner(actorId);
      const row = await mustGet(id);
      await gateDb.remove(id);
      await app.audit(actorId, 'gate.remove', row.chat_id, row.title);
      await invalidate();
      return row;
    },

    async setEnabled(actorId, id, flag) {
      assertOwner(actorId);
      const row = await mustGet(id);
      await gateDb.setEnabled(id, flag);
      await app.audit(actorId, flag ? 'gate.enable' : 'gate.disable', row.chat_id);
      await invalidate();
    },

    async move(actorId, id, dir) {
      assertOwner(actorId);
      const ids = (await gateDb.list()).map((r) => r.id);
      const i = ids.indexOf(id);
      if (i < 0) throw new UserError('gm.err.gone');
      const j = i + dir;
      if (j < 0 || j >= ids.length) return false;
      [ids[i], ids[j]] = [ids[j], ids[i]];
      await gateDb.reorder(ids);
      await app.audit(actorId, 'gate.reorder', id, String(dir));
      await invalidate();
      return true;
    },

    async setInviteLink(actorId, id, link) {
      assertOwner(actorId);
      const row = await mustGet(id);
      if (link !== null && !isValidInviteLink(link)) throw new UserError('gm.err.link');
      await gateDb.setInviteLink(id, link ? link.trim() : null);
      await app.audit(actorId, 'gate.link', row.chat_id, link ? 'set' : 'cleared');
      await invalidate();
    },

    async setGateEnabled(actorId, flag) {
      assertOwner(actorId);
      await settings.set(actorId, 'gate.enabled', !!flag);
      await invalidate();
    },

    /** Re-checks the bot's rights everywhere and refreshes titles. */
    async checkHealth(actorId) {
      assertOwner(actorId);
      const rows = await gateDb.list();
      const now = clock.now();
      await Promise.all(rows.map(async (ch) => {
        const info = await tg.inspectChannel(ch.chat_id);
        const status = info.ok ? (info.isAdmin ? 'ok' : 'bot_not_admin') : info.error === 'transient' ? 'error' : 'not_found';
        await gateDb.setHealth(ch.id, status, now);
        if (info.ok && (info.chat.title !== ch.title || (info.chat.username || null) !== ch.username)) {
          await gateDb.updateMeta(ch.id, String(info.chat.title || '').slice(0, 128), info.chat.username || null);
        }
      }));
      return gateDb.list();
    },

    /** my_chat_member in a gate channel → health + immediate alert. @returns {Promise<boolean>} ours */
    async onBotStatusChange(chat, member) {
      const ch = await gateDb.getByChatId(chat.id);
      if (!ch) return false;
      const ok = member && (member.status === 'administrator' || member.status === 'creator');
      await gateDb.setHealth(ch.id, ok ? 'ok' : 'bot_not_admin', clock.now());
      if (!ok && settings.get('notify.gate')) {
        await app.alerts.owner(`gate:${ch.chat_id}:status`, (lang) => t(lang, 'alert.gate_removed', { title: label(ch), status: (member && member.status) || '?' }), 60);
      }
      return true;
    },
  };
}
