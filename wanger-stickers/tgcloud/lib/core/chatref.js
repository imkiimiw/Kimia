// (Copied from wanger-music lib/telegram/chatref.js, 2026-11-12.)
// Parsing of chat references typed or forwarded by the owner (pure): @username, t.me links,
// numeric ids and forwarded channel posts. Resolution (getChat) happens in telegram/client.js.

const USERNAME = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;

/**
 * @param {string|undefined|null} text
 * @param {any} [message] the whole Message, for forwards
 * @returns {{kind: 'username', value: string} | {kind: 'id', value: number} | {kind: 'invite'} | null}
 */
export function parseChatRef(text, message) {
  const origin = message && message.forward_origin;
  if (origin && origin.type === 'channel' && origin.chat && Number.isSafeInteger(origin.chat.id)) return { kind: 'id', value: origin.chat.id };
  if (message && message.forward_from_chat && Number.isSafeInteger(message.forward_from_chat.id)) return { kind: 'id', value: message.forward_from_chat.id };
  const s = String(text || '').trim();
  if (!s || s.length > 128) return null;
  if (/^-?\d{5,16}$/.test(s)) {
    const n = Number(s);
    return Number.isSafeInteger(n) ? { kind: 'id', value: n } : null;
  }
  const m = /^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\/(.+)$/i.exec(s);
  if (m) {
    const path = m[1].replace(/\/+$/, '');
    if (/^(\+|joinchat\/)/i.test(path)) return { kind: 'invite' };
    const name = path.split(/[/?#]/)[0];
    return USERNAME.test(name) ? { kind: 'username', value: name } : null;
  }
  const name = s.startsWith('@') ? s.slice(1) : s;
  return USERNAME.test(name) ? { kind: 'username', value: name } : null;
}

/** A join link for a channel: public username, or a stored invite link. */
export function isValidInviteLink(link) {
  return /^https:\/\/t\.me\/(\+[A-Za-z0-9_-]{6,64}|joinchat\/[A-Za-z0-9_-]{6,64}|[A-Za-z][A-Za-z0-9_]{3,31})$/.test(String(link || '').trim());
}
