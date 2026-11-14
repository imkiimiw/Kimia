package com.wanger.stickers

import android.graphics.drawable.Animatable
import android.os.Bundle
import android.widget.Button
import android.widget.GridLayout
import android.widget.ImageView
import android.widget.TextView

/** One pack: its stickers (animated ones play on Android 9+), add to WhatsApp, delete. */
class PackActivity : BaseActivity() {
    private lateinit var identifier: String

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_pack)
        applyInsets(findViewById(R.id.root))
        identifier = intent.getStringExtra(EXTRA_ID) ?: return finish()
        load()
    }

    override fun onPacksChanged() = load()

    private fun load() {
        val trayPx = (64 * resources.displayMetrics.density).toInt()
        background({
            val pack = store.get(identifier) ?: return@background null
            Triple(pack, store.file(identifier, pack.tray)?.let { bitmap(it, trayPx) }, addedEverywhere(pack))
        }) { r ->
            val (pack, tray, added) = r.getOrNull() ?: return@background finish()
            findViewById<ImageView>(R.id.tray).setImageBitmap(tray)
            findViewById<TextView>(R.id.name).text = pack.name
            findViewById<TextView>(R.id.details).text = details(pack)
            findViewById<Button>(R.id.add).apply {
                text = getString(if (added) R.string.in_whatsapp else R.string.add)
                isEnabled = !added
                setOnClickListener { addToWhatsApp(pack) }
            }
            findViewById<Button>(R.id.delete).setOnClickListener { confirmDelete(pack) { finish() } }
            showStickers(pack)
        }
    }

    private fun showStickers(pack: PackMeta) {
        val grid = findViewById<GridLayout>(R.id.grid)
        grid.removeAllViews()
        val pad = (20 * 2 * resources.displayMetrics.density).toInt()
        val cell = (resources.displayMetrics.widthPixels - pad) / grid.columnCount
        val views = pack.stickers.map { s ->
            ImageView(this).apply {
                layoutParams = GridLayout.LayoutParams().apply { width = cell; height = cell }
                setPadding(cell / 16, cell / 16, cell / 16, cell / 16)
                contentDescription = s.emojis.joinToString(" ")
                grid.addView(this)
            }
        }
        background({ pack.stickers.map { s -> store.file(identifier, s.file)?.let { sticker(this, it, cell) } } }) { r ->
            r.getOrNull()?.forEachIndexed { i, d ->
                views[i].setImageDrawable(d)
                (d as? Animatable)?.start()
            }
        }
    }

    companion object {
        const val EXTRA_ID = "identifier"
    }
}
