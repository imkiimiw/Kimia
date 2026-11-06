// Groups the bot is in, from my_chat_member updates (Phase 5 builds the group features on this).
import { db } from 'sdk';
import { sql } from 'sdk/db';

/**
 * Records the bot's status in a group. Returns { created, activated, deactivated } so the caller
 * keeps the running "groups_active" counter exact; each transition is claimed by one statement.
 */
export async function recordStatus(chat, status, isAdmin, by, now, lang = null) {
  const active = ['member', 'administrator', 'restricted'].includes(status) ? 1 : 0;
  const ins = await db.run(sql`INSERT INTO groups (chat_id, type, title, username, bot_status, is_admin, active, added_by, added_at, updated_at)
    VALUES (${chat.id}, ${chat.type || null}, ${chat.title || null}, ${chat.username || null}, ${status}, ${isAdmin ? 1 : 0}, ${active}, ${by}, ${now}, ${now})
    ON CONFLICT DO NOTHING`);
  if (ins.rowsAffected === 1) {
    await db.run(sql`INSERT INTO group_settings (chat_id, lang, updated_at) VALUES (${chat.id}, ${lang}, ${now}) ON CONFLICT DO NOTHING`);
    return { created: true, activated: active === 1, deactivated: false };
  }
  const flip = await db.run(sql`UPDATE groups SET type = ${chat.type || null}, title = ${chat.title || null}, username = ${chat.username || null},
      bot_status = ${status}, is_admin = ${isAdmin ? 1 : 0}, active = ${active}, updated_at = ${now},
      added_by = iif(${active} = 1, ${by}, added_by), added_at = iif(${active} = 1, ${now}, added_at)
    WHERE chat_id = ${chat.id} AND active != ${active}`);
  if (flip.rowsAffected === 1) {
    if (active) await db.run(sql`INSERT INTO group_settings (chat_id, lang, updated_at) VALUES (${chat.id}, ${lang}, ${now}) ON CONFLICT DO NOTHING`);
    return { created: false, activated: active === 1, deactivated: active === 0 };
  }
  await db.run(sql`UPDATE groups SET type = ${chat.type || null}, title = ${chat.title || null}, username = ${chat.username || null},
      bot_status = ${status}, is_admin = ${isAdmin ? 1 : 0}, updated_at = ${now}
    WHERE chat_id = ${chat.id}`);
  return { created: false, activated: false, deactivated: false };
}

export async function get(chatId) {
  return db.get(sql`SELECT * FROM groups WHERE chat_id = ${chatId}`);
}

/** The group's settings row (created with the defaults if it is missing). */
export async function settingsOf(chatId, now) {
  await db.run(sql`INSERT INTO group_settings (chat_id, updated_at) VALUES (${chatId}, ${now}) ON CONFLICT DO NOTHING`);
  return db.get(sql`SELECT * FROM group_settings WHERE chat_id = ${chatId}`);
}

/** The settings an admin may change, and how each is stored. */
export const GROUP_FIELDS = ['auto_download', 'admin_only', 'silent', 'max_links', 'max_mb', 'user_cooldown_s', 'group_cooldown_s', 'lang', 'platforms'];

export async function setSetting(chatId, field, value, by, now) {
  if (!GROUP_FIELDS.includes(field)) throw new Error('group setting: unknown field ' + field);
  // The column name comes from the fixed list above, never from input.
  await db.run(sql`UPDATE group_settings SET ${sql.raw(field)} = ${value}, updated_by = ${by}, updated_at = ${now} WHERE chat_id = ${chatId}`);
}

/** Group cooldown: true for the one call that may download now. */
export async function claimGroupSlot(chatId, now, cooldownS) {
  const r = await db.run(sql`UPDATE groups SET last_dl_at = ${now} WHERE chat_id = ${chatId} AND last_dl_at <= ${now - cooldownS}`);
  return r.rowsAffected === 1;
}

/** Member cooldown inside a group: true for the one call that may download now. */
export async function claimMemberSlot(chatId, userId, now, cooldownS) {
  const r = await db.run(sql`INSERT INTO group_members (chat_id, user_id, last_dl_at) VALUES (${chatId}, ${userId}, ${now})
    ON CONFLICT(chat_id, user_id) DO UPDATE SET last_dl_at = excluded.last_dl_at WHERE group_members.last_dl_at <= ${now - cooldownS}`);
  return r.rowsAffected === 1;
}

export async function member(chatId, userId) {
  return db.get(sql`SELECT * FROM group_members WHERE chat_id = ${chatId} AND user_id = ${userId}`);
}

export async function setMemberPass(chatId, userId, until) {
  await db.run(sql`INSERT INTO group_members (chat_id, user_id, join_ok_until) VALUES (${chatId}, ${userId}, ${until})
    ON CONFLICT(chat_id, user_id) DO UPDATE SET join_ok_until = excluded.join_ok_until`);
}

/** The join prompt for a member: at most once per `everyS` (true = send it now). */
export async function claimPrompt(chatId, userId, now, everyS) {
  const r = await db.run(sql`INSERT INTO group_members (chat_id, user_id, prompted_at) VALUES (${chatId}, ${userId}, ${now})
    ON CONFLICT(chat_id, user_id) DO UPDATE SET prompted_at = excluded.prompted_at WHERE group_members.prompted_at <= ${now - everyS}`);
  return r.rowsAffected === 1;
}

/** Double-tap guard for a group's settings buttons (same message + data within windowMs). */
export async function claimTap(chatId, key, nowMs, windowMs) {
  const r = await db.run(sql`UPDATE groups SET last_cb = ${key}, last_cb_at_ms = ${nowMs}
    WHERE chat_id = ${chatId} AND NOT (last_cb IS ${key} AND last_cb_at_ms > ${nowMs - windowMs})`);
  return r.rowsAffected === 1;
}
