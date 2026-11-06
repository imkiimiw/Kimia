// Pure helpers of the Wanger Media external service (no I/O): request validation and the same
// allowlist rules as the bot (wanger-media/tgcloud/lib/url.js). Tested in test/unit/external_service.test.js.
import { timingSafeEqual } from 'node:crypto';

export const VERSION = '1.0.0';
export const TYPES = ['video', 'photo', 'gif'];
export const MB = 1024 * 1024;

const HOST_RE = /^(?=.{1,253}$)(?:(?!-)[a-z0-9-]{1,63}(?<!-)\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
const PRIVATE_SUFFIX = /(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain|test|example|invalid|onion)$/;

export function isPublicHostname(host) {
  if (typeof host !== 'string' || !HOST_RE.test(host)) return false;
  if (host.split('.').every((l) => /^\d+$/.test(l)) || /^0x/i.test(host)) return false;
  return !PRIVATE_SUFFIX.test(host);
}

/** "*.domain" patterns or exact hosts; patterns themselves must be public names. */
export function hostMatches(host, patterns) {
  const h = String(host || '').toLowerCase();
  return patterns.some((p) => (p.startsWith('*.') ? h === p.slice(2) || h.endsWith(p.slice(1)) : h === p));
}

/** https only, no credentials, default port, public host on the allowlist → the host, else null. */
export function allowedHost(url, allow) {
  const m = /^https:\/\/([^/?#@]+)(?:[/?#]|$)/i.exec(String(url || ''));
  if (!m) return null;
  const host = m[1].toLowerCase().replace(/:443$/, '');
  if (host.includes(':') || !isPublicHostname(host) || !hostMatches(host, allow)) return null;
  return host;
}

/** Bearer key check in constant time. */
export function authorized(header, key) {
  const m = /^Bearer (.+)$/.exec(String(header || ''));
  if (!m || !key) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * A /v1/relay body → { job } or { code } (the contract in docs/PHASE8.md §2). maxBytes = the
 * service's own limit; the bot's `bytes` is a ceiling — never more is downloaded.
 */
export function validateRelay(body, maxBytes) {
  const b = body && typeof body === 'object' ? body : null;
  if (!b) return { code: 'ERROR' };
  const allow = Array.isArray(b.allow_hosts) ? b.allow_hosts.filter((p) => typeof p === 'string' && isPublicHostname(p.replace(/^\*\./, ''))).slice(0, 10) : [];
  if (!allow.length || !allowedHost(b.url, allow)) return { code: 'UNSUPPORTED' };
  if (!TYPES.includes(b.type)) return { code: 'UNSUPPORTED' };
  if (!Number.isInteger(b.bytes) || b.bytes <= 0) return { code: 'ERROR' };
  if (b.bytes > maxBytes) return { code: 'TOO_LARGE' };
  if (!Number.isInteger(b.chat_id) || b.chat_id === 0) return { code: 'ERROR' };
  return {
    job: {
      id: String(b.request_id || '').replace(/[^A-Za-z0-9:_-]/g, '').slice(0, 64) || 'job',
      url: String(b.url), allow, bytes: b.bytes, type: b.type, chatId: b.chat_id,
      replyTo: Number.isInteger(b.reply_to_message_id) ? b.reply_to_message_id : null,
      caption: typeof b.caption === 'string' ? b.caption.slice(0, 1024) : '',
      failText: typeof b.fail_text === 'string' ? b.fail_text.slice(0, 500) : '',
    },
  };
}

/** The Bot API call that sends a local file (telegram-bot-api --local takes file:// paths). */
export function sendCall(job, path) {
  const method = { video: 'sendVideo', photo: 'sendPhoto', gif: 'sendAnimation' }[job.type];
  const field = { video: 'video', photo: 'photo', gif: 'animation' }[job.type];
  return {
    method,
    params: {
      chat_id: job.chatId, [field]: 'file://' + path,
      ...(job.caption ? { caption: job.caption, parse_mode: 'HTML' } : {}),
      ...(job.type === 'video' ? { supports_streaming: true } : {}),
      ...(job.replyTo ? { reply_parameters: { message_id: job.replyTo, allow_sending_without_reply: true } } : {}),
    },
  };
}

/** Resolves a Location header against the URL it came from. */
export function nextUrl(base, location) {
  if (!location) return null;
  if (/^https?:\/\//i.test(location)) return location;
  const m = /^(https?:\/\/[^/?#]+)([^?#]*)/i.exec(base);
  if (!m) return null;
  if (location.startsWith('//')) return 'https:' + location;
  if (location.startsWith('/')) return m[1] + location;
  return m[1] + m[2].replace(/[^/]*$/, '') + location;
}
