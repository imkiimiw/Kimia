package com.wanger.stickers.ui

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.graphics.drawable.Animatable
import android.graphics.drawable.Drawable
import android.os.Build
import android.util.LruCache
import android.widget.ImageView
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

/** Decoded images: still bitmaps are cached (lists scroll); animated drawables are made per view. */
private object Images {
    private val cache = object : LruCache<String, Bitmap>(24 * 1024 * 1024) {
        override fun sizeOf(key: String, value: Bitmap) = value.byteCount
    }

    fun still(file: File, maxPx: Int): Bitmap? {
        val key = "${file.path}:${file.lastModified()}:$maxPx"
        cache.get(key)?.let { return it }
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.path, bounds)
        var sample = 1
        while (bounds.outWidth / (sample * 2) >= maxPx) sample *= 2
        val b = BitmapFactory.decodeFile(file.path, BitmapFactory.Options().apply { inSampleSize = sample }) ?: return null
        cache.put(key, b)
        return b
    }

    /** An animated WebP as a playing drawable (Android 9+); null = show it still. */
    fun animated(file: File, maxPx: Int): Drawable? {
        if (Build.VERSION.SDK_INT < 28) return null
        return try {
            val d = ImageDecoder.decodeDrawable(ImageDecoder.createSource(file)) { decoder, info, _ ->
                if (info.size.width > maxPx) decoder.setTargetSize(maxPx, maxPx * info.size.height / info.size.width)
            }
            if (d is Animatable) d else null
        } catch (e: Exception) {
            null
        }
    }
}

private sealed interface Loaded {
    data object Pending : Loaded
    data object Missing : Loaded
    class Still(val bitmap: Bitmap) : Loaded
    class Moving(val drawable: Drawable) : Loaded
}

/**
 * A sticker or tray icon that fills its box: decoded off the main thread, animated WebP playing
 * when [animate] (Android 9+), a soft placeholder while it loads.
 */
@Composable
fun StickerImage(file: File?, modifier: Modifier = Modifier, animate: Boolean = false, description: String? = null) {
    BoxWithConstraints(modifier.semantics { if (description != null) contentDescription = description }) {
        val px = with(LocalDensity.current) { maxWidth.roundToPx().coerceIn(48, 512) }
        val state by produceState<Loaded>(Loaded.Pending, file?.path, file?.lastModified(), px, animate) {
            value = withContext(Dispatchers.IO) {
                if (file == null) return@withContext Loaded.Missing
                (if (animate) Images.animated(file, px)?.let { Loaded.Moving(it) } else null)
                    ?: Images.still(file, px)?.let { Loaded.Still(it) }
                    ?: Loaded.Missing
            }
        }
        when (val s = state) {
            is Loaded.Still -> Image(s.bitmap.asImageBitmap(), null, Modifier.fillMaxSize(), contentScale = ContentScale.Fit)
            is Loaded.Moving -> AndroidView(
                factory = { ImageView(it).apply { scaleType = ImageView.ScaleType.FIT_CENTER } },
                update = { v ->
                    if (v.drawable !== s.drawable) {
                        v.setImageDrawable(s.drawable)
                        (s.drawable as Animatable).start()
                    }
                },
                modifier = Modifier.fillMaxSize(),
            )
            else -> Box(Modifier.fillMaxSize().clip(RoundedCornerShape(12.dp)).background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.6f)))
        }
    }
}
