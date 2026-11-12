/**
 * Header readers for the files this project produces: WebP (RIFF) and WebM (EBML). Pure module
 * (no 'sdk'), shared by the Mini App's engine and the server. Phase 0 uses them to check the spike's
 * outputs; Phase 2/3 builds the rule validators (limits.js) on top of these facts.
 *
 * They read structure only (no decoding) and never throw on bad input: they return { error }.
 */

const td = typeof TextDecoder !== 'undefined' ? new TextDecoder('latin1') : null;
function fourcc(b, o) {
  return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
}
function u24(b, o) {
  return b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
}
function u32(b, o) {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

/**
 * @param {Uint8Array} b
 * @returns {{ error?: string, width?: number, height?: number, animated?: boolean, alpha?: boolean,
 *   lossless?: boolean, frames?: number, durationMs?: number, minFrameMs?: number, loop?: number,
 *   chunks?: string[], bytes: number }}
 */
export function inspectWebP(b) {
  const bytes = b.length;
  if (bytes < 20 || fourcc(b, 0) !== 'RIFF' || fourcc(b, 8) !== 'WEBP') return { error: 'NOT_WEBP', bytes };
  const riffSize = u32(b, 4);
  if (riffSize + 8 > bytes) return { error: 'TRUNCATED', bytes };
  const out = { bytes, width: 0, height: 0, animated: false, alpha: false, lossless: false, frames: 0, durationMs: 0, minFrameMs: Infinity, loop: -1, chunks: /** @type {string[]} */ ([]) };
  let o = 12;
  const end = Math.min(bytes, riffSize + 8);
  while (o + 8 <= end) {
    const id = fourcc(b, o);
    const size = u32(b, o + 4);
    const p = o + 8;
    if (p + size > end) return { ...out, error: 'BAD_CHUNK:' + id };
    out.chunks.push(id);
    if (id === 'VP8X') {
      const flags = b[p];
      out.alpha = !!(flags & 0x10);
      out.animated = !!(flags & 0x02);
      out.width = u24(b, p + 4) + 1;
      out.height = u24(b, p + 7) + 1;
    } else if (id === 'ANIM') {
      out.loop = b[p + 4] | (b[p + 5] << 8);
    } else if (id === 'ANMF') {
      const d = u24(b, p + 12);
      out.frames++;
      out.durationMs += d;
      out.minFrameMs = Math.min(out.minFrameMs, d);
      // frame payload: look for VP8L / ALPH inside
      let q = p + 16;
      while (q + 8 <= p + size) {
        const sid = fourcc(b, q);
        if (sid === 'VP8L') out.lossless = true;
        if (sid === 'ALPH') out.alpha = true;
        q += 8 + u32(b, q + 4) + (u32(b, q + 4) & 1);
      }
    } else if (id === 'VP8 ' && !out.width) {
      // keyframe header: 3-byte tag, start code 9d 01 2a, then 14-bit width/height
      out.width = (b[p + 6] | (b[p + 7] << 8)) & 0x3fff;
      out.height = (b[p + 8] | (b[p + 9] << 8)) & 0x3fff;
      out.frames = 1;
    } else if (id === 'VP8L' && !out.width) {
      const bits = u32(b, p + 1);
      out.width = (bits & 0x3fff) + 1;
      out.height = ((bits >> 14) & 0x3fff) + 1;
      out.alpha = !!((bits >> 28) & 1);
      out.lossless = true;
      out.frames = 1;
    } else if (id === 'ALPH') {
      out.alpha = true;
    }
    o = p + size + (size & 1);
  }
  if (!out.animated && out.frames === 0 && out.width) out.frames = 1;
  if (out.minFrameMs === Infinity) out.minFrameMs = 0;
  return out;
}

/**
 * PNG: signature + IHDR (width, height, colour type → alpha).
 * @param {Uint8Array} b
 */
export function inspectPng(b) {
  const bytes = b.length;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes < 33 || sig.some((v, i) => b[i] !== v)) return { error: 'NOT_PNG', bytes };
  if (fourcc(b, 12) !== 'IHDR') return { error: 'BAD_IHDR', bytes };
  const be32 = (o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const colorType = b[25];
  return { bytes, width: be32(16), height: be32(20), bitDepth: b[24], alpha: colorType === 4 || colorType === 6 };
}

/* ---------------- WebM (EBML) ---------------- */

const ID = {
  EBML: 0x1a45dfa3, DocType: 0x4282, Segment: 0x18538067, Info: 0x1549a966, TimecodeScale: 0x2ad7b1, Duration: 0x4489,
  Tracks: 0x1654ae6b, TrackEntry: 0xae, TrackType: 0x83, CodecID: 0x86, Video: 0xe0, PixelWidth: 0xb0, PixelHeight: 0xba,
  AlphaMode: 0x53c0, DefaultDuration: 0x23e383, Cluster: 0x1f43b675, SimpleBlock: 0xa3, BlockGroup: 0xa0, Block: 0xa1, Timecode: 0xe7,
  TrackNumber: 0xd7,
};
const MASTER = new Set([ID.EBML, ID.Segment, ID.Info, ID.Tracks, ID.TrackEntry, ID.Video, ID.Cluster, ID.BlockGroup]);

function readId(b, o) {
  const first = b[o];
  let len = 1;
  if (first & 0x80) len = 1;
  else if (first & 0x40) len = 2;
  else if (first & 0x20) len = 3;
  else if (first & 0x10) len = 4;
  else return null;
  let v = 0;
  for (let i = 0; i < len; i++) v = v * 256 + b[o + i];
  return { id: v, len };
}
function readSize(b, o) {
  const first = b[o];
  let len = 1;
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
  if (len > 8) return null;
  let v = first & (0xff >> len);
  let allOnes = v === 0xff >> len;
  for (let i = 1; i < len; i++) {
    v = v * 256 + b[o + i];
    if (b[o + i] !== 0xff) allOnes = false;
  }
  return { size: allOnes ? -1 : v, len }; // -1 = unknown size (live streams)
}
function readUint(b, o, n) {
  let v = 0;
  for (let i = 0; i < n; i++) v = v * 256 + b[o + i];
  return v;
}
function readFloat(b, o, n) {
  const dv = new DataView(b.buffer, b.byteOffset + o, n);
  return n === 4 ? dv.getFloat32(0) : dv.getFloat64(0);
}

/**
 * @param {Uint8Array} b
 * @returns {{ error?: string, docType?: string, tracks?: Array<{type:number, codec:string, width?:number, height?:number, alphaMode?:number, defaultDurationNs?:number}>,
 *   durationMs?: number, frames?: number, fps?: number, hasAudio?: boolean, bytes: number }}
 */
export function inspectWebM(b) {
  const bytes = b.length;
  if (bytes < 4 || readUint(b, 0, 4) !== ID.EBML) return { error: 'NOT_EBML', bytes };
  const out = { bytes, docType: '', tracks: /** @type {any[]} */ ([]), durationMs: 0, frames: 0, fps: 0, hasAudio: false };
  let scale = 1000000;
  let rawDuration = 0;
  let clusterTc = 0;
  let maxTs = 0;
  let cur = null;

  const walk = (start, end, depth) => {
    let o = start;
    while (o < end) {
      const id = readId(b, o);
      if (!id) return 'BAD_ID';
      const sz = readSize(b, o + id.len);
      if (!sz) return 'BAD_SIZE';
      const p = o + id.len + sz.len;
      const e = sz.size < 0 ? end : Math.min(end, p + sz.size);
      if (MASTER.has(id.id)) {
        if (id.id === ID.TrackEntry) {
          cur = { type: 0, codec: '' };
          out.tracks.push(cur);
        }
        const err = depth < 8 ? walk(p, e, depth + 1) : null;
        if (err) return err;
        if (id.id === ID.TrackEntry) cur = null;
      } else {
        const n = e - p;
        if (id.id === ID.DocType) out.docType = td ? td.decode(b.subarray(p, e)) : String.fromCharCode(...b.subarray(p, e));
        else if (id.id === ID.TimecodeScale) scale = readUint(b, p, n);
        else if (id.id === ID.Duration) rawDuration = readFloat(b, p, n);
        else if (cur && id.id === ID.TrackType) cur.type = readUint(b, p, n);
        else if (cur && id.id === ID.TrackNumber) cur.number = readUint(b, p, n);
        else if (cur && id.id === ID.CodecID) cur.codec = String.fromCharCode(...b.subarray(p, e));
        else if (cur && id.id === ID.PixelWidth) cur.width = readUint(b, p, n);
        else if (cur && id.id === ID.PixelHeight) cur.height = readUint(b, p, n);
        else if (cur && id.id === ID.AlphaMode) cur.alphaMode = readUint(b, p, n);
        else if (cur && id.id === ID.DefaultDuration) cur.defaultDurationNs = readUint(b, p, n);
        else if (id.id === ID.Timecode) clusterTc = readUint(b, p, n);
        else if (id.id === ID.SimpleBlock || id.id === ID.Block) {
          const tn = readSize(b, p);
          if (tn) {
            const track = out.tracks.find((t) => t.number === tn.size);
            if (!track || track.type === 1) {
              const rel = (b[p + tn.len] << 8) | b[p + tn.len + 1];
              const signed = rel & 0x8000 ? rel - 0x10000 : rel;
              maxTs = Math.max(maxTs, clusterTc + signed);
              out.frames++;
            }
          }
        }
      }
      o = e;
    }
    return null;
  };
  const err = walk(0, bytes, 0);
  if (err) return { ...out, error: err };
  out.hasAudio = out.tracks.some((t) => t.type === 2);
  const durNs = rawDuration ? rawDuration * scale : 0;
  out.durationMs = Math.round(durNs / 1e6);
  const video = out.tracks.find((t) => t.type === 1);
  if (video && video.defaultDurationNs) out.fps = Math.round(1e9 / video.defaultDurationNs);
  else if (out.frames > 1 && maxTs) out.fps = Math.round(((out.frames - 1) * 1e9) / (maxTs * scale));
  if (!out.durationMs && out.frames && out.fps) out.durationMs = Math.round((out.frames * 1000) / out.fps);
  return out;
}

/* ---------------- GIF ---------------- */

/**
 * GIF: logical screen, frame count, delays (1/100 s units → ms) and the NETSCAPE loop count.
 * @param {Uint8Array} b
 * @returns {{ error?: string, width?: number, height?: number, frames?: number, durationMs?: number,
 *   minDelayMs?: number, loop?: number, bytes: number }}
 */
export function inspectGif(b) {
  const bytes = b.length;
  const sig = bytes >= 6 ? String.fromCharCode(b[0], b[1], b[2], b[3], b[4], b[5]) : '';
  if (sig !== 'GIF87a' && sig !== 'GIF89a') return { error: 'NOT_GIF', bytes };
  if (bytes < 13) return { error: 'TRUNCATED', bytes };
  const out = { bytes, width: b[6] | (b[7] << 8), height: b[8] | (b[9] << 8), frames: 0, durationMs: 0, minDelayMs: Infinity, loop: -1 };
  let o = 13;
  if (b[10] & 0x80) o += 3 * (1 << ((b[10] & 7) + 1));
  let delay = 0;
  const skipSub = () => {
    while (o < bytes) {
      const n = b[o++];
      if (n === 0) return true;
      o += n;
    }
    return false;
  };
  while (o < bytes) {
    const t = b[o++];
    if (t === 0x3b) break; // trailer
    if (t === 0x21) {
      const label = b[o++];
      if (label === 0xf9 && b[o] >= 4) {
        delay = (b[o + 2] | (b[o + 3] << 8)) * 10;
      } else if (label === 0xff && b[o] === 11 && String.fromCharCode(...b.subarray(o + 1, o + 12)) === 'NETSCAPE2.0' && b[o + 12] >= 3) {
        out.loop = b[o + 14] | (b[o + 15] << 8);
      }
      if (!skipSub()) return { ...out, error: 'TRUNCATED', minDelayMs: 0 };
    } else if (t === 0x2c) {
      if (o + 9 > bytes) return { ...out, error: 'TRUNCATED', minDelayMs: 0 };
      const packed = b[o + 8];
      o += 9;
      if (packed & 0x80) o += 3 * (1 << ((packed & 7) + 1));
      o++; // LZW minimum code size
      if (!skipSub()) return { ...out, error: 'TRUNCATED', minDelayMs: 0 };
      out.frames++;
      out.durationMs += delay;
      out.minDelayMs = Math.min(out.minDelayMs, delay);
      delay = 0;
    } else return { ...out, error: 'BAD_BLOCK', minDelayMs: 0 };
  }
  if (out.minDelayMs === Infinity) out.minDelayMs = 0;
  return out;
}

/* ---------------- MP4 (ISO BMFF) ---------------- */

const MP4_CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts']);

/**
 * MP4: brand, movie duration, and per track its handler (vide/soun), codec, size and sample count.
 * @param {Uint8Array} b
 * @returns {{ error?: string, brand?: string, durationMs?: number, tracks?: Array<{type: string, codec: string, width: number, height: number, samples: number, durationMs: number}>, hasAudio?: boolean, bytes: number }}
 */
export function inspectMp4(b) {
  const bytes = b.length;
  if (bytes < 16 || fourcc(b, 4) !== 'ftyp') return { error: 'NOT_MP4', bytes };
  const be32 = (o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const be64 = (o) => be32(o) * 4294967296 + be32(o + 4);
  const out = { bytes, brand: fourcc(b, 8), durationMs: 0, tracks: /** @type {any[]} */ ([]), hasAudio: false };
  let cur = null;
  let movieScale = 0;
  let movieDur = 0;
  let sawMoov = false;
  const walk = (start, end, depth) => {
    let o = start;
    while (o + 8 <= end) {
      let size = be32(o);
      const type = fourcc(b, o + 4);
      let head = 8;
      if (size === 1) {
        if (o + 16 > end) return 'TRUNCATED';
        size = be64(o + 8);
        head = 16;
      } else if (size === 0) size = end - o;
      if (size < head || o + size > end) return 'BAD_BOX:' + type;
      const p = o + head;
      const e = o + size;
      if (type === 'moov') sawMoov = true;
      if (type === 'trak') {
        cur = { type: '', codec: '', width: 0, height: 0, samples: 0, durationMs: 0 };
        out.tracks.push(cur);
      }
      if (MP4_CONTAINERS.has(type)) {
        const err = depth < 8 ? walk(p, e, depth + 1) : null;
        if (err) return err;
        if (type === 'trak') cur = null;
      } else if (type === 'mvhd') {
        const v = b[p];
        movieScale = v === 1 ? be32(p + 20) : be32(p + 12);
        movieDur = v === 1 ? be64(p + 24) : be32(p + 16);
      } else if (cur && type === 'tkhd') {
        const v = b[p];
        const wo = v === 1 ? p + 88 : p + 76;
        if (wo + 8 <= e) {
          cur.width = be32(wo) / 65536;
          cur.height = be32(wo + 4) / 65536;
        }
      } else if (cur && type === 'mdhd') {
        const v = b[p];
        const scale = v === 1 ? be32(p + 20) : be32(p + 12);
        const dur = v === 1 ? be64(p + 24) : be32(p + 16);
        if (scale) cur.durationMs = Math.round((dur * 1000) / scale);
      } else if (cur && type === 'hdlr') {
        cur.type = fourcc(b, p + 8);
      } else if (cur && type === 'stsd') {
        if (be32(p + 4) > 0 && p + 16 <= e) cur.codec = fourcc(b, p + 12);
      } else if (cur && type === 'stsz') {
        cur.samples = be32(p + 8);
      }
      o = e;
    }
    return null;
  };
  const err = walk(0, bytes, 0);
  if (err) return { ...out, error: err };
  if (!sawMoov) return { ...out, error: 'NO_MOOV' };
  if (movieScale) out.durationMs = Math.round((movieDur * 1000) / movieScale);
  out.hasAudio = out.tracks.some((t) => t.type === 'soun');
  return out;
}

/* ---------------- Lottie (TGS = gzipped Lottie JSON) ---------------- */

/**
 * The Lottie fields Telegram checks (the caller gunzips the TGS first).
 * @param {any} json
 * @returns {{ error?: string, width?: number, height?: number, fps?: number, frames?: number, durationMs?: number }}
 */
export function inspectLottie(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { error: 'NOT_LOTTIE' };
  const { w, h, fr, ip, op } = json;
  if (![w, h, fr, ip, op].every((v) => typeof v === 'number' && Number.isFinite(v)) || fr <= 0) return { error: 'NOT_LOTTIE' };
  const frames = Math.max(0, op - ip);
  return { width: w, height: h, fps: fr, frames, durationMs: Math.round((frames * 1000) / fr) };
}
