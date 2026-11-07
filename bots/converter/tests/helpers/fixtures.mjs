// Minimal sample files built in code (spec §12: no copyrighted fixtures). Each is just enough of the
// real format for the detector: headers, containers and markers, not playable/openable content.
const enc = new TextEncoder();
const bytes = (...parts) => {
  const arrs = parts.map((p) => (typeof p === 'string' ? enc.encode(p) : p instanceof Uint8Array ? p : new Uint8Array(p)));
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
};
const latin = (s) => Uint8Array.from([...s].map((c) => c.charCodeAt(0) & 255));
const u16le = (n) => [n & 255, (n >> 8) & 255];
const u32le = (n) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
const u32be = (n) => [(n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
const utf16 = (s) => [...s].flatMap((c) => [c.charCodeAt(0) & 255, c.charCodeAt(0) >> 8]);
const pad = (n, v = 0) => new Uint8Array(n).fill(v);

let CRC = null;
function crc32(d) {
  if (!CRC) { CRC = new Int32Array(256); for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC[i] = c; } }
  let c = -1;
  for (let i = 0; i < d.length; i++) c = CRC[(c ^ d[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** A STORED zip. entries: [[name, content, { encrypted?, symlink? }]] */
export function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content = '', opt = {}] of entries) {
    const data = typeof content === 'string' ? enc.encode(content) : content;
    const nameB = enc.encode(name);
    const crc = crc32(data);
    const flags = 0x800 | (opt.encrypted ? 1 : 0);
    const local = bytes([0x50, 0x4b, 0x03, 0x04], u16le(20), u16le(flags), u16le(0), u16le(0), u16le(0), u32le(crc), u32le(data.length), u32le(data.length), u16le(nameB.length), u16le(0), nameB, data);
    const extAttr = opt.symlink ? (0xa1ff << 16) >>> 0 : 0;
    central.push(bytes([0x50, 0x4b, 0x01, 0x02], [20, opt.symlink ? 3 : 0], u16le(20), u16le(flags), u16le(0), u16le(0), u16le(0), u32le(crc), u32le(data.length), u32le(data.length), u16le(nameB.length), u16le(0), u16le(0), u16le(0), u16le(0), u32le(extAttr), u32le(offset), nameB));
    locals.push(local);
    offset += local.length;
  }
  const cd = bytes(...central);
  const eocd = bytes([0x50, 0x4b, 0x05, 0x06], u16le(0), u16le(0), u16le(entries.length), u16le(entries.length), u32le(cd.length), u32le(offset), u16le(0));
  return bytes(...locals, cd, eocd);
}

const box = (type, ...content) => { const body = bytes(...content); return bytes(u32be(8 + body.length), type, body); };
const ftyp = (major, ...compat) => box('ftyp', major, u32be(0), ...compat);
const hdlr = (handler) => box('hdlr', pad(8), handler, pad(12));
const trak = (handler) => box('trak', box('mdia', hdlr(handler)));

const oggPage = (packet) => bytes('OggS', [0, 2], pad(8), pad(4), pad(4), pad(4), [1, packet.length], packet);

export function ebml(docType) {
  return bytes([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, 0x01, 0x42, 0x82, 0x80 | docType.length], docType, [0x42, 0x87, 0x81, 0x04], pad(32));
}

function tarHeader(name) {
  const h = pad(512);
  h.set(enc.encode(name), 0);
  h.set(enc.encode('0000644\0'), 100);
  h.set(enc.encode('00000000004\0'), 124);
  h.set(enc.encode('ustar\x0000'), 257);
  return bytes(h, 'data', pad(508), pad(1024));
}

const jpeg = () => bytes([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10], 'JFIF\0', [1, 1, 0, 0, 1, 0, 1, 0, 0], [0xff, 0xd9]);
const pe = () => { const b = pad(256); b.set(latin('MZ'), 0); b.set(u32le(0x80), 0x3c); b.set(latin('PE\0\0'), 0x80); return b; };
const ole = (...streams) => bytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], pad(504), ...streams.map((s) => (Array.isArray(s) ? s : utf16(s))), pad(64));

/** name → [bytes, suggested file name] for every format the spec lists (§5, §6). */
export const SAMPLES = {
  jpeg: [jpeg(), 'a.jpg'],
  png: [bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], u32be(13), 'IHDR', u32be(1), u32be(1), [8, 2, 0, 0, 0], pad(4)), 'a.png'],
  gif: [bytes('GIF89a', [1, 0, 1, 0, 0, 0, 0], ';'), 'a.gif'],
  webp: [bytes('RIFF', u32le(20), 'WEBPVP8 ', u32le(8), pad(8)), 'a.webp'],
  bmp: [bytes('BM', u32le(30), [0, 0, 0, 0], u32le(26), u32le(12), pad(12)), 'a.bmp'],
  tiff: [bytes([0x49, 0x49, 0x2a, 0x00], u32le(8), pad(8)), 'a.tif'],
  ico: [bytes([0, 0, 1, 0, 1, 0], [16, 16, 0, 0, 1, 0, 32, 0], u32le(40), u32le(22), pad(40)), 'a.ico'],
  avif: [bytes(ftyp('avif', 'mif1', 'miaf'), pad(16)), 'a.avif'],
  heic: [bytes(ftyp('heic', 'mif1', 'heic'), pad(16)), 'a.heic'],
  psd: [bytes('8BPS', [0, 1], pad(20)), 'a.psd'],
  svg: [enc.encode('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>'), 'a.svg'],
  pdf: [enc.encode('%PDF-1.7\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n'), 'a.pdf'],
  docx: [zip([['[Content_Types].xml', '<Types/>'], ['word/document.xml', '<w:document/>']]), 'a.docx'],
  xlsx: [zip([['[Content_Types].xml', '<Types/>'], ['xl/workbook.xml', '<workbook/>']]), 'a.xlsx'],
  pptx: [zip([['[Content_Types].xml', '<Types/>'], ['ppt/presentation.xml', '<p/>']]), 'a.pptx'],
  docm: [zip([['[Content_Types].xml', '<Types/>'], ['word/document.xml', '<w/>'], ['word/vbaProject.bin', 'VBA']]), 'a.docm'],
  xlsm: [zip([['[Content_Types].xml', '<Types/>'], ['xl/workbook.xml', '<w/>'], ['xl/vbaProject.bin', 'VBA']]), 'a.xlsm'],
  pptm: [zip([['[Content_Types].xml', '<Types/>'], ['ppt/presentation.xml', '<p/>'], ['ppt/vbaProject.bin', 'VBA']]), 'a.pptm'],
  odt: [zip([['mimetype', 'application/vnd.oasis.opendocument.text'], ['content.xml', '<x/>'], ['META-INF/manifest.xml', '<m/>']]), 'a.odt'],
  ods: [zip([['mimetype', 'application/vnd.oasis.opendocument.spreadsheet'], ['content.xml', '<x/>']]), 'a.ods'],
  odp: [zip([['mimetype', 'application/vnd.oasis.opendocument.presentation'], ['content.xml', '<x/>']]), 'a.odp'],
  epub: [zip([['mimetype', 'application/epub+zip'], ['META-INF/container.xml', '<c/>']]), 'a.epub'],
  apk: [zip([['AndroidManifest.xml', 'x'], ['classes.dex', 'dex\n035']]), 'a.apk'],
  jar: [zip([['META-INF/MANIFEST.MF', 'Manifest-Version: 1.0\n'], ['a/Main.class', 'x']]), 'a.jar'],
  zip: [zip([['readme.txt', 'hello'], ['dir/b.txt', 'b']]), 'a.zip'],
  doc: [ole('Root Entry', 'WordDocument'), 'a.doc'],
  xls: [ole('Root Entry', 'Workbook'), 'a.xls'],
  ppt: [ole('Root Entry', 'PowerPoint Document'), 'a.ppt'],
  ole_macro: [ole('Root Entry', 'WordDocument', 'Macros', '_VBA_PROJECT'), 'a.doc'],
  msi: [ole([0x84, 0x10, 0x0c, 0x00, 0x00, 0x00, 0x00, 0x00, 0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46]), 'setup.msi'],
  rtf: [enc.encode('{\\rtf1\\ansi Hello}'), 'a.rtf'],
  text: [enc.encode('سلام دنیا\nhello world\n'), 'a.txt'],
  html: [enc.encode('<!DOCTYPE html><html><body>hi</body></html>'), 'a.html'],
  xml: [enc.encode('<?xml version="1.0"?><root/>'), 'a.xml'],
  json: [enc.encode('{"a": [1, 2, "سلام"]}'), 'a.json'],
  vtt: [enc.encode('WEBVTT\n\n00:00.000 --> 00:01.000\nhi\n'), 'a.vtt'],
  srt: [enc.encode('1\n00:00:01,000 --> 00:00:02,000\nسلام\n'), 'a.srt'],
  tar: [tarHeader('a.txt'), 'a.tar'],
  gzip: [bytes([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 3], pad(10)), 'a.tar.gz'],
  bz2: [bytes('BZh91AY&SY', pad(10)), 'a.bz2'],
  xz: [bytes([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00], pad(10)), 'a.xz'],
  zstd: [bytes([0x28, 0xb5, 0x2f, 0xfd], pad(10)), 'a.zst'],
  '7z': [bytes([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4], pad(24)), 'a.7z'],
  rar: [bytes(latin('Rar!\x1a\x07\x01\x00'), pad(16)), 'a.rar'],
  mp3: [bytes('ID3', [4, 0, 0, 0, 0, 0, 0], [0xff, 0xfb, 0x90, 0x00], pad(32)), 'a.mp3'],
  mp3_raw: [bytes([0xff, 0xfb, 0x90, 0x64], pad(400)), 'a.mp3'],
  aac: [bytes([0xff, 0xf1, 0x50, 0x80], pad(32)), 'a.aac'],
  m4a: [bytes(ftyp('M4A ', 'M4A ', 'mp42', 'isom'), pad(16)), 'a.m4a'],
  m4a_tracks: [bytes(ftyp('isom', 'isom', 'mp42'), box('moov', trak('soun'))), 'a.mp4'],
  wav: [bytes('RIFF', u32le(36), 'WAVEfmt ', u32le(16), pad(16)), 'a.wav'],
  flac: [bytes('fLaC', pad(38)), 'a.flac'],
  opus: [bytes(oggPage(bytes('OpusHead', [1, 2], pad(10))), pad(8)), 'a.opus'],
  vorbis: [bytes(oggPage(bytes([1], 'vorbis', pad(22))), pad(8)), 'a.ogg'],
  amr: [bytes('#!AMR\n', pad(16)), 'a.amr'],
  midi: [bytes('MThd', u32be(6), [0, 0, 0, 1, 0, 96]), 'a.mid'],
  mp4: [bytes(ftyp('isom', 'isom', 'avc1'), box('moov', trak('vide'), trak('soun'))), 'a.mp4'],
  mov: [bytes(ftyp('qt  ', 'qt  '), pad(16)), 'a.mov'],
  webm: [ebml('webm'), 'a.webm'],
  mkv: [ebml('matroska'), 'a.mkv'],
  avi: [bytes('RIFF', u32le(36), 'AVI LIST', pad(24)), 'a.avi'],
  '3gp': [bytes(ftyp('3gp4', '3gp4', 'isom'), pad(16)), 'a.3gp'],
  ogv: [bytes(oggPage(bytes([0x80], 'theora', pad(30))), pad(8)), 'a.ogv'],
  flv: [bytes('FLV', [1, 5, 0, 0, 0, 9], pad(8)), 'a.flv'],
  asf: [bytes([0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11], pad(24)), 'a.wmv'],
  woff: [bytes('wOFF', pad(40)), 'a.woff'],
  woff2: [bytes('wOF2', pad(40)), 'a.woff2'],
  otf: [bytes('OTTO', pad(40)), 'a.otf'],
  sqlite: [bytes(latin('SQLite format 3\0'), pad(84)), 'a.sqlite'],
  exe: [pe(), 'a.exe'],
  elf: [bytes([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], pad(57)), 'a'],
  macho: [bytes([0xcf, 0xfa, 0xed, 0xfe], pad(28)), 'a'],
  macho_fat: [bytes([0xca, 0xfe, 0xba, 0xbe], u32be(2), pad(40)), 'a'],
  javaclass: [bytes([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 0x34], pad(16)), 'A.class'],
  dex: [bytes('dex\n035\0', pad(100)), 'classes.dex'],
  lnk: [bytes([0x4c, 0, 0, 0, 1, 0x14, 2, 0], pad(68)), 'a.lnk'],
  script: [enc.encode('#!/bin/sh\necho hi\n'), 'run.sh'],
  script_ext: [enc.encode('@echo off\r\necho hi\r\n'), 'run.bat'],
  empty: [new Uint8Array(0), 'empty.txt'],
  unknown: [bytes([0x00, 0x13, 0x37, 0x42, 0x99, 0x01, 0x02, 0x03], pad(100, 7)), 'mystery.dat'],
};

/** A JPEG with a ZIP appended (a classic polyglot). */
export const polyglotJpegZip = () => bytes(jpeg(), zip([['evil.js', 'alert(1)']]));
/** A Windows executable named like a photo. */
export const exeAsJpg = () => [pe(), 'holiday.jpg'];

export { bytes, crc32 };
