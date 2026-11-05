// SettingsService: runtime values from the `settings` table, with defaults and validation from
// lib/config/static.js. Loaded once per invocation (one query); nothing is cached across updates.
import { SETTINGS, TIME_ZONES } from '../config/static.js';
import { parseIntInRange } from '../core/util.js';
import { assertCan } from '../permissions/policy.js';

/**
 * Validates and normalises a value for a setting key (pure).
 * @returns {{ok: true, value: any} | {ok: false}}
 */
export function validateSetting(key, value) {
  const d = SETTINGS[key];
  if (!d) return { ok: false };
  switch (d.type) {
    case 'enum':
      return /** @type {string[]} */ (d.values).includes(value) ? { ok: true, value } : { ok: false };
    case 'int': {
      const n = typeof value === 'number' ? value : parseIntInRange(value, /** @type {number} */ (d.min ?? -1e15), /** @type {number} */ (d.max ?? 1e15));
      if (n === null || !Number.isSafeInteger(n)) return { ok: false };
      if ((d.min !== undefined && n < d.min) || (d.max !== undefined && n > d.max)) return { ok: false };
      return { ok: true, value: n };
    }
    case 'bool':
      return typeof value === 'boolean' ? { ok: true, value } : { ok: false };
    case 'tz':
      return typeof value === 'string' && value in TIME_ZONES ? { ok: true, value } : { ok: false };
    case 'chat':
      return value === null || Number.isSafeInteger(value) ? { ok: true, value } : { ok: false };
    case 'json':
      return { ok: true, value };
    default:
      return { ok: false };
  }
}

/** Next value when an enum / bool / tz setting is tapped (pure). */
export function cycleValue(key, current) {
  const d = SETTINGS[key];
  if (!d) return current;
  if (d.type === 'bool') return !current;
  const list = d.type === 'tz' ? Object.keys(TIME_ZONES) : d.type === 'enum' ? /** @type {string[]} */ (d.values) : null;
  if (!list) return current;
  return list[(list.indexOf(current) + 1) % list.length];
}

/** Keys shown in ⚙️ Settings, in order. */
export const EDITABLE_KEYS = Object.keys(SETTINGS).filter((k) => !SETTINGS[k].internal);

/**
 * @param {{repo: any, clock: any, audit: any}} deps
 */
export function createSettingsService({ repo, clock, audit }) {
  /** @type {Map<string, any> | null} */
  let cache = null;

  async function load() {
    if (cache) return cache;
    const m = new Map();
    for (const row of await repo.all()) {
      try {
        m.set(row.key, JSON.parse(row.value));
      } catch {
        // a malformed value falls back to the default
      }
    }
    cache = m;
    return m;
  }

  /** @param {string} key */
  async function get(key) {
    const d = SETTINGS[key];
    if (!d) throw new Error(`unknown setting ${key}`);
    const m = await load();
    if (!m.has(key)) return d.default;
    const v = validateSetting(key, m.get(key));
    return v.ok ? v.value : d.default;
  }

  /** Owner-facing change: validated and audited. @returns {Promise<any>} the stored value */
  async function set(actor, key, value) {
    assertCan(actor, 'settings.manage');
    const v = validateSetting(key, value);
    if (!v.ok || SETTINGS[key].internal) throw new Error(`invalid value for ${key}`);
    const now = clock.now();
    await repo.upsert(key, JSON.stringify(v.value), actor ? actor.telegram_id : 0, now);
    (await load()).set(key, v.value);
    await audit.record(actor, 'settings.set', 'setting', key, { value: v.value });
    return v.value;
  }

  /** Internal state (tick times, cooldowns): not audited. */
  async function setInternal(key, value) {
    await repo.upsert(key, JSON.stringify(value), 0, clock.now());
    (await load()).set(key, value);
  }

  return {
    load,
    get,
    set,
    setInternal,
    /** Makes sure an internal row exists (needed before conditional updates on it). */
    ensure: (key, value) => repo.insertIfMissing(key, JSON.stringify(value), clock.now()),
    /** One conditional UPDATE elects a single tick winner. */
    claimTick: (now, interval) => repo.claimInterval('tick.last_at', now, interval),
    ping: () => repo.ping(),
  };
}
