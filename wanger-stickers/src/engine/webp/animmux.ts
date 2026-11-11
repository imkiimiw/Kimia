// Animated WebP muxer (pure TypeScript, no dependencies).
//
// Input: one complete still WebP file per frame (e.g. from libwebp WASM), all the size of the
// canvas. Output: an animated WebP (VP8X + ANIM + ANMF frames) that loops forever, keeps alpha,
// and replaces the whole canvas on every frame (no blending, no disposal), so the FIRST frame is
// the complete sticker — what WhatsApp shows when the loop stops.
//
// Container spec: https://developers.google.com/speed/webp/docs/riff_container

export interface MuxFrame {
  webp: Uint8Array; // a still WebP file (RIFF/WEBP)
  durationMs: number; // >= 1; WhatsApp needs >= 8
}

const enc = new TextEncoder();

function fourcc(b: Uint8Array, o: number): string {
  return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
}
function u32(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}
function put24(b: Uint8Array, o: number, v: number): void {
  b[o] = v & 255;
  b[o + 1] = (v >> 8) & 255;
  b[o + 2] = (v >> 16) & 255;
}
function put32(b: Uint8Array, o: number, v: number): void {
  b[o] = v & 255;
  b[o + 1] = (v >> 8) & 255;
  b[o + 2] = (v >> 16) & 255;
  b[o + 3] = (v >>> 24) & 255;
}
function chunk(id: string, payload: Uint8Array): Uint8Array {
  const pad = payload.length & 1;
  const out = new Uint8Array(8 + payload.length + pad);
  out.set(enc.encode(id), 0);
  put32(out, 4, payload.length);
  out.set(payload, 8);
  return out;
}
function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** The image chunks (ALPH + VP8, or VP8L) of a still WebP, as raw chunk bytes. */
function imageChunks(webp: Uint8Array): { bytes: Uint8Array; alpha: boolean } {
  if (fourcc(webp, 0) !== 'RIFF' || fourcc(webp, 8) !== 'WEBP') throw new Error('frame is not a WebP file');
  const keep: Uint8Array[] = [];
  let alpha = false;
  let o = 12;
  while (o + 8 <= webp.length) {
    const id = fourcc(webp, o);
    const size = u32(webp, o + 4);
    const total = 8 + size + (size & 1);
    if (id === 'ALPH' || id === 'VP8 ' || id === 'VP8L') {
      keep.push(webp.subarray(o, o + total));
      if (id === 'ALPH') alpha = true;
      if (id === 'VP8L' && (u32(webp, o + 9) >> 28) & 1) alpha = true;
    }
    if (id === 'ANIM' || id === 'ANMF') throw new Error('frame is already animated');
    o += total;
  }
  if (!keep.length) throw new Error('frame has no image data');
  return { bytes: concat(keep), alpha };
}

export function muxAnimatedWebP(frames: MuxFrame[], width: number, height: number, loopCount = 0): Uint8Array<ArrayBuffer> {
  if (!frames.length) throw new Error('no frames');
  const parts: Uint8Array[] = [];
  let anyAlpha = false;
  const anmf: Uint8Array[] = [];
  for (const f of frames) {
    const img = imageChunks(f.webp);
    anyAlpha ||= img.alpha;
    const head = new Uint8Array(16);
    put24(head, 0, 0); // X offset / 2
    put24(head, 3, 0); // Y offset / 2
    put24(head, 6, width - 1);
    put24(head, 9, height - 1);
    put24(head, 12, Math.max(1, Math.min(0xffffff, Math.round(f.durationMs))));
    head[15] = 0b10; // do not blend; no disposal (every frame covers the whole canvas)
    anmf.push(chunk('ANMF', concat([head, img.bytes])));
  }
  const vp8x = new Uint8Array(10);
  vp8x[0] = 0x02 | (anyAlpha ? 0x10 : 0); // animation (+ alpha)
  put24(vp8x, 4, width - 1);
  put24(vp8x, 7, height - 1);
  const anim = new Uint8Array(6); // background 0,0,0,0 (transparent); loop count
  anim[4] = loopCount & 255;
  anim[5] = (loopCount >> 8) & 255;
  parts.push(chunk('VP8X', vp8x), chunk('ANIM', anim), ...anmf);
  const body = concat(parts);
  const out = new Uint8Array(12 + body.length);
  out.set(enc.encode('RIFF'), 0);
  put32(out, 4, 4 + body.length);
  out.set(enc.encode('WEBP'), 8);
  out.set(body, 12);
  return out;
}
