// Builders for audio files with an embedded cover picture (tests of music/artwork.js and of the
// cover in channel posts). Only the parts the reader looks at are real; the "audio" is filler.

const enc = (s) => new TextEncoder().encode(s);
const cat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const be = (n, bytes) => Uint8Array.from({ length: bytes }, (_, i) => Math.floor(n / 2 ** (8 * (bytes - 1 - i))) & 0xff);
const syncsafe = (n) => Uint8Array.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);

/** A JPEG with a frame header saying width × height, padded to about `size` bytes. */
export function jpeg(width, height, size = 2000) {
  const app0 = cat([0xff, 0xe0], be(16, 2), enc('JFIF\0'), [1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const sof = cat([0xff, 0xc0], be(17, 2), [8], be(height, 2), be(width, 2), [3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  const head = cat([0xff, 0xd8], app0, sof, [0xff, 0xda, 0, 2]);
  return cat(head, new Uint8Array(Math.max(0, size - head.length - 2)).fill(0x55), [0xff, 0xd9]);
}

/** A PNG whose IHDR says width × height. */
export function png(width, height, size = 2000) {
  const head = cat([0x89], enc('PNG\r\n\x1a\n'), be(13, 4), enc('IHDR'), be(width, 4), be(height, 4), [8, 2, 0, 0, 0], be(0, 4));
  return cat(head, new Uint8Array(Math.max(0, size - head.length)).fill(0x33));
}

/** Some MPEG audio frames (no tag). */
export const mp3Audio = (n = 4096) => Uint8Array.from({ length: n }, (_, i) => [0xff, 0xfb, 0x90, 0x64][i % 4]);

/**
 * An MP3 with an ID3v2 tag: a title frame, then the pictures, then padding, then audio.
 * @param {{type?: number, bytes: Uint8Array, desc?: string, utf16?: boolean}[]} pictures
 * @param {{version?: 2|3|4, audio?: number, padding?: number}} [o]
 */
export function mp3WithCover(pictures, { version = 3, audio = 50000, padding = 64 } = {}) {
  const size = (n) => (version === 4 ? syncsafe(n) : be(n, version === 2 ? 3 : 4));
  const frame = (id, body) => (version === 2 ? cat(enc(id), size(body.length), body) : cat(enc(id), size(body.length), [0, 0], body));
  const text = frame(version === 2 ? 'TT2' : 'TIT2', cat([3], enc('Song')));
  const pics = pictures.map((p) => {
    const desc = p.utf16 ? cat([0xff, 0xfe], ...[...(p.desc || 'Cover')].map((c) => [c.charCodeAt(0), 0]).map((x) => Uint8Array.from(x)), [0, 0]) : cat(enc(p.desc || ''), [0]);
    const mime = p.bytes[0] === 0x89 ? 'image/png' : 'image/jpeg';
    const body = version === 2
      ? cat([p.utf16 ? 1 : 0], enc(mime === 'image/png' ? 'PNG' : 'JPG'), [p.type ?? 3], desc, p.bytes)
      : cat([p.utf16 ? 1 : 0], enc(mime), [0], [p.type ?? 3], desc, p.bytes);
    return frame(version === 2 ? 'PIC' : 'APIC', body);
  });
  const tag = cat(text, ...pics, new Uint8Array(padding));
  return cat(enc('ID3'), [version, 0, 0], syncsafe(tag.length), tag, mp3Audio(audio));
}

/** A FLAC file: STREAMINFO, a PICTURE block, then frames. */
export function flacWithCover(picture, { type = 3 } = {}) {
  const block = (t, body, last) => cat([(last ? 0x80 : 0) | t], be(body.length, 3), body);
  const mime = enc(picture[0] === 0x89 ? 'image/png' : 'image/jpeg');
  const pic = cat(be(type, 4), be(mime.length, 4), mime, be(0, 4), be(0, 4), be(0, 4), be(24, 4), be(0, 4), be(picture.length, 4), picture);
  return cat(enc('fLaC'), block(0, new Uint8Array(34), false), block(6, pic, true), new Uint8Array(30000).fill(0xff));
}

/** An M4A: ftyp, moov (udta › meta › ilst › covr › data), mdat — or mdat before moov. */
export function m4aWithCover(picture, { moovFirst = true } = {}) {
  const box = (type, ...body) => { const b = cat(...body); return cat(be(8 + b.length, 4), enc(type), b); };
  const data = box('data', be(picture[0] === 0x89 ? 14 : 13, 4), be(0, 4), picture);
  const moov = box('moov', box('mvhd', new Uint8Array(100)), box('udta', box('meta', be(0, 4), box('hdlr', new Uint8Array(25)), box('ilst', box('covr', data)))));
  const ftyp = box('ftyp', enc('M4A '), be(0, 4), enc('M4A mp42isom'));
  const mdat = box('mdat', new Uint8Array(40000).fill(0x11));
  return moovFirst ? cat(ftyp, moov, mdat) : cat(ftyp, mdat, moov);
}

/** The bytes as an async stream of chunks, counting how much was read. */
export function chunked(bytes, size = 65536) {
  const stats = { read: 0 };
  const body = (async function* () {
    for (let o = 0; o < bytes.length; o += size) {
      const c = bytes.subarray(o, o + size);
      stats.read += c.length;
      yield c;
    }
  })();
  return { body, stats };
}
