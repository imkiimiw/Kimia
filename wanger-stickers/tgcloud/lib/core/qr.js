/**
 * A small QR code encoder (pure; byte mode, error correction level M, versions 1–10 = up to 213
 * bytes, enough for any t.me link). Follows ISO/IEC 18004 the way Nayuki's reference
 * implementation does (MIT): data + Reed–Solomon codewords interleaved per block, function
 * patterns, zig-zag placement, the mask with the lowest penalty, format and version information.
 * Tests decode the output with jsQR.
 */

/** Level M per version: [total codewords, EC codewords per block, number of blocks]. */
const M_TABLE = [null, [26, 10, 1], [44, 16, 1], [70, 26, 1], [100, 18, 2], [134, 24, 2], [172, 16, 4], [196, 18, 4], [242, 22, 4], [292, 22, 5], [346, 26, 5]];
const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
const ECL_M_BITS = 0; // format bits: L = 1, M = 0, Q = 3, H = 2

function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}
function rsDivisor(degree) {
  const r = new Array(degree).fill(0);
  r[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < r.length; j++) {
      r[j] = gfMul(r[j], root);
      if (j + 1 < r.length) r[j] ^= r[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return r;
}
function rsRemainder(data, divisor) {
  const r = new Array(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ r.shift();
    r.push(0);
    divisor.forEach((coef, i) => (r[i] ^= gfMul(coef, factor)));
  }
  return r;
}

const dataCodewords = (v) => M_TABLE[v][0] - M_TABLE[v][1] * M_TABLE[v][2];
const ccBits = (v) => (v <= 9 ? 8 : 16);

/** The data codewords for `bytes` at version v (byte mode, terminator, padding). */
function encodeData(bytes, v) {
  const cap = dataCodewords(v) * 8;
  const bits = [];
  const put = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, ccBits(v));
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, cap - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) put(pad, 8);
  const out = [];
  for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  return out;
}

function interleave(data, v) {
  const [raw, eccLen, numBlocks] = M_TABLE[v];
  const numShort = numBlocks - (raw % numBlocks);
  const shortLen = Math.floor(raw / numBlocks);
  const div = rsDivisor(eccLen);
  const blocks = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, div);
    if (i < numShort) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const out = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((b, j) => {
      if (i !== shortLen - eccLen || j >= numShort) out.push(b[i]);
    });
  }
  return out;
}

/**
 * @param {string | Uint8Array} input
 * @returns {{ size: number, version: number, modules: boolean[][] }} modules[y][x], true = dark
 */
export function makeQr(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  let v = 1;
  while (v <= 10 && 4 + ccBits(v) + bytes.length * 8 > dataCodewords(v) * 8) v++;
  if (v > 10) throw new Error('QR data too long');
  const size = v * 4 + 17;
  const mods = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => {
    mods[y][x] = dark;
    fn[y][x] = true;
  };
  // timing, finders, alignment
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx, y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
      }
    }
  }
  const al = ALIGN[v];
  for (let i = 0; i < al.length; i++) {
    for (let j = 0; j < al.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === al.length - 1) || (i === al.length - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
  const drawFormat = (mask) => {
    const data = (ECL_M_BITS << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i) => ((bits >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6));
    set(8, 8, bit(7));
    set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true); // the dark module
  };
  drawFormat(0);
  if (v >= 7) {
    let rem = v;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (v << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, dark);
      set(b, a, dark);
    }
  }
  // data
  const cw = interleave(encodeData(bytes, v), v);
  let k = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const up = ((right + 1) & 2) === 0;
        const y = up ? size - 1 - vert : vert;
        if (!fn[y][x] && k < cw.length * 8) {
          mods[y][x] = ((cw[k >>> 3] >>> (7 - (k & 7))) & 1) !== 0;
          k++;
        }
      }
    }
  }
  // the best mask
  const masked = (m) => {
    const out = mods.map((r) => r.slice());
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (fn[y][x]) continue;
        const inv = [
          (x + y) % 2 === 0, y % 2 === 0, x % 3 === 0, (x + y) % 3 === 0,
          (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, ((x * y) % 2) + ((x * y) % 3) === 0,
          (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
        ][m];
        if (inv) out[y][x] = !out[y][x];
      }
    }
    return out;
  };
  let best = null;
  let bestScore = Infinity;
  let bestMask = 0;
  for (let m = 0; m < 8; m++) {
    drawFormat(m);
    const grid = masked(m);
    // format bits live in `mods` (function modules are never masked)
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (fn[y][x]) grid[y][x] = mods[y][x];
    const s = penalty(grid);
    if (s < bestScore) {
      bestScore = s;
      best = grid;
      bestMask = m;
    }
  }
  drawFormat(bestMask);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (fn[y][x]) best[y][x] = mods[y][x];
  return { size, version: v, modules: best };
}

/** ISO penalty rules N1–N4 (runs, 2×2 blocks, finder-like patterns, dark balance). */
function penalty(g) {
  const n = g.length;
  let s = 0;
  const line = (get) => {
    let run = 1;
    for (let i = 1; i < n; i++) {
      if (get(i) === get(i - 1)) {
        run++;
        if (run === 5) s += 3;
        else if (run > 5) s += 1;
      } else run = 1;
    }
    const pat = [true, false, true, true, true, false, true];
    for (let i = 0; i + 7 <= n; i++) {
      if (!pat.every((p, k) => get(i + k) === p)) continue;
      const before = i >= 4 && [1, 2, 3, 4].every((k) => !get(i - k));
      const after = i + 11 <= n && [7, 8, 9, 10].every((k) => !get(i + k));
      if (before || after) s += 40;
    }
  };
  for (let y = 0; y < n; y++) line((i) => g[y][i]);
  for (let x = 0; x < n; x++) line((i) => g[i][x]);
  for (let y = 0; y + 1 < n; y++) for (let x = 0; x + 1 < n; x++) if (g[y][x] === g[y][x + 1] && g[y][x] === g[y + 1][x] && g[y][x] === g[y + 1][x + 1]) s += 3;
  let dark = 0;
  for (const r of g) for (const c of r) if (c) dark++;
  const total = n * n;
  s += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return s;
}
