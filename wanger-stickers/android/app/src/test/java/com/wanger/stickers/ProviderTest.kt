package com.wanger.stickers

import android.app.Application
import android.net.Uri
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import java.io.FileNotFoundException

/** The provider exactly as WhatsApp queries it (paths and columns of WhatsApp's official contract). */
@RunWith(RobolectricTestRunner::class)
class ProviderTest {
    private lateinit var app: Application
    private lateinit var auth: String
    private val zip = TestData.fixture("static.zip")

    @Before fun setUp() {
        app = RuntimeEnvironment.getApplication()
        auth = StickerContentProvider.authorityOf(app)
        PackStore.of(app.filesDir).save(TestData.read(zip))
        PackStore.of(app.filesDir).save(TestData.read(TestData.fixture("animated.zip")))
        Robolectric.setupContentProvider(StickerContentProvider::class.java, auth)
    }

    private fun uri(path: String) = Uri.parse("content://$auth/$path")

    @Test fun authorityMatchesTheManifest() {
        assertEquals("com.wanger.stickers.stickercontentprovider", auth)
        val info = app.packageManager.resolveContentProvider(auth, 0)
        assertNotNull("provider declared in the manifest", info)
        assertEquals("com.whatsapp.sticker.READ", info!!.readPermission)
        assertTrue(info.exported)
    }

    @Test fun metadataForAllPacksAndOne() {
        app.contentResolver.query(uri("metadata"), null, null, null, null)!!.use { c ->
            assertEquals(StickerContentProvider.PACK_COLUMNS.toList(), c.columnNames.toList())
            assertEquals(2, c.count)
            val ids = buildList { while (c.moveToNext()) add(c.getString(0)) }
            assertEquals(setOf("ws_gi4x_w1", "ws_gi4x_w2"), ids.toSet())
        }
        app.contentResolver.query(uri("metadata/ws_gi4x_w1"), null, null, null, null)!!.use { c ->
            assertEquals(1, c.count)
            c.moveToFirst()
            fun col(n: String) = c.getString(c.getColumnIndexOrThrow(n))
            assertEquals("پک تست Wanger", col("sticker_pack_name"))
            assertEquals("کیمی", col("sticker_pack_publisher"))
            assertEquals("tray.png", col("sticker_pack_icon"))
            assertEquals("1", col("image_data_version"))
            assertEquals("https://t.me/Wanger_Motionbot", col("sticker_pack_publisher_website"))
            assertEquals(0, c.getInt(c.getColumnIndexOrThrow("animated_sticker_pack")))
            assertEquals(0, c.getInt(c.getColumnIndexOrThrow("whatsapp_will_not_cache_stickers")))
        }
        app.contentResolver.query(uri("metadata/ws_gi4x_w2"), null, null, null, null)!!.use { c ->
            c.moveToFirst()
            assertEquals(1, c.getInt(c.getColumnIndexOrThrow("animated_sticker_pack")))
        }
        app.contentResolver.query(uri("metadata/unknown"), null, null, null, null)!!.use { assertEquals(0, it.count) }
    }

    @Test fun stickersWithEmojis() {
        app.contentResolver.query(uri("stickers/ws_gi4x_w1"), null, null, null, null)!!.use { c ->
            assertEquals(StickerContentProvider.STICKER_COLUMNS.toList(), c.columnNames.toList())
            val rows = buildList { while (c.moveToNext()) add(c.getString(0) to c.getString(1)) }
            assertEquals(listOf("01.webp" to "😂,🔥", "02.webp" to "😀", "03.webp" to "🥲"), rows)
        }
    }

    @Test fun servesStickerAndTrayBytes() {
        val raw = java.util.zip.ZipInputStream(zip.inputStream()).use { z ->
            buildMap { while (true) { val e = z.nextEntry ?: break; put(e.name, z.readBytes()) } }
        }
        for (name in listOf("01.webp", "03.webp", "tray.png")) {
            app.contentResolver.openAssetFileDescriptor(uri("stickers_asset/ws_gi4x_w1/$name"), "r")!!.use { fd ->
                assertEquals(raw.getValue(name).size.toLong(), fd.length)
                assertArrayEquals(raw.getValue(name), fd.createInputStream().readBytes())
            }
        }
        assertEquals("image/webp", app.contentResolver.getType(uri("stickers_asset/ws_gi4x_w1/01.webp")))
        assertEquals("image/png", app.contentResolver.getType(uri("stickers_asset/ws_gi4x_w1/tray.png")))
        assertEquals("vnd.android.cursor.dir/vnd.$auth.metadata", app.contentResolver.getType(uri("metadata")))
    }

    @Test fun refusesEverythingElse() {
        for (path in listOf("stickers_asset/ws_gi4x_w1/meta.json", "stickers_asset/ws_gi4x_w1/..%2Fmeta.json", "stickers_asset/nope/01.webp", "stickers_asset/ws_gi4x_w1/09.webp")) {
            try {
                app.contentResolver.openAssetFileDescriptor(uri(path), "r")
                throw AssertionError("served $path")
            } catch (e: FileNotFoundException) {
            }
        }
        try {
            app.contentResolver.openAssetFileDescriptor(uri("stickers_asset/ws_gi4x_w1/01.webp"), "w")
            throw AssertionError("writable")
        } catch (e: FileNotFoundException) {
        }
        try {
            app.contentResolver.query(uri("other"), null, null, null, null)
            throw AssertionError("unknown path answered")
        } catch (e: IllegalArgumentException) {
        }
    }
}
