package com.wanger.stickers

import com.wanger.stickers.ImportException.Code
import com.wanger.stickers.TestData.animWebp
import com.wanger.stickers.TestData.fixture
import com.wanger.stickers.TestData.packZip
import com.wanger.stickers.TestData.png
import com.wanger.stickers.TestData.read
import com.wanger.stickers.TestData.webp
import com.wanger.stickers.TestData.zip
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.util.zip.ZipInputStream

class PackReaderTest {
    private fun refused(bytes: ByteArray, code: Code, sticker: Int = 0, count: Int = -1): ImportException {
        try {
            read(bytes)
        } catch (e: ImportException) {
            assertEquals(code, e.code)
            assertEquals(sticker, e.sticker)
            if (count >= 0) assertEquals(count, e.count)
            return e
        }
        fail("expected $code")
        throw AssertionError()
    }

    private fun entries(bytes: ByteArray): Map<String, ByteArray> {
        val out = LinkedHashMap<String, ByteArray>()
        ZipInputStream(bytes.inputStream()).use { z -> while (true) { val e = z.nextEntry ?: break; out[e.name] = z.readBytes() } }
        return out
    }

    // ---- the bot's own exports (scripts/android-fixtures.mjs: real Chromium WebP/PNG through the real endpoints)

    @Test fun readsTheBotsStaticZip() {
        val bytes = fixture("static.zip")
        val p = read(bytes)
        assertEquals("ws_gi4x_w1", p.meta.identifier)
        assertEquals("پک تست Wanger", p.meta.name)
        assertEquals("کیمی", p.meta.publisher)
        assertFalse(p.meta.animated)
        assertEquals(listOf("01.webp", "02.webp", "03.webp"), p.meta.stickers.map { it.file })
        assertEquals(listOf(listOf("😂", "🔥"), listOf("😀"), listOf("🥲")), p.meta.stickers.map { it.emojis })
        val raw = entries(bytes)
        for (name in listOf("01.webp", "02.webp", "03.webp", "tray.png")) assertArrayEquals(raw.getValue(name), p.files.getValue(name))
        val info = Media.webp(p.files.getValue("01.webp"))!!
        assertEquals(512, info.width)
        assertFalse(info.animated)
        assertEquals(Media.Png(96, 96), Media.png(p.files.getValue("tray.png")))
    }

    @Test fun readsTheBotsAnimatedZip() {
        val p = read(fixture("animated.zip"))
        assertTrue(p.meta.animated)
        assertEquals("Moving test", p.meta.name)
        for (s in p.meta.stickers) {
            val info = Media.webp(p.files.getValue(s.file))!!
            assertTrue(info.animated)
            assertEquals(4, info.frames)
            assertEquals(480, info.durationMs)
            assertEquals(0, info.loop)
            assertTrue(p.files.getValue(s.file).size <= Limits.ANIMATED_MAX_BYTES)
        }
    }

    @Test fun readsTheBotsWaStickers() {
        val p = read(fixture("animated.wastickers"))
        assertTrue(p.meta.identifier, p.meta.identifier.matches(Regex("^wst_[0-9a-f]{16}$")))
        assertEquals(p.meta.identifier, read(fixture("animated.wastickers")).meta.identifier) // stable → a re-import replaces
        assertEquals("Moving test", p.meta.name)
        assertEquals("Kimi", p.meta.publisher)
        assertTrue(p.meta.animated)
        assertEquals(3, p.meta.stickers.size)
        assertTrue(p.meta.stickers.all { it.emojis == listOf("😀") }) // .wastickers has none; WhatsApp needs one
    }

    // ---- WhatsApp's rules

    @Test fun refusesWhatIsNotAPack() {
        refused(ByteArray(0), Code.NOT_ZIP)
        refused("hello".toByteArray(), Code.NOT_ZIP)
        refused(webp(), Code.NOT_ZIP)
        refused(zip(listOf("readme.txt" to "x".toByteArray())), Code.NO_PACK)
        refused(zip(listOf("pack.json" to "{nope".toByteArray())), Code.BAD_META)
        refused(zip(List(Limits.MAX_ENTRIES + 1) { "f$it.txt" to ByteArray(1) }), Code.TOO_BIG)
    }

    @Test fun countsStickers() {
        refused(packZip(n = 2), Code.TOO_FEW, count = 2)
        refused(packZip(n = 31), Code.TOO_MANY, count = 31)
        assertEquals(30, read(packZip(n = 30)).meta.stickers.size)
    }

    @Test fun checksEverySticker() {
        refused(packZip { if (it == 2) webp(513, 512) else webp() }, Code.STICKER_NOT_512, sticker = 2)
        refused(packZip { if (it == 3) "not webp".toByteArray() else webp() }, Code.STICKER_NOT_WEBP, sticker = 3)
        refused(packZip { if (it == 1) webp(size = 101 * 1024) else webp() }, Code.STICKER_TOO_BIG, sticker = 1)
        refused(packZip(animated = true) { if (it == 2) animWebp(frameBytes = 60_000) else animWebp() }, Code.STICKER_TOO_BIG, sticker = 2)
        refused(packZip { if (it == 2) animWebp() else webp() }, Code.STICKER_MIXED, sticker = 2)
        refused(packZip(animated = true) { if (it == 3) webp() else animWebp() }, Code.STICKER_MIXED, sticker = 3)
        refused(packZip(animated = true) { if (it == 1) animWebp(frameMs = listOf(100, 5, 100)) else animWebp() }, Code.STICKER_FRAME_TOO_SHORT, sticker = 1)
        refused(packZip(animated = true) { if (it == 2) animWebp(frameMs = List(21) { 500 }) else animWebp() }, Code.STICKER_TOO_LONG, sticker = 2)
        // a file the pack lists but the ZIP lacks
        refused(zip(listOf("01.webp" to webp(), "tray.png" to png(), "pack.json" to TestData.packJson(emojis = List(3) { listOf("😀") }))), Code.STICKER_MISSING, sticker = 2)
        // 8 ms and exactly 10 s are allowed
        read(packZip(animated = true) { animWebp(frameMs = listOf(8) + List(9) { 999 } + listOf(1001)) })
    }

    @Test fun checksTheTray() {
        refused(zip(listOf("01.webp" to webp(), "02.webp" to webp(), "03.webp" to webp(), "pack.json" to TestData.packJson(emojis = List(3) { listOf("😀") }))), Code.NO_TRAY)
        refused(packZip(tray = png(20, 20)), Code.BAD_TRAY)
        refused(packZip(tray = png(600, 600)), Code.BAD_TRAY)
        refused(packZip(tray = png(size = 51 * 1024)), Code.BAD_TRAY)
        refused(packZip(tray = webp(96, 96)), Code.BAD_TRAY)
        read(packZip(tray = png(512, 512)))
    }

    @Test fun checksTheIdentifier() {
        for (bad in listOf("", "../evil", "a..b", "a/b", "ünï", "x".repeat(128))) refused(packZip(identifier = bad), Code.IDENTIFIER)
        read(packZip(identifier = "ws_abc_w1"))
        read(packZip(identifier = "My pack-1.2"))
    }

    @Test fun normalisesEmojisNamesAndFileNames() {
        assertEquals(listOf("😀", "😂", "🔥"), read(packZip(emojis = listOf("😀", "😂", "🔥", "🎉", "❤️"))).meta.stickers[0].emojis)
        assertEquals(listOf("😀"), read(packZip(emojis = listOf(" ", ""))).meta.stickers[0].emojis)
        // name on one line, at most 128 UTF-16 units, never cutting an emoji in half
        val long = "a".repeat(127) + "😀" + "b"
        val bytes = zip(
            (1..3).map { String.format("%02d.webp", it) to webp() } + listOf(
                "tray.png" to png(),
                "pack.json" to TestData.packJson(name = "line one\nline  two", publisher = long, emojis = List(3) { listOf("😀") }),
            ),
        )
        val m = read(bytes).meta
        assertEquals("line one line two", m.name)
        assertEquals("a".repeat(127), m.publisher)
        // entries inside a folder (a re-zipped download) and odd names are found by their base name
        val nested = zip((1..3).map { "My Pack/" + String.format("%02d.webp", it) to webp() } + listOf("My Pack/tray.png" to png(), "My Pack/pack.json" to TestData.packJson(emojis = List(3) { listOf("😀") }), "__MACOSX/._tray.png" to ByteArray(3)))
        assertEquals(3, read(nested).meta.stickers.size)
    }

    @Test fun refusesNamelessPacks() {
        refused(zip((1..3).map { String.format("%02d.webp", it) to webp() } + listOf("tray.png" to png(), "pack.json" to TestData.packJson(name = "  ", emojis = List(3) { listOf("😀") }))), Code.NAME)
        refused(zip((1..3).map { String.format("%02d.webp", it) to webp() } + listOf("tray.png" to png(), "pack.json" to TestData.packJson(publisher = "", emojis = List(3) { listOf("😀") }))), Code.PUBLISHER)
    }
}
