// Groups the bot is in, from my_chat_member updates (Phase 5 builds the group features on this).
import { db } from 'sdk';
import { sql } from 'sdk/db';

/**
 * Records the bot's status in a group. Returns { created, activated, deactivated } so the caller
 * keeps the running "groups_active" counter exact; each transition is claimed by one statement.
 */
export async function recordStatus(chat, status, isAdmin, by, now) {
  const active = ['member', 'administrator', 'restricted'].includes(status) ? 1 : 0;
  const ins = await db.run(sql`INSERT INTO groups (chat_id, type, title, username, bot_status, is_admin, active, added_by, added_at, updated_at)
    VALUES (${chat.id}, ${chat.type || null}, ${chat.title || null}, ${chat.username || null}, ${status}, ${isAdmin ? 1 : 0}, ${active}, ${by}, ${now}, ${now})
    ON CONFLICT DO NOTHING`);
  if (ins.rowsAffected === 1) {
    await db.run(sql`INSERT INTO group_settings (chat_id, updated_at) VALUES (${chat.id}, ${now}) ON CONFLICT DO NOTHING`);
    return { created: true, activated: active === 1, deactivated: false };
  }
  const flip = await db.run(sql`UPDATE groups SET type = ${chat.type || null}, title = ${chat.title || null}, username = ${chat.username || null},
      bot_status = ${status}, is_admin = ${isAdmin ? 1 : 0}, active = ${active}, updated_at = ${now},
      added_by = iif(${active} = 1, ${by}, added_by), added_at = iif(${active} = 1, ${now}, added_at)
    WHERE chat_id = ${chat.id} AND active != ${active}`);
  if (flip.rowsAffected === 1) {
    if (active) await db.run(sql`INSERT INTO group_settings (chat_id, updated_at) VALUES (${chat.id}, ${now}) ON CONFLICT DO NOTHING`);
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
