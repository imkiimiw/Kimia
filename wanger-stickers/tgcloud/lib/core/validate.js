/**
 * Rule validators (pure; brief §10): read the file's own headers and list every violation of the
 * target's rules. The Studio runs them before upload and the server runs them again in
 * upload_commit, so a broken or oversized file never reaches Telegram.
 */
import { inspectPng, inspectWebP, inspectWebM, inspectGif, inspectMp4 } from './inspect.js';
import { TELEGRAM, WHATSAPP, OUTPUT } from './limits.js';

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
    sideRule(v, info.width, info.height, S.side);
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
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'gif';
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'webm';
  if (bytes.length >= 8 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) return 'mp4';
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return 'zip';
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) return 'gzip';
  return null;
}

/** One side exactly `side`, the other at most `side` (Telegram's sticker rule). */
function sideRule(v, w, h, side) {
  if (!(w === side || h === side)) v.push('NO_SIDE_512');
  if (w > side || h > side || w < 1 || h < 1) v.push('TOO_LARGE_DIMENSIONS');
}

/**
 * Telegram video sticker: WEBM with exactly one VP9 video track and no audio, one side 512 and the
 * other ≤ 512, ≤ 3 s, ≤ 30 fps, ≤ 256 KB.
 * @param {Uint8Array} bytes
 */
export function validateTelegramVideo(bytes) {
  const S = TELEGRAM.video;
  const v = [];
  const info = inspectWebM(bytes);
  if (info.error || info.docType !== 'webm') v.push(info.error === 'NOT_EBML' || !info.error ? 'NOT_WEBM' : 'BROKEN_WEBM');
  else {
    const videos = info.tracks.filter((t) => t.type === 1);
    if (videos.length !== 1) v.push('VIDEO_TRACKS');
    const t = videos[0];
    if (t && t.codec !== S.codec) v.push('NOT_VP9');
    if (info.hasAudio || info.tracks.some((x) => x.type !== 1)) v.push('AUDIO');
    if (t) sideRule(v, t.width || 0, t.height || 0, S.side);
    if (!info.frames) v.push('EMPTY');
    if (info.durationMs > S.maxDurationMs) v.push('TOO_LONG');
    if (info.fps > S.maxFps) v.push('FPS');
  }
  if (bytes.length > S.maxBytes) v.push('TOO_BIG');
  return { ok: v.length === 0, violations: v, info };
}

/** Custom emoji (Phase 4), static: PNG or WEBP, exactly 100×100, not animated, sticker size limit. */
export function validateCustomEmojiStatic(bytes, format) {
  const E = TELEGRAM.customEmoji;
  const v = [];
  const info = format === 'png' ? inspectPng(bytes) : format === 'webp' ? inspectWebP(bytes) : { error: 'FORMAT' };
  if (info.error) v.push(info.error === 'FORMAT' ? 'FORMAT' : 'NOT_' + format.toUpperCase());
  else {
    if (info.animated) v.push('ANIMATED');
    if (info.width !== E.width || info.height !== E.height) v.push('NOT_100X100');
  }
  if (bytes.length > TELEGRAM.static.maxBytes) v.push('TOO_BIG');
  return { ok: v.length === 0, violations: v, info };
}

/** Custom emoji (Phase 4), video: the video-sticker rules at exactly 100×100. */
export function validateCustomEmojiVideo(bytes) {
  const r = validateTelegramVideo(bytes);
  const v = r.violations.filter((x) => x !== 'NO_SIDE_512' && x !== 'TOO_LARGE_DIMENSIONS');
  const t = r.info.tracks && r.info.tracks.find((x) => x.type === 1);
  if (t && (t.width !== TELEGRAM.customEmoji.width || t.height !== TELEGRAM.customEmoji.height)) v.push('NOT_100X100');
  return { ok: v.length === 0, violations: v, info: r.info };
}

/** WhatsApp static sticker: WebP, exactly 512×512, not animated, ≤ 100 KB. */
export function validateWhatsAppStatic(bytes) {
  const S = WHATSAPP.static;
  const v = [];
  const info = inspectWebP(bytes);
  if (info.error) v.push(info.error === 'NOT_WEBP' ? 'NOT_WEBP' : 'BROKEN_WEBP');
  else {
    if (info.animated) v.push('ANIMATED');
    if (info.width !== S.width || info.height !== S.height) v.push('NOT_512X512');
  }
  if (bytes.length > S.maxBytes) v.push('TOO_BIG');
  return { ok: v.length === 0, violations: v, info };
}

/**
 * WhatsApp animated sticker: animated WebP, exactly 512×512, ≤ 500 KB, ≤ 10 s, every frame ≥ 8 ms,
 * loops forever.
 */
export function validateWhatsAppAnimated(bytes) {
  const S = WHATSAPP.animated;
  const v = [];
  const info = inspectWebP(bytes);
  if (info.error) v.push(info.error === 'NOT_WEBP' ? 'NOT_WEBP' : 'BROKEN_WEBP');
  else {
    if (!info.animated || info.frames < 1) v.push('NOT_ANIMATED');
    if (info.width !== S.width || info.height !== S.height) v.push('NOT_512X512');
    if (info.durationMs > S.maxDurationMs) v.push('TOO_LONG');
    if (info.frames && info.minFrameMs < S.minFrameMs) v.push('FRAME_TOO_SHORT');
    if (info.animated && info.loop !== 0) v.push('NOT_LOOPING');
  }
  if (bytes.length > S.maxBytes) v.push('TOO_BIG');
  return { ok: v.length === 0, violations: v, info };
}

/** WhatsApp tray icon: PNG, exactly 96×96, ≤ 50 KB. */
export function validateWhatsAppTray(bytes) {
  const S = WHATSAPP.tray;
  const v = [];
  const info = inspectPng(bytes);
  if (info.error) v.push('NOT_PNG');
  else if (info.width !== S.width || info.height !== S.height) v.push('NOT_96X96');
  if (bytes.length > S.maxBytes) v.push('TOO_BIG');
  return { ok: v.length === 0, violations: v, info };
}

/** A .gif for the chat: valid GIF, our size caps, frames not faster than browsers play them. */
export function validateGif(bytes) {
  const S = OUTPUT.gif;
  const v = [];
  const info = inspectGif(bytes);
  if (info.error) v.push(info.error === 'NOT_GIF' ? 'NOT_GIF' : 'BROKEN_GIF');
  else {
    if (!info.frames) v.push('EMPTY');
    if (info.width > S.maxSide || info.height > S.maxSide || !info.width || !info.height) v.push('TOO_LARGE_DIMENSIONS');
    if (info.durationMs > S.maxDurationMs) v.push('TOO_LONG');
    if (info.frames > 1 && info.minDelayMs < S.minDelayMs) v.push('FRAME_TOO_SHORT');
  }
  if (bytes.length > S.maxBytes) v.push('TOO_BIG');
  return { ok: v.length === 0, violations: v, info };
}

/** An MP4 for sendAnimation: one H.264 video track, no sound, our size caps. */
export function validateMp4Animation(bytes) {
  const S = OUTPUT.animation;
  const v = [];
  const info = inspectMp4(bytes);
  if (info.error) v.push(info.error === 'NOT_MP4' ? 'NOT_MP4' : 'BROKEN_MP4');
  else {
    const videos = info.tracks.filter((t) => t.type === 'vide');
    if (videos.length !== 1) v.push('VIDEO_TRACKS');
    if (videos[0] && videos[0].codec !== S.codec) v.push('NOT_H264');
    if (info.hasAudio || info.tracks.some((t) => t.type !== 'vide')) v.push('AUDIO');
    if (videos[0] && (videos[0].width > S.maxSide || videos[0].height > S.maxSide || !videos[0].width)) v.push('TOO_LARGE_DIMENSIONS');
    if (videos[0] && !videos[0].samples) v.push('EMPTY');
    if (info.durationMs > S.maxDurationMs) v.push('TOO_LONG');
  }
  if (bytes.length > S.maxBytes) v.push('TOO_BIG');
  return { ok: v.length === 0, violations: v, info };
}

/** Animated WebP sent as a file (any size up to our caps). */
export function validateWebPFile(bytes) {
  const S = OUTPUT.webp;
  const v = [];
  const info = inspectWebP(bytes);
  if (info.error) v.push(info.error === 'NOT_WEBP' ? 'NOT_WEBP' : 'BROKEN_WEBP');
  else if (info.width > S.maxSide || info.height > S.maxSide || !info.width) v.push('TOO_LARGE_DIMENSIONS');
  if (bytes.length > S.maxBytes) v.push('TOO_BIG');
  return { ok: v.length === 0, violations: v, info };
}

/**
 * A WhatsApp pack before export: 3–30 stickers, one kind (never mixed), 1–3 emojis each, a name, a
 * publisher, an identifier and a tray icon.
 * @param {{ title: string, publisher: string, identifier: string, kind: string, tray: boolean, items: Array<{ kind: string, emojis: string[] }> }} p
 */
export function validateWhatsAppPack(p) {
  const P = WHATSAPP.pack;
  const v = [];
  const n = p.items.length;
  if (n < P.minStickers) v.push('TOO_FEW');
  if (n > P.maxStickers) v.push('TOO_MANY');
  if (p.kind !== 'static' && p.kind !== 'animated') v.push('KIND');
  if (p.items.some((i) => i.kind !== p.kind)) v.push('MIXED');
  if (p.items.some((i) => !Array.isArray(i.emojis) || i.emojis.length < P.emojiPerStickerMin || i.emojis.length > P.emojiPerStickerMax)) v.push('EMOJIS');
  if (!p.title || [...p.title].length > P.nameMaxChars) v.push('NAME');
  if (!p.publisher || [...p.publisher].length > P.publisherMaxChars) v.push('PUBLISHER');
  if (!new RegExp(P.identifierPattern).test(p.identifier || '')) v.push('IDENTIFIER');
  if (!p.tray) v.push('NO_TRAY');
  return { ok: v.length === 0, violations: v };
}

/**
 * Every file kind the Studio uploads → its format(s) and validator (upload_begin/commit use this).
 * @type {Readonly<Record<string, {formats: readonly string[], maxBytes: number, check: (b: Uint8Array, format: string) => {ok: boolean, violations: string[], info: any}}>>}
 */
export const UPLOAD_KINDS = Object.freeze({
  telegram_static: { formats: TELEGRAM.static.formats, maxBytes: TELEGRAM.static.maxBytes, check: (b, f) => validateTelegramStatic(b, /** @type {any} */ (f)) },
  telegram_video: { formats: ['webm'], maxBytes: TELEGRAM.video.maxBytes, check: (b) => validateTelegramVideo(b) },
  animation: { formats: ['mp4'], maxBytes: OUTPUT.animation.maxBytes, check: (b) => validateMp4Animation(b) },
  gif: { formats: ['gif'], maxBytes: OUTPUT.gif.maxBytes, check: (b) => validateGif(b) },
  webp_file: { formats: ['webp'], maxBytes: OUTPUT.webp.maxBytes, check: (b) => validateWebPFile(b) },
  frames_zip: { formats: ['zip'], maxBytes: OUTPUT.zip.maxBytes, check: () => ({ ok: true, violations: [], info: {} }) }, // checked entry by entry in transfer.js
  emoji_static: { formats: TELEGRAM.static.formats, maxBytes: TELEGRAM.static.maxBytes, check: (b, f) => validateCustomEmojiStatic(b, f) },
  emoji_video: { formats: ['webm'], maxBytes: TELEGRAM.video.maxBytes, check: (b) => validateCustomEmojiVideo(b) },
  whatsapp_static: { formats: ['webp'], maxBytes: WHATSAPP.static.maxBytes, check: (b) => validateWhatsAppStatic(b) },
  whatsapp_animated: { formats: ['webp'], maxBytes: WHATSAPP.animated.maxBytes, check: (b) => validateWhatsAppAnimated(b) },
  whatsapp_tray: { formats: ['png'], maxBytes: WHATSAPP.tray.maxBytes, check: (b) => validateWhatsAppTray(b) },
});
