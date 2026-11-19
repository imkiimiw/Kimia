package com.wanger.stickers

import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.net.Uri
import android.os.Looper
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.core.app.ActivityScenario
import org.junit.After
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.shadows.ShadowDialog
import java.io.ByteArrayInputStream
import java.io.File

/**
 * Renders the screens with real graphics (Robolectric native mode) into app/build/screenshots/ for
 * a look without a phone; open sheets and dialogs (their own windows) are drawn on top. Not a pixel
 * test: it fails only if drawing fails.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [36], qualifiers = "fa-w411dp-h891dp-xxhdpi")
class ScreenshotTest {
    @get:Rule val compose = createEmptyComposeRule()
    private val app get() = RuntimeEnvironment.getApplication()
    private val store get() = PackStore.of(app.filesDir)
    private var scenario: ActivityScenario<MainActivity>? = null

    @After fun close() {
        scenario?.close()
    }

    private fun packs(vararg names: String) {
        store.list().forEach { store.delete(it.identifier) }
        for (n in names) store.save(TestData.read(TestData.fixture(n)))
    }

    private fun launch(intent: Intent = Intent(app, MainActivity::class.java)) {
        scenario = ActivityScenario.launch(intent)
    }

    /** Lets images decode (IO thread) and animations settle. */
    private fun settle(ms: Long = 1200) {
        val end = System.currentTimeMillis() + ms
        while (System.currentTimeMillis() < end) {
            compose.mainClock.advanceTimeBy(100)
            shadowOf(Looper.getMainLooper()).idle()
            Thread.sleep(25)
        }
        compose.waitForIdle()
    }

    private fun shot(name: String) {
        var bitmap: Bitmap? = null
        scenario!!.onActivity { a ->
            val v = a.window.decorView
            val b = Bitmap.createBitmap(v.width, v.height, Bitmap.Config.ARGB_8888)
            val c = Canvas(b)
            v.draw(c)
            ShadowDialog.getShownDialogs().filter { it.isShowing }.forEach { d ->
                val dv = d.window!!.decorView
                c.save()
                if (dv.width < v.width || dv.height < v.height) {
                    // a centred dialog: the system dims what is behind it
                    c.drawColor(0x99000000.toInt())
                    c.translate((v.width - dv.width) / 2f, (v.height - dv.height) / 2f)
                }
                dv.draw(c)
                c.restore()
            }
            bitmap = b
        }
        val dir = File("build/screenshots").apply { mkdirs() }
        File(dir, "$name.png").outputStream().use { bitmap!!.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private fun waitTag(tag: String) = compose.waitUntil(8_000) { compose.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty() }

    @Test fun home() {
        packs("animated.zip", "static.zip")
        launch()
        waitTag("pack_ws_gi4x_w1")
        settle()
        shot("home-fa")
        compose.onNodeWithTag("new_pack").performClick()
        waitTag("opt_file")
        settle(800)
        shot("add-sheet-fa")
    }

    @Test @Config(qualifiers = "fa-w411dp-h891dp-night-xxhdpi")
    fun homeDark() {
        packs("animated.zip", "static.zip")
        launch()
        waitTag("pack_ws_gi4x_w1")
        settle()
        shot("home-fa-night")
    }

    @Test fun empty() {
        packs()
        launch()
        waitTag("empty")
        settle(600)
        shot("empty-fa")
    }

    @Test fun pack() {
        packs("static.zip")
        launch()
        waitTag("pack_ws_gi4x_w1")
        compose.onNodeWithTag("pack_ws_gi4x_w1").performScrollTo().performClick()
        waitTag("pack_screen")
        settle()
        shot("pack-fa")
        compose.onNodeWithTag("sticker_0").performClick()
        waitTag("preview")
        settle(800)
        shot("preview-fa")
    }

    @Test fun imported() {
        packs()
        val uri = Uri.parse("content://org.telegram.messenger.provider/media/pack.zip")
        shadowOf(app.contentResolver).registerInputStream(uri, ByteArrayInputStream(TestData.fixture("static.zip")))
        launch(Intent(app, MainActivity::class.java).setAction(Intent.ACTION_VIEW).setData(uri))
        waitTag("imported")
        settle()
        shot("imported-fa")
    }

    @Test @Config(qualifiers = "en-w411dp-h891dp-xxhdpi")
    fun homeEnglish() {
        packs("animated.zip", "static.zip")
        launch()
        waitTag("pack_ws_gi4x_w1")
        settle()
        shot("home-en")
    }
}
