// Reddit (docs/PLATFORMS.md §4) — METADATA_ONLY. Method:
//   official — Reddit's public oEmbed endpoint (title, author; measured from Serverless 2026-11-06,
//              test/fixtures/reddit_oembed.json). It carries no image, so the card is text only.
// Post JSON answers 403 to Serverless and old.reddit.com redirects to a login; hosted videos are
// separate sound and picture streams (brief §7: no merging), so no media is fetched.
// Share links (/r/<sub>/s/<code>) and redd.it/<id> are expanded by following their redirects.
import { hostMatches, segments } from '../url.js';
import { card, cleanText, expandShort, getJson, healthOf, oembedError, refFromUrl, ResolveError } from './common.js';

const LINK_HOSTS = ['reddit.com', '*.reddit.com', 'redd.it', '*.redd.it'];
const PAGE_HOSTS = ['reddit.com', 'www.reddit.com', 'old.reddit.com', 'new.reddit.com', 'np.reddit.com', 'm.reddit.com', 'redd.it'];
const API_HOSTS = ['www.reddit.com'];
const ID_RE = /^[a-z0-9]{4,12}$/i;
const SUB_RE = /^[A-Za-z0-9_]{2,40}$/;

const postRef = (id, sub = null) => ({
  id: id.toLowerCase(), sub, key: 'reddit:' + id.toLowerCase(), account: null,
  url: sub ? `https://www.reddit.com/r/${sub}/comments/${id.toLowerCase()}/` : `https://www.reddit.com/comments/${id.toLowerCase()}/`,
});

export function identify(u) {
  if (!hostMatches(u.host, LINK_HOSTS)) return null;
  const seg = segments(u.path);
  if (u.host === 'redd.it') return seg.length === 1 && ID_RE.test(seg[0]) ? { short: seg[0], key: null, url: `https://redd.it/${seg[0]}`, account: null } : { unsupported: true };
  if (!PAGE_HOSTS.includes(u.host)) return { unsupported: true }; // i.redd.it / v.redd.it media hosts, etc.
  if (seg[0] === 'r' && SUB_RE.test(seg[1] || '') && seg[2] === 's' && /^[A-Za-z0-9]{4,20}$/.test(seg[3] || '')) {
    return { short: seg[3], key: null, url: `https://www.reddit.com/r/${seg[1]}/s/${seg[3]}`, account: null };
  }
  const i = seg.indexOf('comments');
  if (i < 0 || !ID_RE.test(seg[i + 1] || '')) return { unsupported: true };
  if (i === 0) return postRef(seg[1]);
  if (i === 2 && seg[0] === 'r' && SUB_RE.test(seg[1])) return postRef(seg[3], seg[1]);
  if (i === 2 && (seg[0] === 'user' || seg[0] === 'u')) return postRef(seg[3]);
  return { unsupported: true };
}

export function fromOembed(j, ref) {
  if (!j || typeof j.title !== 'string' || !j.title) throw new ResolveError('not_found', 'no title');
  const sub = ((/reddit\.com\/r\/([A-Za-z0-9_]{2,40})\/"/.exec(String(j.html || '')) || [])[1]) || ref.sub || null;
  const author = j.author_name && /^[A-Za-z0-9_-]{2,40}$/.test(j.author_name) ? j.author_name : null;
  return card('reddit', 'official', ref, {
    title: cleanText(j.title), details: sub ? 'r/' + sub : null,
    author: author ? 'u/' + author : null, account: author ? 'reddit:' + author.toLowerCase() : null,
  });
}

async function expand(ctx, ref) {
  if (!ref.short) return ref;
  return expandShort(ctx, ref.url, PAGE_HOSTS, (url) => refFromUrl(identify, url));
}

async function resolveOfficial(ctx, ref) {
  let j;
  try {
    // oEmbed needs a /r/<community>/ link; Reddit finds a post by its id whatever community the link
    // names (measured), so a link without one is asked about as /r/all/ and the real one is read back.
    const asked = ref.sub ? ref.url : `https://www.reddit.com/r/all/comments/${ref.id}/`;
    j = await getJson(ctx, 'https://www.reddit.com/oembed?url=' + encodeURIComponent(asked), { allow: API_HOSTS });
  } catch (err) {
    throw oembedError(err);
  }
  return fromOembed(j, ref);
}

export default {
  id: 'reddit',
  name: 'Reddit',
  mediaHosts: [],
  coverHosts: [],
  headSafe: false,
  methodOrder: ['official'],
  identify,
  capabilities: () => ({
    status: 'METADATA_ONLY',
    kinds: ['info'],
    note: 'title, author and community; no media',
    methods: { official: 'METADATA_ONLY' },
  }),
  expand,
  resolve(ctx, ref, method) {
    if (method === 'official') return resolveOfficial(ctx, ref);
    throw new ResolveError('unsupported', `method ${method}`);
  },
  healthCheck: (ctx) => healthOf(() => resolveOfficial(ctx, postRef('92dd8', 'pics'))),
  riskNotes: {},
};
