// Owner broadcast in resumable batches (no scheduler on this platform): each «▶️ دسته\u200cی بعدی» press
// copies the message to the next BROADCAST_BATCH users. A lease keeps two presses from sending the
// same batch; on a 429 the batch stops and the cursor stays at the last delivered user, so nobody
// gets it twice. Users who blocked the bot are marked.
import { BROADCAST_BATCH } from './config.js';
import * as bc from './db/broadcasts.js';
import * as users from './db/users.js';
import * as tg from './tg.js';

const LEASE_S = 25; // longer than one batch can take inside a ~30 s invocation

/** → { ok, row, sent, failed, blocked, done, busy?, rate? } */
export async function runBatch(ctx, id) {
  const row = await bc.lease(id, ctx.now, LEASE_S);
  if (!row) return { ok: false, busy: true, row: await bc.get(id) };
  const recipients = await users.nextRecipients(row.cursor, BROADCAST_BATCH);
  let cursor = row.cursor;
  let sent = 0;
  let failed = 0;
  let blocked = 0;
  let rate = false;
  for (const r of recipients) {
    if (r.id === row.created_by) { cursor = r.id; continue; }
    try {
      await tg.call(ctx, 'broadcast', 'copyMessage', { chat_id: r.id, from_chat_id: row.from_chat_id, message_id: row.message_id });
      sent++;
    } catch (err) {
      if (err.kind === 'rate') { rate = true; break; }
      if (err.kind === 'blocked' || err.kind === 'chat_not_found' || err.kind === 'user_not_found') { blocked++; await users.setBlocked(r.id, true); } else failed++;
    }
    cursor = r.id;
  }
  const done = !rate && recipients.length < BROADCAST_BATCH;
  await bc.progress(id, { cursor, sent, failed, blocked, done }, ctx.now);
  return { ok: true, row: await bc.get(id), sent, failed, blocked, done, rate };
}
