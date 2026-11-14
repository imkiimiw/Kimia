package com.wanger.stickers

import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

/** Synthetic files for the tests (headers are real; payloads are filler — the checks read headers). */
object TestData {
    private fun le(size: Int) = ByteBuffer.allocate(size).order(ByteOrder.LITTLE_ENDIAN)

    private fun chunk(id: String, payload: ByteArray): ByteArray {
        val b = le(8 + payload.size + (payload.size and 1))
        b.put(id.toByteArray(Charsets.ISO_8859_1)).putInt(payload.size).put(payload)
        return b.array()
    }

    private fun riff(vararg chunks: ByteArray): ByteArray {
        val body = chunks.fold(ByteArray(0)) { a, c -> a + c }
        return le(12).put("RIFF".toByteArray()).putInt(4 + body.size).put("WEBP".toByteArray()).array() + body
    }

    private fun u24(v: Int) = byteArrayOf((v and 255).toByte(), ((v shr 8) and 255).toByte(), ((v shr 16) and 255).toByte())

    /** A still lossless WebP header for w×h, padded to about [size] bytes. */
    fun webp(w: Int = 512, h: Int = 512, size: Int = 2000): ByteArray {
        val bits = ((w - 1) or ((h - 1) shl 14) or (1 shl 28))
        val payload = ByteArray(maxOf(5, size - 20))
        payload[0] = 0x2f
        le(4).putInt(bits).array().copyInto(payload, 1)
        return riff(chunk("VP8L", payload))
    }

    /** An animated WebP: VP8X + ANIM + one ANMF per frame duration. */
    fun animWebp(w: Int = 512, h: Int = 512, frameMs: List<Int> = List(10) { 100 }, frameBytes: Int = 200, loop: Int = 0): ByteArray {
        val vp8x = byteArrayOf(0x12, 0, 0, 0) + u24(w - 1) + u24(h - 1)
        val anim = le(6).putInt(0).putShort(loop.toShort()).array()
        val frames = frameMs.map { d ->
            chunk("ANMF", u24(0) + u24(0) + u24(w - 1) + u24(h - 1) + u24(d) + byteArrayOf(0) + webp(w, h, frameBytes).copyOfRange(12, 12 + frameBytes - 12))
        }
        return riff(chunk("VP8X", vp8x), chunk("ANIM", anim), *frames.toTypedArray())
    }

    /** A PNG signature + IHDR for w×h, padded to about [size] bytes. */
    fun png(w: Int = 96, h: Int = 96, size: Int = 200): ByteArray {
        val b = ByteBuffer.allocate(maxOf(size, 45))
        b.put(byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))
        b.putInt(13).put("IHDR".toByteArray()).putInt(w).putInt(h).put(byteArrayOf(8, 6, 0, 0, 0)).putInt(0)
        return b.array()
    }

    fun zip(entries: List<Pair<String, ByteArray>>): ByteArray {
        val out = ByteArrayOutputStream()
        ZipOutputStream(out).use { z ->
            for ((name, bytes) in entries) {
                z.putNextEntry(ZipEntry(name))
                z.write(bytes)
                z.closeEntry()
            }
        }
        return out.toByteArray()
    }

    fun packJson(identifier: String = "ws_test_w1", name: String = "Test", publisher: String = "me", animated: Boolean = false, emojis: List<List<String>>): ByteArray =
        JSONObject().put("identifier", identifier).put("name", name).put("publisher", publisher)
            .put("tray_image_file", "tray.png").put("animated_sticker_pack", animated)
            .put("stickers", JSONArray().apply {
                emojis.forEachIndexed { i, e -> put(JSONObject().put("image_file", String.format("%02d.webp", i + 1)).put("emojis", JSONArray(e))) }
            }).toString().toByteArray()

    /** A pack ZIP in the bot's layout with [n] stickers built by [sticker] (1-based index). */
    fun packZip(
        n: Int = 3,
        identifier: String = "ws_test_w1",
        animated: Boolean = false,
        tray: ByteArray = png(),
        emojis: List<String> = listOf("😀"),
        sticker: (Int) -> ByteArray = { if (animated) animWebp() else webp() },
    ): ByteArray = zip(
        (1..n).map { String.format("%02d.webp", it) to sticker(it) } +
            listOf("tray.png" to tray, "pack.json" to packJson(identifier, animated = animated, emojis = List(n) { emojis })),
    )

    fun fixture(name: String): ByteArray =
        requireNotNull(TestData::class.java.classLoader!!.getResourceAsStream("fixtures/$name")) { "missing fixture $name" }.use { it.readBytes() }

    fun read(bytes: ByteArray): ReadPack = PackReader.read(ByteArrayInputStream(bytes))
}
