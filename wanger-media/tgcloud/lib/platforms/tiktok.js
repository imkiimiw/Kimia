// TikTok (docs/PLATFORMS.md §4) — METADATA_ONLY. Method:
//   public — the JSON TikTok puts in its public video page (__UNIVERSAL_DATA_FOR_REHYDRATION__):
//            description, author and cover (measured from Serverless 2026-11-06, test/fixtures/
//            tiktok_page.html; the signed cover answers a Range request without cookies).
// The video file itself answers 403 without TikTok's cookies, and this bot never uses cookies, so
// no video is fetched (playAddr / downloadAddr are ignored). vm./vt.tiktok.com and /t/ short links
// are expanded by following their redirects.
import { hostMatches, segments } from '../url.js';
import { asResolveError, card, expandShort, getText, healthOf, refFromUrl, ResolveError } from './common.js';

const LINK_HOSTS = ['tiktok.com', 'www.tiktok.com', 'm.tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com'];
const PAGE_HOSTS = ['tiktok.com', 'www.tiktok.com', 'm.tiktok.com'];
const COVER_HOSTS = ['*.tiktokcdn.com', '*.tiktokcdn-eu.com', '*.tiktokcdn-us.com'];
const ID_RE = /^\d{8,25}$/;
const USER_RE = /^@[A-Za-z0-9._]{2,40}$/;
const DATA_RE = /<script[^>]+id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/;
/** statusCode of webapp.video-detail: 0 found, 10204 missing (measured); 10216 / 10222 private. */
const PRIVATE_CODES = [10216, 10222];

const videoRef = (id, user = null, photo = false) => ({
  id, key: 'tiktok:' + id, account: user ? 'tiktok:' + user.toLowerCase() : null,
  url: `https://www.tiktok.com/@${user || ''}/${photo ? 'photo' : 'video'}/${id}`,
});

export function identify(u) {
  if (!hostMatches(u.host, LINK_HOSTS)) return null;
  const seg = segments(u.path);
  if (u.host === 'vm.tiktok.com' || u.host === 'vt.tiktok.com' || seg[0] === 't') {
    const code = seg[0] === 't' ? seg[1] : seg[0];
    const n = seg[0] === 't' ? 2 : 1;
    return seg.length === n && /^[A-Za-z0-9]{5,20}$/.test(code || '') ? { short: code, key: null, url: `https://${u.host}/${seg.join('/')}/`, account: null } : { unsupported: true };
  }
  if (USER_RE.test(seg[0] || '') && (seg[1] === 'video' || seg[1] === 'photo') && ID_RE.test(seg[2] || '') && seg.length === 3) {
    return videoRef(seg[2], seg[0].slice(1), seg[1] === 'photo');
  }
  if (seg[0] === 'v' && /^\d{8,25}(\.html)?$/.test(seg[1] || '') && seg.length === 2) return videoRef(seg[1].replace('.html', ''));
  if (seg[0] === 'embed' && seg[1] === 'v2' && ID_RE.test(seg[2] || '') && seg.length === 3) return videoRef(seg[2]);
  return { unsupported: true }; // profiles, tags, music, live…
}

/** The item of a video page: { item } | { code } (TikTok's statusCode) | null (no data). */
export function pageItem(html) {
  const m = DATA_RE.exec(String(html));
  if (!m) return null;
  let data;
  try {
    data = JSON.parse(m[1]);
  } catch {
    return null;
  }
  const scope = (data && data.__DEFAULT_SCOPE__) || {};
  const detail = scope['webapp.video-detail'] || scope['webapp.photo-detail'] || null;
  if (!detail) return null;
  const item = detail.itemInfo && detail.itemInfo.itemStruct;
  if (detail.statusCode === 0 && item && item.id) return { item };
  return { code: Number(detail.statusCode) || -1 };
}

export function fromPage(html, ref) {
  const r = pageItem(html);
  if (!r) throw new ResolveError('unavailable', 'no page data');
  if (r.code === 10204) throw new ResolveError('not_found', 'item does not exist');
  if (PRIVATE_CODES.includes(r.code)) throw new ResolveError('private', 'private item');
  if (!r.item) throw new ResolveError('unavailable', `status ${r.code}`);
  const it = r.item;
  if (it.privateItem || it.secret) throw new ResolveError('private', 'private item');
  const user = it.author && /^[A-Za-z0-9._]{2,40}$/.test(it.author.uniqueId || '') ? it.author.uniqueId : null;
  const video = it.video || {};
  const photoCover = it.imagePost && it.imagePost.cover && it.imagePost.cover.imageURL && (it.imagePost.cover.imageURL.urlList || [])[0];
  return card('tiktok', 'public', { ...ref, url: user ? `https://www.tiktok.com/@${user}/${it.imagePost ? 'photo' : 'video'}/${it.id}` : ref.url }, {
    title: it.desc || '', author: user ? '@' + user : null, account: user ? 'tiktok:' + user.toLowerCase() : null,
    cover: video.cover || video.originCover || photoCover || null,
  });
}

async function expand(ctx, ref) {
  if (!ref.short) return ref;
  return expandShort(ctx, ref.url, LINK_HOSTS, (url) => refFromUrl(identify, url));
}

async function resolvePublic(ctx, ref) {
  try {
    const { text } = await getText(ctx, ref.url, { allow: PAGE_HOSTS });
    return fromPage(text, ref);
  } catch (err) {
    throw asResolveError(err);
  }
}

export default {
  id: 'tiktok',
  name: 'TikTok',
  mediaHosts: [],
  coverHosts: COVER_HOSTS,
  headSafe: false, // only a Range request to the cover CDN was measured
  methodOrder: ['public'],
  identify,
  capabilities: () => ({
    status: 'METADATA_ONLY',
    kinds: ['info'],
    note: 'description, author and cover; the video needs TikTok’s cookies',
    methods: { public: 'METADATA_ONLY', official: 'REQUIRES_APPROVAL' },
  }),
  expand,
  resolve(ctx, ref, method) {
    if (method === 'public') return resolvePublic(ctx, ref);
    throw new ResolveError('unsupported', `method ${method}`);
  },
  healthCheck: (ctx) => healthOf(() => resolvePublic(ctx, videoRef('6718335390845095173', 'scout2015'))),
  riskNotes: {
    public: {
      en: 'TikTok’s terms forbid automated scraping without written permission. This method reads the public data of a video page for its description, author and cover only — the video itself is never fetched. TikTok can change or block it at any time.',
      fa: 'قوانین TikTok جمع\u200cآوری خودکار بدون اجازه\u200cی کتبی را ممنوع کرده است. این روش از داده\u200cهای عمومی صفحه\u200cی ویدیو فقط توضیح، سازنده و کاور را می\u200cخواند و خود ویدیو هرگز دریافت نمی\u200cشود. TikTok هر وقت بخواهد می\u200cتواند آن را عوض کند یا جلویش را بگیرد.',
      ru: 'Правила TikTok запрещают автоматический скрапинг без письменного разрешения. Этот метод читает из публичных данных страницы видео только описание, автора и обложку — само видео никогда не загружается. TikTok может изменить или заблокировать это в любой момент.',
    },
  },
};
