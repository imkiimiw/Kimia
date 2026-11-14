package com.wanger.stickers

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MediaTest {
    @Test fun readsStillWebP() {
        val w = Media.webp(TestData.webp(512, 400))!!
        assertEquals(512, w.width)
        assertEquals(400, w.height)
        assertFalse(w.animated)
        assertEquals(1, w.frames)
    }

    @Test fun readsAnimatedWebP() {
        val w = Media.webp(TestData.animWebp(frameMs = listOf(100, 40, 60), loop = 0))!!
        assertTrue(w.animated)
        assertEquals(3, w.frames)
        assertEquals(200, w.durationMs)
        assertEquals(40, w.minFrameMs)
        assertEquals(0, w.loop)
        assertEquals(512, w.width)
    }

    @Test fun refusesBrokenFiles() {
        assertNull(Media.webp(ByteArray(0)))
        assertNull(Media.webp("RIFF....WEBPVP8L".toByteArray()))
        val ok = TestData.webp()
        assertNull(Media.webp(ok.copyOf(ok.size - 10))) // truncated
        assertNull(Media.png(TestData.webp()))
        assertNull(Media.png(ByteArray(40)))
    }

    @Test fun readsPng() {
        assertEquals(Media.Png(96, 96), Media.png(TestData.png()))
        assertEquals(Media.Png(24, 512), Media.png(TestData.png(24, 512)))
    }

    @Test fun readsRealEncoderOutput() {
        // Chromium's libwebp: lossy VP8 with an ALPH chunk inside VP8X (see the fixtures script)
        val p = TestData.read(TestData.fixture("static.zip"))
        for (s in p.meta.stickers) {
            val w = Media.webp(p.files.getValue(s.file))!!
            assertEquals(512 to 512, w.width to w.height)
        }
    }
}
