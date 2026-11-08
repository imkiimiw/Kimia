// Base64 for request bodies (Gemini inline images). The isolate has no btoa / Buffer (measured).
// Pure; builds the string in 48 KB blocks so a 14 MB input stays fast and memory-friendly.
const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
let PAIRS = null; // 4096 two-character strings for 12-bit groups

export function toBase64(bytes) {
  if (!PAIRS) { PAIRS = new Array(4096); for (let i = 0; i < 4096; i++) PAIRS[i] = A[i >> 6] + A[i & 63]; }
  const n = bytes.length;
  const parts = [];
  const BLOCK = 49152; // multiple of 3
  for (let start = 0; start < n - (n % 3); start += BLOCK) {
    const end = Math.min(start + BLOCK, n - (n % 3));
    let s = '';
    for (let i = start; i < end; i += 3) {
      const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      s += PAIRS[v >> 12] + PAIRS[v & 4095];
    }
    parts.push(s);
  }
  const rest = n % 3;
  if (rest === 1) { const v = bytes[n - 1] << 16; parts.push(`${A[v >> 18]}${A[(v >> 12) & 63]}==`); }
  if (rest === 2) { const v = (bytes[n - 2] << 16) | (bytes[n - 1] << 8); parts.push(`${A[v >> 18]}${A[(v >> 12) & 63]}${A[(v >> 6) & 63]}=`); }
  return parts.join('');
}

/**
 * Base64 as ASCII bytes. Large inputs must use this: on Serverless a 14 MB image's base64 *string*
 * ran out of memory (JS heap), while typed arrays have gigabytes (measured in C3).
 */
export function toBase64Bytes(bytes) {
  const n = bytes.length;
  const out = new Uint8Array(Math.ceil(n / 3) * 4);
  const T = new Uint8Array(64);
  for (let i = 0; i < 64; i++) T[i] = A.charCodeAt(i);
  let o = 0;
  let i = 0;
  for (; i + 2 < n; i += 3) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out[o++] = T[v >> 18]; out[o++] = T[(v >> 12) & 63]; out[o++] = T[(v >> 6) & 63]; out[o++] = T[v & 63];
  }
  if (n - i === 1) { const v = bytes[i] << 16; out[o++] = T[v >> 18]; out[o++] = T[(v >> 12) & 63]; out[o++] = 61; out[o++] = 61; }
  if (n - i === 2) { const v = (bytes[i] << 16) | (bytes[i + 1] << 8); out[o++] = T[v >> 18]; out[o++] = T[(v >> 12) & 63]; out[o++] = T[(v >> 6) & 63]; out[o++] = 61; }
  return out;
}
