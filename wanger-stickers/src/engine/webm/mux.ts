// Minimal WebM muxer for one VP9 video track, with optional alpha (pure TypeScript, no deps).
//
// WebM stores transparency as a SECOND VP9 bitstream that encodes the alpha plane as luma, carried
// next to each colour frame in BlockAdditions (BlockAddID 1) and flagged with AlphaMode = 1 on the
// track — the same layout libvpx/ffmpeg produce with `-pix_fmt yuva420p`. Browsers whose WebCodecs
// cannot encode alpha (Chromium today) can still produce it with two encoders: one for colour, one
// for the alpha plane. Sticker clips are tiny (<= 3 s, <= 256 KB), so everything is written with
// exact sizes into one Cluster; no Cues are needed for files this small.

export interface WebMFrame {
  data: Uint8Array; // VP9 frame (colour)
  alpha?: Uint8Array; // VP9 frame of the alpha plane
  timestampMs: number;
  key: boolean;
}

export interface WebMOptions {
  width: number;
  height: number;
  fps: number;
  alpha: boolean;
}

type El = Uint8Array;

function idBytes(id: number): Uint8Array {
  const out: number[] = [];
  let v = id;
  while (v > 0) {
    out.unshift(v & 255);
    v = Math.floor(v / 256);
  }
  return new Uint8Array(out);
}
function sizeBytes(n: number): Uint8Array {
  // 8-byte size field (always valid; files are tiny so the overhead is irrelevant)
  const out = new Uint8Array(8);
  out[0] = 0x01;
  let v = n;
  for (let i = 7; i >= 1; i--) {
    out[i] = v & 255;
    v = Math.floor(v / 256);
  }
  return out;
}
function cat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
function el(id: number, ...body: Uint8Array[]): El {
  const data = cat(body);
  return cat([idBytes(id), sizeBytes(data.length), data]);
}
function uint(id: number, v: number): El {
  const b: number[] = [];
  let x = v;
  do {
    b.unshift(x & 255);
    x = Math.floor(x / 256);
  } while (x > 0);
  return el(id, new Uint8Array(b));
}
function float(id: number, v: number): El {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, v);
  return el(id, b);
}
function str(id: number, s: string): El {
  return el(id, new TextEncoder().encode(s));
}

export function muxWebM(frames: WebMFrame[], o: WebMOptions): Uint8Array<ArrayBuffer> {
  if (!frames.length) throw new Error('no frames');
  if (!frames[0].key) throw new Error('first frame must be a keyframe');
  const frameMs = 1000 / o.fps;
  const durationMs = frames[frames.length - 1].timestampMs + frameMs;

  const header = el(0x1a45dfa3, uint(0x4286, 1), uint(0x42f7, 1), uint(0x42f2, 4), uint(0x42f3, 8), str(0x4282, 'webm'), uint(0x4287, 4), uint(0x4285, 2));
  const info = el(0x1549a966, uint(0x2ad7b1, 1_000_000), float(0x4489, durationMs), str(0x4d80, 'wanger-stickers'), str(0x5741, 'wanger-stickers'));
  const video = el(0xe0, uint(0xb0, o.width), uint(0xba, o.height), ...(o.alpha ? [uint(0x53c0, 1)] : []));
  const track = el(
    0xae,
    uint(0xd7, 1), // TrackNumber
    uint(0x73c5, 1), // TrackUID
    uint(0x83, 1), // TrackType video
    uint(0x9c, 0), // FlagLacing
    str(0x86, 'V_VP9'),
    uint(0x23e383, Math.round(1e9 / o.fps)), // DefaultDuration (ns)
    ...(o.alpha ? [uint(0x55ee, 1)] : []), // MaxBlockAdditionID = 1
    video,
  );
  const tracks = el(0x1654ae6b, track);

  const blocks: Uint8Array[] = [uint(0xe7, 0)]; // Cluster Timecode 0
  let prevRel = 0;
  for (const f of frames) {
    const rel = Math.round(f.timestampMs);
    if (rel > 32767) throw new Error('clip too long for one cluster');
    const prelude = new Uint8Array([0x81, (rel >> 8) & 255, rel & 255, 0]);
    if (o.alpha && f.alpha) {
      const block = el(0xa1, prelude, f.data);
      const more = el(0xa6, uint(0xee, 1), el(0xa5, f.alpha)); // BlockMore(BlockAddID 1, BlockAdditional)
      const parts = [block, el(0x75a1, more)];
      if (!f.key) {
        const d = (prevRel - rel) & 0xffff; // ReferenceBlock: signed offset to the previous frame → not a keyframe
        parts.push(el(0xfb, new Uint8Array([d >> 8, d & 255])));
      }
      blocks.push(el(0xa0, ...parts));
    } else {
      prelude[3] = f.key ? 0x80 : 0;
      blocks.push(el(0xa3, prelude, f.data)); // SimpleBlock
    }
    prevRel = rel;
  }
  const cluster = el(0x1f43b675, ...blocks);
  const segment = el(0x18538067, info, tracks, cluster);
  return cat([header, segment]);
}
