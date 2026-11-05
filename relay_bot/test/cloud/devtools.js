/*
 * Test-only endpoint. test/cloud/run.mjs copies it to tgcloud/endpoints/zz_devtools.js for the length
 * of a run (`tgcloud run` uploads local modules without deploying them) and deletes it after.
 * NEVER push it. It only touches the made-up test users (ids 990000000-990000999) and the bot's own
 * test messages in the owner's chat.
 */
import { api, db, EndpointError } from 'sdk';
import { sql } from 'sdk/db';
import { OWNER_ID } from '../lib/config.js';

export default async function (input, ctx) {
  const caller = ctx && ctx.initData && ctx.initData.user;
  if (!caller || Number(caller.id) !== OWNER_ID) throw new EndpointError('owner only', { code: 'FORBIDDEN' });
  const userId = Number(input.userId);
  if (!(userId >= 990000000 && userId <= 990000999)) throw new EndpointError('test users only', { code: 'NOT_TEST_USER' });

  if (input.action === 'rows') {
    const user = await db.get(sql`SELECT * FROM users WHERE user_id = ${userId} LIMIT 1`);
    const links = await db.all(sql`SELECT owner_msg_id, user_msg_id, seen FROM links WHERE user_id = ${userId} LIMIT 50`);
    return { user, links };
  }
  if (input.action === 'cleanup') {
    const links = await db.run(sql`DELETE FROM links WHERE user_id = ${userId}`);
    const users = await db.run(sql`DELETE FROM users WHERE user_id = ${userId}`);
    const ids = (input.messageIds || []).map(Number).filter((n) => n > 0).slice(0, 100);
    let deleted = false;
    if (ids.length) deleted = await api.deleteMessages({ chat_id: OWNER_ID, message_ids: ids });
    return { links: links.rowsAffected, users: users.rowsAffected, deleted, messages: ids.length };
  }
  throw new EndpointError('unknown action', { code: 'BAD_ACTION' });
}
