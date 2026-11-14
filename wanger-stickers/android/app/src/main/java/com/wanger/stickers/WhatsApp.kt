package com.wanger.stickers

import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri

/**
 * WhatsApp's side of the official integration: is it installed (consumer and Business), has the
 * user already added a pack (its "whitelist" provider), and the intent that asks WhatsApp to add
 * one. Names and paths as in WhatsApp's guide and sample app.
 */
object WhatsApp {
    const val CONSUMER = "com.whatsapp"
    const val BUSINESS = "com.whatsapp.w4b"
    const val ACTION_ENABLE = "com.whatsapp.intent.action.ENABLE_STICKER_PACK"
    const val EXTRA_ID = "sticker_pack_id"
    const val EXTRA_AUTHORITY = "sticker_pack_authority"
    const val EXTRA_NAME = "sticker_pack_name"
    /** WhatsApp puts its reason here when it refuses a pack (result RESULT_CANCELED). */
    const val EXTRA_VALIDATION_ERROR = "validation_error"

    fun installed(pm: PackageManager, pkg: String): Boolean = try {
        @Suppress("DEPRECATION")
        pm.getApplicationInfo(pkg, 0).enabled
    } catch (e: PackageManager.NameNotFoundException) {
        false
    }

    /** The installed WhatsApp apps (consumer first). */
    fun apps(ctx: Context): List<String> = listOf(CONSUMER, BUSINESS).filter { installed(ctx.packageManager, it) }

    /**
     * Whether `pkg` already has the pack: true / false, or null when that WhatsApp can't tell
     * (too old for stickers, or the query failed).
     */
    fun isAdded(ctx: Context, pkg: String, identifier: String): Boolean? = try {
        val auth = "$pkg.provider.sticker_whitelist_check"
        @Suppress("DEPRECATION")
        if (ctx.packageManager.resolveContentProvider(auth, PackageManager.GET_META_DATA) == null) null
        else {
            val uri = Uri.Builder().scheme(ContentResolver.SCHEME_CONTENT).authority(auth).appendPath("is_whitelisted")
                .appendQueryParameter("authority", StickerContentProvider.authorityOf(ctx))
                .appendQueryParameter("identifier", identifier).build()
            ctx.contentResolver.query(uri, null, null, null, null)?.use { c ->
                if (c.moveToFirst()) c.getInt(c.getColumnIndexOrThrow("result")) == 1 else null
            }
        }
    } catch (e: Exception) {
        null // a WhatsApp update can change or remove this provider; never crash on it
    }

    /** The intent asking WhatsApp (`pkg`, or a chooser between both when null) to add the pack. */
    fun addIntent(ctx: Context, pack: PackMeta, pkg: String?): Intent = Intent(ACTION_ENABLE).apply {
        putExtra(EXTRA_ID, pack.identifier)
        putExtra(EXTRA_AUTHORITY, StickerContentProvider.authorityOf(ctx))
        putExtra(EXTRA_NAME, pack.name)
        if (pkg != null) setPackage(pkg)
    }
}
