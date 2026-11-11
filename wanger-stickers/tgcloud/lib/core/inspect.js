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

/* ---------------- WebM (EBML) ---------------- */

const ID = {
  EBML: 0x1a45dfa3, DocType: 0x4282, Segment: 0x18538067, Info: 0x1549a966, TimecodeScale: 0x2ad7b1, Duration: 0x4489,
  Tracks: 0x1654ae6b, TrackEntry: 0xae, TrackType: 0x83, CodecID: 0x86, Video: 0xe0, PixelWidth: 0xb0, PixelHeight: 0xba,
  AlphaMode: 0x53c0, DefaultDuration: 0x23e383, Cluster: 0x1f43b675, SimpleBlock: 0xa3, BlockGroup: 0xa0, Block: 0xa1, Timecode: 0xe7,
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
        else if (cur && id.id === ID.CodecID) cur.codec = String.fromCharCode(...b.subarray(p, e));
        else if (cur && id.id === ID.PixelWidth) cur.width = readUint(b, p, n);
        else if (cur && id.id === ID.PixelHeight) cur.height = readUint(b, p, n);
        else if (cur && id.id === ID.AlphaMode) cur.alphaMode = readUint(b, p, n);
        else if (cur && id.id === ID.DefaultDuration) cur.defaultDurationNs = readUint(b, p, n);
        else if (id.id === ID.Timecode) clusterTc = readUint(b, p, n);
        else if (id.id === ID.SimpleBlock || id.id === ID.Block) {
          const tn = readSize(b, p);
          if (tn) {
            const rel = (b[p + tn.len] << 8) | b[p + tn.len + 1];
            const signed = rel & 0x8000 ? rel - 0x10000 : rel;
            maxTs = Math.max(maxTs, clusterTc + signed);
            out.frames++;
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
