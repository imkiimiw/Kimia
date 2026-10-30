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
 *                  log_settings, log_locks, log_security — what is posted there
 *   new_window     seconds a member counts as new (locks that apply to new members only)
 * Phase 6 — the 26 advanced settings and the extra settings (ui/advanced.js, ui/panel_adv.js):
 *   cleanup del_join del_leave del_pin del_chatinfo del_videochat del_cmds del_bots notice_ttl;
 *   messages slow max_lines max_mentions caps junk edit_window media_ttl; commands rules rules_btn
 *   member_cmds reply_private admin_call anon_cmds; join bot_kick jr_mode name_watch title_lock bot_alert;
 *   extras welcome_* goodbye_* fj_chats fa_n clean_* night_* tz min_len max_len reports report_dest
 *   ev_* linked title_locked.
 */
import { db } from 'sdk';
import { sql } from 'sdk/db';
import * as audit from '../core/audit.js';
import { nowSec, parseJson } from '../core/util.js';
import { CLEAN_MAX_TIMES, FJ_MAX_CHANNELS, NEW_WINDOWS } from '../config.js';
import { TZ_OFFSETS } from '../core/clock.js';
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
  log_security: '1',
  new_window: '86400',
  /* Phase 6: the 26 advanced settings */
  del_join: '0', del_leave: '0', del_pin: '0', del_chatinfo: '0', del_videochat: '0', del_cmds: '0', del_bots: '0', notice_ttl: '0',
  slow: '0', max_lines: '0', max_mentions: '0', caps: '0', junk: '0', edit_window: '0', media_ttl: '0',
  rules: '', rules_btn: '1', member_cmds: '1', reply_private: '0', admin_call: '1', anon_cmds: '0',
  bot_kick: '0', jr_mode: 'manual', name_watch: '0', title_lock: '0', bot_alert: '1',
  /* Phase 6: extra settings */
  welcome_on: '0', welcome_text: '', welcome_btns: '', welcome_clean: '1', goodbye_on: '0', goodbye_text: '',
  fj_chats: '[]', fa_n: '0', clean_on: '0', clean_times: '[]', clean_scope: 'all', night_on: '0', night_from: '0', night_to: '420',
  tz: 'auto', min_len: '0', max_len: '0', reports: '1', report_dest: 'admins', ev_chat: '0', ev_join: '1', ev_leave: '1', ev_admin: '1',
  ev_names: '1', linked: 'keep', title_locked: '',
};

/* Allowed values of the Phase 6 settings (flags are '0'/'1'). */
export const CHOICES = {
  notice_ttl: [0, 60, 300, 900, 3600], slow: [0, 10, 30, 60, 300], max_lines: [0, 10, 20, 50], max_mentions: [0, 3, 5, 10], edit_window: [0, 60, 300, 3600],
  media_ttl: [0, 3600, 21600, 86400], jr_mode: ['manual', 'approve', 'decline'], fa_n: [0, 1, 2, 3, 5, 10], clean_scope: ['all', 'media', 'service'],
  min_len: [0, 2, 3, 5, 10], max_len: [0, 200, 500, 1000, 2000, 4000], report_dest: ['admins', 'log'], linked: ['keep', 'unpin', 'delete'],
};
const TEXTS = { rules: 3000, welcome_text: 1000, welcome_btns: 1000, goodbye_text: 500, title_locked: 128 };

export const WARN_TTLS = [0, 86400, 7 * 86400, 30 * 86400];
export const BETRAY_NS = [3, 5, 10, 20];
export const BETRAY_SECS = [60, 300, 600, 3600];
const FLAGS = new Set(['audit', 'notify', 'warn_reset', 'betray_on', 'log_on', 'log_punish', 'log_lists', 'log_admin', 'log_settings', 'log_locks', 'log_security',
  'del_join', 'del_leave', 'del_pin', 'del_chatinfo', 'del_videochat', 'del_cmds', 'del_bots', 'caps', 'junk', 'rules_btn', 'member_cmds', 'reply_private',
  'admin_call', 'anon_cmds', 'bot_kick', 'name_watch', 'title_lock', 'bot_alert', 'welcome_on', 'welcome_clean', 'goodbye_on', 'clean_on', 'night_on', 'reports',
  'ev_join', 'ev_leave', 'ev_admin', 'ev_names']);
export const isFlag = (key) => FLAGS.has(key);

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
  if (CHOICES[key]) return CHOICES[key].map(String).includes(v);
  if (TEXTS[key] !== undefined) return [...v].length <= TEXTS[key];
  if (key === 'tz') return v === 'auto' || TZ_OFFSETS.includes(Number(v));
  if (key === 'night_from' || key === 'night_to') return /^\d{1,4}$/.test(v) && Number(v) < 1440;
  if (key === 'ev_chat') return /^-?\d{1,16}$/.test(v);
  if (key === 'fj_chats') {
    const list = parseJson(v, null);
    return Array.isArray(list) && list.length <= FJ_MAX_CHANNELS && list.every((x) => x && Number.isSafeInteger(x.id));
  }
  if (key === 'clean_times') {
    const list = parseJson(v, null);
    return Array.isArray(list) && list.length <= CLEAN_MAX_TIMES && list.every((x) => Number.isInteger(x) && x >= 0 && x < 1440);
  }
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
  const long = TEXTS[key] !== undefined || key === 'fj_chats';
  await audit.log(actorId, 'settings.set', { chatId, target: key, details: long ? { length: [...v].length } : { from: before, to: v } });
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
