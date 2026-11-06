// Pinterest (docs/PLATFORMS.md §4) — image pins and video pins. Method:
//   public — the JSON behind Pinterest's official embed widget (widgets.pinterest.com/v3/pidgets/pins/info):
//            the original image on i.pinimg.com, or for a video pin its MP4 from videos.video_list on
//            v1.pinimg.com (HLS playlists are never used). Verified from Serverless on 2026-11-06.
// Idea Pins (story_pin_data) carry no video file in that JSON: only the cover image is sent and the
// caption says so.
// pin.it short links are expanded by following their redirects (each hop allowlisted) without
// fetching the 1.5 MB pin page.
//
// Format (test/fixtures/pin_info.json, a video pin): { status: 'success', data: [{ id, description, images:
//   { '236x', '564x': { url, width, height } }, pinner: { profile_url, full_name }, story_pin_data, is_video,
//   videos: { video_list: { V_720P: { url: '…mp4', width, height, duration (ms) }, V_HLSV4: { url: '…m3u8' } } } }] };
//   an unknown pin → data: [{ error, id }].
import { parseUrl, segments } from '../url.js';
import { asResolveError, decodeEntities, getJson, request, ResolveError } from './common.js';

const HOST_RE = /^(?:[a-z0-9-]+\.)?pinterest\.(?:com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})$/;
const MEDIA_HOSTS = ['i.pinimg.com', 'v1.pinimg.com'];
const API_HOSTS = ['widgets.pinterest.com'];
const SHORT_HOSTS = ['pin.it', 'api.pinterest.com', 'www.pinterest.com', 'pinterest.com'];
const HEALTH_PIN = '424605071146271645';

const pinRef = (id) => ({ id, key: 'pinterest:' + id, url: `https://www.pinterest.com/pin/${id}/`, account: null });

/** The pin id in a /pin/<id>/ or /pin/<slug>--<id>/ path, or null. */
export function pinIdFromPath(path) {
  const seg = segments(path);
  const i = seg.indexOf('pin');
  if (i < 0 || !seg[i + 1]) return null;
  const m = /(?:^|--)(\d{5,20})$/.exec(seg[i + 1]);
  return m ? m[1] : null;
}

export function identify(u) {
  if (u.host === 'pin.it') {
    const code = segments(u.path)[0];
    return code && /^[A-Za-z0-9]{3,20}$/.test(code) ? { short: code, key: null, url: `https://pin.it/${code}`, account: null } : { unsupported: true };
  }
  if (!HOST_RE.test(u.host)) return null;
  const id = pinIdFromPath(u.path);
  return id ? pinRef(id) : { unsupported: true };
}

/** i.pinimg.com/564x/… → [originals, 564x] (best first). */
export function imageVariants(images) {
  const i564 = images && images['564x'];
  const best = i564 || (images && (images['237x'] || images['236x']));
  if (!best || !best.url || !/^https:\/\/i\.pinimg\.com\//.test(best.url)) return [];
  const original = best.url.replace(/\/(?:564x|236x|237x)\//, '/originals/');
  const out = [{ url: original }];
  if (original !== best.url) out.push({ url: best.url, width: best.width, height: best.height });
  return out;
}

/** The pinner's username: the widget gives profile_url ("https://www.pinterest.com/<name>/"), not a username field. */
export function pinnerUsername(p) {
  if (!p) return null;
  if (p.username && /^[A-Za-z0-9_.-]{1,60}$/.test(p.username)) return p.username;
  const u = parseUrl(p.profile_url || '');
  const name = u && HOST_RE.test(u.host) ? segments(u.path)[0] : null;
  return name && /^[A-Za-z0-9_.-]{1,60}$/.test(name) ? name : null;
}

/** MP4 variants of a video pin (v1.pinimg.com), largest first; HLS playlists are skipped. */
export function videoVariants(videos) {
  const list = videos && videos.video_list && typeof videos.video_list === 'object' ? Object.values(videos.video_list) : [];
  return list
    .filter((v) => v && typeof v.url === 'string' && /^https:\/\/v1\.pinimg\.com\/[^?#]+\.mp4(?:[?#]|$)/.test(v.url))
    .map((v) => ({ url: v.url, width: Number(v.width) || undefined, height: Number(v.height) || undefined, duration: v.duration ? Math.round(v.duration / 1000) : undefined }))
    .sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0));
}

export function fromPinInfo(j, ref) {
  const d = j && Array.isArray(j.data) ? j.data[0] : null;
  if (!d || d.error) throw new ResolveError('not_found', d && d.error);
  const video = videoVariants(d.videos);
  const variants = imageVariants(d.images);
  if (!video.length && !variants.length) throw new ResolveError('no_media');
  const username = pinnerUsername(d.pinner);
  return {
    platform: 'pinterest', method: 'public', key: ref.key, url: ref.url,
    title: decodeEntities(String(d.description || '')).trim(), author: username ? '@' + username : null,
    account: username ? 'pinterest:' + username.toLowerCase() : null,
    sensitive: false,
    coverOnly: !video.length && !!(d.is_video || d.story_pin_data),
    items: video.length
      ? [{ type: 'video', width: video[0].width, height: video[0].height, duration: video[0].duration, variants: video }]
      : [{ type: 'photo', variants }],
  };
}

async function expand(ctx, ref) {
  if (!ref.short) return ref;
  const isPin = (url) => {
    const u = parseUrl(url);
    return !!u && HOST_RE.test(u.host) && !!pinIdFromPath(u.path);
  };
  let res;
  try {
    res = await request(ctx, ref.url, { allow: [...SHORT_HOSTS, '*.pinterest.com'], stopAt: isPin });
  } catch (err) {
    throw asResolveError(err);
  }
  if (!res.stoppedAt) throw new ResolveError('not_found', 'short link did not lead to a pin');
  return pinRef(pinIdFromPath(parseUrl(res.stoppedAt).path));
}

async function resolvePublic(ctx, ref) {
  try {
    return fromPinInfo(await getJson(ctx, `https://widgets.pinterest.com/v3/pidgets/pins/info/?pin_ids=${ref.id}`, { allow: API_HOSTS }), ref);
  } catch (err) {
    throw asResolveError(err);
  }
}

export default {
  id: 'pinterest',
  name: 'Pinterest',
  mediaHosts: MEDIA_HOSTS,
  headSafe: true, // HEAD on i.pinimg.com / v1.pinimg.com measured fine from Serverless
  methodOrder: ['public'],
  identify,
  capabilities: () => ({
    status: 'LIMITED',
    kinds: ['photo', 'video'],
    note: 'image and video pins; Idea Pins send their cover image',
    methods: { public: 'LIMITED', official: 'REQUIRES_APPROVAL' },
  }),
  expand,
  resolve(ctx, ref, method) {
    if (method === 'public') return resolvePublic(ctx, ref);
    throw new ResolveError('unsupported', `method ${method}`);
  },
  async healthCheck(ctx) {
    try {
      const p = await resolvePublic(ctx, pinRef(HEALTH_PIN));
      return { ok: true, detail: `${p.items[0].type}, ${p.items[0].variants.length} variant(s)` };
    } catch (err) {
      return { ok: false, detail: err.code || err.message };
    }
  },
  riskNotes: {
    public: {
      en: 'Pinterest’s terms forbid scraping or collecting content by automated means without its prior permission. This method reads the data behind Pinterest’s own embed widget; Pinterest can block it at any time. Pins are often re-posts of other people’s work: the caption always links the source.',
      fa: 'قوانین Pinterest جمع\u200cآوری خودکار محتوا را بدون اجازه\u200cی قبلی\u200cاش ممنوع کرده است. این روش داده\u200cی پشت ویجت embed خود Pinterest را می\u200cخواند و Pinterest هر وقت بخواهد می\u200cتواند جلویش را بگیرد. پین\u200cها اغلب بازنشر کار دیگران\u200cاند: کپشن همیشه لینک منبع را دارد.',
      ru: 'Правила Pinterest запрещают автоматический сбор контента без его предварительного разрешения. Этот метод читает данные собственного виджета встраивания Pinterest; Pinterest может заблокировать его в любой момент. Пины часто являются репостами чужих работ: в подписи всегда есть ссылка на источник.',
    },
  },
};
