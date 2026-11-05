// Central classification of Bot API errors (pure). Every error path in the bot asks this module
// what a failure means, so retries, blocking and alerts are decided in one place.

/**
 * @typedef {'rate_limit'|'transient'|'blocked'|'chat_gone'|'no_rights'|'not_modified'|'message_gone'|'bad_file'|'bad_caption'|'user_not_found'|'query_expired'|'bad_request'|'unknown'} ErrorKind
 * @param {any} err a BotApiError (code, description, parameters) or any thrown value
 * @returns {{kind: ErrorKind, code: number, retryAfter: number, description: string}}
 */
export function classify(err) {
  const code = Number(err && err.code) || 0;
  const description = String((err && (err.description || err.message)) || '');
  const d = description.toLowerCase();
  const retryAfter = Number(err && err.parameters && err.parameters.retry_after) || 0;
  /** @param {ErrorKind} kind */
  const out = (kind) => ({ kind, code, retryAfter, description: description.slice(0, 200) });

  if (code === 429) return out('rate_limit');
  if (!code || code >= 500) return out('transient');
  if (code === 403) {
    if (/blocked by the user|user is deactivated|bot can't initiate|bot can't send messages to/.test(d)) return out('blocked');
    return out('no_rights');
  }
  if (code === 400) {
    if (/message is not modified/.test(d)) return out('not_modified');
    if (/message to edit not found|message can't be edited|message_id_invalid|message to delete not found/.test(d)) return out('message_gone');
    if (/query is too old|query id is invalid|query_id_invalid/.test(d)) return out('query_expired');
    if (/chat not found|peer_id_invalid|channel_private|chat_id_invalid|group chat was deactivated/.test(d)) return out('chat_gone');
    if (/member list is inaccessible|chat_admin_required|not enough rights|need administrator rights|have no rights|chat_write_forbidden/.test(d)) return out('no_rights');
    // getChatMember for someone who isn't in the channel answers 400 "member not found" (measured
    // on the platform by another bot in this repository): that means "not a member", not a broken channel.
    if (/member not found|user not found|participant_id_invalid|user_id_invalid|user_not_participant/.test(d)) return out('user_not_found');
    if (/wrong file identifier|wrong remote file|file_id|failed to get http url content|wrong type of the web page content/.test(d)) return out('bad_file');
    if (/can't parse entities|caption is too long|message caption is too long|entity/.test(d)) return out('bad_caption');
    return out('bad_request');
  }
  return out('unknown');
}

/** @param {any} err */
export const isTransient = (err) => classify(err).kind === 'transient';
