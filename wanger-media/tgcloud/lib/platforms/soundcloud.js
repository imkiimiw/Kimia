// SoundCloud (docs/PLATFORMS.md §4) — METADATA_ONLY. Method:
//   official — SoundCloud's public oEmbed endpoint (title, artist, artwork; no key needed; measured
//              from Serverless 2026-11-06, test/fixtures/sc_oembed.json).
// Audio is never downloaded: streams are HLS segments (brief §7: no merging), downloads exist only
// where the artist switched them on, and an API app needs a paid Artist Pro subscription.
// Secret ("s-…") share links are private and refused. on.soundcloud.com short links are expanded.
import { hostMatches, segments } from '../url.js';
import { card, expandShort, getJson, healthOf, oembedError, refFromUrl, ResolveError } from './common.js';

const LINK_HOSTS = ['soundcloud.com', 'www.soundcloud.com', 'm.soundcloud.com', 'on.soundcloud.com'];
const API_HOSTS = ['soundcloud.com'];
const COVER_HOSTS = ['*.sndcdn.com'];
const NAME_RE = /^[A-Za-z0-9_-]{1,100}$/;
const RESERVED = new Set(['discover', 'search', 'stream', 'you', 'upload', 'pages', 'charts', 'tags', 'people', 'settings',
  'messages', 'notifications', 'mobile', 'popular', 'jobs', 'imprint', 'signin', 'logout', 'connect', 'home', 'explore',
  'terms-of-use', 'feed', 'artists', 'creators', 'premium', 'go', 'next', 'pro', 'oembed', 'player']);

const trackRef = (user, slug, set = false) => ({
  user, key: `soundcloud:${user.toLowerCase()}/${set ? 'sets/' : ''}${slug.toLowerCase()}`,
  url: `https://soundcloud.com/${user}/${set ? 'sets/' : ''}${slug}`, account: 'soundcloud:' + user.toLowerCase(),
});

export function identify(u) {
  if (!hostMatches(u.host, LINK_HOSTS)) return null;
  const seg = segments(u.path);
  if (u.host === 'on.soundcloud.com') {
    return seg.length === 1 && /^[A-Za-z0-9]{3,30}$/.test(seg[0]) ? { short: seg[0], key: null, url: `https://on.soundcloud.com/${seg[0]}`, account: null } : { unsupported: true };
  }
  const [user, a, b] = seg;
  if (!NAME_RE.test(user || '') || RESERVED.has(user.toLowerCase())) return { unsupported: true };
  if (seg.length === 2 && NAME_RE.test(a) && !['sets', 'tracks', 'albums', 'likes', 'reposts', 'followers', 'following', 'popular-tracks', 'comments'].includes(a)) return trackRef(user, a);
  if (seg.length === 3 && a === 'sets' && NAME_RE.test(b)) return trackRef(user, b, true);
  return { unsupported: true }; // profiles, secret "s-…" links, likes…
}

export function fromOembed(j, ref) {
  if (!j || typeof j.title !== 'string' || !j.title) throw new ResolveError('not_found', 'no title');
  const author = j.author_name ? String(j.author_name) : null;
  const title = author && j.title.endsWith(' by ' + author) ? j.title.slice(0, -(' by ' + author).length) : j.title;
  return card('soundcloud', 'official', ref, { title, author, cover: j.thumbnail_url || null });
}

async function expand(ctx, ref) {
  if (!ref.short) return ref;
  return expandShort(ctx, ref.url, LINK_HOSTS, (url) => refFromUrl(identify, url));
}

async function resolveOfficial(ctx, ref) {
  let j;
  try {
    j = await getJson(ctx, 'https://soundcloud.com/oembed?format=json&url=' + encodeURIComponent(ref.url), { allow: API_HOSTS });
  } catch (err) {
    throw oembedError(err);
  }
  return fromOembed(j, ref);
}

export default {
  id: 'soundcloud',
  name: 'SoundCloud',
  mediaHosts: [],
  coverHosts: COVER_HOSTS,
  headSafe: true, // HEAD to i1.sndcdn.com measured fine (no Content-Length: the Range probe follows)
  methodOrder: ['official'],
  identify,
  capabilities: () => ({
    status: 'METADATA_ONLY',
    kinds: ['info'],
    note: 'title, artist and artwork; audio is never downloaded',
    methods: { official: 'METADATA_ONLY' },
  }),
  expand,
  resolve(ctx, ref, method) {
    if (method === 'official') return resolveOfficial(ctx, ref);
    throw new ResolveError('unsupported', `method ${method}`);
  },
  healthCheck: (ctx) => healthOf(() => resolveOfficial(ctx, trackRef('forss', 'flickermood'))),
  riskNotes: {},
};
