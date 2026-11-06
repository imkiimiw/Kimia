// Platform registry (brief §7): one adapter per platform behind a common interface —
//   identify(parsedUrl) → ref | { unsupported } | null      capabilities() → statuses
//   expand(ctx, ref) → ref (short links)                     resolve(ctx, ref, method) → post
//   healthCheck(ctx, method?) → { ok, detail }               riskNotes[method] = { fa, en, ru }
// Platforms without an adapter yet are recognised by their hosts and reported UNAVAILABLE, so a
// user gets an honest "not supported yet" instead of "unknown link".
import { hostMatches, parseUrl } from '../url.js';
import pinterest from './pinterest.js';
import snapchat from './snapchat.js';
import x from './x.js';

export const ADAPTERS = [x, pinterest, snapchat];
export const byId = (id) => ADAPTERS.find((a) => a.id === id) || null;

/** Recognised but not built yet (Phase 7, one per session). */
export const STUBS = [
  { id: 'tiktok', hosts: ['tiktok.com', '*.tiktok.com'] },
  { id: 'instagram', hosts: ['instagram.com', '*.instagram.com', 'instagr.am'] },
  { id: 'facebook', hosts: ['facebook.com', '*.facebook.com', 'fb.watch', 'fb.com'] },
  { id: 'linkedin', hosts: ['linkedin.com', '*.linkedin.com', 'lnkd.in'] },
  { id: 'youtube', hosts: ['youtube.com', '*.youtube.com', 'youtu.be'] },
  { id: 'reddit', hosts: ['reddit.com', '*.reddit.com', 'redd.it', '*.redd.it'] },
  { id: 'twitch', hosts: ['twitch.tv', '*.twitch.tv'] },
  { id: 'threads', hosts: ['threads.net', '*.threads.net', 'threads.com', '*.threads.com'] },
  { id: 'discord', hosts: ['discord.com', '*.discord.com', 'discord.gg', 'cdn.discordapp.com', 'media.discordapp.net'] },
  { id: 'spotify', hosts: ['spotify.com', '*.spotify.com', 'spotify.link'] },
  { id: 'soundcloud', hosts: ['soundcloud.com', '*.soundcloud.com', 'snd.sc'] },
];

const TELEGRAM_HOSTS = ['t.me', 'telegram.me', 'telegram.dog', '*.t.me'];

/**
 * What a link is:
 *   { kind: 'post', adapter, ref }          a link an adapter can handle
 *   { kind: 'unsupported_kind', adapter }   right platform, wrong kind of link (a profile, a story…)
 *   { kind: 'not_built', platform }         a known platform without an adapter yet
 *   { kind: 'telegram' }                    t.me post links (out of scope: bots can't read channels)
 *   { kind: 'invalid' }                     not a URL we accept (IP literal, credentials, odd port…)
 *   { kind: 'unknown', host }               any other website
 */
export function identify(link) {
  const u = parseUrl(link);
  if (!u) return { kind: 'invalid' };
  if (hostMatches(u.host, TELEGRAM_HOSTS)) return { kind: 'telegram' };
  for (const adapter of ADAPTERS) {
    const ref = adapter.identify(u);
    if (!ref) continue;
    if (ref.unsupported) return { kind: 'unsupported_kind', adapter };
    return { kind: 'post', adapter, ref };
  }
  const stub = STUBS.find((s) => hostMatches(u.host, s.hosts));
  if (stub) return { kind: 'not_built', platform: stub.id };
  return { kind: 'unknown', host: u.host };
}

/** Capability status of any platform id (built or not). */
export function statusOf(id) {
  const a = byId(id);
  return a ? a.capabilities().status : 'UNAVAILABLE';
}
