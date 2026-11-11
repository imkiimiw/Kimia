/**
 * Every Telegram and WhatsApp number this project relies on, in one place.
 *
 * Pure module (no 'sdk'): the backend validators (upload_commit) and the Mini App's media engine
 * (src/engine/limits.ts re-exports this file) read the SAME object, so the two sides can never
 * drift apart.
 *
 * Re-checked on 2026-11-11 against the official pages listed in SOURCES (Bot API 10.4, Nov 9 2026).
 * Each value carries the source key it came from; docs/SPIKE_REPORT.md §2 lists the differences
 * from the original brief. If an official page changes, change it HERE and nowhere else.
 */

const KB = 1024;
const MB = 1024 * 1024;

export const CHECKED_ON = '2026-11-11';

export const SOURCES = Object.freeze({
  stickers: 'https://core.telegram.org/stickers',
  webm: 'https://core.telegram.org/stickers/webm-vp9-encoding',
  import: 'https://core.telegram.org/import-stickers',
  botapi: 'https://core.telegram.org/bots/api',
  serverless: 'https://core.telegram.org/bots/serverless',
  whatsapp: 'https://github.com/WhatsApp/stickers/blob/main/Android/README.md',
});

export const TELEGRAM = Object.freeze({
  /** Static sticker: PNG or WEBP, one side exactly 512, the other <= 512. */
  static: Object.freeze({
    formats: Object.freeze(['png', 'webp']),
    side: 512,
    maxBytes: 512 * KB, // from the import-stickers page; the Bot API page gives no number
    source: 'stickers+import',
  }),
  /** Video sticker: WEBM/VP9, no audio stream, <= 3 s, <= 30 fps, <= 256 KB. */
  video: Object.freeze({
    container: 'webm',
    codec: 'V_VP9',
    side: 512,
    maxDurationMs: 3000,
    maxFps: 30,
    maxBytes: 256 * KB,
    audioAllowed: false,
    source: 'stickers+webm',
  }),
  /** Animated sticker (TGS = gzipped Lottie): import/convert only, never generated. */
  animated: Object.freeze({
    width: 512,
    height: 512,
    fps: 60, // stickers page: "must run at 60 FPS"; the import page accepts 30-60
    maxDurationMs: 3000,
    maxBytes: 64 * KB,
    source: 'stickers+import',
  }),
  /** Custom emoji (Phase 4): exactly 100x100. */
  customEmoji: Object.freeze({ width: 100, height: 100, source: 'stickers' }),
  /** Sticker set thumbnail: WEBP/PNG 100x100 <= 128 KB; TGS or WEBM <= 32 KB. */
  thumbnail: Object.freeze({
    width: 100,
    height: 100,
    staticMaxBytes: 128 * KB,
    animatedMaxBytes: 32 * KB,
    videoMaxBytes: 32 * KB,
    source: 'botapi#setstickersetthumbnail',
  }),
  /** Sticker sets (Bot API createNewStickerSet / addStickerToSet / InputSticker). */
  set: Object.freeze({
    nameMaxChars: 64, // ASCII letters, digits, '_'; starts with a letter; no '__'; ends in _by_<bot>
    titleMaxChars: 64,
    initialStickersMax: 50, // createNewStickerSet takes 1-50 stickers
    maxStickersRegular: 120, // addStickerToSet: "Other sticker sets can have up to 120 stickers"
    maxStickersEmoji: 200, // "Emoji sticker sets can have up to 200 stickers"
    emojiPerStickerMin: 1,
    emojiPerStickerMax: 20,
    keywordsMax: 20,
    keywordsTotalChars: 64,
    mixedFormatsAllowed: true, // InputSticker carries its own format
    source: 'botapi',
  }),
  /** File transfer through the Bot API from Serverless. */
  files: Object.freeze({
    downloadMaxBytes: 20 * MB, // getFile / getFileContent / getFileStream
    uploadMaxBytes: 50 * MB,
    photoUploadMaxBytes: 10 * MB,
    source: 'botapi+serverless',
  }),
  /** Messages and buttons. */
  ui: Object.freeze({
    callbackDataMaxBytes: 64,
    messageMaxChars: 4096,
    captionMaxChars: 1024,
    startParamMaxChars: 64,
    source: 'botapi',
  }),
  /** Sending rates (Bot FAQ; not hard API numbers, so keep a margin). */
  rate: Object.freeze({
    globalPerSecond: 30,
    perChatPerSecond: 1,
    perGroupOrChannelPerMinute: 20,
    source: 'https://core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this',
  }),
  /** A bot can delete a message only within 48 hours (deleteMessage). */
  deleteMessageMaxAgeSec: 48 * 3600,
});

export const WHATSAPP = Object.freeze({
  static: Object.freeze({ format: 'webp', width: 512, height: 512, maxBytes: 100 * KB }),
  animated: Object.freeze({
    format: 'webp',
    width: 512,
    height: 512,
    maxBytes: 500 * KB,
    minFrameMs: 8,
    maxDurationMs: 10000,
    firstFrameIsComplete: true, // WhatsApp stops on the first frame after looping
  }),
  tray: Object.freeze({ format: 'png', width: 96, height: 96, maxBytes: 50 * KB }),
  pack: Object.freeze({
    minStickers: 3,
    maxStickers: 30,
    mixedAllowed: false, // all static or all animated
    emojiPerStickerMin: 1, // "emojis (required)"
    emojiPerStickerMax: 3,
    nameMaxChars: 128,
    publisherMaxChars: 128,
    identifierMaxChars: 127, // "less than 128 characters"; a-z A-Z 0-9 _ - . and space
    identifierPattern: '^[A-Za-z0-9_.\\- ]{1,127}$',
  }),
  /** Margin kept transparent around the art inside the 512x512 canvas (our choice, not WhatsApp's). */
  marginPx: 16,
  source: 'whatsapp',
});

/** Serverless platform numbers (official where stated; measured values live in docs/SPIKE_REPORT.md). */
export const PLATFORM = Object.freeze({
  fetchResponseMaxBytes: 30 * MB, // official
  cpuMsPerInvocation: 3000, // measured by the other Wanger bots (2026-11-05); re-measure with scripts/probe.mjs
  boundValuesPerStatement: 4096, // measured (wanger-music, 2026-11-06)
  rowsWrittenPerStatement: 10000, // measured (wanger-music)
  rowsReadPerQuery: 50000, // measured (wanger-media)
});

/** Size-targeting ladder used by the engine (section 10 of the brief). */
export const SIZE_TARGETING = Object.freeze({
  maxQualitySearchEncodes: 6,
  fpsLadder: Object.freeze([30, 24, 20, 15]),
});

export const LIMITS = Object.freeze({ TELEGRAM, WHATSAPP, PLATFORM, SIZE_TARGETING, CHECKED_ON, SOURCES });
export default LIMITS;
