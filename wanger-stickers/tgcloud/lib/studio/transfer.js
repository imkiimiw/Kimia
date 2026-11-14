// The Studio's transfer protocol (brief §4, DECISIONS D5; sizes from SPIKE_REPORT §3a):
// - chat → Studio: a `jobs` row for a file the user sent; the first studio_media call streams it
//   (getFileStream, ≤ 20 MB) into raw chunks, later calls return one chunk as base64;
// - Studio → bot: upload_begin → upload_chunk… → upload_commit, or one call with `inline` for a
//   file that fits a single chunk (every sticker ≤ 256 KB). Commit checks size + SHA-256, runs the
//   kind's validator again (core/validate.js UPLOAD_KINDS), then acts: add to a Telegram pack, new
//   pack, send a sticker / animation / file to the chat, or add to a WhatsApp pack (Phase 3).
// Ownership: every job/upload query includes the caller's id from the verified init data.
import { transfer as tdb } from '../db/transfer.js';
import { packs as pdb } from '../db/packs.js';
import { UserError, randomId } from '../core/util.js';
import { toBase64, fromBase64, sha256Hex, concatBytes } from '../core/bytes.js';
import { UPLOAD_KINDS, sniffImage } from '../core/validate.js';
import { cleanTitle, parseEmojiList, cleanWaText, parseWaEmojis, maxStickers, packUrl } from '../core/packs.js';
import { classify, friendlyKey } from '../core/errors.js';
import { makeZip, readZip } from '../core/zip.js';
import { TELEGRAM, WHATSAPP, OUTPUT } from '../core/limits.js';
import { InputFile } from 'sdk';

const MIME = Object.freeze({ webp: 'image/webp', png: 'image/png', webm: 'video/webm' });

export const TRANSFER = Object.freeze({
  chunkBytes: 256 * 1024, // raw bytes per chunk (≈ 342 KB base64 per request); one SQL value < 1 MB (measured)
  jobTtlSec: 30 * 60,
  uploadTtlSec: 30 * 60,
  maxOpenUploads: 3,
  jobMaxBytes: TELEGRAM.files.downloadMaxBytes,
});

/** @param {any} app */
export function createTransfer(app) {
  const { clock, tg } = app;

  return {
    /** A file the user sent in chat → a job token for the Studio (?job=<id>). */
    async createJob(user, { file_id, kind, mime, size }) {
      if (size > TRANSFER.jobMaxBytes) throw new UserError('studio.err.too_big', { mb: TRANSFER.jobMaxBytes / 1048576 });
      const now = clock.now();
      return tdb.createJob({ id: randomId(12), tg_id: user.tg_id, file_id, kind, mime: mime || null, size: size || 0, now, expires: now + TRANSFER.jobTtlSec });
    },

    async job(user, id) {
      const j = await tdb.getJob(String(id || ''), user.tg_id, clock.now());
      if (!j) throw new UserError('studio.err.job_gone');
      return j;
    },

    /** Chunk idx of a job's file as base64; the first call downloads and stores the file. */
    async media(user, id, idx) {
      let j = await this.job(user, id);
      if (j.status === 'new') {
        const stream = await tg.call('getFileStream', { file_id: j.source_file_id }, 'job_download');
        const parts = [];
        let buf = [];
        let have = 0;
        let total = 0;
        const flush = async () => {
          const chunk = concatBytes(buf);
          await tdb.putJobChunk(j.id, parts.length, chunk);
          parts.push(chunk.length);
          buf = [];
          have = 0;
        };
        for await (const piece of stream.body) {
          let p = piece;
          total += p.length;
          if (total > TRANSFER.jobMaxBytes) throw new UserError('studio.err.too_big', { mb: TRANSFER.jobMaxBytes / 1048576 });
          while (have + p.length >= TRANSFER.chunkBytes) {
            const take = TRANSFER.chunkBytes - have;
            buf.push(p.subarray(0, take));
            p = p.subarray(take);
            have += take;
            await flush();
          }
          if (p.length) {
            buf.push(p);
            have += p.length;
          }
        }
        if (have || !parts.length) await flush();
        j = (await tdb.markReady(j.id, parts.length, total)) || (await this.job(user, id));
      }
      const n = Number(idx);
      if (!Number.isInteger(n) || n < 0 || n >= j.chunks) throw new UserError('studio.err.bad_input');
      const data = await tdb.jobChunk(j.id, n);
      if (!data) throw new UserError('studio.err.job_gone');
      return { idx: n, total: j.chunks, size: j.size, b64: toBase64(data) };
    },

    async begin(user, { kind, format, size, sha256 }) {
      const K = kindOf(app, user, kind);
      if (!K.formats.includes(format)) throw new UserError('studio.err.bad_input');
      if (!Number.isInteger(size) || size < 1 || size > K.maxBytes) throw new UserError('studio.err.too_big_export', { kb: Math.round(K.maxBytes / 1024) });
      if (!/^[0-9a-f]{64}$/.test(String(sha256))) throw new UserError('studio.err.bad_input');
      const now = clock.now();
      if ((await tdb.openUploadsOf(user.tg_id, now)) >= TRANSFER.maxOpenUploads) throw new UserError('studio.err.busy');
      const chunks = Math.ceil(size / TRANSFER.chunkBytes);
      const up = await tdb.createUpload({ id: randomId(16), tg_id: user.tg_id, kind, format, size, sha256, chunks, now, expires: now + TRANSFER.uploadTtlSec });
      return { uploadId: up.upload_id, chunkBytes: TRANSFER.chunkBytes, chunks };
    },

    async chunk(user, { uploadId, idx, b64 }) {
      const up = await tdb.getUpload(String(uploadId || ''), user.tg_id, clock.now());
      if (!up || up.status !== 'open') throw new UserError('studio.err.upload_gone');
      if (!Number.isInteger(idx) || idx < 0 || idx >= up.chunks) throw new UserError('studio.err.bad_input');
      const data = fromBase64(b64);
      if (!data || !data.length || data.length > TRANSFER.chunkBytes) throw new UserError('studio.err.bad_input');
      await tdb.putUploadChunk(up.upload_id, idx, data);
      return { received: idx };
    },

    /**
     * Reassembles (or takes `inline`), checks size + SHA-256 + the target's rules, then acts.
     * @param {any} user
     * @param {{uploadId?: string, inline?: string, kind?: string, format: string, size: number, sha256: string, action: string, packId?: number, title?: string, publisher?: string, emojis?: string}} o
     */
    async commit(user, o) {
      let bytes;
      let up = null;
      if (o.inline !== undefined) {
        bytes = fromBase64(o.inline);
        if (!bytes || bytes.length > TRANSFER.chunkBytes) throw new UserError('studio.err.bad_input');
        o = { ...o, kind: o.kind || 'telegram_static' };
      } else {
        up = await tdb.getUpload(String(o.uploadId || ''), user.tg_id, clock.now());
        if (!up) throw new UserError('studio.err.upload_gone');
        if (up.status !== 'open') throw new UserError('studio.err.already');
        if ((await tdb.countUploadChunks(up.upload_id)) !== up.chunks) throw new UserError('studio.err.missing_chunks');
        if (!(await tdb.claimCommit(up.upload_id))) throw new UserError('studio.err.already');
        const parts = [];
        for (let i = 0; i < up.chunks; i++) parts.push(await tdb.uploadChunk(up.upload_id, i));
        bytes = concatBytes(parts);
        o = { ...o, kind: up.kind, format: up.format, size: up.total_size, sha256: up.sha256 };
      }
      try {
        const K = kindOf(app, user, o.kind);
        if (!ACTIONS[o.kind].includes(o.action)) throw new UserError('studio.err.bad_input');
        if (bytes.length !== o.size || bytes.length > K.maxBytes) throw new UserError('studio.err.corrupt');
        if ((await sha256Hex(bytes)) !== o.sha256) throw new UserError('studio.err.corrupt');
        const format = sniffImage(bytes);
        if (format !== o.format || !K.formats.includes(format)) throw new UserError('studio.err.invalid', { why: 'FORMAT' });
        const check = K.check(bytes, format);
        if (!check.ok) throw new UserError('studio.err.invalid', { why: check.violations.join(', ') });
        if (o.kind === 'frames_zip') checkFramesZip(bytes);
        const result = await ACT[o.kind](app, user, bytes, format, o, check.info);
        if (up) await tdb.dropUploadChunks(up.upload_id);
        app.stats.count(`studio.export.${o.kind.replace(/^telegram_/, '')}`);
        return result;
      } catch (e) {
        if (up) await tdb.reopen(up.upload_id); // the user may retry the same upload
        throw e;
      }
    },
  };
}

/** Which actions each upload kind allows. */
export const ACTIONS = Object.freeze({
  telegram_static: ['add', 'new', 'send'],
  telegram_video: ['add', 'new', 'send'],
  emoji_static: ['add', 'new'],
  emoji_video: ['add', 'new'],
  animation: ['send'],
  gif: ['send', 'file'],
  webp_file: ['file'],
  frames_zip: ['file'],
  whatsapp_static: ['wa_add', 'wa_new'],
  whatsapp_animated: ['wa_add', 'wa_new'],
  whatsapp_tray: ['wa_tray'],
});

/** The feature flag that switches each kind on (the owner may always test). */
const KIND_FLAG = Object.freeze({
  telegram_static: 'studio',
  telegram_video: 'video',
  emoji_static: 'emoji',
  emoji_video: 'emoji',
  animation: 'gif_studio',
  gif: 'gif_studio',
  webp_file: 'convert',
  frames_zip: 'convert',
  whatsapp_static: 'whatsapp',
  whatsapp_animated: 'whatsapp',
  whatsapp_tray: 'whatsapp',
});

function kindOf(app, user, kind) {
  const K = Object.prototype.hasOwnProperty.call(UPLOAD_KINDS, kind) ? UPLOAD_KINDS[kind] : null;
  if (!K) throw new UserError('studio.err.bad_input');
  if (!app.flag(KIND_FLAG[kind]) && app.role !== 'owner') throw new UserError('common.feature_off');
  return K;
}

/** A frames ZIP from the Studio: stored entries, PNG only, at most OUTPUT.zip.maxEntries. */
function checkFramesZip(bytes) {
  const z = readZip(bytes);
  if (z.error) throw new UserError('studio.err.invalid', { why: z.error });
  if (!z.entries.length || z.entries.length > OUTPUT.zip.maxEntries) throw new UserError('studio.err.invalid', { why: 'ENTRIES' });
  if (z.entries.some((e) => !/^[A-Za-z0-9_.-]{1,64}\.png$/.test(e.name) || sniffImage(e.data) !== 'png')) throw new UserError('studio.err.invalid', { why: 'NOT_PNG' });
}

/** Media deliveries share one daily quota ('media_send'), counted after the send. */
async function deliver(app, user, send) {
  await app.packs.checkQuota(user.tg_id, 'media_send');
  try {
    await send();
  } catch (e) {
    const key = friendlyKey(e);
    if (key !== 'err.generic') throw new UserError(key, { s: classify(e).retryAfter || 1 });
    throw e;
  }
  await app.packs.countUsage(user.tg_id, 'media_send');
  return { action: 'send' };
}

const stamp = (app) => new Date(app.clock.now() * 1000).toISOString().slice(0, 10).replace(/-/g, '');
const FILE_EXTRA = { disable_content_type_detection: true };

const ACT = {
  telegram_static: (app, user, bytes, format, o) => act(app, user, bytes, format, 'static', o),
  telegram_video: (app, user, bytes, format, o) => act(app, user, bytes, format, 'video', o),
  emoji_static: (app, user, bytes, format, o) => act(app, user, bytes, format, 'static', o, true),
  emoji_video: (app, user, bytes, format, o) => act(app, user, bytes, format, 'video', o, true),
  animation: (app, user, bytes, format, o, info) => {
    const v = info.tracks.find((t) => t.type === 'vide');
    return deliver(app, user, () => app.tg.sendAnimation(user.tg_id, bytes, `wanger_${stamp(app)}.mp4`, { width: Math.round(v.width), height: Math.round(v.height), duration: Math.max(1, Math.round(info.durationMs / 1000)) }, 'studio_animation'));
  },
  gif: (app, user, bytes, format, o, info) => {
    if (o.action === 'send') return deliver(app, user, () => app.tg.sendAnimation(user.tg_id, bytes, `wanger_${stamp(app)}.gif`, { type: 'image/gif', width: info.width, height: info.height }, 'studio_gif'));
    // a real .gif file; if Telegram still turns it into an animation, the owner turns on flags.gif_zip
    if (app.flag('gif_zip')) {
      const zip = makeZip([{ name: `wanger_${stamp(app)}.gif`, data: bytes }], app.clock.now());
      return deliver(app, user, () => app.tg.sendDocument(user.tg_id, zip, `wanger_${stamp(app)}_gif.zip`, { type: 'application/zip', extra: FILE_EXTRA }, 'studio_gif_zip'));
    }
    return deliver(app, user, () => app.tg.sendDocument(user.tg_id, bytes, `wanger_${stamp(app)}.gif`, { type: 'image/gif', extra: FILE_EXTRA }, 'studio_gif_file'));
  },
  webp_file: (app, user, bytes) => deliver(app, user, () => app.tg.sendDocument(user.tg_id, bytes, `wanger_${stamp(app)}.webp`, { type: 'image/webp', extra: FILE_EXTRA }, 'studio_webp_file')),
  frames_zip: (app, user, bytes) => deliver(app, user, () => app.tg.sendDocument(user.tg_id, bytes, `wanger_frames_${stamp(app)}.zip`, { type: 'application/zip', extra: FILE_EXTRA }, 'studio_frames_zip')),
  whatsapp_static: (app, user, bytes, format, o) => waAct(app, user, bytes, 'static', o),
  whatsapp_animated: (app, user, bytes, format, o) => waAct(app, user, bytes, 'animated', o),
  whatsapp_tray: async (app, user, bytes, format, o) => {
    const pack = await app.whatsapp.own(user.tg_id, o.packId);
    await app.whatsapp.setTray(user, pack, bytes);
    return { action: 'wa_tray', packId: pack.id };
  },
};

/** WhatsApp: new pack (name + publisher) or an existing one of this user, then add. */
async function waAct(app, user, bytes, kind, o) {
  const emojis = parseWaEmojis(o.emojis || '');
  if (!emojis) throw new UserError('wa.err.emojis', { max: WHATSAPP.pack.emojiPerStickerMax });
  let pack;
  if (o.action === 'wa_new') {
    const title = cleanWaText(o.title);
    const publisher = cleanWaText(o.publisher, WHATSAPP.pack.publisherMaxChars);
    if (!title || !publisher) throw new UserError('wa.err.meta', { max: WHATSAPP.pack.nameMaxChars });
    pack = await app.whatsapp.create(user, { title, publisher, kind });
  } else pack = await app.whatsapp.own(user.tg_id, o.packId);
  const after = await app.whatsapp.add(user, pack, bytes, kind, emojis);
  const left = Math.max(0, WHATSAPP.pack.minStickers - after.sticker_count);
  return { action: o.action, packId: pack.id, count: after.sticker_count, needTray: !after.tray_file_id, left };
}

/**
 * Checks the target first, then uploadStickerFile, then add / create / send. `emoji`: the file is
 * a 100×100 custom emoji, which goes only into custom emoji sets (and regular stickers never do).
 */
async function act(app, user, bytes, format, stickerFormat, o, emoji = false) {
  const emojis = parseEmojiList(o.emojis || '') || ['⭐'];
  // nothing reaches Telegram unless the target is valid and the caller's own
  let target = null;
  let title = null;
  if (o.action === 'add') {
    target = await pdb.getOwned(Number(o.packId), user.tg_id);
    if (!target) throw new UserError('pk.err.gone');
    if (emoji !== (target.kind === 'emoji')) throw new UserError(emoji ? 'pk.err.not_emoji_set' : 'pk.err.emoji_set');
    if (target.sticker_count >= maxStickers(target)) throw new UserError('err.set_full');
    await app.packs.checkQuota(user.tg_id, 'sticker_add');
  } else if (o.action === 'new') {
    title = cleanTitle(o.title);
    if (!title) throw new UserError('pk.err.title', { max: TELEGRAM.set.titleMaxChars });
    await app.packs.checkQuota(user.tg_id, 'pack_create');
  } else if (o.action !== 'send') throw new UserError('studio.err.bad_input');
  let file;
  try {
    file = await app.tg.call('uploadStickerFile', {
      user_id: user.tg_id,
      sticker: new InputFile(bytes, `sticker.${format}`, { type: MIME[format] }),
      sticker_format: stickerFormat,
    }, 'sticker_upload');
  } catch (e) {
    const key = friendlyKey(e);
    if (key !== 'err.generic') throw new UserError(key, { s: classify(e).retryAfter || 1 });
    throw e;
  }
  const si = { file_id: file.file_id, file_unique_id: file.file_unique_id, format: stickerFormat, emojis };
  if (o.action === 'send') {
    await app.tg.sticker(user.tg_id, file.file_id, null, 'studio_sticker');
    return { action: 'send' };
  }
  if (o.action === 'new') {
    const pack = await app.packs.create(user, title, si, 'made', { emoji, repaint: !!o.repaint });
    if (!o.quiet) await app.tg.send(user.tg_id, { text: app.t('studio.n_new_pack', { title: pack.title, link: packUrl(pack) }) }, 'studio_done');
    return { action: 'new', packId: pack.id, name: pack.tg_name, count: 1 };
  }
  if (o.action === 'add') {
    const pack = target;
    await app.packs.add(user, pack, si, 'made');
    // batch mode sets quiet on every sticker but the last, so the chat gets one confirmation
    if (!o.quiet) await app.tg.send(user.tg_id, { text: app.t('studio.n_added', { title: pack.title, n: pack.sticker_count, link: packUrl(pack) }) }, 'studio_done');
    return { action: 'add', packId: pack.id, name: pack.tg_name, count: pack.sticker_count };
  }
  throw new UserError('studio.err.bad_input');
}
