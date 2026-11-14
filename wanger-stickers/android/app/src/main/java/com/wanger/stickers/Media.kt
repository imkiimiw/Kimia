package com.wanger.stickers

/**
 * Header-only readers for the two image formats a pack holds (pure Kotlin, no Android classes, so
 * the JVM tests cover them). A port of `inspectWebP` / `inspectPng` in the bot's
 * `tgcloud/lib/core/inspect.js`: the bot and the app judge a file the same way.
 */
object Media {
    data class WebP(
        val width: Int,
        val height: Int,
        val animated: Boolean,
        val frames: Int,
        val durationMs: Int,
        val minFrameMs: Int,
        /** ANIM loop count; 0 = forever, -1 = no ANIM chunk. */
        val loop: Int,
    )

    data class Png(val width: Int, val height: Int)

    private fun fourcc(b: ByteArray, o: Int) = String(b, o, 4, Charsets.ISO_8859_1)
    private fun u8(b: ByteArray, o: Int) = b[o].toInt() and 0xff
    private fun u24(b: ByteArray, o: Int) = u8(b, o) or (u8(b, o + 1) shl 8) or (u8(b, o + 2) shl 16)
    private fun u32(b: ByteArray, o: Int): Long = (u24(b, o).toLong()) or (u8(b, o + 3).toLong() shl 24)
    private fun be32(b: ByteArray, o: Int): Long =
        (u8(b, o).toLong() shl 24) or (u8(b, o + 1).toLong() shl 16) or (u8(b, o + 2).toLong() shl 8) or u8(b, o + 3).toLong()

    /** RIFF/WEBP container: size, animation, frame timings. null = not a WebP or broken. */
    fun webp(b: ByteArray): WebP? {
        if (b.size < 20 || fourcc(b, 0) != "RIFF" || fourcc(b, 8) != "WEBP") return null
        val riffSize = u32(b, 4)
        if (riffSize + 8 > b.size) return null
        val end = minOf(b.size.toLong(), riffSize + 8).toInt()
        var width = 0
        var height = 0
        var animated = false
        var frames = 0
        var duration = 0
        var minFrame = Int.MAX_VALUE
        var loop = -1
        var o = 12
        while (o + 8 <= end) {
            val id = fourcc(b, o)
            val size = u32(b, o + 4)
            val p = o + 8
            if (p + size > end) return null
            val s = size.toInt()
            when (id) {
                "VP8X" -> {
                    if (s < 10) return null
                    animated = (u8(b, p) and 0x02) != 0
                    width = u24(b, p + 4) + 1
                    height = u24(b, p + 7) + 1
                }
                "ANIM" -> if (s >= 6) loop = u8(b, p + 4) or (u8(b, p + 5) shl 8)
                "ANMF" -> {
                    if (s < 16) return null
                    val d = u24(b, p + 12)
                    frames++
                    duration += d
                    minFrame = minOf(minFrame, d)
                }
                "VP8 " -> if (width == 0 && s >= 10) {
                    width = (u8(b, p + 6) or (u8(b, p + 7) shl 8)) and 0x3fff
                    height = (u8(b, p + 8) or (u8(b, p + 9) shl 8)) and 0x3fff
                    frames = 1
                }
                "VP8L" -> if (width == 0 && s >= 5) {
                    val bits = u32(b, p + 1)
                    width = ((bits and 0x3fff) + 1).toInt()
                    height = (((bits shr 14) and 0x3fff) + 1).toInt()
                    frames = 1
                }
            }
            o = p + s + (s and 1)
        }
        if (width == 0 || height == 0) return null
        if (!animated && frames == 0) frames = 1
        return WebP(width, height, animated, frames, duration, if (minFrame == Int.MAX_VALUE) 0 else minFrame, loop)
    }

    private val PNG_SIG = byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)

    /** PNG signature + IHDR. null = not a PNG. */
    fun png(b: ByteArray): Png? {
        if (b.size < 33) return null
        for (i in PNG_SIG.indices) if (b[i] != PNG_SIG[i]) return null
        if (fourcc(b, 12) != "IHDR") return null
        val w = be32(b, 16)
        val h = be32(b, 20)
        if (w <= 0 || h <= 0 || w > 65535 || h > 65535) return null
        return Png(w.toInt(), h.toInt())
    }
}
