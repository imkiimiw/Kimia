package com.wanger.stickers

/**
 * WhatsApp's sticker-pack rules, from the official integration guide and its sample validator
 * (https://github.com/WhatsApp/stickers/tree/main/Android). The sticker numbers mirror the bot's
 * `tgcloud/lib/core/limits.js` (WHATSAPP); `tests/android.test.mjs` fails when the two drift.
 */
object Limits {
    const val STICKER_SIDE = 512
    const val STATIC_MAX_BYTES = 100 * 1024
    const val ANIMATED_MAX_BYTES = 500 * 1024
    const val MIN_FRAME_MS = 8
    const val MAX_DURATION_MS = 10_000

    // WhatsApp's own validator accepts any tray between 24 and 512 px; the bot always writes 96×96.
    const val TRAY_MIN_SIDE = 24
    const val TRAY_MAX_SIDE = 512
    const val TRAY_MAX_BYTES = 50 * 1024

    const val MIN_STICKERS = 3
    const val MAX_STICKERS = 30
    const val EMOJI_MIN = 1
    const val EMOJI_MAX = 3
    const val NAME_MAX_CHARS = 128
    const val PUBLISHER_MAX_CHARS = 128
    const val IDENTIFIER_MAX_CHARS = 127
    /** WhatsApp: a–z A–Z 0–9 _ - . and space (its sample also allows , and '; the bot never writes them). */
    val IDENTIFIER = Regex("^[A-Za-z0-9_.\\- ]{1,127}$")

    /** "Packs per app: 1 to 10" (WhatsApp guide). */
    const val MAX_PACKS = 10

    /** Our own caps while reading an untrusted ZIP (a full animated pack is about 15 MB). */
    const val MAX_ZIP_BYTES = 40L * 1024 * 1024
    const val MAX_ENTRIES = 80
    const val MAX_META_BYTES = 64 * 1024
}
