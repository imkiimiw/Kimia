// Discord (docs/PLATFORMS.md §4) — LIMITED: direct attachment links only (brief §7). Method:
//   public — the file link the user hands over (cdn.discordapp.com / media.discordapp.net
//            /attachments/<channel>/<file id>/<name>?ex=…&is=…&hm=…). Discord signs these links and
//            they expire (≈ 24 h); an expired or unsigned link answers 404 (measured 2026-11-05).
// Message, invite and channel links need a login → refused with a hint. Discord's CDN has carried
// malware, so only images, GIFs and MP4 videos are delivered: the name's extension AND the served
// Content-Type must both be one of those, checked before anything is downloaded.
import { hostMatches, segments } from '../url.js';
import { asResolveError, request, ResolveError } from './common.js';

const LINK_HOSTS = ['discord.com', '*.discord.com', 'discord.gg', 'discordapp.com', '*.discordapp.com', 'cdn.discordapp.com', 'media.discordapp.net'];
const MEDIA_HOSTS = ['cdn.discordapp.com', 'media.discordapp.net'];
const SNOWFLAKE = /^\d{15,22}$/;
const NAME_RE = /^[A-Za-z0-9._()%+-]{1,200}$/;
/** Allowed files: extension → item type, and the Content-Types each may be served as. */
const EXT = { jpg: 'photo', jpeg: 'photo', png: 'photo', webp: 'photo', gif: 'gif', mp4: 'video' };
const MIME = { 'image/jpeg': 'photo', 'image/png': 'photo', 'image/webp': 'photo', 'image/gif': 'gif', 'video/mp4': 'video' };

export function extOf(name) {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}

export function identify(u) {
  if (!hostMatches(u.host, LINK_HOSTS)) return null;
  if (!MEDIA_HOSTS.includes(u.host)) return { unsupported: true }; // message / invite / channel links
  const seg = segments(u.path);
  if ((seg[0] === 'attachments' || seg[0] === 'ephemeral-attachments') && seg.length === 4
      && SNOWFLAKE.test(seg[1]) && SNOWFLAKE.test(seg[2]) && NAME_RE.test(seg[3])) {
    return { id: seg[2], name: seg[3], key: 'discord:' + seg[2], url: u.href, account: null };
  }
  return { unsupported: true }; // avatars, emojis, icons…
}

const own = (map, k) => (Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null);

const header = (res, name) => {
  try { return res.headers.get(name) || ''; } catch { return ''; }
};

/** Classifies the served file: → item type, or throws ResolveError('file_type'). */
export function fileKind(name, contentType) {
  const byExt = own(EXT, extOf(name));
  const byMime = own(MIME, String(contentType || '').split(';')[0].trim().toLowerCase());
  if (!byExt || !byMime || byExt !== byMime) throw new ResolveError('file_type', `${extOf(name) || '?'} / ${contentType || '?'}`);
  return byMime;
}

async function resolvePublic(ctx, ref) {
  if (!own(EXT, extOf(ref.name))) throw new ResolveError('file_type', extOf(ref.name) || 'no extension');
  let res;
  try {
    res = await request(ctx, ref.url, { allow: MEDIA_HOSTS, method: 'HEAD' });
  } catch (err) {
    throw asResolveError(err);
  }
  if (res.status === 404 || res.status === 403 || res.status === 410) throw new ResolveError('not_found', `HTTP ${res.status} (expired or unsigned link)`);
  if (!res.ok) throw new ResolveError('unavailable', `HTTP ${res.status}`);
  const contentType = header(res, 'content-type');
  const type = fileKind(ref.name, contentType);
  const bytes = Number(header(res, 'content-length'));
  return {
    platform: 'discord', method: 'public', key: ref.key, url: ref.url,
    title: '', author: null, account: null, sensitive: false,
    items: [{
      type,
      variants: [{ url: ref.url, bytes: bytes > 0 ? bytes : undefined, mime: contentType.split(';')[0].trim(), ranges: /bytes/i.test(header(res, 'accept-ranges')) }],
    }],
  };
}

export default {
  id: 'discord',
  name: 'Discord',
  mediaHosts: MEDIA_HOSTS,
  headSafe: true, // HEAD to cdn.discordapp.com measured fine
  methodOrder: ['public'],
  identify,
  capabilities: () => ({
    status: 'LIMITED',
    kinds: ['photo', 'gif', 'video'],
    note: 'direct attachment links (images, GIFs, MP4) — they expire after about a day',
    methods: { public: 'LIMITED', official: 'REQUIRES_OAUTH' },
  }),
  expand: async (ctx, ref) => ref,
  resolve(ctx, ref, method) {
    if (method === 'public') return resolvePublic(ctx, ref);
    throw new ResolveError('unsupported', `method ${method}`);
  },
  async healthCheck(ctx) {
    try {
      const res = await request(ctx, 'https://cdn.discordapp.com/embed/avatars/0.png', { allow: MEDIA_HOSTS, method: 'HEAD' });
      return res.ok ? { ok: true, detail: 'CDN reachable' } : { ok: false, detail: `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, detail: err.kind || err.message };
    }
  },
  riskNotes: {
    public: {
      en: 'The user hands over a direct file link that Discord already made shareable; the bot fetches only that file — images, GIFs and MP4 videos, never other file types. Discord links expire after about a day. The files belong to whoever uploaded them.',
      fa: 'کاربر لینک مستقیم فایلی را می\u200cدهد که خود Discord قابل اشتراک کرده است؛ ربات فقط همان فایل را دریافت می\u200cکند — عکس، GIF و ویدیوی MP4 و هرگز نوع دیگری از فایل. لینک\u200cهای Discord بعد از حدود یک روز منقضی می\u200cشوند. فایل\u200cها متعلق به کسی است که آن\u200cها را بارگذاری کرده است.',
      ru: 'Пользователь передаёт прямую ссылку на файл, которой Discord уже разрешил делиться; бот загружает только этот файл — изображения, GIF и видео MP4, никаких других типов файлов. Ссылки Discord истекают примерно через сутки. Файлы принадлежат тем, кто их загрузил.',
    },
  },
};
