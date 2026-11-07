// C0 spike benchmarks — pure code shared by the local runner (spikes/local.mjs) and the temporary
// Serverless endpoint (spikes/endpoints/zz_lib.js). Never deployed: scripts/spike.mjs copies it into
// tgcloud/ only for one `tgcloud run` and deletes it again.
//
// On Serverless `Date.now()` does not advance during synchronous work, only across I/O, so every
// step is timed as: work → `await env.now()` (which performs a tiny I/O first) → difference.
import { zipSync, unzipSync, gzipSync, gunzipSync, zlibSync } from './vendor/fflate.js';
import { PDFDocument, degrees } from './vendor/pdf-lib.js';

const MB = 1024 * 1024;

let CRC_TABLE = null;
export function crc32(d) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[i] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < d.length; i++) c = CRC_TABLE[(c ^ d[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// A 64×64 baseline JPEG (1 701 bytes), made with Pillow; padded with random bytes after EOI to
// reach a realistic size (pdf-lib copies JPEG bytes as-is, it never decodes them).
const TINY_JPEG_B64 = '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';

function b64decode(s) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const map = new Uint8Array(128);
  for (let i = 0; i < A.length; i++) map[A.charCodeAt(i)] = i;
  const clean = s.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = map[clean.charCodeAt(i)], b = map[clean.charCodeAt(i + 1)];
    const c = map[clean.charCodeAt(i + 2)] || 0, d = map[clean.charCodeAt(i + 3)] || 0;
    const n = (a << 18) | (b << 12) | (c << 6) | d;
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

export function timer(env) {
  const steps = [];
  let last = null;
  return {
    steps,
    async start() { last = await env.now(); },
    async lap(name, extra = {}) {
      const t = await env.now();
      steps.push({ step: name, ms: Math.round(t - last), ...extra });
      last = await env.now(); // the lap's own I/O is not charged to the next step
    },
  };
}

export function randomBytes(n) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(out.subarray(i, Math.min(n, i + 65536)));
  return out;
}

// Text-like, compressible bytes (mixed Persian / English words, LCG-chosen).
export function textBytes(n) {
  const words = ['سلام', 'فایل', 'تبدیل', 'ربات', 'تصویر', 'متن', 'hello', 'world', 'file', 'convert',
    'telegram', 'pdf', 'zip', 'image', 'data', '۱۲۳', '2026', 'Wanger', 'سند', 'صفحه'];
  const enc = new TextEncoder();
  const wb = words.map((w) => enc.encode(w + ' '));
  const out = new Uint8Array(n);
  let o = 0, x = 12345;
  while (o < n) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    const w = wb[(x >>> 16) % wb.length];
    const len = Math.min(w.length, n - o);
    out.set(len === w.length ? w : w.subarray(0, len), o);
    o += len;
    if ((x & 63) === 0 && o < n) out[o++] = 10;
  }
  return out;
}

function paddedJpeg(size) {
  const jpg = b64decode(TINY_JPEG_B64);
  const out = randomBytes(size);
  out.set(jpg, 0);
  return out;
}

// A real PNG (RGB, filter 0 per row) built with fflate's zlib: gradient + a little noise.
export function makePng(w, h) {
  const raw = new Uint8Array((w * 3 + 1) * h);
  let x = 7;
  for (let y = 0; y < h; y++) {
    let p = y * (w * 3 + 1);
    raw[p++] = 0;
    for (let i = 0; i < w; i++) {
      x = (Math.imul(x, 1103515245) + 12345) >>> 0;
      const n = (x >>> 28) & 15;
      raw[p++] = (i + n) & 255; raw[p++] = (y + n) & 255; raw[p++] = ((i ^ y) + n) & 255;
    }
  }
  const idat = zlibSync(raw, { level: 6 });
  const chunks = [];
  const chunk = (type, data) => {
    const len = new Uint8Array(4); new DataView(len.buffer).setUint32(0, data.length);
    const td = new Uint8Array(4 + data.length);
    for (let i = 0; i < 4; i++) td[i] = type.charCodeAt(i);
    td.set(data, 4);
    const crc = new Uint8Array(4); new DataView(crc.buffer).setUint32(0, crc32(td) >>> 0);
    chunks.push(len, td, crc);
  };
  const ihdr = new Uint8Array(13); const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  chunks.push(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
  chunk('IHDR', ihdr); chunk('IDAT', idat); chunk('IEND', new Uint8Array(0));
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total); let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

// pdf-lib's waitForTick() needs setTimeout (absent on Serverless): load needs parseSpeed: Infinity
// (ParseSpeeds.Fastest), save needs objectsPerTick: Infinity. useObjectStreams (pdf-lib's default
// true) is pathological: a full re-save of a 127k-object PDF ran out of the 3 s CPU budget.
const LOAD = { parseSpeed: Infinity, updateMetadata: false, ignoreEncryption: true };
const SAVE = { objectsPerTick: Infinity, useObjectStreams: false };

async function imagePdf(totalBytes, pages) {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const per = Math.floor(totalBytes / pages);
  for (let i = 0; i < pages; i++) {
    const img = await doc.embedJpg(paddedJpeg(per));
    const page = doc.addPage([595, 842]);
    page.drawImage(img, { x: 20, y: 20, width: 555, height: 555 });
  }
  return doc;
}

// One case per invocation (the CPU budget is per invocation). `input` = { case, mb, url, ... }.
export async function runCase(input, env) {
  const t = timer(env);
  const mb = input.mb || 15;
  const n = Math.round(mb * MB);
  await t.start();
  switch (input.case) {
    case 'gen_text': { const d = textBytes(n); await t.lap('gen_text', { bytes: d.length }); break; }
    case 'gen_random': { const d = randomBytes(n); await t.lap('gen_random', { bytes: d.length }); break; }
    case 'zip_store': {
      const d = textBytes(n); await t.lap('gen_text');
      const z = zipSync({ 'a.txt': [d, { level: 0 }] }); await t.lap('zip_store', { out: z.length });
      const u = unzipSync(z); await t.lap('unzip_store', { ok: u['a.txt'].length === n });
      break;
    }
    case 'zip_deflate': {
      const level = input.level ?? 6;
      const d = input.random ? randomBytes(n) : textBytes(n); await t.lap(input.random ? 'gen_random' : 'gen_text');
      const z = zipSync({ 'a.txt': [d, { level }] }); await t.lap(`zip_deflate_l${level}`, { out: z.length });
      let seen = null;
      unzipSync(z, { filter: (f) => { seen = { name: f.name, size: f.size, originalSize: f.originalSize }; return false; } });
      await t.lap('zip_index_only', { entry: seen });
      const u = unzipSync(z); await t.lap('unzip_inflate', { ok: u['a.txt'].length === n });
      break;
    }
    case 'zip_many': {
      const count = input.count || 1000;
      const per = Math.floor(n / count);
      const base = textBytes(per * 2);
      const files = {};
      for (let i = 0; i < count; i++) files[`dir/file-${i}.txt`] = base.subarray(i % per, (i % per) + per);
      await t.lap('gen');
      const z = zipSync(files, { level: input.level ?? 6 }); await t.lap(`zip_${count}_files`, { out: z.length });
      let entries = 0; unzipSync(z, { filter: () => { entries++; return false; } }); await t.lap('index_only', { entries });
      const u = unzipSync(z); await t.lap('unzip_all', { files: Object.keys(u).length });
      break;
    }
    case 'gzip': {
      const d = textBytes(n); await t.lap('gen_text');
      const g = gzipSync(d, { level: 6 }); await t.lap('gzip_l6', { out: g.length });
      const u = gunzipSync(g); await t.lap('gunzip', { ok: u.length === n });
      break;
    }
    case 'crc32': {
      const d = textBytes(n); await t.lap('gen_text');
      const c = crc32(d); await t.lap('crc32', { crc: c >>> 0 });
      break;
    }
    case 'pdf_load': {
      // `input.bytes` (local) or fetched from `input.url` by the caller and passed as env.bytes.
      const bytes = env.bytes; await t.lap('input', { bytes: bytes.length });
      const doc = await PDFDocument.load(bytes, LOAD); await t.lap('pdf_load', { pages: doc.getPageCount() });
      if (input.then === 'split') {
        const out = await PDFDocument.create({ updateMetadata: false });
        const take = Math.min(input.pages || 10, doc.getPageCount());
        const copied = await out.copyPages(doc, [...Array(take).keys()]);
        copied.forEach((p) => out.addPage(p)); await t.lap(`copy_${take}_pages`);
        const saved = await out.save({ ...SAVE, useObjectStreams: false }); await t.lap('save_split', { out: saved.length });
      } else if (input.then === 'rotate') {
        doc.getPages().forEach((p) => p.setRotation(degrees(90))); await t.lap('rotate_all');
        const saved = await doc.save({ ...SAVE, useObjectStreams: input.objstm !== false }); await t.lap('save_full', { out: saved.length });
      }
      break;
    }
    case 'pdf_images': {
      // JPG → PDF: `pages` padded JPEGs totalling `mb`.
      const doc = await imagePdf(n, input.pages || 30); await t.lap('embed_jpgs', { pages: doc.getPageCount() });
      const saved = await doc.save(SAVE); await t.lap('save', { out: saved.length });
      if (input.then === 'ops') {
        const a = await PDFDocument.load(saved, LOAD); await t.lap('load_image_pdf');
        const merged = await PDFDocument.create({ updateMetadata: false });
        for (const src of [a, a]) {
          const ps = await merged.copyPages(src, src.getPageIndices());
          ps.forEach((p) => merged.addPage(p));
        }
        await t.lap('merge_x2', { pages: merged.getPageCount() });
        merged.getPages().forEach((p, i) => i % 2 && p.setRotation(degrees(180)));
        const m = await merged.save(SAVE); await t.lap('save_merged', { out: m.length });
        const part = await PDFDocument.create({ updateMetadata: false });
        (await part.copyPages(a, [0, 2, 4, 6, 8])).forEach((p) => part.addPage(p));
        const s = await part.save(SAVE); await t.lap('split_5_pages', { out: s.length });
      }
      break;
    }
    case 'pdf_png': {
      const w = input.w || 2000, h = input.h || 1500;
      const png = makePng(w, h); await t.lap('make_png', { bytes: png.length });
      const doc = await PDFDocument.create({ updateMetadata: false });
      const img = await doc.embedPng(png); await t.lap('embed_png');
      doc.addPage([w, h]).drawImage(img, { x: 0, y: 0, width: w, height: h });
      const saved = await doc.save(SAVE); await t.lap('save', { out: saved.length });
      break;
    }
    case 'cpu': {
      // Same spin as zz_core's cpu case: compare where each module is stopped, to see the CPU cost
      // of importing the vendored libraries.
      const slice = input.slice || 5e7;
      let x = 1, done = 0;
      const t0 = await env.now();
      for (;;) {
        for (let i = 0; i < slice; i++) x = (Math.imul(x, 1103515245) + 12345) | 0;
        done += slice;
        console.log(JSON.stringify({ done, elapsed_ms: (await env.now()) - t0, x }));
      }
    }
    default: throw new Error(`unknown case ${input.case}`);
  }
  return t.steps;
}
