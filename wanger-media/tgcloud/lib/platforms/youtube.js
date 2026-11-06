// YouTube (docs/PLATFORMS.md §4) — METADATA_ONLY. Method:
//   official — YouTube's public oEmbed endpoint (title, channel, thumbnail; no key needed; measured
//              from Serverless 2026-11-06, test/fixtures/yt_oembed.json).
// Videos are never downloaded: YouTube's terms allow downloading only where YouTube shows a download
// link, and most qualities are separate audio and video streams (brief §7: no merging).
import { hostMatches, queryParams, segments } from '../url.js';
import { card, getJson, healthOf, oembedError, ResolveError } from './common.js';

const LINK_HOSTS = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtu.be'];
const API_HOSTS = ['www.youtube.com'];
const COVER_HOSTS = ['i.ytimg.com'];
const ID_RE = /^[A-Za-z0-9_-]{11}$/;

const videoRef = (id, shorts = false) => ({
  id, key: 'youtube:' + id, account: null,
  url: shorts ? `https://www.youtube.com/shorts/${id}` : `https://www.youtube.com/watch?v=${id}`,
});

export function identify(u) {
  if (!hostMatches(u.host, LINK_HOSTS)) return null;
  const seg = segments(u.path);
  if (u.host === 'youtu.be' || u.host === 'www.youtu.be') return ID_RE.test(seg[0] || '') && seg.length === 1 ? videoRef(seg[0]) : { unsupported: true };
  if (seg[0] === 'watch' && seg.length === 1) {
    const v = (queryParams(u.query).find(([k]) => k === 'v') || [])[1];
    return ID_RE.test(v || '') ? videoRef(v) : { unsupported: true };
  }
  if (['shorts', 'live', 'embed', 'v'].includes(seg[0]) && ID_RE.test(seg[1] || '') && seg.length === 2) return videoRef(seg[1], seg[0] === 'shorts');
  return { unsupported: true }; // channels, playlists, search…
}

export function fromOembed(j, ref) {
  if (!j || typeof j.title !== 'string' || !j.title) throw new ResolveError('not_found', 'no title');
  const handle = /\/@([A-Za-z0-9._-]{1,100})$/.exec(String(j.author_url || ''));
  return card('youtube', 'official', ref, {
    title: j.title, author: j.author_name || null,
    account: handle ? 'youtube:' + handle[1].toLowerCase() : null,
    cover: j.thumbnail_url || null,
  });
}

async function resolveOfficial(ctx, ref) {
  let j;
  try {
    j = await getJson(ctx, 'https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(ref.url), { allow: API_HOSTS });
  } catch (err) {
    throw oembedError(err);
  }
  return fromOembed(j, ref);
}

export default {
  id: 'youtube',
  name: 'YouTube',
  mediaHosts: [],
  coverHosts: COVER_HOSTS,
  headSafe: true, // HEAD to i.ytimg.com measured fine
  methodOrder: ['official'],
  identify,
  capabilities: () => ({
    status: 'METADATA_ONLY',
    kinds: ['info'],
    note: 'title, channel and thumbnail; videos are never downloaded',
    methods: { official: 'METADATA_ONLY' },
  }),
  expand: async (ctx, ref) => ref,
  resolve(ctx, ref, method) {
    if (method === 'official') return resolveOfficial(ctx, ref);
    throw new ResolveError('unsupported', `method ${method}`);
  },
  healthCheck: (ctx) => healthOf(() => resolveOfficial(ctx, videoRef('dQw4w9WgXcQ'))),
  riskNotes: {},
};
