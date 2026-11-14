package com.wanger.stickers

import android.app.Activity
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.Drawable
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.View
import android.widget.Toast
import java.io.File
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * What both screens share: a background thread for disk and WhatsApp queries, system-bar insets
 * (Android 15+ always draws edge to edge), dialogs, and the add-to-WhatsApp flow with its result.
 */
abstract class BaseActivity : Activity() {
    protected val store: PackStore by lazy { PackStore.of(filesDir) }
    private val io: ExecutorService = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())

    /** Runs [work] off the main thread; [done] runs on it, unless the screen is gone. */
    protected fun <T> background(work: () -> T, done: (Result<T>) -> Unit) {
        io.execute {
            val r = runCatching(work)
            main.post { if (!isFinishing && !isDestroyed) done(r) }
        }
    }

    override fun onDestroy() {
        io.shutdownNow()
        super.onDestroy()
    }

    /** Pads [root] by the system bars so nothing hides under them. */
    protected fun applyInsets(root: View) {
        val l = root.paddingLeft
        val t = root.paddingTop
        val r = root.paddingRight
        val b = root.paddingBottom
        root.setOnApplyWindowInsetsListener { v, insets ->
            @Suppress("DEPRECATION")
            v.setPadding(l + insets.systemWindowInsetLeft, t + insets.systemWindowInsetTop, r + insets.systemWindowInsetRight, b + insets.systemWindowInsetBottom)
            insets
        }
        root.requestApplyInsets()
    }

    protected fun alert(message: String, title: String? = null) {
        AlertDialog.Builder(this).setTitle(title).setMessage(message).setPositiveButton(R.string.ok, null).show()
    }

    protected fun toast(res: Int) = Toast.makeText(this, res, Toast.LENGTH_SHORT).show()

    /** Whether every installed WhatsApp already has the pack (false when none is installed). */
    protected fun addedEverywhere(pack: PackMeta): Boolean {
        val apps = WhatsApp.apps(this)
        return apps.isNotEmpty() && apps.all { WhatsApp.isAdded(this, it, pack.identifier) == true }
    }

    /**
     * Asks WhatsApp to add the pack: straight to the one app that lacks it, or a chooser when both
     * WhatsApp and WhatsApp Business lack it (the flow of WhatsApp's own sample).
     */
    protected fun addToWhatsApp(pack: PackMeta) {
        background({ WhatsApp.apps(this).map { it to WhatsApp.isAdded(this, it, pack.identifier) } }) { r ->
            val states = r.getOrDefault(emptyList())
            if (states.isEmpty()) {
                alert(getString(R.string.no_whatsapp))
                return@background
            }
            val missing = states.filter { it.second != true }.map { it.first }
            if (missing.isEmpty()) {
                toast(R.string.already_added)
                return@background
            }
            val intent = if (missing.size == 1) WhatsApp.addIntent(this, pack, missing[0])
            else Intent.createChooser(WhatsApp.addIntent(this, pack, null), getString(R.string.add_to))
            try {
                startActivityForResult(intent, REQ_ADD)
            } catch (e: ActivityNotFoundException) {
                alert(getString(R.string.wa_too_old))
            }
        }
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode != REQ_ADD) {
            super.onActivityResult(requestCode, resultCode, data)
            return
        }
        if (resultCode == RESULT_OK) {
            toast(R.string.added_ok)
        } else {
            data?.getStringExtra(WhatsApp.EXTRA_VALIDATION_ERROR)?.let { alert(getString(R.string.wa_refused, it)) }
        }
        onPacksChanged()
    }

    protected fun confirmDelete(pack: PackMeta, after: () -> Unit) {
        AlertDialog.Builder(this)
            .setMessage(getString(R.string.delete_q, pack.name))
            .setPositiveButton(R.string.delete) { _, _ ->
                background({ store.delete(pack.identifier) }) {
                    StickerContentProvider.notifyChanged(this)
                    toast(R.string.deleted)
                    after()
                }
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    /** Called after WhatsApp answered or a pack changed; screens reload. */
    protected open fun onPacksChanged() {}

    protected fun details(pack: PackMeta): String =
        resources.getQuantityString(if (pack.animated) R.plurals.details_animated else R.plurals.details, pack.stickers.size, pack.publisher, pack.stickers.size)

    companion object {
        const val REQ_ADD = 200

        /** A small bitmap of a still image (tray icons, stickers before Android 9). */
        fun bitmap(file: File, maxPx: Int): Bitmap? {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeFile(file.path, bounds)
            var sample = 1
            while (bounds.outWidth / (sample * 2) >= maxPx) sample *= 2
            return BitmapFactory.decodeFile(file.path, BitmapFactory.Options().apply { inSampleSize = sample })
        }

        /** A sticker preview; animated stickers play on Android 9+ (a still frame before). */
        fun sticker(activity: Activity, file: File, maxPx: Int): Drawable? = try {
            if (Build.VERSION.SDK_INT >= 28) {
                ImageDecoder.decodeDrawable(ImageDecoder.createSource(file)) { decoder, info, _ ->
                    if (info.size.width > maxPx) decoder.setTargetSize(maxPx, maxPx * info.size.height / info.size.width)
                }
            } else bitmap(file, maxPx)?.let { BitmapDrawable(activity.resources, it) }
        } catch (e: Exception) {
            null
        }
    }
}
