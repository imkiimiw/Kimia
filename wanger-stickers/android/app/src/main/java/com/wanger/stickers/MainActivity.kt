package com.wanger.stickers

import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.widget.Button
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import java.io.FileNotFoundException

/**
 * The pack list. Packs arrive as the bot's ZIP: opened from Telegram ("Open with"), shared to the
 * app, or picked with the system file picker (no storage permission needed).
 */
class MainActivity : BaseActivity() {
    private lateinit var list: LinearLayout
    private lateinit var empty: View
    private lateinit var progress: ProgressBar

    private class Row(val pack: PackMeta, val tray: Bitmap?, val added: Boolean)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        applyInsets(findViewById(R.id.root))
        list = findViewById(R.id.list)
        empty = findViewById(R.id.empty)
        progress = findViewById(R.id.progress)
        findViewById<Button>(R.id.open_file).setOnClickListener { pickFile() }
        findViewById<Button>(R.id.open_bot).setOnClickListener {
            try {
                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(getString(R.string.bot_url))))
            } catch (e: ActivityNotFoundException) {
                alert(getString(R.string.bot_url))
            }
        }
        if (savedInstanceState == null) handle(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handle(intent)
    }

    override fun onResume() {
        super.onResume()
        refresh()
    }

    override fun onPacksChanged() = refresh()

    /** A file opened with ("View") or shared to ("Send") the app. */
    private fun handle(intent: Intent?) {
        val uri: Uri? = when (intent?.action) {
            Intent.ACTION_VIEW -> intent.data
            Intent.ACTION_SEND -> if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
            else @Suppress("DEPRECATION") intent.getParcelableExtra(Intent.EXTRA_STREAM)
            else -> null
        }
        if (uri != null) import(uri)
    }

    private fun pickFile() {
        val i = Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
            .putExtra(Intent.EXTRA_MIME_TYPES, MIME_TYPES)
        try {
            startActivityForResult(i, REQ_PICK)
        } catch (e: ActivityNotFoundException) {
            alert(getString(R.string.cant_open))
        }
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == REQ_PICK) {
            if (resultCode == RESULT_OK) data?.data?.let { import(it) }
            return
        }
        super.onActivityResult(requestCode, resultCode, data)
    }

    private fun import(uri: Uri) {
        progress.visibility = View.VISIBLE
        background({
            val read = (contentResolver.openInputStream(uri) ?: throw FileNotFoundException()).use { PackReader.read(it) }
            store.save(read)
        }) { r ->
            progress.visibility = View.GONE
            r.onSuccess { (pack, replaced) ->
                StickerContentProvider.notifyChanged(this)
                refresh()
                val n = pack.stickers.size
                val msg = resources.getQuantityString(if (replaced) R.plurals.updated else R.plurals.imported, n, pack.name, n)
                AlertDialog.Builder(this)
                    .setMessage(msg + "\n\n" + getString(R.string.add_now_q))
                    .setPositiveButton(R.string.add) { _, _ -> addToWhatsApp(pack) }
                    .setNegativeButton(R.string.later, null)
                    .show()
            }.onFailure { e -> alert(messageFor(e), getString(R.string.title_error)) }
        }
    }

    private fun messageFor(e: Throwable): String = when (e) {
        is StoreFullException -> getString(R.string.full)
        is ImportException -> when (e.code) {
            ImportException.Code.NOT_ZIP -> getString(R.string.err_not_zip)
            ImportException.Code.TOO_BIG -> getString(R.string.err_too_big)
            ImportException.Code.NO_PACK -> getString(R.string.err_no_pack)
            ImportException.Code.BAD_META -> getString(R.string.err_bad_meta)
            ImportException.Code.IDENTIFIER -> getString(R.string.err_identifier)
            ImportException.Code.NAME -> getString(R.string.err_name)
            ImportException.Code.PUBLISHER -> getString(R.string.err_publisher)
            ImportException.Code.TOO_FEW -> resources.getQuantityString(R.plurals.err_too_few, e.count, e.count)
            ImportException.Code.TOO_MANY -> resources.getQuantityString(R.plurals.err_too_many, e.count, e.count)
            ImportException.Code.NO_TRAY -> getString(R.string.err_no_tray)
            ImportException.Code.BAD_TRAY -> getString(R.string.err_bad_tray)
            ImportException.Code.STICKER_MISSING -> getString(R.string.err_sticker_missing, e.sticker)
            ImportException.Code.STICKER_NOT_WEBP -> getString(R.string.err_sticker_not_webp, e.sticker)
            ImportException.Code.STICKER_NOT_512 -> getString(R.string.err_sticker_not_512, e.sticker)
            ImportException.Code.STICKER_MIXED -> getString(R.string.err_sticker_mixed, e.sticker)
            ImportException.Code.STICKER_TOO_BIG -> getString(R.string.err_sticker_too_big, e.sticker)
            ImportException.Code.STICKER_TOO_LONG -> getString(R.string.err_sticker_too_long, e.sticker)
            ImportException.Code.STICKER_FRAME_TOO_SHORT -> getString(R.string.err_sticker_frame, e.sticker)
        }
        else -> getString(R.string.cant_open)
    }

    private fun refresh() {
        val px = (56 * resources.displayMetrics.density).toInt()
        background({
            store.list().map { p -> Row(p, store.file(p.identifier, p.tray)?.let { bitmap(it, px) }, addedEverywhere(p)) }
        }) { r -> render(r.getOrDefault(emptyList())) }
    }

    private fun render(rows: List<Row>) {
        list.removeAllViews()
        empty.visibility = if (rows.isEmpty()) View.VISIBLE else View.GONE
        val inflater = LayoutInflater.from(this)
        for (row in rows) {
            val v = inflater.inflate(R.layout.item_pack, list, false)
            v.findViewById<ImageView>(R.id.tray).setImageBitmap(row.tray)
            v.findViewById<TextView>(R.id.name).text = row.pack.name
            v.findViewById<TextView>(R.id.details).text = details(row.pack)
            v.findViewById<Button>(R.id.add).apply {
                text = getString(if (row.added) R.string.in_whatsapp else R.string.add)
                isEnabled = !row.added
                setOnClickListener { addToWhatsApp(row.pack) }
            }
            v.setOnClickListener { startActivity(Intent(this, PackActivity::class.java).putExtra(PackActivity.EXTRA_ID, row.pack.identifier)) }
            v.setOnLongClickListener {
                confirmDelete(row.pack) { refresh() }
                true
            }
            list.addView(v)
        }
    }

    companion object {
        private const val REQ_PICK = 201
        private val MIME_TYPES = arrayOf("application/zip", "application/x-zip-compressed", "application/x-zip", "application/octet-stream")
    }
}
