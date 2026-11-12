// The per-invocation context: clock, logger, Telegram client, settings (loaded once), buffered
// stats, owner alerts, audit, conversation state, the current user and their language.
// Module state does not survive between invocations on this platform, so everything is rebuilt.
import { createLogger } from './core/logger.js';
import { createTelegram } from './tg.js';
import { DEFAULTS, OWNER_ID, T, SEED_CHANNELS } from './config.js';
import { system } from './db/system.js';
import { users } from './db/users.js';
import { gate as gateDb } from './db/gate.js';
import { t, tp, normLang } from './i18n/index.js';
import { truncate, dayKey, parseJson } from './core/util.js';
import { roleOf, can } from './core/roles.js';

/** Unix seconds; Date.now() advances across awaits on this platform (not during CPU work). */
export const clock = Object.freeze({ now: () => Math.floor(Date.now() / 1000), ms: () => Date.now() });

/** Bumped when bootstrap() has something new to set up. */
const BOOT_VERSION = 1;

/** @param {{kind: string, updateId?: number|null}} opts */
export async function createApp({ kind, updateId = null }) {
  const log = createLogger({ update_id: updateId, handler: kind });
  /** @type {any} */
  const app = { kind, updateId, clock, log, user: null, role: 'user', lang: 'fa' };
  app.tg = createTelegram({ log, onBlocked: (id) => users.markBlocked(id, true) });

  /* ---- settings: one query per invocation ---- */
  const stored = new Map();
  for (const row of await system.allSettings()) stored.set(row.key, parseJson(row.value, null));
  app.settings = {
    get: (key) => (stored.has(key) ? stored.get(key) : DEFAULTS[key]),
    has: (key) => stored.has(key),
    async set(actorId, key, value) {
      await system.setSetting(key, value, actorId, clock.now());
      stored.set(key, value);
      if (actorId) await app.audit(actorId, 'setting', key, typeof value === 'object' ? JSON.stringify(value).slice(0, 200) : String(value).slice(0, 200));
    },
  };
  app.flag = (feature) => app.settings.get(`flags.${feature}`) === true;

  /* ---- buffered stats, written in one statement by the boundary ---- */
  const counters = new Map();
  app.stats = {
    count: (metric, n = 1) => counters.set(metric, (counters.get(metric) || 0) + n),
    async flush() {
      if (!counters.size) return;
      const pairs = [...counters.entries()];
      counters.clear();
      try {
        await system.addStats(dayKey(clock.now()), pairs);
      } catch (e) {
        log.warn('stats_flush_failed', { error: String(e && e.message).slice(0, 200) });
      }
    },
  };

  app.audit = (actorId, action, target = null, details = null) =>
    system.audit({ at: clock.now(), actor_id: actorId, action, target: target === null ? null : String(target).slice(0, 100), details }).catch(() => null);

  /* ---- owner alerts (throttled per key) and the error log ---- */
  app.alerts = {
    async owner(key, render, everySec, keyboard) {
      try {
        if (!(await system.claimAlert(key, clock.now(), everySec))) return false;
        const owner = await users.get(OWNER_ID);
        await app.tg.send(OWNER_ID, { text: render(normLang(owner && owner.lang)), keyboard }, 'alert');
        return true;
      } catch (e) {
        log.warn('alert_failed', { error: String(e && (e.description || e.message)).slice(0, 200) });
        return false;
      }
    },
    async recordError(scope, userId, err) {
      try {
        await system.insertError({
          at: clock.now(),
          tg_id: Number.isSafeInteger(userId) ? userId : null,
          scope: String(scope).slice(0, 64),
          code: String((err && (err.code || err.name)) || 'Error').slice(0, 64),
          message: truncate(String((err && (err.description || err.message)) || err), 300),
        });
      } catch (e) {
        log.error('error_log_failed', { error: String(e && e.message).slice(0, 200) });
      }
    },
  };

  /* ---- conversation state (user_state) ---- */
  app.state = {
    async get(id) {
      const r = await system.getState(id, clock.now());
      return r ? { step: r.step, payload: parseJson(r.payload, {}) } : null;
    },
    set: (id, step, payload = {}) => system.setState(id, step, payload, clock.now() + T.stateTtlSec),
    clear: (id) => system.clearState(id),
  };

  /* ---- the current user ---- */
  app.setUser = async (row) => {
    app.user = row;
    app.lang = normLang(row && row.lang ? row.lang : row && row.lang_code && String(row.lang_code).startsWith('en') ? 'en' : 'fa');
    const staffRow = row && row.tg_id !== OWNER_ID ? await system.getStaff(row.tg_id) : null;
    app.role = roleOf(row, staffRow);
  };
  app.can = (perm) => can(app.role, perm);
  app.t = (key, vars) => t(app.lang, key, vars);
  app.tp = (key, vars) => tp(app.lang, key, vars);

  await bootstrap(app);
  return app;
}

/** One-time setup (idempotent): the forced-join seed. */
async function bootstrap(app) {
  if (Number(app.settings.get('boot.version') || 0) >= BOOT_VERSION) return;
  const now = clock.now();
  if (await system.claimSetting('boot.seeded', 1, now)) await gateDb.seedIfEmpty(SEED_CHANNELS, now);
  await system.setSetting('boot.version', BOOT_VERSION, 0, now);
  app.log.info('bootstrapped');
}
