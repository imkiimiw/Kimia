/**
 * Central classification of Bot API errors (pure), so retries, blocking, friendly messages and
 * alerts are decided in one place. (Adapted from wanger-music lib/telegram/errors.js, plus the
 * sticker-set errors.)
 *
 * @typedef {'rate_limit'|'transient'|'blocked'|'chat_gone'|'no_rights'|'not_modified'|'message_gone'|'query_expired'|'user_not_found'|'bad_file'|'bad_caption'|
 *   'set_name_taken'|'set_invalid'|'set_full'|'sticker_invalid'|'file_too_big'|'emoji_invalid'|'bad_request'|'unknown'} ErrorKind
 */

/** @param {any} err @returns {{kind: ErrorKind, code: number, retryAfter: number, description: string}} */
export function classify(err) {
  const code = Number(err && err.code) || 0;
  const description = String((err && (err.description || err.message)) || '');
  const d = description.toLowerCase();
  const retryAfter = Number(err && err.parameters && err.parameters.retry_after) || 0;
  /** @param {ErrorKind} kind */
  const out = (kind) => ({ kind, code, retryAfter, description: description.slice(0, 200) });

  if (code === 429 || /too many requests|flood/.test(d)) return out('rate_limit');
  if (!code || code >= 500) return out('transient');
  if (code === 403) {
    if (/blocked by the user|user is deactivated|bot can't initiate|bot can't send messages to/.test(d)) return out('blocked');
    return out('no_rights');
  }
  if (code === 413 || /file is too big|too large/.test(d)) return out('file_too_big');
  if (code === 400) {
    if (/message is not modified/.test(d)) return out('not_modified');
    if (/message to edit not found|message can't be edited|message_id_invalid|message to delete not found|message can't be deleted/.test(d)) return out('message_gone');
    if (/query is too old|query id is invalid|query_id_invalid/.test(d)) return out('query_expired');
    if (/sticker set name is already occupied|name is already occupied|stickerset_name_occupied/.test(d)) return out('set_name_taken');
    if (/stickers_too_much|too many stickers|stickerset is full|stickerpack_stickers_too_much/.test(d)) return out('set_full');
    if (/stickerset_invalid|sticker set not found|invalid sticker set/.test(d)) return out('set_invalid');
    if (/emoji|emoticon/.test(d) && !/sticker_/.test(d)) return out('emoji_invalid');
    if (/sticker_png_dimensions|sticker_png_nopng|sticker_video|sticker_tgs|sticker_file_invalid|invalid sticker|wrong file type|sticker_id_invalid|sticker_invalid|stickers_empty|wrong sticker|can't use file of type/.test(d)) return out('sticker_invalid');
    if (/chat not found|peer_id_invalid|channel_private|chat_id_invalid|group chat was deactivated/.test(d)) return out('chat_gone');
    if (/member list is inaccessible|chat_admin_required|not enough rights|need administrator rights|have no rights|chat_write_forbidden/.test(d)) return out('no_rights');
    // getChatMember for someone not in the channel answers 400 "member not found" (measured by
    // another Wanger bot): that means "not a member", not a broken channel.
    if (/member not found|user not found|participant_id_invalid|user_id_invalid|user_not_participant/.test(d)) return out('user_not_found');
    if (/wrong file identifier|wrong remote file|file_id|failed to get http url content|wrong type of the web page content/.test(d)) return out('bad_file');
    if (/can't parse entities|caption is too long|message caption is too long/.test(d)) return out('bad_caption');
    return out('bad_request');
  }
  return out('unknown');
}

/** The i18n key for a friendly message about a failed sticker operation. @param {any} err */
export function friendlyKey(err) {
  const k = classify(err).kind;
  return (
    {
      set_name_taken: 'err.set_name_taken',
      set_full: 'err.set_full',
      set_invalid: 'err.set_invalid',
      sticker_invalid: 'err.sticker_invalid',
      file_too_big: 'err.file_too_big',
      emoji_invalid: 'err.emoji_invalid',
      rate_limit: 'err.flood',
      blocked: 'err.blocked',
      bad_file: 'err.sticker_invalid',
    }[k] || 'err.generic'
  );
}
