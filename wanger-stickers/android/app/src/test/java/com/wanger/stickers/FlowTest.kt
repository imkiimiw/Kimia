package com.wanger.stickers

import android.app.Activity
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageInfo
import android.net.Uri
import android.os.Looper
import android.view.View
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.test.core.app.ActivityScenario
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowActivity
import java.io.ByteArrayInputStream

/**
 * The user's path through the app: Telegram "Open with" → pack stored → "Add to WhatsApp" →
 * WhatsApp's intent, its answer, and every refusal on the way. Runs on Android 7.0 (24, the oldest
 * Robolectric still ships; the app itself supports 6.0) and on the newest (36).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [24, 36], qualifiers = "w411dp-h891dp-xxhdpi") // a common phone screen (Robolectric's default is 320×470 dp)
class FlowTest {
    @get:Rule val compose = createEmptyComposeRule()
    private val app get() = RuntimeEnvironment.getApplication()
    private val store get() = PackStore.of(app.filesDir)
    private var scenario: ActivityScenario<MainActivity>? = null

    @Before fun clean() = store.list().forEach { store.delete(it.identifier) }

    @After fun close() {
        scenario?.close()
    }

    private fun launch(intent: Intent = Intent(app, MainActivity::class.java)): MainActivity {
        scenario?.close()
        val s = ActivityScenario.launch<MainActivity>(intent)
        scenario = s
        var a: MainActivity? = null
        s.onActivity { a = it }
        return a!!
    }

    private fun open(bytes: ByteArray, send: Boolean = false): MainActivity {
        val uri = Uri.parse("content://org.telegram.messenger.provider/media/pack.zip")
        shadowOf(app.contentResolver).registerInputStream(uri, ByteArrayInputStream(bytes))
        val i = Intent(app, MainActivity::class.java)
        if (send) i.setAction(Intent.ACTION_SEND).setType("application/zip").putExtra(Intent.EXTRA_STREAM, uri)
        else i.setAction(Intent.ACTION_VIEW).setData(uri)
        return launch(i)
    }

    private fun waitTag(tag: String) = compose.waitUntil(8_000) { compose.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty() }
    private fun gone(tag: String) = compose.waitUntil(8_000) { compose.onAllNodesWithTag(tag).fetchSemanticsNodes().isEmpty() }
    private fun text(tag: String): String =
        compose.onNodeWithTag(tag, useUnmergedTree = true).fetchSemanticsNode().config.getOrNull(SemanticsProperties.Text)?.joinToString("") { it.text }.orEmpty()

    private fun installWhatsApp(pkg: String) {
        shadowOf(app.packageManager).installPackage(PackageInfo().apply {
            packageName = pkg
            applicationInfo = ApplicationInfo().apply { packageName = pkg; enabled = true }
        })
    }

    private fun startedForResult(a: Activity): ShadowActivity.IntentForResult {
        var started: ShadowActivity.IntentForResult? = null
        compose.waitUntil(8_000) {
            shadowOf(Looper.getMainLooper()).idle() // the coroutine that launches it resumes on the main looper
            shadowOf(a).nextStartedActivityForResult?.also { started = it } != null
        }
        return started!!
    }

    @Test fun opensTheBotsZipAndAddsItToWhatsApp() {
        val a = open(TestData.fixture("static.zip"))
        waitTag("imported")
        assertEquals("پک تست Wanger", text("imported_name"))
        assertEquals("ws_gi4x_w1", store.list().single().identifier)
        compose.onNodeWithText(app.getString(R.string.ready_title)).assertExists()

        // no WhatsApp on the phone → a clear message
        compose.onNode(hasTestTag("add") and hasAnyAncestor(hasTestTag("imported"))).performClick()
        waitTag("failed")
        assertEquals(app.getString(R.string.no_whatsapp), text("failed_message"))
        compose.onNodeWithText(app.getString(R.string.ok)).performClick()
        gone("failed")

        // the card in the list
        waitTag("pack_ws_gi4x_w1")

        // WhatsApp installed → its own ENABLE_STICKER_PACK screen, aimed at that app
        installWhatsApp(WhatsApp.CONSUMER)
        compose.onNode(hasTestTag("add") and hasAnyAncestor(hasTestTag("pack_ws_gi4x_w1"))).performScrollTo().performClick()
        val started = startedForResult(a)
        val i = started.intent
        assertEquals("com.whatsapp.intent.action.ENABLE_STICKER_PACK", i.action)
        assertEquals("com.whatsapp", i.`package`)
        assertEquals("ws_gi4x_w1", i.getStringExtra("sticker_pack_id"))
        assertEquals("com.wanger.stickers.stickercontentprovider", i.getStringExtra("sticker_pack_authority"))
        assertEquals("پک تست Wanger", i.getStringExtra("sticker_pack_name"))

        // WhatsApp refuses → its reason is shown
        shadowOf(a).receiveResult(i, Activity.RESULT_CANCELED, Intent().putExtra("validation_error", "tray too big"))
        compose.waitUntil(8_000) { compose.onAllNodesWithTag("failed_message").fetchSemanticsNodes().isNotEmpty() && text("failed_message").contains("tray too big") }
        assertEquals(app.getString(R.string.wa_refused, "tray too big"), text("failed_message"))
    }

    @Test fun bothWhatsAppsGetAChooser() {
        installWhatsApp(WhatsApp.CONSUMER)
        installWhatsApp(WhatsApp.BUSINESS)
        val a = open(TestData.fixture("animated.zip"), send = true)
        waitTag("imported")
        assertEquals("Moving test", text("imported_name"))
        compose.onNode(hasTestTag("add") and hasAnyAncestor(hasTestTag("imported"))).performClick()
        val started = startedForResult(a)
        assertEquals(Intent.ACTION_CHOOSER, started.intent.action)
        @Suppress("DEPRECATION")
        val inner = started.intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)!!
        assertEquals(WhatsApp.ACTION_ENABLE, inner.action)
        assertEquals(null, inner.`package`)
    }

    @Test fun reimportUpdatesTheSamePack() {
        open(TestData.fixture("static.zip"))
        waitTag("imported")
        open(TestData.fixture("static.zip"))
        compose.waitUntil(8_000) { store.list().singleOrNull()?.version == 2 }
        waitTag("imported")
        assertEquals(1, store.list().size)
    }

    @Test fun explainsRefusals() {
        val cases = listOf(
            "not a zip".toByteArray() to app.getString(R.string.err_not_zip),
            TestData.packZip(n = 2) to app.resources.getQuantityString(R.plurals.err_too_few, 2, 2),
            TestData.packZip { if (it == 2) TestData.webp(400, 400) else TestData.webp() } to app.getString(R.string.err_sticker_not_512, 2),
        )
        for ((bytes, expected) in cases) {
            open(bytes)
            waitTag("failed_message")
            assertEquals(expected, text("failed_message"))
        }
        assertTrue(store.list().isEmpty())
    }

    @Test fun packScreenPreviewAndDelete() {
        store.save(TestData.read(TestData.fixture("static.zip")))
        launch()
        waitTag("pack_ws_gi4x_w1")
        compose.onNodeWithTag("pack_ws_gi4x_w1").performScrollTo().performClick()
        waitTag("pack_screen")
        assertEquals("پک تست Wanger", text("pack_name"))
        for (k in 0..2) waitTag("sticker_$k")
        compose.onNode(hasContentDescription("😂 🔥"), useUnmergedTree = true).assertExists() // emojis are the accessibility text
        // a sticker large, then closed
        compose.onNodeWithTag("sticker_1").performScrollTo().performClick()
        waitTag("preview")
        compose.onNodeWithText(app.getString(R.string.close)).performClick()
        gone("preview")
        // back to the list and in again
        compose.onNodeWithTag("back").performClick()
        waitTag("pack_ws_gi4x_w1")
        compose.onNodeWithTag("pack_ws_gi4x_w1").performScrollTo().performClick()
        waitTag("pack_screen")
        // delete from the pack screen
        compose.onNodeWithTag("delete").performClick()
        waitTag("confirm_delete")
        compose.onNodeWithTag("confirm_delete").performClick()
        waitTag("empty")
        assertTrue(store.list().isEmpty())
    }

    @Test @Config(qualifiers = "+fa")
    fun speaksPersian() {
        val a = open(TestData.fixture("static.zip"))
        waitTag("imported")
        assertEquals("پکت آماده است 🎉", app.getString(R.string.ready_title))
        assertEquals("افزودن به واتس‌اپ", app.getString(R.string.add))
        assertEquals(View.LAYOUT_DIRECTION_RTL, a.window.decorView.layoutDirection)
    }
}
