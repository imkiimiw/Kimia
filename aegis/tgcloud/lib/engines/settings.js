/*
 * Per-chat settings (aegis_chat_settings): only changed keys are stored; DEFAULTS fill the rest.
 * Every change is validated here and logged (settings.set, with the old and new value).
 *
 *   audit          '1' = Audit Mode: automatic punishments are only recorded and reported
 *   notify         '1' = post a notice in the group when someone is punished
 *   warn_ttl       seconds after which a warning stops counting ('0' = never)
 *   warn_reset     '1' = clear a member's warnings after the last step was applied
 *   steps          JSON ladder [{ n, a, d }] (lib/engines/steps.js)
 *   betray_on, betray_n, betray_sec, betray_action ('demote' | 'alert')   anti-betrayal
 *   log_chat       the log channel/group id ('0' = none); log_on; log_punish, log_lists, log_admin,
 *                  log_settings, log_locks — what is posted there
 *   new_window     seconds a member counts as new (locks that apply to new members only)
 */
import { db } from 'sdk';
import { sql } from 'sdk/db';
import * as audit from '../core/audit.js';
import { nowSec, parseJson } from '../core/util.js';
import { NEW_WINDOWS } from '../config.js';
import { DEFAULT_STEPS, validSteps } from './steps.js';

export const DEFAULTS = {
  audit: '0',
  notify: '1',
  warn_ttl: '0',
  warn_reset: '1',
  steps: JSON.stringify(DEFAULT_STEPS),
  betray_on: '1',
  betray_n: '5',
  betray_sec: '60',
  betray_action: 'demote',
  log_chat: '0',
  log_on: '1',
  log_punish: '1',
  log_lists: '1',
  log_admin: '1',
  log_settings: '1',
  log_locks: '1',
  new_window: '86400',
};

export const WARN_TTLS = [0, 86400, 7 * 86400, 30 * 86400];
export const BETRAY_NS = [3, 5, 10, 20];
export const BETRAY_SECS = [60, 300, 600, 3600];
const FLAGS = new Set(['audit', 'notify', 'warn_reset', 'betray_on', 'log_on', 'log_punish', 'log_lists', 'log_admin', 'log_settings', 'log_locks']);

function valid(key, value) {
  const v = String(value);
  if (FLAGS.has(key)) return v === '0' || v === '1';
  if (key === 'warn_ttl') return WARN_TTLS.includes(Number(v));
  if (key === 'betray_n') return BETRAY_NS.includes(Number(v));
  if (key === 'betray_sec') return BETRAY_SECS.includes(Number(v));
  if (key === 'betray_action') return v === 'demote' || v === 'alert';
  if (key === 'steps') return validSteps(parseJson(v, null));
  if (key === 'log_chat') return /^-?\d{1,16}$/.test(v);
  if (key === 'new_window') return NEW_WINDOWS.includes(Number(v));
  return false;
}

/* All settings of a chat, defaults filled in; cached on ctx for the update. */
export async function all(ctx, chatId) {
  ctx.chatSettings = ctx.chatSettings || {};
  if (ctx.chatSettings[chatId]) return ctx.chatSettings[chatId];
  const rows = await db.all(sql`SELECT key, value FROM aegis_chat_settings WHERE chat_id = ${chatId} LIMIT 100`);
  const out = { ...DEFAULTS };
  for (const r of rows) if (r.key in DEFAULTS) out[r.key] = r.value;
  ctx.chatSettings[chatId] = out;
  return out;
}

export const flag = (s, key) => s[key] === '1';
export const steps = (s) => {
  const parsed = parseJson(s.steps, null);
  return validSteps(parsed) ? parsed : DEFAULT_STEPS;
};

/* Sets one key (validated). Gives false for an invalid value. Logged with the old value. */
export async function set(ctx, chatId, key, value, actorId) {
  if (!(key in DEFAULTS) || !valid(key, value)) return false;
  const s = await all(ctx, chatId);
  const before = s[key];
  const v = String(value);
  if (before === v) return true;
  await db.run(sql`INSERT INTO aegis_chat_settings (chat_id, key, value, updated_by, updated_at) VALUES (${chatId}, ${key}, ${v}, ${actorId}, ${nowSec()})
    ON CONFLICT(chat_id, key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`);
  s[key] = v;
  await audit.log(actorId, 'settings.set', { chatId, target: key, details: { from: before, to: v } });
  return true;
}

export async function toggle(ctx, chatId, key, actorId) {
  const s = await all(ctx, chatId);
  const next = flag(s, key) ? '0' : '1';
  await set(ctx, chatId, key, next, actorId);
  return next === '1';
}

/* A group became a supergroup: its settings move with it. */
export async function migrate(oldId, newId) {
  await db.run(sql`DELETE FROM aegis_chat_settings WHERE chat_id = ${newId} AND key IN (SELECT key FROM aegis_chat_settings WHERE chat_id = ${oldId})`);
  await db.run(sql`UPDATE aegis_chat_settings SET chat_id = ${newId} WHERE chat_id = ${oldId}`);
}
