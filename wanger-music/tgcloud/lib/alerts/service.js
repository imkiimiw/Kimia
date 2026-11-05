// Owner alerts (throttled per key, one statement elects who sends) and the error log.
import { OWNER_ID, LIMITS } from '../config/static.js';
import { truncate } from '../core/util.js';

/**
 * @param {{repo: any, tg: any, clock: any, log: any, ownerLang: () => Promise<string>}} deps
 */
export function createAlertsService({ repo, tg, clock, log, ownerLang }) {
  return {
    /**
     * Sends `render(lang)` to the owner at most once per `everySeconds` for `key`.
     * Never throws. @returns {Promise<boolean>} whether it was sent
     */
    async owner(key, render, everySeconds) {
      try {
        if (!(await repo.claimAlert(key, clock.now(), everySeconds))) return false;
        const lang = await ownerLang();
        await tg.send(OWNER_ID, { text: render(lang) }, 'alert');
        return true;
      } catch (e) {
        log.warn('alert_failed', { error: String(e && (e.description || e.message)).slice(0, 200) });
        return false;
      }
    },

    /** Stores an error row (truncated, no raw update or message text). Never throws. */
    async recordError({ handler, updateId = null, userId = null, err, context = {} }) {
      try {
        await repo.insertError({
          created_at: clock.now(),
          handler: String(handler).slice(0, 64),
          update_id: Number.isSafeInteger(updateId) ? updateId : null,
          user_id: Number.isSafeInteger(userId) ? userId : null,
          code: String((err && (err.code || err.name)) || 'Error').slice(0, 64),
          message: truncate(String((err && (err.description || err.message)) || err), LIMITS.errorMessageMax),
          stack: truncate(String((err && err.stack) || ''), LIMITS.errorStackMax),
          context: JSON.stringify(context).slice(0, 1000),
        });
      } catch (e) {
        log.error('error_log_failed', { error: String(e && e.message).slice(0, 200) });
      }
    },

    recentErrors: (n = LIMITS.recentErrors) => repo.recentErrors(n),
  };
}
