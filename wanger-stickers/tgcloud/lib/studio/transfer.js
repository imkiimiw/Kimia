// The Studio's transfer protocol (brief §4, DECISIONS D5; sizes from SPIKE_REPORT §3a):
// - chat → Studio: a `jobs` row for a file the user sent; the first studio_media call streams it
//   (getFileStream, ≤ 20 MB) into raw chunks, later calls return one chunk as base64;
// - Studio → bot: upload_begin → upload_chunk… → upload_commit, or one call with `inline` for a
//   file that fits a single chunk (every static sticker ≤ 256 KB). Commit checks size + SHA-256,
//   runs the validator again, then acts (add to a pack, new pack, send to chat).
// Ownership: every job/upload query includes the caller's id from the verified init data.
import { transfer as tdb } from '../db/transfer.js';
import { packs as pdb } from '../db/packs.js';
import { UserError, randomId } from '../core/util.js';
import { toBase64, fromBase64, sha256Hex, concatBytes } from '../core/bytes.js';
import { validateTelegramStatic, sniffImage } from '../core/validate.js';
import { cleanTitle, parseEmojiList } from '../core/packs.js';
import { classify, friendlyKey } from '../core/errors.js';
import { TELEGRAM } from '../core/limits.js';
import { InputFile } from 'sdk';

export const TRANSFER = Object.freeze({
  chunkBytes: 256 * 1024, // raw bytes per chunk (≈ 342 KB base64 per request); one SQL value < 1 MB (measured)
  jobTtlSec: 30 * 60,
  uploadTtlSec: 30 * 60,
  maxStaticBytes: TELEGRAM.static.maxBytes,
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
      if (kind !== 'telegram_static') throw new UserError('studio.err.bad_input');
      if (format !== 'webp' && format !== 'png') throw new UserError('studio.err.bad_input');
      if (!Number.isInteger(size) || size < 1 || size > TRANSFER.maxStaticBytes) throw new UserError('studio.err.too_big_export', { kb: TRANSFER.maxStaticBytes / 1024 });
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
     * Reassembles (or takes `inline`), checks size + SHA-256 + the platform rules, then acts.
     * @param {any} user
     * @param {{uploadId?: string, inline?: string, format: string, size: number, sha256: string, action: 'add'|'new'|'send', packId?: number, title?: string, emojis?: string}} o
     */
    async commit(user, o) {
      let bytes;
      let up = null;
      if (o.inline !== undefined) {
        bytes = fromBase64(o.inline);
        if (!bytes || bytes.length > TRANSFER.chunkBytes) throw new UserError('studio.err.bad_input');
      } else {
        up = await tdb.getUpload(String(o.uploadId || ''), user.tg_id, clock.now());
        if (!up) throw new UserError('studio.err.upload_gone');
        if (up.status !== 'open') throw new UserError('studio.err.already');
        if ((await tdb.countUploadChunks(up.upload_id)) !== up.chunks) throw new UserError('studio.err.missing_chunks');
        if (!(await tdb.claimCommit(up.upload_id))) throw new UserError('studio.err.already');
        const parts = [];
        for (let i = 0; i < up.chunks; i++) parts.push(await tdb.uploadChunk(up.upload_id, i));
        bytes = concatBytes(parts);
        o = { ...o, format: up.format, size: up.total_size, sha256: up.sha256 };
      }
      try {
        if (bytes.length !== o.size) throw new UserError('studio.err.corrupt');
        if ((await sha256Hex(bytes)) !== o.sha256) throw new UserError('studio.err.corrupt');
        const format = sniffImage(bytes);
        if (format !== o.format) throw new UserError('studio.err.invalid', { why: 'FORMAT' });
        const check = validateTelegramStatic(bytes, format);
        if (!check.ok) throw new UserError('studio.err.invalid', { why: check.violations.join(', ') });
        const emojis = parseEmojiList(o.emojis || '') || ['⭐'];
        const result = await act(app, user, bytes, format, emojis, o);
        if (up) await tdb.dropUploadChunks(up.upload_id);
        app.stats.count('studio.export.static');
        return result;
      } catch (e) {
        if (up) await tdb.reopen(up.upload_id); // the user may retry the same upload
        throw e;
      }
    },
  };
}

/** Checks the target first, then uploadStickerFile, then add / create / send. */
async function act(app, user, bytes, format, emojis, o) {
  // nothing reaches Telegram unless the target is valid and the caller's own
  let target = null;
  let title = null;
  if (o.action === 'add') {
    target = await pdb.getOwned(Number(o.packId), user.tg_id);
    if (!target) throw new UserError('pk.err.gone');
    if (target.sticker_count >= TELEGRAM.set.maxStickersRegular) throw new UserError('err.set_full');
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
      sticker: new InputFile(bytes, `sticker.${format}`, { type: format === 'png' ? 'image/png' : 'image/webp' }),
      sticker_format: 'static',
    }, 'sticker_upload');
  } catch (e) {
    const key = friendlyKey(e);
    if (key !== 'err.generic') throw new UserError(key, { s: classify(e).retryAfter || 1 });
    throw e;
  }
  const si = { file_id: file.file_id, file_unique_id: file.file_unique_id, format: 'static', emojis };
  if (o.action === 'send') {
    await app.tg.sticker(user.tg_id, file.file_id, null, 'studio_sticker');
    return { action: 'send' };
  }
  if (o.action === 'new') {
    const pack = await app.packs.create(user, title, si, 'made');
    await app.tg.send(user.tg_id, { text: app.t('studio.n_new_pack', { title: pack.title, link: `https://t.me/addstickers/${pack.tg_name}` }) }, 'studio_done');
    return { action: 'new', packId: pack.id, name: pack.tg_name, count: 1 };
  }
  if (o.action === 'add') {
    const pack = target;
    await app.packs.add(user, pack, si, 'made');
    await app.tg.send(user.tg_id, { text: app.t('studio.n_added', { title: pack.title, n: pack.sticker_count, link: `https://t.me/addstickers/${pack.tg_name}` }) }, 'studio_done');
    return { action: 'add', packId: pack.id, name: pack.tg_name, count: pack.sticker_count };
  }
  throw new UserError('studio.err.bad_input');
}
