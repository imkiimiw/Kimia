// Strict URL handling (brief §9). The isolate has no URL global, so this is a small hand-written
// parser: http(s) only, no credentials, no IP literals, no localhost or private names, default ports
// only, bounded length. Pure module: must not import 'sdk'.

export const MAX_URL_LENGTH = 2048;
export const MAX_LINKS_PER_MESSAGE = 3;

const HOST_RE = /^(?=.{1,253}$)(?:(?!-)[a-z0-9-]{1,63}(?<!-)\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
const PRIVATE_SUFFIX = /(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain|test|example|invalid|onion)$/;

/** A parsed URL or null: { scheme, host, port, path, query, fragment, href }. */
export function parseUrl(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (!s || s.length > MAX_URL_LENGTH || /[\s<>"\\^`{|}\u0000-\u001f\u007f]/.test(s)) return null;
  const m = /^(https?):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/i.exec(s);
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  const authority = m[2];
  if (!authority || authority.includes('@')) return null; // credentials in a link are never legitimate here
  const hp = /^([^:]+)(?::(\d{1,5}))?$/.exec(authority);
  if (!hp) return null; // IPv6 literals ("[...]") and other oddities end here
  const host = hp[1].toLowerCase().replace(/\.$/, '');
  const port = hp[2] ? Number(hp[2]) : null;
  if (port !== null && !((scheme === 'https' && port === 443) || (scheme === 'http' && port === 80))) return null;
  if (!isPublicHostname(host)) return null;
  const path = m[3] || '/';
  const query = m[4] ? m[4].slice(1) : '';
  const fragment = m[5] ? m[5].slice(1) : '';
  const href = `${scheme}://${host}${path}${query ? '?' + query : ''}`;
  return { scheme, host, port, path, query, fragment, href };
}

/** A DNS name that could be on the public internet: not an IP literal, not localhost/private. */
export function isPublicHostname(host) {
  if (typeof host !== 'string' || !HOST_RE.test(host)) return false;
  if (/^[0-9.]+$/.test(host) || /^0x/i.test(host)) return false; // dotted or hex IPv4
  if (host.split('.').every((l) => /^\d+$/.test(l))) return false;
  if (PRIVATE_SUFFIX.test(host)) return false;
  return true;
}

/** Does `host` equal one of `patterns`, or is it a subdomain of a "*.domain" pattern? */
export function hostMatches(host, patterns) {
  const h = String(host || '').toLowerCase();
  return patterns.some((p) => (p.startsWith('*.') ? h === p.slice(2) || h.endsWith(p.slice(1)) : h === p));
}

/**
 * May the bot (or Telegram, on the bot's behalf) fetch this URL? https, a public host, and the
 * host on `allow` (the platform's API and media hosts). Every redirect target is checked again.
 */
export function isAllowedFetch(url, allow) {
  const u = parseUrl(url);
  return !!u && u.scheme === 'https' && hostMatches(u.host, allow);
}

/** Query parameters as [key, value] pairs (values left encoded; we only compare ASCII ids). */
export function queryParams(query) {
  return String(query || '').split('&').filter(Boolean).map((kv) => {
    const i = kv.indexOf('=');
    return i < 0 ? [kv, ''] : [kv.slice(0, i), kv.slice(i + 1)];
  });
}

/** Path segments without empty ones: "/a//b/" → ["a", "b"]. */
export const segments = (path) => String(path || '').split('/').filter(Boolean);

/**
 * The links in a Telegram message, in order, deduplicated: entities first (url, text_link — a
 * text_link carries its URL in the entity), then nothing else. Entity offsets are UTF-16 units,
 * which is what String#slice uses.
 */
export function extractLinks(message, max = MAX_LINKS_PER_MESSAGE) {
  if (!message) return [];
  const text = message.text ?? message.caption ?? '';
  const entities = message.entities ?? message.caption_entities ?? [];
  const out = [];
  for (const e of entities) {
    let raw = null;
    if (e.type === 'text_link' && e.url) raw = e.url;
    else if (e.type === 'url') raw = text.slice(e.offset, e.offset + e.length);
    if (!raw) continue;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = 'https://' + raw; // "x.com/…" without a scheme
    if (!out.includes(raw)) out.push(raw);
    if (out.length >= max) break;
  }
  return out;
}
