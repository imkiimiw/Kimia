/**
 * Rule validators (pure; brief §10): read the file's own headers and list every violation of the
 * target's rules. The Studio runs them before upload and the server runs them again in
 * upload_commit, so a broken or oversized file never reaches Telegram.
 */
import { inspectPng, inspectWebP } from './inspect.js';
import { TELEGRAM } from './limits.js';

/**
 * Telegram static sticker: PNG or WEBP, one side exactly 512, the other ≤ 512, ≤ 512 KB, not animated.
 * @param {Uint8Array} bytes @param {'png'|'webp'} format
 * @returns {{ok: boolean, violations: string[], info: any}}
 */
export function validateTelegramStatic(bytes, format) {
  const S = TELEGRAM.static;
  const v = [];
  const info = format === 'png' ? inspectPng(bytes) : format === 'webp' ? inspectWebP(bytes) : { error: 'FORMAT' };
  if (info.error) v.push(info.error === 'FORMAT' ? 'FORMAT' : 'NOT_' + format.toUpperCase());
  else {
    if (info.animated) v.push('ANIMATED');
    const w = info.width;
    const h = info.height;
    if (!(w === S.side || h === S.side)) v.push('NO_SIDE_512');
    if (w > S.side || h > S.side || w < 1 || h < 1) v.push('TOO_LARGE_DIMENSIONS');
  }
  if (bytes.length > S.maxBytes) v.push('TOO_BIG');
  if (bytes.length === 0) v.push('EMPTY');
  return { ok: v.length === 0, violations: v, info };
}

/** What the bytes are, from their magic numbers. */
export function sniffImage(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'webp';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  return null;
}
