/*
 * Bytes and files without libraries (Phase 9): CRC-32 and Adler-32, DEFLATE (inflate and a real
 * compressor with LZ77 and dynamic Huffman codes), zlib wrappers, base64, and the PDF check — what a
 * PDF can do when it is opened (JavaScript, automatic actions, launching programs, embedded files,
 * forms that send data, links), read from its raw bytes and its compressed streams; and (Phase 10)
 * SHA-256 for the audit log's seals. Pure.
 */

/* ---------- checksums ---------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes, start = 0, end = bytes.length, crc = 0) {
  let c = (crc ^ 0xFFFFFFFF) >>> 0;
  for (let i = start; i < end; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

export function adler32(bytes) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length;) {
    const end = Math.min(bytes.length, i + 3800);
    for (; i < end; i += 1) {
      a += bytes[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/* A growable byte buffer. */
export class Bytes {
  constructor(size = 1024) {
    this.buf = new Uint8Array(size);
    this.len = 0;
  }
  ensure(n) {
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    const b = new Uint8Array(size);
    b.set(this.buf.subarray(0, this.len));
    this.buf = b;
  }
  byte(v) {
    this.ensure(1);
    this.buf[this.len] = v;
    this.len += 1;
  }
  bytes(arr) {
    this.ensure(arr.length);
    this.buf.set(arr, this.len);
    this.len += arr.length;
  }
  u16le(v) {
    this.byte(v & 255);
    this.byte((v >>> 8) & 255);
  }
  u32be(v) {
    this.byte((v >>> 24) & 255);
    this.byte((v >>> 16) & 255);
    this.byte((v >>> 8) & 255);
    this.byte(v & 255);
  }
  ascii(s) {
    for (let i = 0; i < s.length; i += 1) this.byte(s.charCodeAt(i) & 255);
  }
  done() {
    return this.buf.slice(0, this.len);
  }
}

/* ---------- inflate (RFC 1951) ---------- */

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/* A decoding table: for every code length, the symbols in canonical order. */
function huffTable(lengths) {
  const count = new Uint16Array(16);
  for (const l of lengths) count[l] += 1;
  count[0] = 0;
  const offs = new Uint16Array(16);
  for (let i = 1; i < 16; i += 1) offs[i] = offs[i - 1] + count[i - 1];
  const symbols = new Uint16Array(lengths.length);
  for (let s = 0; s < lengths.length; s += 1) if (lengths[s]) symbols[offs[lengths[s]]++] = s;
  return { count, symbols };
}

/*
 * Inflates raw DEFLATE data. max: the most output allowed (a bomb stops there). Gives
 * { data, end } (end: where the compressed data stopped) or throws on corrupt data.
 */
export function inflateRaw(src, { start = 0, max = 64 * 1024 * 1024 } = {}) {
  let pos = start;
  let bitBuf = 0;
  let bitCnt = 0;
  const out = new Bytes(Math.min(max, Math.max(1024, (src.length - start) * 4)));
  const need = (n) => {
    while (bitCnt < n) {
      if (pos >= src.length) throw new Error('inflate: unexpected end');
      bitBuf |= src[pos++] << bitCnt;
      bitCnt += 8;
    }
  };
  const bits = (n) => {
    if (!n) return 0;
    need(n);
    const v = bitBuf & ((1 << n) - 1);
    bitBuf >>>= n;
    bitCnt -= n;
    return v;
  };
  const decode = (h) => {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len < 16; len += 1) {
      code |= bits(1);
      const c = h.count[len];
      if (code - c < first) return h.symbols[index + (code - first)];
      index += c;
      first = (first + c) << 1;
      code <<= 1;
    }
    throw new Error('inflate: bad code');
  };
  let fixedLit = null;
  let fixedDist = null;
  let last = 0;
  while (!last) {
    last = bits(1);
    const type = bits(2);
    if (type === 0) {
      bitBuf = 0;
      bitCnt = 0;
      if (pos + 4 > src.length) throw new Error('inflate: unexpected end');
      const len = src[pos] | (src[pos + 1] << 8);
      const nlen = src[pos + 2] | (src[pos + 3] << 8);
      if ((len ^ 0xFFFF) !== nlen) throw new Error('inflate: bad stored block');
      pos += 4;
      if (pos + len > src.length) throw new Error('inflate: unexpected end');
      if (out.len + len > max) throw new Error('inflate: too large');
      out.bytes(src.subarray(pos, pos + len));
      pos += len;
      continue;
    }
    let lit;
    let dist;
    if (type === 1) {
      if (!fixedLit) {
        const l = new Uint8Array(288);
        l.fill(8, 0, 144);
        l.fill(9, 144, 256);
        l.fill(7, 256, 280);
        l.fill(8, 280, 288);
        fixedLit = huffTable(l);
        fixedDist = huffTable(new Uint8Array(30).fill(5));
      }
      lit = fixedLit;
      dist = fixedDist;
    } else if (type === 2) {
      const hlit = bits(5) + 257;
      const hdist = bits(5) + 1;
      const hclen = bits(4) + 4;
      const cl = new Uint8Array(19);
      for (let i = 0; i < hclen; i += 1) cl[CL_ORDER[i]] = bits(3);
      const clh = huffTable(cl);
      const lens = new Uint8Array(hlit + hdist);
      for (let i = 0; i < hlit + hdist;) {
        const sym = decode(clh);
        if (sym < 16) lens[i++] = sym;
        else {
          let rep;
          let val = 0;
          if (sym === 16) {
            if (!i) throw new Error('inflate: bad repeat');
            val = lens[i - 1];
            rep = 3 + bits(2);
          } else if (sym === 17) rep = 3 + bits(3);
          else rep = 11 + bits(7);
          if (i + rep > hlit + hdist) throw new Error('inflate: bad lengths');
          lens.fill(val, i, i + rep);
          i += rep;
        }
      }
      lit = huffTable(lens.subarray(0, hlit));
      dist = huffTable(lens.subarray(hlit));
    } else throw new Error('inflate: bad block type');
    for (;;) {
      const sym = decode(lit);
      if (sym < 256) {
        if (out.len >= max) throw new Error('inflate: too large');
        out.byte(sym);
      } else if (sym === 256) break;
      else {
        const li = sym - 257;
        if (li >= 29) throw new Error('inflate: bad length');
        const len = LEN_BASE[li] + bits(LEN_EXTRA[li]);
        const di = decode(dist);
        if (di >= 30) throw new Error('inflate: bad distance');
        const d = DIST_BASE[di] + bits(DIST_EXTRA[di]);
        if (d > out.len) throw new Error('inflate: distance too far');
        if (out.len + len > max) throw new Error('inflate: too large');
        out.ensure(len);
        const b = out.buf;
        let o = out.len;
        for (let k = 0; k < len; k += 1, o += 1) b[o] = b[o - d];
        out.len = o;
      }
    }
  }
  return { data: out.done(), end: pos };
}

/* zlib (RFC 1950): a 2-byte header, the DEFLATE data, Adler-32. */
export function inflate(src, opts = {}) {
  if (src.length < 2 || (src[0] & 15) !== 8 || ((src[0] << 8) | src[1]) % 31) return inflateRaw(src, opts).data;
  return inflateRaw(src, { ...opts, start: 2 }).data;
}

/* ---------- deflate ---------- */

/* Code lengths (at most `limit` bits) for symbol frequencies: Huffman, then lengths over the limit are folded down. */
function codeLengths(freq, limit) {
  const n = freq.length;
  const lengths = new Uint8Array(n);
  const syms = [];
  for (let i = 0; i < n; i += 1) if (freq[i]) syms.push(i);
  if (!syms.length) return lengths;
  if (syms.length === 1) {
    lengths[syms[0]] = 1;
    return lengths;
  }
  /* nodes: leaves 0..m-1, then internal; a two-queue Huffman build */
  syms.sort((a, b) => freq[a] - freq[b] || a - b);
  const m = syms.length;
  const weight = new Float64Array(2 * m);
  const parent = new Int32Array(2 * m).fill(-1);
  for (let i = 0; i < m; i += 1) weight[i] = freq[syms[i]];
  let leaf = 0;
  let inner = m;
  let next = m;
  const pick = () => {
    if (leaf < m && (inner >= next || weight[leaf] <= weight[inner])) return leaf++;
    return inner++;
  };
  for (let k = 0; k < m - 1; k += 1) {
    const a = pick();
    const b = pick();
    weight[next] = weight[a] + weight[b];
    parent[a] = next;
    parent[b] = next;
    next += 1;
  }
  const depth = new Int32Array(2 * m);
  for (let i = next - 2; i >= 0; i -= 1) depth[i] = depth[parent[i]] + 1;
  const blCount = new Int32Array(Math.max(limit, 32) + 1);
  let overflow = 0;
  for (let i = 0; i < m; i += 1) {
    let d = depth[i];
    if (d > limit) {
      d = limit;
      overflow += 1;
    }
    blCount[d] += 1;
  }
  /* fix the Kraft sum after clamping (zlib's method) */
  while (overflow > 0) {
    let bits = limit - 1;
    while (!blCount[bits]) bits -= 1;
    blCount[bits] -= 1;
    blCount[bits + 1] += 2;
    blCount[limit] -= 1;
    overflow -= 2;
  }
  /* hand the lengths out again: the least frequent symbols get the longest codes */
  let idx = 0;
  for (let bits = limit; bits >= 1; bits -= 1) {
    for (let c = blCount[bits]; c > 0; c -= 1) lengths[syms[idx++]] = bits;
  }
  return lengths;
}

function canonicalCodes(lengths) {
  const count = new Uint16Array(16);
  for (const l of lengths) if (l) count[l] += 1;
  const next = new Uint16Array(16);
  let code = 0;
  for (let b = 1; b < 16; b += 1) {
    next[b] = code;
    code = (code + count[b]) << 1;
  }
  const codes = new Uint16Array(lengths.length);
  for (let s = 0; s < lengths.length; s += 1) {
    const l = lengths[s];
    if (!l) continue;
    let c = next[l]++;
    let r = 0;
    for (let i = 0; i < l; i += 1) {
      r = (r << 1) | (c & 1);
      c >>= 1;
    }
    codes[s] = r;
  }
  return codes;
}

class BitWriter {
  constructor() {
    this.out = new Bytes(1 << 16);
    this.acc = 0;
    this.n = 0;
  }
  put(v, n) {
    this.acc |= v << this.n;
    this.n += n;
    while (this.n >= 8) {
      this.out.byte(this.acc & 255);
      this.acc >>>= 8;
      this.n -= 8;
    }
  }
  flush() {
    if (this.n > 0) this.out.byte(this.acc & 255);
    this.acc = 0;
    this.n = 0;
  }
}

const lenSymbol = (() => {
  const t = new Uint16Array(259);
  for (let i = 0; i < 29; i += 1) {
    const end = i === 28 ? 259 : LEN_BASE[i + 1];
    for (let l = LEN_BASE[i]; l < end; l += 1) t[l] = i;
  }
  t[258] = 28;
  return t;
})();

function distSymbol(d) {
  let lo = 0;
  let hi = 29;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (DIST_BASE[mid] <= d) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/* One dynamic-Huffman block of LZ77 tokens: literal (v < 256) or match (len << 16 | dist), packed in `toks`. */
function writeBlock(w, toks, ntok, last) {
  const lf = new Uint32Array(286);
  const df = new Uint32Array(30);
  for (let i = 0; i < ntok; i += 1) {
    const t = toks[i];
    if (t < 256) lf[t] += 1;
    else {
      lf[257 + lenSymbol[t >>> 16]] += 1;
      df[distSymbol(t & 0xFFFF)] += 1;
    }
  }
  lf[256] = 1;
  const ll = codeLengths(lf, 15);
  let dl = codeLengths(df, 15);
  if (!df.some((x) => x)) {
    dl = new Uint8Array(30);
    dl[0] = 1;
  }
  let hlit = 286;
  while (hlit > 257 && !ll[hlit - 1]) hlit -= 1;
  let hdist = 30;
  while (hdist > 1 && !dl[hdist - 1]) hdist -= 1;
  const all = [...ll.subarray(0, hlit), ...dl.subarray(0, hdist)];
  /* run-length the code lengths with 16 / 17 / 18 */
  const rle = [];
  for (let i = 0; i < all.length;) {
    const v = all[i];
    let run = 1;
    while (i + run < all.length && all[i + run] === v) run += 1;
    if (v === 0 && run >= 3) {
      let r = run;
      while (r >= 3) {
        const k = Math.min(r, 138);
        if (k >= 11) rle.push([18, k - 11]);
        else rle.push([17, k - 3]);
        r -= k;
      }
      for (let k = 0; k < r; k += 1) rle.push([0, 0]);
      i += run;
    } else if (v !== 0 && run >= 4) {
      rle.push([v, 0]);
      let r = run - 1;
      while (r >= 3) {
        const k = Math.min(r, 6);
        rle.push([16, k - 3]);
        r -= k;
      }
      for (let k = 0; k < r; k += 1) rle.push([v, 0]);
      i += run;
    } else {
      rle.push([v, 0]);
      i += 1;
    }
  }
  const cf = new Uint32Array(19);
  for (const [s] of rle) cf[s] += 1;
  const cl = codeLengths(cf, 7);
  let hclen = 19;
  while (hclen > 4 && !cl[CL_ORDER[hclen - 1]]) hclen -= 1;
  const lc = canonicalCodes(ll);
  const dc = canonicalCodes(dl);
  const cc = canonicalCodes(cl);
  w.put(last ? 1 : 0, 1);
  w.put(2, 2);
  w.put(hlit - 257, 5);
  w.put(hdist - 1, 5);
  w.put(hclen - 4, 4);
  for (let i = 0; i < hclen; i += 1) w.put(cl[CL_ORDER[i]], 3);
  for (const [s, extra] of rle) {
    w.put(cc[s], cl[s]);
    if (s === 16) w.put(extra, 2);
    else if (s === 17) w.put(extra, 3);
    else if (s === 18) w.put(extra, 7);
  }
  for (let i = 0; i < ntok; i += 1) {
    const t = toks[i];
    if (t < 256) w.put(lc[t], ll[t]);
    else {
      const len = t >>> 16;
      const d = t & 0xFFFF;
      const ls = lenSymbol[len];
      w.put(lc[257 + ls], ll[257 + ls]);
      if (LEN_EXTRA[ls]) w.put(len - LEN_BASE[ls], LEN_EXTRA[ls]);
      const ds = distSymbol(d);
      w.put(dc[ds], dl[ds]);
      if (DIST_EXTRA[ds]) w.put(d - DIST_BASE[ds], DIST_EXTRA[ds]);
    }
  }
  w.put(lc[256], ll[256]);
}

/*
 * Raw DEFLATE with LZ77 (hash chains, 32 KB window) and dynamic Huffman blocks. level 1–9 sets how
 * hard it looks for matches.
 */
export function deflateRaw(data, level = 6) {
  const w = new BitWriter();
  const n = data.length;
  if (!n) {
    w.put(1, 1);
    w.put(1, 2);
    w.put(0, 7);
    w.flush();
    return w.out.done();
  }
  const WSIZE = 32768;
  const HBITS = 15;
  const head = new Int32Array(1 << HBITS).fill(-1);
  const prev = new Int32Array(WSIZE);
  const chainMax = [0, 4, 8, 16, 32, 64, 128, 256, 512, 1024][Math.max(1, Math.min(9, level))];
  const BLOCK = 1 << 16;
  const toks = new Uint32Array(BLOCK);
  let ntok = 0;
  const hash = (i) => (((data[i] << 10) ^ (data[i + 1] << 5) ^ data[i + 2]) & ((1 << HBITS) - 1));
  const insert = (i) => {
    if (i + 2 >= n) return;
    const h = hash(i);
    prev[i & (WSIZE - 1)] = head[h];
    head[h] = i;
  };
  let i = 0;
  while (i < n) {
    let bestLen = 0;
    let bestDist = 0;
    if (i + 2 < n) {
      let cand = head[hash(i)];
      let chain = chainMax;
      const maxLen = Math.min(258, n - i);
      while (cand >= 0 && i - cand <= WSIZE && chain-- > 0) {
        if (data[cand + bestLen] === data[i + bestLen] && data[cand] === data[i]) {
          let l = 0;
          while (l < maxLen && data[cand + l] === data[i + l]) l += 1;
          if (l > bestLen) {
            bestLen = l;
            bestDist = i - cand;
            if (l === maxLen) break;
          }
        }
        const p = prev[cand & (WSIZE - 1)];
        if (p >= cand) break;
        cand = p;
      }
    }
    if (bestLen >= 3) {
      toks[ntok++] = (bestLen << 16) | bestDist;
      for (let k = 0; k < bestLen; k += 1) insert(i + k);
      i += bestLen;
    } else {
      toks[ntok++] = data[i];
      insert(i);
      i += 1;
    }
    if (ntok === BLOCK) {
      writeBlock(w, toks, ntok, i >= n);
      ntok = 0;
    }
  }
  if (ntok) writeBlock(w, toks, ntok, true);
  w.flush();
  return w.out.done();
}

export function deflate(data, level = 6) {
  const raw = deflateRaw(data, level);
  const out = new Uint8Array(raw.length + 6);
  out[0] = 0x78;
  out[1] = 0x9C;
  out.set(raw, 2);
  const a = adler32(data);
  out[raw.length + 2] = (a >>> 24) & 255;
  out[raw.length + 3] = (a >>> 16) & 255;
  out[raw.length + 4] = (a >>> 8) & 255;
  out[raw.length + 5] = a & 255;
  return out;
}

/* ---------- base64 (the isolate has no btoa) ---------- */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function base64(bytes) {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[v >> 18] + B64[(v >> 12) & 63] + B64[(v >> 6) & 63] + B64[v & 63];
  }
  if (i < bytes.length) {
    const v = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8);
    out += B64[v >> 18] + B64[(v >> 12) & 63] + (i + 1 < bytes.length ? B64[(v >> 6) & 63] : '=') + '=';
  }
  return out;
}

/* ---------- the PDF check ---------- */

const PDF_KEYS = ['JavaScript', 'JS', 'OpenAction', 'AA', 'Launch', 'EmbeddedFile', 'EmbeddedFiles', 'RichMedia', 'XFA', 'AcroForm', 'SubmitForm', 'ImportData',
  'GoToR', 'GoToE', 'URI', 'Encrypt', 'ObjStm'];
const latin1 = (bytes, a = 0, b = bytes.length) => {
  let s = '';
  for (let i = a; i < b; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(b, i + 8192)));
  return s;
};

/* Names with #xx escapes are decoded (an old trick to hide /JavaScript); counts how many were escaped. */
function countNames(text, counts, found) {
  const re = /\/([A-Za-z0-9#]{1,40})/g;
  let m;
  while ((m = re.exec(text))) {
    let name = m[1];
    if (name.includes('#')) {
      const dec = name.replace(/#([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
      if (dec !== name) {
        found.escaped += 1;
        name = dec;
      }
    }
    if (Object.prototype.hasOwnProperty.call(counts, name)) counts[name] += 1;
  }
  const pages = text.match(/\/Type\s*\/Page(?![s\w])/g);
  if (pages) found.pages += pages.length;
  const uri = /\/URI\s*\(([^)]{1,300})\)/g;
  while ((m = uri.exec(text)) && found.uris.length < 20) found.uris.push(m[1]);
}

/*
 * Checks a PDF. Gives { pdf, pages, counts: { JavaScript, … }, escaped, uris, streams, unread,
 * encrypted, verdict: 'clean' | 'caution' | 'danger', reasons: [...] }.
 * Compressed (FlateDecode) streams are inflated — at most `maxOut` bytes in all and 3000 streams.
 */
export function checkPdf(bytes, { maxOut = 24 * 1024 * 1024 } = {}) {
  const head = latin1(bytes, 0, Math.min(bytes.length, 1024));
  const counts = Object.fromEntries(PDF_KEYS.map((k) => [k, 0]));
  const found = { escaped: 0, pages: 0, uris: [] };
  const res = { pdf: /%PDF-\d/.test(head), counts, escaped: 0, pages: 0, uris: [], streams: 0, unread: 0, encrypted: false, verdict: 'clean', reasons: [] };
  if (!res.pdf) return res;
  const text = latin1(bytes);
  countNames(text, counts, found);
  let budget = maxOut;
  const streamRe = /(?<!end)stream\r?\n/g;
  let m;
  while ((m = streamRe.exec(text)) && res.streams < 3000) {
    const objAt = text.lastIndexOf(' obj', m.index);
    const dict = text.slice(Math.max(objAt, m.index - 4000, 0), m.index);
    const begin = m.index + m[0].length;
    const endAt = text.indexOf('endstream', begin);
    if (endAt < 0) break;
    streamRe.lastIndex = endAt + 9;
    res.streams += 1;
    if (!/\/FlateDecode/.test(dict) || /\/Subtype\s*\/Image|\/(DCTDecode|JPXDecode|CCITTFax|JBIG2)/.test(dict)) continue;
    try {
      const out = inflate(bytes.subarray(begin, endAt), { max: Math.max(0, budget) });
      budget -= out.length;
      countNames(latin1(out, 0, Math.min(out.length, 4 * 1024 * 1024)), counts, found);
    } catch {
      res.unread += 1;
    }
    if (budget <= 0) break;
  }
  res.escaped = found.escaped;
  res.pages = found.pages;
  res.uris = [...new Set(found.uris)].slice(0, 10);
  res.encrypted = counts.Encrypt > 0;
  const danger = [];
  const caution = [];
  if (counts.JavaScript || counts.JS) danger.push('javascript');
  if (counts.Launch) danger.push('launch');
  if (counts.EmbeddedFile || counts.EmbeddedFiles) danger.push('embedded');
  if (counts.RichMedia) danger.push('richmedia');
  if (counts.OpenAction || counts.AA) caution.push('autoaction');
  if (counts.SubmitForm || counts.ImportData || counts.XFA) caution.push('form');
  if (counts.GoToR || counts.GoToE) caution.push('remote');
  if (counts.URI) caution.push('links');
  if (res.encrypted) caution.push('encrypted');
  if (found.escaped) caution.push('obfuscated');
  if (res.unread) caution.push('unreadable');
  if (danger.length && (counts.OpenAction || counts.AA)) danger.push('autoaction');
  res.reasons = [...new Set([...danger, ...caution])];
  res.verdict = danger.length ? 'danger' : (caution.length ? 'caution' : 'clean');
  return res;
}

/* ---------- SHA-256 (FIPS 180-4) — the audit log's seals (engines/system.js) ---------- */

const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/* SHA-256 of bytes (Uint8Array) as 64 lowercase hex digits. */
export function sha256(bytes) {
  const n = bytes.length;
  const total = ((n + 9 + 63) >> 6) << 6;
  const m = new Uint8Array(total);
  m.set(bytes);
  m[n] = 0x80;
  const bits = n * 8;
  const dv = new DataView(m.buffer);
  dv.setUint32(total - 8, Math.floor(bits / 0x100000000));
  dv.setUint32(total - 4, bits >>> 0);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const a = w[i - 15];
      const b = w[i - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i += 1) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K256[i] + w[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  let out = '';
  for (let i = 0; i < 8; i += 1) out += h[i].toString(16).padStart(8, '0');
  return out;
}
