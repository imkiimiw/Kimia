// Snapchat (docs/PLATFORMS.md §4) — public Spotlight links only. Method:
//   public — the Open Graph tags of the public Spotlight page: og:video is a complete MP4 on
//            *.sc-cdn.net (verified from Serverless on 2026-11-05/06, test/fixtures/snap_spotlight.html).
// Stories, profiles and other link types are not supported. snapchat.com/t/<code> short links are
// expanded by following their redirects (each hop allowlisted).
import { hostMatches, parseUrl, segments } from '../url.js';
import { asResolveError, getText, metaTags, request, ResolveError } from './common.js';

const LINK_HOSTS = ['snapchat.com', 'www.snapchat.com', 't.snapchat.com', 'story.snapchat.com'];
const PAGE_HOSTS = ['snapchat.com', 'www.snapchat.com', 't.snapchat.com'];
const MEDIA_HOSTS = ['*.sc-cdn.net'];
const ID_RE = /^[A-Za-z0-9_-]{20,160}$/;

const spotlightRef = (id, user = null) => ({
  id, user, key: 'snapchat:' + id, url: `https://www.snapchat.com/spotlight/${id}`,
  account: user ? 'snapchat:' + user.toLowerCase() : null,
});

/** /spotlight/<id> or /@<user>/spotlight/<id> → { id, user } or null. */
export function spotlightFromPath(path) {
  const seg = segments(path);
  const i = seg.indexOf('spotlight');
  if (i < 0 || !ID_RE.test(seg[i + 1] || '')) return null;
  const user = i > 0 && /^@[A-Za-z0-9._-]{2,40}$/.test(seg[i - 1]) ? seg[i - 1].slice(1) : null;
  return { id: seg[i + 1], user };
}

export function identify(u) {
  if (!hostMatches(u.host, LINK_HOSTS)) return null;
  if (u.host === 'story.snapchat.com') return { unsupported: true };
  const seg = segments(u.path);
  if ((seg[0] === 't' && seg[1]) || (u.host === 't.snapchat.com' && seg[0])) {
    const code = seg[0] === 't' ? seg[1] : seg[0];
    return /^[A-Za-z0-9_-]{4,40}$/.test(code) ? { short: code, key: null, url: `https://www.snapchat.com/t/${code}`, account: null } : { unsupported: true };
  }
  const s = spotlightFromPath(u.path);
  return s ? spotlightRef(s.id, s.user) : { unsupported: true };
}

export function fromSpotlightHtml(html, ref, finalUrl) {
  const og = metaTags(html);
  const video = og['og:video:secure_url'] || og['og:video'] || og['og:video:url'];
  if (!video || !/^https:\/\/[a-z0-9.-]+\.sc-cdn\.net\//i.test(video)) throw new ResolveError('no_media');
  const where = parseUrl(og['og:url'] || finalUrl || '');
  const s = where ? spotlightFromPath(where.path) : null;
  const user = (s && s.user) || ref.user || null;
  return {
    platform: 'snapchat', method: 'public', key: ref.key, url: ref.url,
    title: '', author: user ? '@' + user : null, account: user ? 'snapchat:' + user.toLowerCase() : ref.account,
    sensitive: false,
    items: [{
      type: 'video',
      width: Number(og['og:video:width']) || undefined,
      height: Number(og['og:video:height']) || undefined,
      variants: [{ url: video, width: Number(og['og:video:width']) || undefined, height: Number(og['og:video:height']) || undefined }],
    }],
  };
}

async function expand(ctx, ref) {
  if (!ref.short) return ref;
  const isSpotlight = (url) => {
    const u = parseUrl(url);
    return !!u && hostMatches(u.host, PAGE_HOSTS) && !!spotlightFromPath(u.path);
  };
  let res;
  try {
    res = await request(ctx, ref.url, { allow: PAGE_HOSTS, stopAt: isSpotlight });
  } catch (err) {
    throw asResolveError(err);
  }
  if (!res.stoppedAt) throw new ResolveError('unsupported', 'short link did not lead to a Spotlight');
  const s = spotlightFromPath(parseUrl(res.stoppedAt).path);
  return spotlightRef(s.id, s.user);
}

async function resolvePublic(ctx, ref) {
  try {
    const { text, finalUrl } = await getText(ctx, ref.url, { allow: PAGE_HOSTS });
    return fromSpotlightHtml(text, ref, finalUrl);
  } catch (err) {
    throw asResolveError(err);
  }
}

export default {
  id: 'snapchat',
  name: 'Snapchat',
  mediaHosts: MEDIA_HOSTS,
  headSafe: false, // a HEAD to cf-st.sc-cdn.net crashes the invocation (HTTP 500, measured): Range only
  methodOrder: ['public'],
  identify,
  capabilities: () => ({
    status: 'LIMITED',
    kinds: ['video'],
    note: 'public Spotlight links only',
    methods: { public: 'LIMITED', official: 'REQUIRES_APPROVAL' },
  }),
  expand,
  resolve(ctx, ref, method) {
    if (method === 'public') return resolvePublic(ctx, ref);
    throw new ResolveError('unsupported', `method ${method}`);
  },
  async healthCheck(ctx) {
    try {
      const { text } = await getText(ctx, 'https://www.snapchat.com/spotlight', { allow: PAGE_HOSTS });
      const m = /\/spotlight\/([A-Za-z0-9_-]{20,160})/.exec(text);
      if (!m) return { ok: false, detail: 'no Spotlight on the listing page' };
      const p = await resolvePublic(ctx, spotlightRef(m[1]));
      return { ok: true, detail: `${p.items.length} video` };
    } catch (err) {
      return { ok: false, detail: err.code || err.message };
    }
  },
  riskNotes: {
    public: {
      en: 'Snapchat’s terms forbid robots, crawlers and scrapers. This method reads the public Open Graph tags of Spotlight pages (what link previews use); Snapchat can change or block it at any time. The videos belong to their creators.',
      fa: 'قوانین Snapchat استفاده از ربات، خزنده و ابزار جمع\u200cآوری خودکار را ممنوع کرده است. این روش تگ\u200cهای عمومی Open Graph صفحه\u200cهای Spotlight را می\u200cخواند (همان چیزی که پیش\u200cنمایش لینک\u200cها استفاده می\u200cکند) و Snapchat هر وقت بخواهد می\u200cتواند آن را عوض کند یا جلویش را بگیرد. ویدیوها متعلق به سازندگانشان است.',
      ru: 'Правила Snapchat запрещают роботов, краулеры и скраперы. Этот метод читает публичные теги Open Graph страниц Spotlight (то, что используют превью ссылок); Snapchat может изменить или заблокировать это в любой момент. Видео принадлежат их авторам.',
    },
  },
};
