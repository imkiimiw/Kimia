// Phase 2 backend: chat → Studio hand-off (jobs), the chunked transfer protocol, server-side
// validation, and the export actions (new pack / add / send). Endpoints are called the way the
// platform calls them: (input, ctx) with ctx.initData.user.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { setup, OWNER } from './helpers/harness.mjs';
import boot from '../tgcloud/endpoints/studio_boot.js';
import jobEp from '../tgcloud/endpoints/studio_job.js';
import media from '../tgcloud/endpoints/studio_media.js';
import begin from '../tgcloud/endpoints/upload_begin.js';
import chunk from '../tgcloud/endpoints/upload_chunk.js';
import commit from '../tgcloud/endpoints/upload_commit.js';

const U = 750001;
const V = 750002;
const ctx = (id) => ({ initData: { user: { id, first_name: `User${id}`, username: `user${id}`, language_code: 'fa' } } });
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const b64 = (b) => Buffer.from(b).toString('base64');

/** A WebP whose VP8L header says w×h (enough for the validators), padded to `size` bytes. */
function webp(w, h, size = 2000) {
  const bits = ((w - 1) | ((h - 1) << 14) | (1 << 28)) >>> 0;
  const payloadLen = size - 20;
  const out = new Uint8Array(size);
  out.set(Buffer.from('RIFF'), 0);
  new DataView(out.buffer).setUint32(4, size - 8, true);
  out.set(Buffer.from('WEBPVP8L'), 8);
  new DataView(out.buffer).setUint32(16, payloadLen, true);
  out.set([0x2f, bits & 255, (bits >> 8) & 255, (bits >> 16) & 255, (bits >>> 24) & 255], 20);
  return out;
}
const refusedWith = async (p, code) => {
  try {
    await p;
  } catch (e) {
    assert.equal(e.name, 'EndpointError', String(e && e.stack));
    assert.equal(e.parameters.code, code, `${e.parameters.code}: ${e.description}`);
    return e;
  }
  assert.fail(`expected ${code}`);
};

test('a photo in chat becomes a job with Studio buttons; only its owner can read it', async () => {
  const h = setup();
  await h.ready(U);
  await h.ready(V);
  const bytes = crypto.randomBytes(600 * 1024); // > 2 chunks of 256 KB
  await h.send(U, null, { photo: h.tg.photo(bytes) });
  const job = h.one('SELECT * FROM jobs');
  assert.equal(job.tg_id, U);
  const btns = h.lastButtons(U);
  assert.ok(btns[0].web_app.url.endsWith(`?job=${job.id}`));
  assert.ok(btns[1].web_app.url.endsWith(`?job=${job.id}&quick=1`));
  await refusedWith(jobEp({ job: job.id }, ctx(V)), 'studio.err.job_gone');
  await refusedWith(media({ job: job.id, idx: 0 }, ctx(V)), 'studio.err.job_gone');
  const meta = await jobEp({ job: job.id }, ctx(U));
  assert.equal(meta.kind, 'photo');
  const first = await media({ job: job.id, idx: 0 }, ctx(U));
  assert.equal(first.total, 3);
  const parts = [Buffer.from(first.b64, 'base64')];
  for (let i = 1; i < first.total; i++) parts.push(Buffer.from((await media({ job: job.id, idx: i }, ctx(U))).b64, 'base64'));
  assert.ok(Buffer.concat(parts).equals(bytes));
  assert.equal(h.tg.callsOf('getFileStream').length, 1, 'downloaded once');
});

test('studio_boot: the gate applies (JOIN_REQUIRED with the channels); members get their packs', async () => {
  const h = setup();
  const e = await refusedWith(boot({}, ctx(U)), 'JOIN_REQUIRED');
  assert.deepEqual(e.parameters.channels.map((c) => c.url), ['https://t.me/HIDE_i_SEEK', 'https://t.me/Nepenthw_ir', 'https://t.me/wangerBots']);
  await h.ready(U);
  const r = await boot({}, ctx(U));
  assert.equal(r.user.id, U);
  assert.deepEqual(r.packs, []);
  assert.equal(r.limits.static.side, 512);
  await refusedWith(boot({ evil: 1 }, ctx(U)), 'BAD_INPUT');
  await refusedWith(boot({}, { initData: {} }), 'NO_USER');
  // the owner passes without joining anything
  assert.equal((await boot({}, ctx(OWNER))).role, 'owner');
});

test('inline export → a new pack; then add to it; then send to chat', async () => {
  const h = setup();
  await h.ready(U);
  const f = webp(512, 400);
  let r = await commit({ inline: b64(f), format: 'webp', size: f.length, sha256: sha(f), action: 'new', title: 'استودیو', emojis: '😺' }, ctx(U));
  assert.equal(r.action, 'new');
  const pack = h.one('SELECT * FROM packs');
  assert.equal(pack.title, 'استودیو');
  const set = h.tg.sets.get(pack.tg_name.toLowerCase());
  assert.equal(set.stickers.length, 1);
  assert.deepEqual(set.stickers[0].emoji_list, ['😺']);
  const up = h.tg.callsOf('uploadStickerFile')[0].params;
  assert.equal(up.user_id, U);
  assert.equal(up.sticker_format, 'static');
  const f2 = webp(400, 512, 3000);
  r = await commit({ inline: b64(f2), format: 'webp', size: f2.length, sha256: sha(f2), action: 'add', packId: pack.id }, ctx(U));
  assert.equal(r.count, 2);
  r = await commit({ inline: b64(f2), format: 'webp', size: f2.length, sha256: sha(f2), action: 'send' }, ctx(U));
  assert.equal(h.tg.callsOf('sendSticker', U).length, 1);
  assert.equal(h.one("SELECT value FROM stats_daily WHERE metric = 'studio.export.static'").value, 3);
});

test('the server re-validates: size, dimensions, format, checksum; another user’s pack is refused', async () => {
  const h = setup();
  await h.ready(U);
  await h.ready(V);
  const good = webp(512, 512);
  await commit({ inline: b64(good), format: 'webp', size: good.length, sha256: sha(good), action: 'new', title: 'A' }, ctx(U));
  const pack = h.one('SELECT * FROM packs');
  const small = webp(500, 400);
  await refusedWith(commit({ inline: b64(small), format: 'webp', size: small.length, sha256: sha(small), action: 'send' }, ctx(U)), 'studio.err.invalid');
  await refusedWith(commit({ inline: b64(good), format: 'webp', size: good.length, sha256: sha(small), action: 'send' }, ctx(U)), 'studio.err.corrupt');
  await refusedWith(commit({ inline: b64(good), format: 'png', size: good.length, sha256: sha(good), action: 'send' }, ctx(U)), 'studio.err.invalid');
  await refusedWith(commit({ inline: 'not base64!', format: 'webp', size: 3, sha256: sha(good), action: 'send' }, ctx(U)), 'studio.err.bad_input');
  await refusedWith(commit({ inline: b64(good), format: 'webp', size: good.length, sha256: sha(good), action: 'add', packId: pack.id }, ctx(V)), 'pk.err.gone');
  await refusedWith(commit({ inline: b64(good), format: 'webp', size: good.length, sha256: sha(good), action: 'drop' }, ctx(U)), 'BAD_INPUT');
  await refusedWith(begin({ kind: 'telegram_static', format: 'webp', size: 600 * 1024, sha256: sha(good) }, ctx(U)), 'studio.err.too_big_export');
  assert.equal(h.tg.callsOf('uploadStickerFile').length, 1, 'nothing invalid reached Telegram');
});

test('chunked upload: begin → chunks → commit; a retried commit is refused; others can’t touch it', async () => {
  const h = setup();
  await h.ready(U);
  await h.ready(V);
  const f = webp(512, 512, 400 * 1024); // 2 chunks
  const b = await begin({ kind: 'telegram_static', format: 'webp', size: f.length, sha256: sha(f) }, ctx(U));
  assert.equal(b.chunks, 2);
  await refusedWith(chunk({ uploadId: b.uploadId, idx: 0, b64: b64(f.subarray(0, b.chunkBytes)) }, ctx(V)), 'studio.err.upload_gone');
  await chunk({ uploadId: b.uploadId, idx: 0, b64: b64(f.subarray(0, b.chunkBytes)) }, ctx(U));
  await refusedWith(commit({ uploadId: b.uploadId, action: 'send' }, ctx(U)), 'studio.err.missing_chunks');
  await chunk({ uploadId: b.uploadId, idx: 1, b64: b64(f.subarray(b.chunkBytes)) }, ctx(U));
  const r = await commit({ uploadId: b.uploadId, action: 'send' }, ctx(U));
  assert.equal(r.action, 'send');
  await refusedWith(commit({ uploadId: b.uploadId, action: 'send' }, ctx(U)), 'studio.err.already');
  assert.equal(h.one('SELECT count(*) AS n FROM upload_chunks').n, 0, 'chunks deleted after commit');
});

test('housekeeping removes expired jobs, uploads and their chunks', async () => {
  const h = setup();
  await h.ready(U);
  await h.send(U, null, { photo: h.tg.photo(crypto.randomBytes(1000)) });
  const job = h.one('SELECT * FROM jobs');
  await media({ job: job.id, idx: 0 }, ctx(U));
  const f = webp(512, 512, 400 * 1024);
  const b = await begin({ kind: 'telegram_static', format: 'webp', size: f.length, sha256: sha(f) }, ctx(U));
  await chunk({ uploadId: b.uploadId, idx: 0, b64: b64(f.subarray(0, b.chunkBytes)) }, ctx(U));
  const { advance } = await import('./helpers/harness.mjs');
  advance(31 * 60);
  await h.send(U, '/menu');
  for (const t of ['jobs', 'job_chunks', 'uploads', 'upload_chunks']) assert.equal(h.one(`SELECT count(*) AS n FROM ${t}`).n, 0, t);
});

test('a static sticker can be opened in the Studio; videos are explained, not accepted', async () => {
  const h = setup();
  await h.ready(U);
  await h.sendSticker(U, h.tg.sticker());
  await h.tap(U, 'st:edit');
  assert.equal(h.one('SELECT source_kind FROM jobs').source_kind, 'sticker');
  const mark = h.mark();
  await h.send(U, null, { video: { file_id: 'V1', file_unique_id: 'VU1', width: 10, height: 10, duration: 3 } });
  assert.ok(h.texts(U, mark).some((t) => /فاز بعد/.test(t)));
});
