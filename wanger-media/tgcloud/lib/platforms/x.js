// X / Twitter (docs/PLATFORMS.md §4). Methods, tried in this order when the owner has enabled them:
//   public     — X's own embed JSON (cdn.syndication.twimg.com/tweet-result), the data embedded posts
//                use; the `token` is derived from the id the way X's embed script does (not a credential).
//   thirdparty — FxTwitter (api.fxtwitter.com), a free third-party service; used when the owner allows it.
// Media is only ever fetched from pbs.twimg.com / video.twimg.com. Videos and GIFs are complete MP4
// files (with audio) at several bitrates; posts flagged possibly_sensitive are refused by the pipeline.
//
// Response formats, as captured from Serverless on 2026-11-06 (test/fixtures/syn_*.json, fx_*.json):
//   syndication 200: { __typename: 'Tweet', id_str, text, possibly_sensitive, user: { screen_name, name },
//     mediaDetails: [{ type: 'photo'|'video'|'animated_gif', media_url_https, original_info: { width, height },
//       video_info: { duration_millis, variants: [{ bitrate?, content_type, url }] } }] }
//     missing → 404 HTML; withheld/age-restricted → { __typename: 'TweetTombstone' }
//   fxtwitter 200: { code: 200, tweet: { id, text, possibly_sensitive, author: { screen_name, name },
//     media: { all: [{ type: 'photo'|'video'|'gif', url, width, height, duration, variants: [{ url, bitrate, content_type }] }] } } }
//     missing → 404 { code: 404, message: 'NOT_FOUND' }; private → { code: 401 }
import { hostMatches, segments } from '../url.js';
import { asResolveError, decodeEntities, getJson, HttpError, ResolveError } from './common.js';

const LINK_HOSTS = [
  'x.com', 'www.x.com', 'mobile.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com', 'm.twitter.com',
  'fxtwitter.com', 'www.fxtwitter.com', 'fixupx.com', 'fixvx.com', 'vxtwitter.com', 'twittpr.com',
];
const MEDIA_HOSTS = ['pbs.twimg.com', 'video.twimg.com'];
const API_HOSTS = { public: ['cdn.syndication.twimg.com'], thirdparty: ['api.fxtwitter.com'] };
const HEALTH_IDS = ['2115476295169814978', '2112592291147747809'];

/** The embed script's token for a post id. */
export const syndicationToken = (id) => ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');

export function identify(u) {
  if (!hostMatches(u.host, LINK_HOSTS)) return null;
  const seg = segments(u.path);
  let user = null;
  let id = null;
  if (seg[0] === 'i' && seg[1] === 'web' && seg[2] === 'status') id = seg[3];
  else if (seg[0] === 'i' && seg[1] === 'status') id = seg[2];
  else if (seg.length >= 3 && (seg[1] === 'status' || seg[1] === 'statuses')) [user, , id] = seg;
  if (!id || !/^\d{1,20}$/.test(id)) return { unsupported: true };
  if (user && !/^[A-Za-z0-9_]{1,15}$/.test(user)) user = null;
  return {
    id, user, key: 'x:' + id,
    url: `https://x.com/${user || 'i'}/status/${id}`,
    account: user ? 'x:' + user.toLowerCase() : null,
  };
}

/** pbs.twimg.com/media/ABC.jpg → [orig, 4096x4096, large] (best first). */
export function photoVariants(url, width, height) {
  const m = /^(https:\/\/pbs\.twimg\.com\/media\/[A-Za-z0-9_-]+)(?:\.(jpg|jpeg|png|webp))?(?:\?(.*))?$/i.exec(String(url || ''));
  if (!m) return [];
  let format = m[2] ? m[2].toLowerCase() : null;
  if (!format && m[3]) {
    const f = /(?:^|&)format=(jpg|jpeg|png|webp)/i.exec(m[3]);
    if (f) format = f[1].toLowerCase();
  }
  const base = `${m[1]}?format=${format === 'jpeg' ? 'jpg' : format || 'jpg'}&name=`;
  return [
    { url: base + 'orig', width, height },
    { url: base + '4096x4096' },
    { url: base + 'large' },
  ];
}

const sizeFromUrl = (url) => {
  const m = /\/(\d{2,5})x(\d{2,5})\//.exec(url);
  return m ? { width: Number(m[1]), height: Number(m[2]) } : {};
};

/** MP4 variants on video.twimg.com, deduplicated, highest bitrate first. */
export function mp4Variants(list) {
  const seen = new Set();
  const out = [];
  for (const v of list || []) {
    if (!v || typeof v.url !== 'string' || seen.has(v.url)) continue;
    if (!/^https:\/\/video\.twimg\.com\//.test(v.url)) continue;
    if (v.content_type && v.content_type !== 'video/mp4') continue;
    if (!/\.mp4(?:[?#]|$)/i.test(v.url)) continue;
    seen.add(v.url);
    out.push({ url: v.url, bitrate: Number(v.bitrate) || 0, ...sizeFromUrl(v.url) });
  }
  return out.sort((a, b) => b.bitrate - a.bitrate || (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0));
}

const post = (ref, method, fields) => ({ platform: 'x', method, key: ref.key, url: ref.url, ...fields });

export function fromSyndication(j, ref) {
  if (!j || typeof j !== 'object' || !Object.keys(j).length) throw new ResolveError('not_found');
  if (j.__typename === 'TweetTombstone') throw new ResolveError('restricted', 'tombstone');
  if (j.__typename && j.__typename !== 'Tweet') throw new ResolveError('not_found', j.__typename);
  const items = [];
  for (const m of j.mediaDetails || []) {
    const w = m.original_info && m.original_info.width;
    const h = m.original_info && m.original_info.height;
    if (m.type === 'photo') {
      const variants = photoVariants(m.media_url_https, w, h);
      if (variants.length) items.push({ type: 'photo', width: w, height: h, variants });
    } else if (m.type === 'video' || m.type === 'animated_gif') {
      const variants = mp4Variants(m.video_info && m.video_info.variants);
      const duration = m.video_info && m.video_info.duration_millis ? Math.round(m.video_info.duration_millis / 1000) : undefined;
      if (variants.length) items.push({ type: m.type === 'video' ? 'video' : 'gif', width: w, height: h, duration, variants });
    }
  }
  if (!items.length) throw new ResolveError('no_media');
  const user = j.user || {};
  return post(ref, 'public', {
    title: decodeEntities(j.text || ''), author: user.screen_name ? '@' + user.screen_name : null,
    account: user.screen_name ? 'x:' + String(user.screen_name).toLowerCase() : ref.account,
    sensitive: !!j.possibly_sensitive, items,
  });
}

export function fromFxTwitter(j, ref) {
  if (!j || typeof j !== 'object') throw new ResolveError('unavailable', 'not an object');
  if (j.code === 404) throw new ResolveError('not_found');
  if (j.code === 401) throw new ResolveError('private');
  if (j.code !== 200 || !j.tweet) throw new ResolveError('unavailable', `code ${j.code}`);
  const t = j.tweet;
  const items = [];
  for (const m of (t.media && t.media.all) || []) {
    if (m.type === 'photo') {
      const variants = photoVariants(m.url, m.width, m.height);
      if (variants.length) items.push({ type: 'photo', width: m.width, height: m.height, variants });
    } else if (m.type === 'video' || m.type === 'gif') {
      const variants = mp4Variants([...(m.variants || []), ...(m.url ? [{ url: m.url, content_type: 'video/mp4' }] : [])]);
      if (variants.length) items.push({ type: m.type, width: m.width, height: m.height, duration: m.duration ? Math.round(m.duration) : undefined, variants });
    }
  }
  if (!items.length) throw new ResolveError('no_media');
  const a = t.author || {};
  return post(ref, 'thirdparty', {
    title: t.text || '', author: a.screen_name ? '@' + a.screen_name : null,
    account: a.screen_name ? 'x:' + String(a.screen_name).toLowerCase() : ref.account,
    sensitive: !!t.possibly_sensitive, items,
  });
}

async function resolvePublic(ctx, ref) {
  const url = `https://cdn.syndication.twimg.com/tweet-result?id=${ref.id}&lang=en&token=${syndicationToken(ref.id)}`;
  try {
    return fromSyndication(await getJson(ctx, url, { allow: API_HOSTS.public }), ref);
  } catch (err) {
    if (err instanceof HttpError && err.kind === 'parse') throw new ResolveError('not_found', 'HTML instead of JSON');
    throw asResolveError(err);
  }
}

async function resolveThirdparty(ctx, ref) {
  const url = `https://api.fxtwitter.com/${ref.user || 'i'}/status/${ref.id}`;
  try {
    return fromFxTwitter(await getJson(ctx, url, { allow: API_HOSTS.thirdparty }), ref);
  } catch (err) {
    if (err instanceof HttpError && err.kind === 'status' && err.status === 404) throw new ResolveError('not_found');
    throw asResolveError(err);
  }
}

export default {
  id: 'x',
  name: 'X (Twitter)',
  mediaHosts: MEDIA_HOSTS,
  headSafe: true, // HEAD on pbs/video.twimg.com measured fine from Serverless
  methodOrder: ['public', 'thirdparty'],
  identify,
  capabilities: () => ({
    status: 'SUPPORTED',
    kinds: ['photo', 'album', 'video', 'gif'],
    methods: { public: 'SUPPORTED', thirdparty: 'SUPPORTED', official: 'REQUIRES_APPROVAL' },
  }),
  expand: async (ctx, ref) => ref,
  resolve(ctx, ref, method) {
    if (method === 'public') return resolvePublic(ctx, ref);
    if (method === 'thirdparty') return resolveThirdparty(ctx, ref);
    throw new ResolveError('unsupported', `method ${method}`);
  },
  async healthCheck(ctx, method = 'public') {
    let last = null;
    for (const id of HEALTH_IDS) {
      try {
        const p = await this.resolve(ctx, identify({ host: 'x.com', path: `/i/status/${id}` }), method);
        return { ok: true, detail: `${p.items.length} item(s)` };
      } catch (err) {
        last = err;
      }
    }
    return { ok: false, detail: (last && (last.code || last.message)) || 'failed' };
  },
  riskNotes: {
    public: {
      en: 'X’s terms forbid crawling or scraping its service without prior written consent, even for public posts. This method reads X’s own public embed data; X can block it at any time. The media belongs to its creators.',
      fa: 'قوانین X خزیدن یا جمع\u200cآوری خودکار از سرویسش را بدون رضایت کتبی قبلی ممنوع کرده است، حتی برای پست\u200cهای عمومی. این روش داده\u200cی عمومی embed خود X را می\u200cخواند و X هر وقت بخواهد می\u200cتواند جلویش را بگیرد. رسانه\u200cها متعلق به سازندگانشان است.',
      ru: 'Правила X запрещают сканирование и автоматический сбор данных с сервиса без предварительного письменного согласия, даже для публичных постов. Этот метод читает публичные данные для встраивания самого X; X может заблокировать его в любой момент. Медиа принадлежат их авторам.',
    },
    thirdparty: {
      en: 'Uses FxTwitter, a free service not run by X: it can stop or change at any time and sees which posts are requested. Fetching X content this way is also against X’s terms. The media files still come from X’s servers.',
      fa: 'از FxTwitter استفاده می\u200cکند، سرویسی رایگان که مال X نیست: هر وقت ممکن است متوقف یا عوض شود و می\u200cبیند چه پست\u200cهایی درخواست می\u200cشود. گرفتن محتوای X از این راه هم خلاف قوانین X است. فایل\u200cها همچنان از سرورهای X می\u200cآیند.',
      ru: 'Использует FxTwitter — бесплатный сервис, не принадлежащий X: он может перестать работать или измениться в любой момент и видит, какие посты запрашиваются. Получение контента X таким способом также нарушает правила X. Сами файлы по-прежнему загружаются с серверов X.',
    },
  },
};
