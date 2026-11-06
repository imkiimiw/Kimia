// Twitch (docs/PLATFORMS.md §4) — METADATA_ONLY, video (VOD) links only. Method:
//   public — the Open Graph tags of the public video page (title, channel, thumbnail), measured
//            from Serverless 2026-11-06 (test/fixtures/twitch_video.html).
// VODs are HLS streams (brief §7: no merging) and clip downloads need the channel editor's
// authorisation, so no video is fetched. Clip pages carry only generic tags, so clip links are
// refused with a hint; channels are profiles, not posts.
import { hostMatches, segments } from '../url.js';
import { asResolveError, card, getText, healthOf, metaTags, ResolveError } from './common.js';

const LINK_HOSTS = ['twitch.tv', 'www.twitch.tv', 'm.twitch.tv', 'clips.twitch.tv'];
const PAGE_HOSTS = ['twitch.tv', 'www.twitch.tv', 'm.twitch.tv'];
const COVER_HOSTS = ['static-cdn.jtvnw.net'];

const videoRef = (id) => ({ id, key: 'twitch:video:' + id, url: `https://www.twitch.tv/videos/${id}`, account: null });

export function identify(u) {
  if (!hostMatches(u.host, LINK_HOSTS)) return null;
  const seg = segments(u.path);
  if (u.host !== 'clips.twitch.tv' && seg[0] === 'videos' && /^\d{4,15}$/.test(seg[1] || '') && seg.length === 2) return videoRef(seg[1]);
  return { unsupported: true }; // clips, channels, directories…
}

export function fromPage(html, ref) {
  const og = metaTags(html);
  const raw = og['og:title'] || '';
  if (!raw || raw === 'Twitch' || og['og:type'] !== 'video.other') throw new ResolveError('not_found', 'no video tags');
  const m = /^(.*) - ([A-Za-z0-9_]{2,25}) on Twitch$/.exec(raw);
  const channel = m ? m[2] : null;
  return card('twitch', 'public', ref, {
    title: m ? m[1] : raw, details: og['og:description'] || null,
    author: channel, account: channel ? 'twitch:' + channel.toLowerCase() : null, cover: og['og:image'] || null,
  });
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
  id: 'twitch',
  name: 'Twitch',
  mediaHosts: [],
  coverHosts: COVER_HOSTS,
  headSafe: true, // HEAD to static-cdn.jtvnw.net measured fine
  methodOrder: ['public'],
  identify,
  capabilities: () => ({
    status: 'METADATA_ONLY',
    kinds: ['info'],
    note: 'video (VOD) links: title, channel and thumbnail',
    methods: { public: 'METADATA_ONLY', official: 'REQUIRES_OAUTH' },
  }),
  expand: async (ctx, ref) => ref,
  resolve(ctx, ref, method) {
    if (method === 'public') return resolvePublic(ctx, ref);
    throw new ResolveError('unsupported', `method ${method}`);
  },
  healthCheck: (ctx) => healthOf(() => resolvePublic(ctx, videoRef('6528877'))),
  riskNotes: {
    public: {
      en: 'Twitch’s terms forbid scraping without permission. This method reads only the public link-preview tags of a video page (title, channel, thumbnail); no video is fetched.',
      fa: 'قوانین Twitch جمع\u200cآوری خودکار بدون اجازه را ممنوع کرده است. این روش فقط تگ\u200cهای عمومی پیش\u200cنمایش لینک صفحه\u200cی ویدیو را می\u200cخواند (عنوان، کانال، تصویر کوچک) و هیچ ویدیویی دریافت نمی\u200cشود.',
      ru: 'Правила Twitch запрещают скрапинг без разрешения. Этот метод читает только публичные теги превью страницы видео (название, канал, миниатюра); само видео не загружается.',
    },
  },
};
