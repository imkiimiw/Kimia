/*
 * The bot's channel (ENV.backupChannelId; by default @WangerChaos). The bot never posts to any
 * other channel. Two modes (ENV.backupMode, set at deploy time by scripts/gen-env.mjs):
 *
 * public (default, for a public channel): the channel is a public feed. A meme is posted when it
 * becomes public (approved at upload, approved by an admin, a private meme published) as a clean
 * copy by file_id: its keywords and the bot's @username as caption and a 👍 button, never the
 * uploader's name. Private, waiting and rejected memes are never posted. When a public meme is
 * removed (rejected after reports, deleted by its uploader, back to the queue after an edit) its
 * post is deleted; edited keywords update the caption.
 *
 * all (only for a private channel): every saved meme is forwarded as it was sent — a private
 * archive. If the user deleted the original before writing keywords, it is sent by file_id with
 * the caption #m<id>.
 *
 * Either way the channel message id is kept (memes.backup_chat_id / backup_msg_id): if the bot is
 * ever replaced, a new bot made admin of the channel can forwardMessage each id and get fresh
 * file_ids. Failures never block anything: the row keeps backup_msg_id NULL, the owner gets an
 * alert (at most every 3 hours), and the next successful post retries up to RETRY older ones.
 * backup_msg_id = 0 means "gave up" (Telegram refused the file itself).
 */
import { ENV } from './env.js';
import { APPROVED } from './config.js';
import { alertOwner, botUsername } from './bot.js';
import { likeButton } from './collection.js';
import { t } from './i18n.js';
import { DEFAULT_LANG } from './locales/index.js';
import * as store from './store.js';
import { call, captionable, describeError, isApiError, keyboard, sendMeme } from './tg.js';
import { esc, iso } from './util.js';

const RETRY = 2;
const isPublic = () => ENV.backupMode !== 'all';

const originalGone = (err) => isApiError(err) && err.code === 400 && /message to forward not found|message_id_invalid|message not found/i.test(err.description);

async function caption(ctx, meme, nowSec) {
  return t(DEFAULT_LANG, 'channel.caption', { kw: iso(meme.keywords), bot: esc(await botUsername(ctx, nowSec)) });
}

/* Posts one meme to the channel (a public-feed post, or an archive copy). Throws on failure. */
async function post(ctx, meme, nowSec) {
  const m = isPublic()
    ? await sendMeme(ctx, 'channel.post', ENV.backupChannelId, meme.kind, meme.file_id, await caption(ctx, meme, nowSec), [[likeButton(meme.id, meme.likes || 0)]], { disable_notification: true })
    : await sendMeme(ctx, 'backup.copy', ENV.backupChannelId, meme.kind, meme.file_id, `#m${meme.id}`, null, { disable_notification: true });
  await store.setBackup(meme.id, m.chat.id, m.message_id);
}

async function retryOlder(ctx, nowSec) {
  for (const meme of await store.pendingBackups(nowSec - 60, RETRY, isPublic())) {
    try {
      await post(ctx, meme, nowSec);
    } catch (err) {
      if (isApiError(err) && err.code === 400) await store.setBackup(meme.id, null, 0);
      else break;
    }
  }
}

async function failed(ctx, meme, err, nowSec) {
  console.warn(`channel post of meme ${meme.id} failed: ${describeError(err)}`);
  await alertOwner(ctx, 'backup', 'owner.backup_fail', { id: String(meme.id), err: esc(describeError(err)) }, nowSec);
  return false;
}

/* A meme was just saved (meme = { id, kind, file_id, keywords, status, likes }). Returns true when
   it is in the channel. */
export async function backupMeme(ctx, meme, fromChatId, messageId, nowSec) {
  if (!ENV.backupChannelId) return false;
  if (isPublic()) return meme.status === APPROVED ? memePublished(ctx, meme.id, nowSec) : false;
  try {
    try {
      const m = await call(ctx, 'forwardMessage', { chat_id: ENV.backupChannelId, from_chat_id: fromChatId, message_id: messageId, disable_notification: true }, 'backup.forward');
      await store.setBackup(meme.id, m.chat.id, m.message_id);
    } catch (err) {
      if (!originalGone(err)) throw err;
      await post(ctx, meme, nowSec);
    }
  } catch (err) {
    return failed(ctx, meme, err, nowSec);
  }
  await retryOlder(ctx, nowSec);
  return true;
}

/* A meme became public (public mode: post it unless it is in the channel already). */
export async function memePublished(ctx, id, nowSec) {
  if (!ENV.backupChannelId || !isPublic()) return false;
  const meme = await store.memeById(id);
  if (!meme || meme.status !== APPROVED || meme.backup_msg_id !== null) return false;
  try {
    await post(ctx, meme, nowSec);
  } catch (err) {
    return failed(ctx, meme, err, nowSec);
  }
  await retryOlder(ctx, nowSec);
  return true;
}

/* A public meme was removed (public mode: delete its post). `meme` = the row as it was before. */
export async function memeRemoved(ctx, meme) {
  if (!isPublic() || !meme || !(meme.backup_msg_id > 0)) return false;
  try {
    await call(ctx, 'deleteMessage', { chat_id: meme.backup_chat_id, message_id: meme.backup_msg_id }, 'channel.delete');
  } catch (err) {
    console.warn(`deleting the channel post of meme ${meme.id} failed: ${describeError(err)}`);
  }
  await store.setBackup(meme.id, null, null);
  return true;
}

/* Keywords changed on a public meme (public mode: update the post's caption). */
export async function keywordsChanged(ctx, id, nowSec) {
  if (!isPublic()) return;
  const meme = await store.memeById(id);
  if (!meme || !(meme.backup_msg_id > 0) || !captionable(meme.kind)) return;
  try {
    await call(ctx, 'editMessageCaption', {
      chat_id: meme.backup_chat_id, message_id: meme.backup_msg_id, caption: await caption(ctx, meme, nowSec), parse_mode: 'HTML', reply_markup: keyboard([[likeButton(meme.id, meme.likes)]]),
    }, 'channel.caption');
  } catch (err) {
    console.warn(`updating the channel caption of meme ${id} failed: ${describeError(err)}`);
  }
}
