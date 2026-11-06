// Spotify (docs/PLATFORMS.md §4) — METADATA_ONLY; the music is DRM-protected (brief §7: title,
// artists, cover and link only — never fetch the audio from anywhere). Method:
//   public — the Open Graph tags of the public open.spotify.com page (title; "Artist · Album · Song
//            · Year"; 640 px cover), measured from Serverless 2026-11-06 (test/fixtures/
//            spotify_track.html). Its og:audio preview is deliberately ignored.
// spotify.link short links are expanded by following their redirects.
import { hostMatches, segments } from '../url.js';
import { card, expandShort, getText, healthOf, metaTags, refFromUrl, ResolveError, asResolveError } from './common.js';

const LINK_HOSTS = ['open.spotify.com', 'play.spotify.com', 'spotify.link', 'spotify.app.link'];
const PAGE_HOSTS = ['open.spotify.com'];
const COVER_HOSTS = ['i.scdn.co', 'mosaic.scdn.co', '*.spotifycdn.com'];
const KINDS = ['track', 'album', 'playlist', 'artist', 'episode', 'show'];
const ID_RE = /^[A-Za-z0-9]{22}$/;

const itemRef = (kind, id) => ({ kind, id, key: `spotify:${kind}:${id}`, url: `https://open.spotify.com/${kind}/${id}`, account: null });

export function identify(u) {
  if (!hostMatches(u.host, LINK_HOSTS)) return null;
  const seg = segments(u.path);
  if (u.host === 'spotify.link' || u.host === 'spotify.app.link') {
    return seg.length === 1 && /^[A-Za-z0-9]{4,30}$/.test(seg[0]) ? { short: seg[0], key: null, url: `https://${u.host}/${seg[0]}`, account: null } : { unsupported: true };
  }
  let i = 0;
  if (/^intl-[a-z]{2}(-[a-z]{2})?$/i.test(seg[0] || '')) i = 1;
  if (seg[i] === 'embed') i += 1;
  const kind = seg[i];
  return KINDS.includes(kind) && ID_RE.test(seg[i + 1] || '') && seg.length === i + 2 ? itemRef(kind, seg[i + 1]) : { unsupported: true };
}

export function fromPage(html, ref) {
  const og = metaTags(html);
  const raw = og['og:title'];
  if (!raw) throw new ResolveError('not_found', 'no og:title');
  const title = raw.replace(/^Listen to /, '').replace(/ \| Spotify$/, '');
  return card('spotify', 'public', ref, { title, details: og['og:description'] || null, cover: og['og:image'] || null });
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
  id: 'spotify',
  name: 'Spotify',
  mediaHosts: [],
  coverHosts: COVER_HOSTS,
  headSafe: true, // HEAD to i.scdn.co measured fine
  methodOrder: ['public'],
  identify,
  capabilities: () => ({
    status: 'METADATA_ONLY',
    kinds: ['info'],
    note: 'title, artists and cover; the music is DRM-protected',
    methods: { public: 'METADATA_ONLY' },
  }),
  expand,
  resolve(ctx, ref, method) {
    if (method === 'public') return resolvePublic(ctx, ref);
    throw new ResolveError('unsupported', `method ${method}`);
  },
  healthCheck: (ctx) => healthOf(() => resolvePublic(ctx, itemRef('track', '11dFghVXANMlKmJXsNCbNl'))),
  riskNotes: {
    public: {
      en: 'Spotify’s terms forbid crawling or scraping its service. This method reads only the public link-preview tags of a page (title, artists, cover) — never any audio, not even the preview; the music is DRM-protected.',
      fa: 'قوانین Spotify خزیدن و جمع\u200cآوری خودکار از سرویسش را ممنوع کرده است. این روش فقط تگ\u200cهای عمومی پیش\u200cنمایش لینک را می\u200cخواند (عنوان، هنرمند، کاور) و هیچ صدایی را، حتی پیش\u200cنمایش، دریافت نمی\u200cکند؛ موسیقی Spotify با DRM محافظت می\u200cشود.',
      ru: 'Правила Spotify запрещают краулинг и скрапинг сервиса. Этот метод читает только публичные теги превью ссылки (название, исполнители, обложка) — никакого аудио, даже превью; музыка защищена DRM.',
    },
  },
};
