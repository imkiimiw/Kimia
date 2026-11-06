// Instagram (docs/PLATFORMS.md §4) — LIMITED: public posts only. Method:
//   public — Instagram's public embed page (/p/<code>/embed/captioned/, what websites use to embed a
//            post). It carries the post as JSON ("contextJSON", a JSON string inside the page's
//            script): photos, carousels and — when Instagram includes it — the video file
//            (measured from Serverless 2026-11-06: test/fixtures/ig_embed.html, ig_sidecar.html,
//            ig_reel.html, ig_missing.html).
// Videos Instagram doesn't put in the embed (e.g. copyright_blocked reels) are sent as their cover
// image with a note. Private, deleted and age-restricted posts have no embed data → not found.
// Stories and profiles aren't supported; /share/… links are expanded by following their redirects.
import { hostMatches, segments } from '../url.js';
import { asResolveError, expandShort, getText, healthOf, refFromUrl, ResolveError } from './common.js';

const LINK_HOSTS = ['instagram.com', 'www.instagram.com', 'm.instagram.com', 'instagr.am', 'www.instagr.am'];
const PAGE_HOSTS = ['instagram.com', 'www.instagram.com'];
const MEDIA_HOSTS = ['*.cdninstagram.com', '*.fbcdn.net'];
const CODE_RE = /^[A-Za-z0-9_-]{5,60}$/;
const KIND = new Map([['p', 'p'], ['reel', 'reel'], ['reels', 'reel'], ['tv', 'p']]);
const MAX_ITEMS = 20;

const postRef = (code, kind = 'p') => ({ code, key: 'instagram:' + code, url: `https://www.instagram.com/${kind}/${code}/`, account: null });

export function identify(u) {
  if (!hostMatches(u.host, LINK_HOSTS)) return null;
  const seg = segments(u.path);
  if (seg[0] === 'share' && /^[A-Za-z0-9_-]{4,40}$/.test(seg[seg.length - 1] || '') && seg.length <= 3) {
    return { short: seg[seg.length - 1], key: null, url: `https://www.instagram.com/${seg.join('/')}/`, account: null };
  }
  // /p/<code>/, /reel/<code>/, /tv/<code>/, /<user>/p/<code>/, optionally …/embed[/captioned]
  const i = KIND.has(seg[0]) ? 0 : KIND.has(seg[1]) && /^[A-Za-z0-9._]{1,30}$/.test(seg[0]) ? 1 : -1;
  if (i >= 0 && CODE_RE.test(seg[i + 1] || '')) {
    const rest = seg.slice(i + 2);
    if (rest.length === 0 || (rest[0] === 'embed' && rest.length <= 2)) return postRef(seg[i + 1], KIND.get(seg[i]));
  }
  return { unsupported: true }; // stories, profiles, explore…
}

/** The JSON string value after `"contextJSON":` in the embed page, parsed twice; null if absent. */
export function contextJson(html) {
  const s = String(html);
  const k = '"contextJSON":"';
  const at = s.indexOf(k);
  if (at < 0) return null;
  let j = at + k.length;
  for (; j < s.length; j++) {
    if (s[j] === '\\') j++;
    else if (s[j] === '"') break;
  }
  try {
    return JSON.parse(JSON.parse(s.slice(at + k.length - 1, j + 1)));
  } catch {
    return null;
  }
}

function photoVariants(node) {
  const res = Array.isArray(node.display_resources) ? [...node.display_resources] : [];
  res.sort((a, b) => (b.config_width || 0) - (a.config_width || 0));
  const urls = [node.display_url, ...res.map((r) => r.src)].filter((u) => typeof u === 'string' && /^https:\/\//.test(u));
  const dims = node.dimensions || {};
  return [...new Set(urls)].slice(0, 3).map((url, i) => (i === 0 ? { url, width: dims.width, height: dims.height } : { url }));
}

function itemOf(node) {
  const dims = node.dimensions || {};
  if (node.is_video && typeof node.video_url === 'string' && /^https:\/\//.test(node.video_url)) {
    return { item: { type: 'video', width: dims.width, height: dims.height, duration: node.video_duration ? Math.round(node.video_duration) : undefined, variants: [{ url: node.video_url, width: dims.width, height: dims.height }] }, cover: false };
  }
  return { item: { type: 'photo', variants: photoVariants(node) }, cover: !!node.is_video };
}

export function fromEmbed(html, ref) {
  const c = contextJson(html);
  const m = c && c.gql_data && c.gql_data.shortcode_media;
  if (!m) throw new ResolveError('not_found', 'no embed data (missing, private or restricted)');
  const nodes = m.edge_sidecar_to_children && Array.isArray(m.edge_sidecar_to_children.edges)
    ? m.edge_sidecar_to_children.edges.map((e) => e && e.node).filter(Boolean)
    : [m];
  const parts = nodes.slice(0, MAX_ITEMS).map(itemOf).filter((p) => p.item.variants.length);
  if (!parts.length) throw new ResolveError('no_media');
  const owner = m.owner && /^[A-Za-z0-9._]{1,30}$/.test(m.owner.username || '') ? m.owner.username : null;
  const caption = m.edge_media_to_caption && m.edge_media_to_caption.edges && m.edge_media_to_caption.edges[0];
  return {
    platform: 'instagram', method: 'public', key: ref.key, url: ref.url,
    title: caption && caption.node ? String(caption.node.text || '') : '',
    author: owner ? '@' + owner : null, account: owner ? 'instagram:' + owner.toLowerCase() : null,
    sensitive: false,
    coverOnly: parts.some((p) => p.cover),
    items: parts.map((p) => p.item),
  };
}

async function expand(ctx, ref) {
  if (!ref.short) return ref;
  return expandShort(ctx, ref.url, LINK_HOSTS, (url) => refFromUrl(identify, url));
}

async function resolvePublic(ctx, ref) {
  try {
    const { text } = await getText(ctx, `https://www.instagram.com/p/${ref.code}/embed/captioned/`, { allow: PAGE_HOSTS });
    return fromEmbed(text, ref);
  } catch (err) {
    throw asResolveError(err);
  }
}

export default {
  id: 'instagram',
  name: 'Instagram',
  mediaHosts: MEDIA_HOSTS,
  headSafe: false, // not measured: Range probes only
  methodOrder: ['public'],
  identify,
  capabilities: () => ({
    status: 'LIMITED',
    kinds: ['photo', 'video'],
    note: 'public posts, reels and carousels that Instagram lets websites embed',
    methods: { public: 'LIMITED', official: 'REQUIRES_APPROVAL' },
  }),
  expand,
  resolve(ctx, ref, method) {
    if (method === 'public') return resolvePublic(ctx, ref);
    throw new ResolveError('unsupported', `method ${method}`);
  },
  healthCheck: (ctx) => healthOf(() => resolvePublic(ctx, postRef('fA9uwTtkSN'))),
  riskNotes: {
    public: {
      en: 'Instagram’s terms forbid collecting content in an automated way without permission, and Meta actively blocks it — the highest risk of all platforms here. This method reads Instagram’s public embed page (what websites use to embed a post); only public posts work, and Instagram can stop it at any time. The photos and videos belong to their creators.',
      fa: 'قوانین Instagram جمع\u200cآوری خودکار محتوا بدون اجازه را ممنوع کرده است و Meta فعالانه جلوی آن را می\u200cگیرد؛ این پرخطرترین پلتفرم این فهرست است. این روش صفحه\u200cی عمومی embed اینستاگرام را می\u200cخواند (همان چیزی که سایت\u200cها برای نمایش یک پست استفاده می\u200cکنند)؛ فقط پست\u200cهای عمومی کار می\u200cکنند و Instagram هر وقت بخواهد می\u200cتواند جلویش را بگیرد. عکس\u200cها و ویدیوها متعلق به سازندگانشان است.',
      ru: 'Правила Instagram запрещают автоматический сбор контента без разрешения, и Meta активно это блокирует — это самый рискованный из всех платформ. Этот метод читает публичную embed-страницу Instagram (то, чем сайты встраивают пост); работают только публичные посты, и Instagram может прекратить это в любой момент. Фото и видео принадлежат их авторам.',
    },
  },
};
