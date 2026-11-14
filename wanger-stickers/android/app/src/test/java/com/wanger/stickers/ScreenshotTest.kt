package com.wanger.stickers

import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Looper
import android.widget.GridLayout
import android.widget.LinearLayout
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

/**
 * Renders the two screens with real graphics (Robolectric native mode) into
 * app/build/screenshots/ for a look without a phone. Not a pixel test: it only fails if drawing fails.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [36], qualifiers = "w411dp-h891dp-xxhdpi")
class ScreenshotTest {
    private val app get() = RuntimeEnvironment.getApplication()

    @Before fun packs() {
        val store = PackStore.of(app.filesDir)
        store.list().forEach { store.delete(it.identifier) }
        store.save(TestData.read(TestData.fixture("animated.zip")))
        store.save(TestData.read(TestData.fixture("static.zip")))
    }

    private fun settle(done: () -> Boolean) {
        repeat(300) {
            shadowOf(Looper.getMainLooper()).idle()
            if (done()) return
            Thread.sleep(10)
        }
    }

    private fun shot(a: Activity, name: String) {
        val v = a.window.decorView
        val b = Bitmap.createBitmap(v.width, v.height, Bitmap.Config.ARGB_8888)
        v.draw(Canvas(b))
        val dir = File("build/screenshots").apply { mkdirs() }
        File(dir, "$name.png").outputStream().use { b.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private fun mainScreen(name: String) {
        val a = Robolectric.buildActivity(MainActivity::class.java).setup().get()
        settle { a.findViewById<LinearLayout>(R.id.list).childCount == 2 }
        shot(a, name)
    }

    private fun packScreen(name: String) {
        val a = Robolectric.buildActivity(PackActivity::class.java, Intent(app, PackActivity::class.java).putExtra(PackActivity.EXTRA_ID, "ws_gi4x_w1")).setup().get()
        val grid = a.findViewById<GridLayout>(R.id.grid)
        settle { grid.childCount == 3 && (0 until 3).all { (grid.getChildAt(it) as android.widget.ImageView).drawable != null } }
        shot(a, name)
    }

    @Test fun english() {
        mainScreen("main-en")
        packScreen("pack-en")
    }

    @Test @Config(qualifiers = "fa-w411dp-h891dp-xxhdpi")
    fun persian() {
        mainScreen("main-fa")
        packScreen("pack-fa")
    }

    @Test @Config(qualifiers = "fa-w411dp-h891dp-night-xxhdpi")
    fun persianDark() = mainScreen("main-fa-night")

    @Test @Config(qualifiers = "fa-w411dp-h891dp-xxhdpi")
    fun empty() {
        PackStore.of(app.filesDir).list().forEach { PackStore.of(app.filesDir).delete(it.identifier) }
        val a = Robolectric.buildActivity(MainActivity::class.java).setup().get()
        settle { false }
        shot(a, "empty-fa")
    }
}
