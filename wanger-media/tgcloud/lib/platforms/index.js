// Platform registry (brief §7): one adapter per platform behind a common interface —
//   identify(parsedUrl) → ref | { unsupported } | null      capabilities() → statuses
//   expand(ctx, ref) → ref (short links)                     resolve(ctx, ref, method) → post
//   healthCheck(ctx, method?) → { ok, detail }               riskNotes[method] = { fa, en, ru }
// Platforms without an adapter are recognised by their hosts and reported UNAVAILABLE, so a user
// gets an honest answer instead of "unknown link".
import { BUILT_PLATFORMS } from '../config.js';
import { hostMatches, parseUrl } from '../url.js';
import discord from './discord.js';
import facebook from './facebook.js';
import instagram from './instagram.js';
import pinterest from './pinterest.js';
import reddit from './reddit.js';
import snapchat from './snapchat.js';
import soundcloud from './soundcloud.js';
import spotify from './spotify.js';
import threads from './threads.js';
import tiktok from './tiktok.js';
import twitch from './twitch.js';
import x from './x.js';
import youtube from './youtube.js';

const ALL = [x, instagram, tiktok, pinterest, snapchat, facebook, threads, youtube, reddit, twitch, discord, spotify, soundcloud];
/** Built adapters in the order of config BUILT_PLATFORMS (the order screens list them). */
export const ADAPTERS = BUILT_PLATFORMS.map((id) => ALL.find((a) => a.id === id));
export const byId = (id) => ADAPTERS.find((a) => a.id === id) || null;

/**
 * Recognised platforms without an adapter. `unavailable`: refused for good, with the reason
 * (LinkedIn shows posts only to logged-in members and answers 403 to Serverless — docs/PLATFORMS.md).
 */
export const STUBS = [
  { id: 'linkedin', hosts: ['linkedin.com', '*.linkedin.com', 'lnkd.in'], unavailable: true },
];

const TELEGRAM_HOSTS = ['t.me', 'telegram.me', 'telegram.dog', '*.t.me'];

/**
 * What a link is:
 *   { kind: 'post', adapter, ref }          a link an adapter can handle
 *   { kind: 'unsupported_kind', adapter }   right platform, wrong kind of link (a profile, a story…)
 *   { kind: 'not_built', platform }         a known platform without an adapter yet
 *   { kind: 'unavailable', platform }       a known platform that can't be supported (LinkedIn)
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
  if (stub) return { kind: stub.unavailable ? 'unavailable' : 'not_built', platform: stub.id };
  return { kind: 'unknown', host: u.host };
}

/** Capability status of any platform id (built or not). */
export function statusOf(id) {
  const a = byId(id);
  return a ? a.capabilities().status : 'UNAVAILABLE';
}
