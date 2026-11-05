// ForceJoinService: the membership gate (parallel getChatMember, cached pass, failure mode,
// channel health, throttled owner alerts) and the owner's channel management.
import { FORCE_JOIN_SEED, LIMITS, BOT_USERNAME } from '../config/static.js';
import { assertCan, isStaff } from '../permissions/policy.js';
import { outcomeOf, evaluate } from './gate.js';
import { UserError } from '../core/util.js';
import { parseChatRef, isValidInviteLink } from '../telegram/chatref.js';
import { t, raw } from '../i18n/index.js';
import { NOOP_STATS } from '../stats/service.js';

/**
 * @param {{repo: any, users: any, tg: any, settings: any, alerts: any, audit: any, clock: any, log: any, stats?: any}} deps
 */
export function createForceJoinService({ repo, users, tg, settings, alerts, audit, clock, log, stats = NOOP_STATS }) {
  /** One channel, with one quick retry on a transient error (429/5xx/network). */
  async function checkOne(channel, userId) {
    let result = null;
    let error = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        result = await tg.getChatMember(channel.chat_id, userId);
        error = null;
        break;
      } catch (e) {
        error = e;
        if (!outcomeOf(null, e).transient) break;
      }
    }
    return { channel, ...outcomeOf(result, error) };
  }

  const label = (ch) => ch.title || (ch.username ? '@' + ch.username : String(ch.chat_id));

  /** Saves health changes and alerts the owner about broken channels (once an hour per channel). */
  async function recordHealth(results, mode) {
    const now = clock.now();
    await Promise.all(results.map(async (r) => {
      const ch = r.channel;
      if (ch.last_check_status !== r.health || now - ch.last_checked_at >= LIMITS.channelHealthWriteSeconds) {
        await repo.setHealth(ch.id, r.health, now);
      }
      if (r.health === 'bot_not_admin' || r.health === 'not_found') {
        log.warn('forcejoin_channel_broken', { channel_id: ch.chat_id, status: r.health });
        await alerts.owner(`fj:${ch.chat_id}`, (lang) => t(lang, 'alert.fj_broken', {
          title: label(ch), reason: raw(t(lang, `alert.reason.${r.health}`)), mode: raw(t(lang, `fjm.mode.${mode}`)),
        }), LIMITS.alertForceJoinEverySeconds);
      }
    }));
  }

  /** Bumps forcejoin.version and clears every active pass (one statement). */
  async function invalidate() {
    await settings.setInternal('forcejoin.version', Number(await settings.get('forcejoin.version')) + 1);
    await users.clearAllPasses();
  }

  async function mustGet(id) {
    const row = await repo.get(id);
    if (!row) throw new UserError('fjm.err.gone');
    return row;
  }

  return {
    invalidate,
    list: () => repo.list(),
    get: (id) => repo.get(id),

    /**
     * The gate. Owner/admins pass when bypass is on; a pass is cached for the TTL; failures never are.
     * @param {any} user users row (mutated: force_join_ok_until)
     * @param {{useCache?: boolean}} [opts]
     * @returns {Promise<{passed: boolean, missing: any[], broken: any[], cached?: boolean, bypass?: boolean}>}
     */
    async check(user, { useCache = true } = {}) {
      if (isStaff(user) && (await settings.get('forcejoin.bypass_staff'))) return { passed: true, missing: [], broken: [], bypass: true };
      const now = clock.now();
      if (useCache && user.force_join_ok_until > now) return { passed: true, missing: [], broken: [], cached: true };
      const channels = await repo.listEnabled();
      if (!channels.length) return { passed: true, missing: [], broken: [] };
      const mode = await settings.get('forcejoin.failure_mode');
      const results = await Promise.all(channels.map((ch) => checkOne(ch, user.telegram_id)));
      await recordHealth(results, mode);
      const verdict = evaluate(results, mode);
      if (verdict.passed) {
        const until = now + Number(await settings.get('forcejoin.ttl_seconds'));
        if (user.force_join_ok_until === -1 && (await users.convertPass(user.telegram_id, until))) stats.count('fj.converted');
        else await users.setPass(user.telegram_id, until);
        user.force_join_ok_until = until;
      } else if (user.force_join_ok_until !== -1 && (await users.markGated(user.telegram_id))) {
        user.force_join_ok_until = -1;
        stats.count('fj.gated');
      }
      return verdict;
    },

    /** Seeds the static list once, only into an empty table. */
    async seedIfNeeded() {
      if (await settings.get('forcejoin.seeded')) return 0;
      const n = await repo.seedIfEmpty(FORCE_JOIN_SEED, clock.now());
      await settings.setInternal('forcejoin.seeded', 1);
      return n;
    },

    /** Adds a channel from a typed reference or a forwarded post. */
    async add(actor, text, message) {
      assertCan(actor, 'forcejoin.manage');
      if ((await repo.count()) >= LIMITS.forceJoinMax) throw new UserError('fjm.err.max', { max: LIMITS.forceJoinMax });
      const ref = parseChatRef(text, message);
      if (!ref) throw new UserError('fjm.err.ref');
      if (ref.kind === 'invite') throw new UserError('fjm.err.invite');
      const info = await tg.inspectChannel(ref.kind === 'username' ? '@' + ref.value : ref.value);
      if (!info.ok) throw new UserError({ not_channel: 'fjm.err.not_channel', transient: 'fjm.err.transient' }[info.error] || 'fjm.err.not_found');
      if (!info.isAdmin) throw new UserError('fjm.err.not_admin', { title: info.chat.title || '', bot: BOT_USERNAME });
      if (await repo.getByChatId(info.chat.id)) throw new UserError('fjm.err.duplicate');
      const row = await repo.insert({
        chat_id: info.chat.id,
        username: info.chat.username || null,
        title: String(info.chat.title || '').slice(0, 128),
        invite_link: info.chat.username ? null : info.chat.invite_link || null,
        max: LIMITS.forceJoinMax,
        now: clock.now(),
      });
      if (!row) throw new UserError((await repo.getByChatId(info.chat.id)) ? 'fjm.err.duplicate' : 'fjm.err.max', { max: LIMITS.forceJoinMax });
      await audit.record(actor, 'forcejoin.add', 'channel', row.chat_id, { title: row.title });
      await invalidate();
      return row;
    },

    async remove(actor, id) {
      assertCan(actor, 'forcejoin.manage');
      const row = await mustGet(id);
      await repo.remove(id);
      await audit.record(actor, 'forcejoin.remove', 'channel', row.chat_id, { title: row.title });
      await invalidate();
      return row;
    },

    async setEnabled(actor, id, flag) {
      assertCan(actor, 'forcejoin.manage');
      const row = await mustGet(id);
      await repo.setEnabled(id, flag, clock.now());
      await audit.record(actor, flag ? 'forcejoin.enable' : 'forcejoin.disable', 'channel', row.chat_id);
      await invalidate();
    },

    /** Moves a channel one place up (-1) or down (+1). */
    async move(actor, id, dir) {
      assertCan(actor, 'forcejoin.manage');
      const ids = (await repo.list()).map((r) => r.id);
      const i = ids.indexOf(id);
      if (i < 0) throw new UserError('fjm.err.gone');
      const j = i + dir;
      if (j < 0 || j >= ids.length) return false;
      [ids[i], ids[j]] = [ids[j], ids[i]];
      await repo.reorder(ids, clock.now());
      await audit.record(actor, 'forcejoin.reorder', 'channel', id, { dir });
      await invalidate();
      return true;
    },

    /** @param {string|null} link null clears it */
    async setInviteLink(actor, id, link) {
      assertCan(actor, 'forcejoin.manage');
      const row = await mustGet(id);
      if (link !== null && !isValidInviteLink(link)) throw new UserError('fjm.err.link');
      await repo.setInviteLink(id, link ? link.trim() : null, clock.now());
      await audit.record(actor, 'forcejoin.link', 'channel', row.chat_id, { set: !!link });
      await invalidate();
    },

    async setFailureMode(actor, mode) {
      assertCan(actor, 'forcejoin.manage');
      await settings.set(actor, 'forcejoin.failure_mode', mode);
      await invalidate();
    },

    /** Re-checks the bot's rights in every channel and refreshes titles. */
    async checkHealth(actor) {
      assertCan(actor, 'forcejoin.manage');
      const rows = await repo.list();
      const now = clock.now();
      await Promise.all(rows.map(async (ch) => {
        const info = await tg.inspectChannel(ch.chat_id);
        const status = info.ok ? (info.isAdmin ? 'ok' : 'bot_not_admin') : info.error === 'transient' ? 'error' : 'not_found';
        await repo.setHealth(ch.id, status, now);
        if (info.ok && (info.chat.title !== ch.title || (info.chat.username || null) !== ch.username)) {
          await repo.updateMeta(ch.id, { title: String(info.chat.title || '').slice(0, 128), username: info.chat.username || null }, now);
        }
      }));
      return rows.length;
    },

    /** my_chat_member in a force-join channel: health + alert. @returns {Promise<boolean>} whether it was one of ours */
    async onBotStatusChange(chat, member) {
      const ch = await repo.getByChatId(chat.id);
      if (!ch) return false;
      const ok = member && (member.status === 'administrator' || member.status === 'creator');
      const now = clock.now();
      await repo.setHealth(ch.id, ok ? 'ok' : 'bot_not_admin', now);
      if (chat.title && chat.title !== ch.title) await repo.updateMeta(ch.id, { title: String(chat.title).slice(0, 128), username: chat.username || null }, now);
      if (!ok) {
        const mode = await settings.get('forcejoin.failure_mode');
        await alerts.owner(`fj:${ch.chat_id}`, (lang) => t(lang, 'alert.fj_bot_removed', {
          title: label(ch), status: (member && member.status) || '?', mode: raw(t(lang, `fjm.mode.${mode}`)),
        }), LIMITS.alertForceJoinEverySeconds);
      }
      return true;
    },
  };
}
