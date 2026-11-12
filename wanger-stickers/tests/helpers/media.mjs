// Small media files for the server tests. They are structurally real (our own muxers, gifenc,
// mp4-muxer, zlib) but carry fake codec payloads: the validators read containers and headers only.
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import gifenc from 'gifenc';
const { GIFEncoder, quantize, applyPalette } = gifenc;
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import { muxWebM } from '../../src/engine/webm/mux.ts';
import { muxAnimatedWebP } from '../../src/engine/webp/animmux.ts';

export const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
export const b64 = (b) => Buffer.from(b).toString('base64');

/** A still WebP whose VP8L header says w×h, padded to `size` bytes (random payload). */
export function webp(w, h, size = 2000) {
  const bits = ((w - 1) | ((h - 1) << 14) | (1 << 28)) >>> 0;
  const out = new Uint8Array(size);
  out.set(Buffer.from('RIFF'), 0);
  new DataView(out.buffer).setUint32(4, size - 8, true);
  out.set(Buffer.from('WEBPVP8L'), 8);
  new DataView(out.buffer).setUint32(16, size - 20, true);
  out.set([0x2f, bits & 255, (bits >> 8) & 255, (bits >> 16) & 255, (bits >>> 24) & 255], 20);
  out.set(crypto.randomBytes(Math.max(0, size - 25)), 25);
  return out;
}

/** An animated WebP (our muxer): `frames` frames of `frameMs`, w×h, ≈ frameBytes each. */
export function animWebp({ w = 512, h = 512, frames = 10, frameMs = 100, frameBytes = 3000 } = {}) {
  return muxAnimatedWebP(Array.from({ length: frames }, () => ({ webp: webp(w, h, frameBytes), durationMs: frameMs })), w, h, 0);
}

/** A VP9 WebM from our muxer with fake frame data (optionally with alpha). */
export function webm({ w = 512, h = 512, fps = 30, frames = 90, frameBytes = 1500, alpha = true } = {}) {
  const list = Array.from({ length: frames }, (_, i) => ({
    data: crypto.randomBytes(frameBytes),
    alpha: alpha ? crypto.randomBytes(200) : undefined,
    timestampMs: (i * 1000) / fps,
    key: i === 0,
  }));
  return muxWebM(list, { width: w, height: h, fps, alpha });
}

function crc32(buf) {
  return zlib.crc32 ? zlib.crc32(buf) : 0;
}
/** A real RGBA PNG (w×h, one colour). */
export function png(w, h, rgba = [255, 0, 0, 255]) {
  const row = Buffer.alloc(1 + w * 4);
  for (let x = 0; x < w; x++) row.set(rgba, 1 + x * 4);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

/** A real GIF (gifenc): `frames` frames of w×h with `delayMs` each. */
export function gif({ w = 64, h = 64, frames = 5, delayMs = 100, noise = false } = {}) {
  const enc = GIFEncoder();
  for (let i = 0; i < frames; i++) {
    const rgba = new Uint8Array(w * h * 4);
    const rnd = noise ? crypto.randomBytes(w * h) : null;
    for (let p = 0; p < w * h; p++) rgba.set(noise ? [rnd[p], 255 - rnd[p], (rnd[p] * 7) & 255, 255] : [(p + i * 20) % 256, (i * 50) % 256, 128, 255], p * 4);
    const palette = quantize(rgba, 64);
    enc.writeFrame(applyPalette(rgba, palette), w, h, { palette, delay: delayMs, repeat: 0 });
  }
  enc.finish();
  return enc.bytes();
}

/** An MP4 (mp4-muxer) with one avc1 track of fake samples; optional AAC track. */
export function mp4({ w = 480, h = 270, fps = 30, frames = 60, audio = false } = {}) {
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({ target, video: { codec: 'avc', width: w, height: h }, ...(audio ? { audio: { codec: 'aac', numberOfChannels: 1, sampleRate: 44100 } } : {}), fastStart: 'in-memory' });
  const meta = { decoderConfig: { codec: 'avc1.42001f', codedWidth: w, codedHeight: h, description: new Uint8Array([1, 0x42, 0, 0x1f, 0xff, 0xe0, 0, 0]) } };
  for (let i = 0; i < frames; i++) {
    muxer.addVideoChunkRaw(crypto.randomBytes(800), i === 0 ? 'key' : 'delta', Math.round((i * 1e6) / fps), Math.round(1e6 / fps), i === 0 ? meta : undefined);
    if (audio && i % 2 === 0) muxer.addAudioChunkRaw(crypto.randomBytes(100), 'key', Math.round((i * 1e6) / fps), 23000, i === 0 ? { decoderConfig: { codec: 'mp4a.40.2', numberOfChannels: 1, sampleRate: 44100, description: new Uint8Array([0x12, 0x08]) } } : undefined);
  }
  muxer.finalize();
  return new Uint8Array(target.buffer);
}
