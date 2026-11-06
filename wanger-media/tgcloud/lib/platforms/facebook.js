// Facebook (docs/PLATFORMS.md §4) — METADATA_ONLY. Method:
//   public — the Open Graph tags of the public post / video page (text, preview image), measured
//            from Serverless 2026-11-06 (test/fixtures/facebook_video.html). The page carries no
//            video file for visitors who aren't logged in, so nothing else is fetched.
// Video, reel, watch and post links are accepted; fb.watch and /share/… short links are expanded.
import { hostMatches, parseUrl, queryParams, segments } from '../url.js';
import { asResolveError, card, expandShort, getText, healthOf, metaTags, refFromUrl, ResolveError } from './common.js';

const LINK_HOSTS = ['facebook.com', '*.facebook.com', 'fb.watch', 'fb.com', 'www.fb.com'];
const PAGE_HOSTS = ['facebook.com', 'www.facebook.com', 'm.facebook.com', 'web.facebook.com', 'mbasic.facebook.com'];
const SHORT_HOSTS = [...PAGE_HOSTS, 'fb.watch', 'fb.com', 'www.fb.com'];
const COVER_HOSTS = ['*.fbcdn.net'];
const NUM_RE = /^\d{5,25}$/;
const POST_RE = /^(\d{5,25}|pfbid[A-Za-z0-9]{10,80})$/;
const PAGE_RE = /^[A-Za-z0-9.\-]{2,80}$/;
const NOT_PAGES = new Set(['watch', 'reel', 'reels', 'share', 'video.php', 'photo.php', 'photo', 'permalink.php', 'story.php', 'groups', 'events', 'login', 'login.php', 'people', 'profile.php', 'hashtag', 'stories', 'marketplace', 'gaming']);

const ref = (kind, id, url, page = null) => ({ id, page, key: `facebook:${kind}:${id}`, url, account: page ? 'facebook:' + page.toLowerCase() : null });
const videoRef = (id, page = null) => ref('video', id, `https://www.facebook.com/watch/?v=${id}`, page);
const q = (u, name) => (queryParams(u.query).find(([k]) => k === name) || [])[1] || '';

export function identify(u) {
  if (!hostMatches(u.host, LINK_HOSTS)) return null;
  const seg = segments(u.path);
  if (u.host === 'fb.watch' || ((u.host === 'fb.com' || u.host === 'www.fb.com') && seg.length === 1)) {
    return seg.length === 1 && /^[A-Za-z0-9_-]{4,30}$/.test(seg[0]) ? { short: seg[0], key: null, url: `https://${u.host}/${seg[0]}/`, account: null } : { unsupported: true };
  }
  if (!PAGE_HOSTS.includes(u.host)) return { unsupported: true };
  if (seg[0] === 'share' && ['v', 'r', 'p'].includes(seg[1]) && /^[A-Za-z0-9_-]{4,40}$/.test(seg[2] || '')) {
    return { short: seg[2], key: null, url: `https://www.facebook.com/share/${seg[1]}/${seg[2]}/`, account: null };
  }
  if ((seg[0] === 'watch' && seg.length === 1) || (seg[0] === 'video.php' && seg.length === 1)) return NUM_RE.test(q(u, 'v')) ? videoRef(q(u, 'v')) : { unsupported: true };
  if ((seg[0] === 'reel' || seg[0] === 'reels') && NUM_RE.test(seg[1] || '') && seg.length === 2) return ref('video', seg[1], `https://www.facebook.com/reel/${seg[1]}/`);
  if ((seg[0] === 'photo' || seg[0] === 'photo.php') && seg.length === 1 && NUM_RE.test(q(u, 'fbid'))) return ref('post', q(u, 'fbid'), `https://www.facebook.com/photo/?fbid=${q(u, 'fbid')}`);
  if (seg[0] === 'permalink.php' && POST_RE.test(q(u, 'story_fbid')) && NUM_RE.test(q(u, 'id'))) {
    return ref('post', q(u, 'story_fbid'), `https://www.facebook.com/permalink.php?story_fbid=${q(u, 'story_fbid')}&id=${q(u, 'id')}`);
  }
  const page = seg[0];
  if (page && PAGE_RE.test(page) && !NOT_PAGES.has(page.toLowerCase())) {
    if (seg[1] === 'videos') {
      const id = seg.slice(2).reverse().find((x) => NUM_RE.test(x));
      if (id && seg.length <= 4) return videoRef(id, page);
    }
    if (seg[1] === 'posts' && POST_RE.test(seg[2] || '') && seg.length === 3) return ref('post', seg[2], `https://www.facebook.com/${page}/posts/${seg[2]}`, page);
  }
  return { unsupported: true }; // profiles, pages, groups, events, stories…
}

/** "744 views · 2.3K shares | She survived…" → "She survived…" (the counts are localised noise). */
const stripCounts = (title) => title.replace(/^[^|]*\d[^|]*·[^|]*\|\s*/, '');

export function fromPage(html, ref, finalUrl = null) {
  const og = metaTags(html);
  const title = og['og:title'] || '';
  const text = og['og:description'] || '';
  const where = parseUrl(og['og:url'] || '') || {};
  if (!title || /log ?in/i.test(title) || /\/login/.test(where.path || '') || (!text && !og['og:image'])) throw new ResolveError('login_wall', 'no public tags');
  const fin = parseUrl(finalUrl || '');
  const seg = fin ? segments(fin.path) : [];
  const page = ref.page || (seg[0] && PAGE_RE.test(seg[0]) && !NOT_PAGES.has(seg[0].toLowerCase()) && /^(videos|posts)$/.test(seg[1] || '') ? seg[0] : null);
  return card('facebook', 'public', ref, {
    title: text || stripCounts(title), author: page, account: page ? 'facebook:' + page.toLowerCase() : null, cover: og['og:image'] || null,
  });
}

async function expand(ctx, r) {
  if (!r.short) return r;
  return expandShort(ctx, r.url, SHORT_HOSTS, (url) => refFromUrl(identify, url));
}

async function resolvePublic(ctx, r) {
  try {
    const { text, finalUrl } = await getText(ctx, r.url, { allow: PAGE_HOSTS, headers: { 'Accept-Language': 'en' } });
    return fromPage(text, r, finalUrl);
  } catch (err) {
    throw asResolveError(err);
  }
}

export default {
  id: 'facebook',
  name: 'Facebook',
  mediaHosts: [],
  coverHosts: COVER_HOSTS,
  headSafe: false, // not measured: Range probes only
  methodOrder: ['public'],
  identify,
  capabilities: () => ({
    status: 'METADATA_ONLY',
    kinds: ['info'],
    note: 'public posts and videos: text and preview image',
    methods: { public: 'METADATA_ONLY', official: 'REQUIRES_APPROVAL' },
  }),
  expand,
  resolve(ctx, r, method) {
    if (method === 'public') return resolvePublic(ctx, r);
    throw new ResolveError('unsupported', `method ${method}`);
  },
  healthCheck: (ctx) => healthOf(() => resolvePublic(ctx, videoRef('10155529876156509', 'cnn'))),
  riskNotes: {
    public: {
      en: 'Meta’s terms (Automated Data Collection Terms) forbid automated collection without permission. This method reads only the public link-preview tags of a post or video page (text, preview image); no video is fetched, and many posts are visible only after logging in.',
      fa: 'قوانین Meta (شرایط جمع\u200cآوری خودکار داده) جمع\u200cآوری خودکار بدون اجازه را ممنوع کرده است. این روش فقط تگ\u200cهای عمومی پیش\u200cنمایش لینک صفحه\u200cی پست یا ویدیو را می\u200cخواند (متن، تصویر پیش\u200cنمایش)؛ هیچ ویدیویی دریافت نمی\u200cشود و خیلی از پست\u200cها فقط بعد از ورود به حساب دیده می\u200cشوند.',
      ru: 'Правила Meta (Automated Data Collection Terms) запрещают автоматический сбор данных без разрешения. Этот метод читает только публичные теги превью страницы поста или видео (текст, картинка превью); видео не загружается, а многие посты видны только после входа в аккаунт.',
    },
  },
};
