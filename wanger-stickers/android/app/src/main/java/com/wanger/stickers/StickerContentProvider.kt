package com.wanger.stickers

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.content.UriMatcher
import android.content.res.AssetFileDescriptor
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import androidx.core.net.toUri
import java.io.FileNotFoundException

/**
 * How WhatsApp reads our packs: the read-only provider contract of WhatsApp's official sticker
 * integration (paths and column names exactly as in its sample app). Exported, but readable only
 * with `com.whatsapp.sticker.READ`, a permission WhatsApp defines and holds (see the manifest).
 *
 *  - `metadata`                         every pack
 *  - `metadata/<identifier>`            one pack
 *  - `stickers/<identifier>`            its stickers (file name, emojis, accessibility text)
 *  - `stickers_asset/<identifier>/<f>`  a sticker or the tray icon, as a file descriptor
 */
class StickerContentProvider : ContentProvider() {
    private lateinit var matcher: UriMatcher
    private lateinit var authority: String

    override fun onCreate(): Boolean {
        val ctx = context ?: return false
        authority = authorityOf(ctx)
        matcher = UriMatcher(UriMatcher.NO_MATCH).apply {
            addURI(authority, METADATA, CODE_ALL)
            addURI(authority, "$METADATA/*", CODE_ONE)
            addURI(authority, "$STICKERS/*", CODE_STICKERS)
            addURI(authority, "$STICKERS_ASSET/*/*", CODE_ASSET)
        }
        return true
    }

    private fun store(): PackStore = PackStore.of(requireNotNull(context).filesDir)

    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor {
        val cursor = when (matcher.match(uri)) {
            CODE_ALL -> packCursor(store().list())
            CODE_ONE -> packCursor(listOfNotNull(uri.lastPathSegment?.let { store().get(it) }))
            CODE_STICKERS -> stickerCursor(uri.lastPathSegment?.let { store().get(it) })
            else -> throw IllegalArgumentException("Unknown URI: $uri")
        }
        context?.let { cursor.setNotificationUri(it.contentResolver, uri) }
        return cursor
    }

    private fun packCursor(packs: List<PackMeta>): MatrixCursor {
        val ctx = requireNotNull(context)
        val c = MatrixCursor(PACK_COLUMNS)
        for (p in packs) {
            c.addRow(arrayOf<Any?>(
                p.identifier, p.name, p.publisher, p.tray,
                ctx.getString(R.string.play_store_url), "", "", ctx.getString(R.string.bot_url), "", "",
                p.version.toString(), 0, if (p.animated) 1 else 0,
            ))
        }
        return c
    }

    private fun stickerCursor(p: PackMeta?): MatrixCursor {
        val c = MatrixCursor(STICKER_COLUMNS)
        p?.stickers?.forEach { s -> c.addRow(arrayOf<Any?>(s.file, s.emojis.joinToString(","), null)) }
        return c
    }

    override fun getType(uri: Uri): String = when (matcher.match(uri)) {
        CODE_ALL -> "vnd.android.cursor.dir/vnd.$authority.$METADATA"
        CODE_ONE -> "vnd.android.cursor.item/vnd.$authority.$METADATA"
        CODE_STICKERS -> "vnd.android.cursor.dir/vnd.$authority.$STICKERS"
        CODE_ASSET -> if (uri.lastPathSegment.orEmpty().endsWith(".png")) "image/png" else "image/webp"
        else -> throw IllegalArgumentException("Unknown URI: $uri")
    }

    private fun assetFile(uri: Uri, mode: String) = run {
        if (matcher.match(uri) != CODE_ASSET || mode != "r") throw FileNotFoundException("not readable: $uri")
        val seg = uri.pathSegments
        store().file(seg[1], seg[2]) ?: throw FileNotFoundException("no such sticker: $uri")
    }

    override fun openAssetFile(uri: Uri, mode: String): AssetFileDescriptor {
        val f = assetFile(uri, mode)
        return AssetFileDescriptor(ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_READ_ONLY), 0, f.length())
    }

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor =
        ParcelFileDescriptor.open(assetFile(uri, mode), ParcelFileDescriptor.MODE_READ_ONLY)

    override fun insert(uri: Uri, values: ContentValues?): Uri? = throw UnsupportedOperationException("read-only")
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = throw UnsupportedOperationException("read-only")
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = throw UnsupportedOperationException("read-only")

    companion object {
        private const val METADATA = "metadata"
        private const val STICKERS = "stickers"
        private const val STICKERS_ASSET = "stickers_asset"
        private const val CODE_ALL = 1
        private const val CODE_ONE = 2
        private const val CODE_STICKERS = 3
        private const val CODE_ASSET = 4

        /** Column names WhatsApp reads (from its sample's StickerContentProvider). */
        val PACK_COLUMNS = arrayOf(
            "sticker_pack_identifier", "sticker_pack_name", "sticker_pack_publisher", "sticker_pack_icon",
            "android_play_store_link", "ios_app_download_link", "sticker_pack_publisher_email",
            "sticker_pack_publisher_website", "sticker_pack_privacy_policy_website",
            "sticker_pack_license_agreement_website", "image_data_version", "whatsapp_will_not_cache_stickers",
            "animated_sticker_pack",
        )
        val STICKER_COLUMNS = arrayOf("sticker_file_name", "sticker_emoji", "sticker_accessibility_text")

        /** Must equal the manifest's `${applicationId}.stickercontentprovider`. */
        fun authorityOf(ctx: Context) = ctx.packageName + ".stickercontentprovider"

        /** Tells WhatsApp (and our screens) that the pack list changed. */
        fun notifyChanged(ctx: Context) {
            ctx.contentResolver.notifyChange("content://${authorityOf(ctx)}/$METADATA".toUri(), null)
        }
    }
}
