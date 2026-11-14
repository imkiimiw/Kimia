package com.wanger.stickers

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageInfo
import android.net.Uri
import android.os.Looper
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowDialog
import java.io.ByteArrayInputStream

/**
 * The user's path through the app: Telegram "Open with" → pack stored → "Add to WhatsApp" →
 * WhatsApp's intent, its answer, and every refusal on the way. Runs on Android 7.0 (24, the oldest
 * Robolectric still ships; the app itself supports 6.0) and on the newest (36).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [24, 36])
class FlowTest {
    private val app get() = RuntimeEnvironment.getApplication()

    @Before fun clean() {
        PackStore.of(app.filesDir).list().forEach { PackStore.of(app.filesDir).delete(it.identifier) }
    }

    /** Runs the background thread's work and the main-thread replies until [done] or a timeout. */
    private fun settle(done: () -> Boolean) {
        repeat(200) {
            shadowOf(Looper.getMainLooper()).idle()
            if (done()) return
            Thread.sleep(10)
        }
        throw AssertionError("timed out")
    }

    private fun latestDialog(): AlertDialog? = ShadowDialog.getLatestDialog() as? AlertDialog
    private fun message(d: AlertDialog) = d.findViewById<TextView>(android.R.id.message).text.toString()

    private fun open(bytes: ByteArray, action: String = Intent.ACTION_VIEW): Activity {
        val uri = Uri.parse("content://org.telegram.messenger.provider/media/pack.zip")
        shadowOf(app.contentResolver).registerInputStream(uri, ByteArrayInputStream(bytes))
        val intent = if (action == Intent.ACTION_VIEW) Intent(action, uri) else Intent(action).setType("application/zip").putExtra(Intent.EXTRA_STREAM, uri)
        return Robolectric.buildActivity(MainActivity::class.java, intent).setup().get()
    }

    private fun installWhatsApp(pkg: String) {
        shadowOf(app.packageManager).installPackage(PackageInfo().apply {
            packageName = pkg
            applicationInfo = ApplicationInfo().apply { packageName = pkg; enabled = true }
        })
    }

    private fun rows(a: Activity) = a.findViewById<LinearLayout>(R.id.list)

    @Test fun opensTheBotsZipAndAddsItToWhatsApp() {
        val a = open(TestData.fixture("static.zip"))
        settle { latestDialog()?.isShowing == true && rows(a).childCount == 1 }
        val d = latestDialog()!!
        assertTrue(message(d), message(d).startsWith("“پک تست Wanger” is ready: 3 stickers."))
        assertEquals("ws_gi4x_w1", PackStore.of(app.filesDir).list().single().identifier)
        val row = rows(a).getChildAt(0)
        assertEquals("پک تست Wanger", row.findViewById<TextView>(R.id.name).text.toString())
        assertEquals("کیمی · 3 stickers", row.findViewById<TextView>(R.id.details).text.toString())

        // no WhatsApp on the phone → a clear message
        d.getButton(AlertDialog.BUTTON_POSITIVE).performClick()
        settle { latestDialog() !== d }
        assertEquals(app.getString(R.string.no_whatsapp), message(latestDialog()!!))

        // WhatsApp installed → its own ENABLE_STICKER_PACK screen, aimed at that app
        installWhatsApp(WhatsApp.CONSUMER)
        row.findViewById<Button>(R.id.add).performClick()
        var started: org.robolectric.shadows.ShadowActivity.IntentForResult? = null
        settle { shadowOf(a).nextStartedActivityForResult?.also { started = it } != null }
        val i = started!!.intent
        assertEquals(BaseActivity.REQ_ADD, started!!.requestCode)
        assertEquals("com.whatsapp.intent.action.ENABLE_STICKER_PACK", i.action)
        assertEquals("com.whatsapp", i.`package`)
        assertEquals("ws_gi4x_w1", i.getStringExtra("sticker_pack_id"))
        assertEquals("com.wanger.stickers.stickercontentprovider", i.getStringExtra("sticker_pack_authority"))
        assertEquals("پک تست Wanger", i.getStringExtra("sticker_pack_name"))

        // WhatsApp refuses → its reason is shown
        shadowOf(a).receiveResult(i, Activity.RESULT_CANCELED, Intent().putExtra("validation_error", "tray too big"))
        settle { latestDialog()?.let { message(it).contains("tray too big") } == true }
        assertEquals(app.getString(R.string.wa_refused, "tray too big"), message(latestDialog()!!))
    }

    @Test fun bothWhatsAppsGetAChooser() {
        installWhatsApp(WhatsApp.CONSUMER)
        installWhatsApp(WhatsApp.BUSINESS)
        val a = open(TestData.fixture("animated.zip"), Intent.ACTION_SEND)
        settle { latestDialog()?.isShowing == true && rows(a).childCount == 1 }
        assertEquals("Kimi · 3 animated stickers", rows(a).getChildAt(0).findViewById<TextView>(R.id.details).text.toString())
        latestDialog()!!.getButton(AlertDialog.BUTTON_POSITIVE).performClick()
        var started: org.robolectric.shadows.ShadowActivity.IntentForResult? = null
        settle { shadowOf(a).nextStartedActivityForResult?.also { started = it } != null }
        assertEquals(Intent.ACTION_CHOOSER, started!!.intent.action)
        @Suppress("DEPRECATION")
        val inner = started!!.intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)!!
        assertEquals(WhatsApp.ACTION_ENABLE, inner.action)
        assertEquals(null, inner.`package`)
    }

    @Test fun reimportUpdatesTheSamePack() {
        open(TestData.fixture("static.zip"))
        settle { latestDialog()?.isShowing == true }
        latestDialog()!!.dismiss()
        open(TestData.fixture("static.zip"))
        settle { latestDialog()?.let { message(it).startsWith("“پک تست Wanger” was updated") } == true }
        val p = PackStore.of(app.filesDir).list().single()
        assertEquals(2, p.version)
    }

    @Test fun explainsRefusals() {
        val cases = listOf(
            "not a zip".toByteArray() to app.getString(R.string.err_not_zip),
            TestData.packZip(n = 2) to app.resources.getQuantityString(R.plurals.err_too_few, 2, 2),
            TestData.packZip { if (it == 2) TestData.webp(400, 400) else TestData.webp() } to app.getString(R.string.err_sticker_not_512, 2),
        )
        for ((bytes, expected) in cases) {
            val before = latestDialog()
            open(bytes)
            settle { latestDialog().let { it != null && it !== before } }
            assertEquals(expected, message(latestDialog()!!))
        }
        assertTrue(PackStore.of(app.filesDir).list().isEmpty())
    }

    @Test @Config(qualifiers = "fa")
    fun speaksPersian() {
        val a = open(TestData.fixture("static.zip"))
        settle { latestDialog()?.isShowing == true && rows(a).childCount == 1 }
        assertTrue(message(latestDialog()!!), message(latestDialog()!!).startsWith("«پک تست Wanger» آماده است"))
        assertEquals("افزودن به واتس\u200cاپ", rows(a).getChildAt(0).findViewById<Button>(R.id.add).text.toString())
        assertEquals(android.view.View.LAYOUT_DIRECTION_RTL, a.window.decorView.layoutDirection)
    }

    @Test fun packScreenShowsStickers() {
        PackStore.of(app.filesDir).save(TestData.read(TestData.fixture("static.zip")))
        val a = Robolectric.buildActivity(PackActivity::class.java, Intent(app, PackActivity::class.java).putExtra(PackActivity.EXTRA_ID, "ws_gi4x_w1")).setup().get()
        val grid = a.findViewById<android.widget.GridLayout>(R.id.grid)
        settle { grid.childCount == 3 }
        assertEquals("😂 🔥", grid.getChildAt(0).contentDescription)
        assertNotNull(a.findViewById<Button>(R.id.delete))
    }
}
