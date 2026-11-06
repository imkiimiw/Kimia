// Threads (docs/PLATFORMS.md §4) — METADATA_ONLY. Method:
//   public — the Open Graph tags of the public post page (text, author, preview image), measured
//            from Serverless 2026-11-06 (test/fixtures/threads_post.html). The page holds no media
//            files of the post, and the tokenless oEmbed returns only HTML.
// threads.net redirects to threads.com; both are accepted.
import { hostMatches, segments } from '../url.js';
import { asResolveError, card, getText, healthOf, metaTags, ResolveError } from './common.js';

const LINK_HOSTS = ['threads.net', 'www.threads.net', 'threads.com', 'www.threads.com'];
const COVER_HOSTS = ['*.cdninstagram.com', '*.fbcdn.net'];
const CODE_RE = /^[A-Za-z0-9_-]{5,40}$/;
const USER_RE = /^@[A-Za-z0-9._]{1,30}$/;

const postRef = (code, user = null) => ({
  code, key: 'threads:' + code, account: user ? 'threads:' + user.toLowerCase() : null,
  url: user ? `https://www.threads.com/@${user}/post/${code}` : `https://www.threads.com/t/${code}`,
});

export function identify(u) {
  if (!hostMatches(u.host, LINK_HOSTS)) return null;
  const seg = segments(u.path);
  if (USER_RE.test(seg[0] || '') && seg[1] === 'post' && CODE_RE.test(seg[2] || '') && seg.length <= 4) return postRef(seg[2], seg[0].slice(1));
  if (seg[0] === 't' && CODE_RE.test(seg[1] || '') && seg.length === 2) return postRef(seg[1]);
  return { unsupported: true }; // profiles, search…
}

export function fromPage(html, ref) {
  const og = metaTags(html);
  const title = og['og:title'] || '';
  const m = /^(.*\(@([A-Za-z0-9._]{1,30})\)) on Threads$/.exec(title);
  if (!m) throw new ResolveError('not_found', 'no post tags');
  return card('threads', 'public', ref, {
    title: og['og:description'] || '', author: m[1], account: 'threads:' + m[2].toLowerCase(), cover: og['og:image'] || null,
  });
}

async function resolvePublic(ctx, ref) {
  try {
    const { text } = await getText(ctx, ref.url, { allow: LINK_HOSTS });
    return fromPage(text, ref);
  } catch (err) {
    throw asResolveError(err);
  }
}

export default {
  id: 'threads',
  name: 'Threads',
  mediaHosts: [],
  coverHosts: COVER_HOSTS,
  headSafe: false, // not measured: Range probes only
  methodOrder: ['public'],
  identify,
  capabilities: () => ({
    status: 'METADATA_ONLY',
    kinds: ['info'],
    note: 'public posts: text, author and preview image',
    methods: { public: 'METADATA_ONLY', official: 'REQUIRES_OAUTH' },
  }),
  expand: async (ctx, ref) => ref,
  resolve(ctx, ref, method) {
    if (method === 'public') return resolvePublic(ctx, ref);
    throw new ResolveError('unsupported', `method ${method}`);
  },
  healthCheck: (ctx) => healthOf(() => resolvePublic(ctx, postRef('CuP48CiS5sx', 'zuck'))),
  riskNotes: {
    public: {
      en: 'Meta’s terms forbid automated collection without permission. This method reads only the public link-preview tags of a Threads post (text, author, preview image); no media is fetched.',
      fa: 'قوانین Meta جمع\u200cآوری خودکار بدون اجازه را ممنوع کرده است. این روش فقط تگ\u200cهای عمومی پیش\u200cنمایش لینک یک پست Threads را می\u200cخواند (متن، نویسنده، تصویر پیش\u200cنمایش) و هیچ فایلی دریافت نمی\u200cشود.',
      ru: 'Правила Meta запрещают автоматический сбор данных без разрешения. Этот метод читает только публичные теги превью поста Threads (текст, автор, картинка превью); медиафайлы не загружаются.',
    },
  },
};
