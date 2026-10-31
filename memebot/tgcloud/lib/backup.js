/*
 * Backup channel: every saved meme is forwarded to the private channel ENV.backupChannelId, and
 * the channel message id is kept (memes.backup_chat_id / backup_msg_id). If the bot ever has to
 * be replaced, a new bot made admin of that channel can forwardMessage each id and get fresh
 * file_ids. When the user deleted the original message before writing keywords, the meme is sent
 * to the channel by file_id instead (caption #m<id>).
 * Failures never block an upload: the row keeps backup_msg_id NULL, the owner gets an alert (at
 * most every 3 hours), and the next successful backup retries up to RETRY older ones.
 * backup_msg_id = 0 means "gave up" (Telegram refused the file itself).
 */
import { ENV } from './env.js';
import { alertOwner } from './bot.js';
import * as store from './store.js';
import { call, describeError, isApiError, sendMeme } from './tg.js';
import { esc } from './util.js';

const RETRY = 2;

const originalGone = (err) => isApiError(err) && err.code === 400 && /message to forward not found|message_id_invalid|message not found/i.test(err.description);

async function sendCopy(ctx, meme) {
  const m = await sendMeme(ctx, 'backup.copy', ENV.backupChannelId, meme.kind, meme.file_id, `#m${meme.id}`, null, { disable_notification: true });
  await store.setBackup(meme.id, m.chat.id, m.message_id);
}

async function retryOlder(ctx, nowSec) {
  for (const meme of await store.pendingBackups(nowSec - 60, RETRY)) {
    try {
      await sendCopy(ctx, meme);
    } catch (err) {
      if (isApiError(err) && err.code === 400) await store.setBackup(meme.id, null, 0);
      else break;
    }
  }
}

/* Backs up a just-saved meme. Returns true when it is in the channel. */
export async function backupMeme(ctx, meme, fromChatId, messageId, nowSec) {
  if (!ENV.backupChannelId) return false;
  try {
    try {
      const m = await call(ctx, 'forwardMessage', { chat_id: ENV.backupChannelId, from_chat_id: fromChatId, message_id: messageId, disable_notification: true }, 'backup.forward');
      await store.setBackup(meme.id, m.chat.id, m.message_id);
    } catch (err) {
      if (!originalGone(err)) throw err;
      await sendCopy(ctx, meme);
    }
  } catch (err) {
    console.warn(`backup of meme ${meme.id} failed: ${describeError(err)}`);
    await alertOwner(ctx, 'backup', 'owner.backup_fail', { id: String(meme.id), err: esc(describeError(err)) }, nowSec);
    return false;
  }
  await retryOlder(ctx, nowSec);
  return true;
}
