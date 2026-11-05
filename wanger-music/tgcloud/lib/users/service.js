// UserService: profile upserts (throttled), language, ban/block, admin roles, counts.
import { LIMITS } from '../config/static.js';
import { assertCan, isOwnerId, isStaff } from '../permissions/policy.js';
import { UserError } from '../core/util.js';
import { normLang } from '../i18n/index.js';

/** @param {{repo: any, clock: any, audit: any, settings: any}} deps */
export function createUsersService({ repo, clock, audit, settings }) {
  const svc = {
    /**
     * Upserts the sender of a private-chat update. Reads always; writes only for a new user, a
     * changed profile, an unblock, or when last_seen_at is older than 10 minutes.
     * @param {{id: number, username?: string, first_name?: string, language_code?: string}} from
     */
    async touch(from) {
      const now = clock.now();
      const row = await repo.get(from.id);
      const fresh = {
        telegram_id: from.id,
        username: from.username || null,
        first_name: from.first_name ? String(from.first_name).slice(0, 128) : null,
        language_code: from.language_code ? String(from.language_code).slice(0, 16) : null,
        now,
      };
      if (row && row.username === fresh.username && row.first_name === fresh.first_name && row.language_code === fresh.language_code
        && !row.is_blocked && now - row.last_seen_at < LIMITS.lastSeenWriteSeconds) return row;
      return (await repo.upsertSeen(fresh)) || row;
    },

    /** Inline mode: read only; a first-time inline user gets a row (needed for the force-join pass). */
    async touchInline(from) {
      const row = await repo.get(from.id);
      if (row) return row;
      await repo.insertInline({
        telegram_id: from.id,
        username: from.username || null,
        first_name: from.first_name ? String(from.first_name).slice(0, 128) : null,
        language_code: from.language_code ? String(from.language_code).slice(0, 16) : null,
        now: clock.now(),
      });
      return repo.get(from.id);
    },

    get: (tid) => repo.get(tid),

    /** @param {string} ref numeric id or @username */
    async find(ref) {
      const s = String(ref || '').trim();
      if (/^\d{1,16}$/.test(s)) return repo.get(Number(s));
      const m = /^@?([A-Za-z][A-Za-z0-9_]{3,31})$/.exec(s);
      return m ? repo.findByUsername(m[1]) : null;
    },

    /** The UI language of a user row (their choice, else the default setting). */
    async languageOf(user) {
      if (user && (user.ui_language === 'fa' || user.ui_language === 'en')) return user.ui_language;
      return normLang(await settings.get('ui.default_language'));
    },

    async setLanguage(user, lang) {
      await repo.setLanguage(user.telegram_id, normLang(lang));
      user.ui_language = normLang(lang);
    },

    markBlocked: (tid, flag) => repo.setBlocked(tid, flag),

    async setBanned(actor, tid, flag) {
      assertCan(actor, 'users.ban');
      const target = await repo.get(tid);
      if (!target) throw new UserError('usr.not_found');
      if (isOwnerId(tid)) throw new UserError('usr.err.owner');
      if (flag && isStaff(target)) throw new UserError('usr.err.staff_ban');
      const row = await repo.setBanned(tid, flag);
      await audit.record(actor, flag ? 'users.ban' : 'users.unban', 'user', tid);
      return row;
    },

    /** Grants or removes the admin role. Creates a bare row for an id that never started the bot. */
    async setAdmin(actor, tid, flag) {
      assertCan(actor, 'admins.manage');
      if (isOwnerId(tid)) throw new UserError('usr.err.owner');
      if (!Number.isSafeInteger(tid) || tid <= 0) throw new UserError('usr.err.bad_id');
      if (flag) await repo.insertBare(tid, clock.now());
      const target = await repo.get(tid);
      if (!target) throw new UserError('usr.not_found');
      if (flag && target.role === 'admin') throw new UserError('usr.err.already_admin');
      if (!flag && target.role !== 'admin') throw new UserError('usr.err.not_admin');
      const row = await repo.setRole(tid, flag ? 'admin' : 'user');
      await audit.record(actor, flag ? 'admins.add' : 'admins.remove', 'user', tid);
      return row;
    },

    listAdmins: (page, size) => repo.listAdmins(size, page * size),
    adminIds: () => repo.listAdminIds(200).then((rows) => rows.map((r) => r.telegram_id)),
    stats: () => repo.stats(clock.now()),
    countRecipients: () => repo.countRecipients(),
    recipientsAfter: (cursor, limit) => repo.recipientsAfter(cursor, limit),
    setPass: (tid, until) => repo.setForceJoinPass(tid, until),
    clearAllPasses: () => repo.clearAllPasses(clock.now()),
  };
  return svc;
}
