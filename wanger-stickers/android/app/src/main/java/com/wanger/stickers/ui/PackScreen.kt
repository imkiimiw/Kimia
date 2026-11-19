package com.wanger.stickers.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.windowInsetsBottomHeight
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.layout.layout
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.wanger.stickers.R

/** Lets a grid item reach the screen edges past the grid's horizontal content padding. */
private fun Modifier.fullBleed(pad: Dp) = layout { measurable, constraints ->
    val extra = pad.roundToPx() * 2
    val w = constraints.maxWidth + extra
    val placeable = measurable.measure(constraints.copy(minWidth = w, maxWidth = w))
    layout(constraints.maxWidth, placeable.height) { placeable.place(-extra / 2, 0) }
}

/** One pack: a gradient header with the big add button, then every sticker (tap = see it large). */
@Composable
fun PackScreen(p: PackUi, model: AppModel, actions: Actions, snackbar: SnackbarHostState) {
    var preview by remember { mutableStateOf<Int?>(null) }
    Scaffold(snackbarHost = { SnackbarHost(snackbar, Modifier.navigationBarsPadding()) }, contentWindowInsets = WindowInsets(0)) { pad ->
        LazyVerticalGrid(
            columns = GridCells.Adaptive(96.dp),
            modifier = Modifier.fillMaxSize().testTag("pack_screen"),
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = pad.calculateTopPadding(), bottom = 24.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            item(span = { GridItemSpan(maxLineSpan) }) { Header(p, model, actions, Modifier.fullBleed(16.dp)) }
            item(span = { GridItemSpan(maxLineSpan) }) {
                Column(Modifier.padding(start = 4.dp, end = 4.dp, top = 8.dp)) {
                    Text(stringResource(R.string.stickers_label), style = MaterialTheme.typography.titleLarge)
                    Text(stringResource(R.string.stickers_hint), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            itemsIndexed(p.stickers) { i, f ->
                val emojis = p.meta.stickers.getOrNull(i)?.emojis.orEmpty().joinToString(" ")
                StickerTile(
                    f,
                    Modifier.aspectRatio(1f).clip(RoundedCornerShape(22.dp)).clickable { preview = i }.testTag("sticker_$i"),
                    animate = p.meta.animated,
                    description = emojis,
                    corner = 22.dp,
                )
            }
            item(span = { GridItemSpan(maxLineSpan) }) {
                Column {
                    Text(
                        stringResource(R.string.made_with),
                        Modifier.fillMaxWidth().padding(24.dp),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        textAlign = TextAlign.Center,
                    )
                    Spacer(Modifier.windowInsetsBottomHeight(WindowInsets.navigationBars))
                }
            }
        }
    }
    preview?.let { i -> StickerPreview(p, i, onDismiss = { preview = null }) }
}

@Composable
private fun Header(p: PackUi, model: AppModel, actions: Actions, modifier: Modifier) {
    Box(modifier.fillMaxWidth().clip(RoundedCornerShape(bottomStart = 36.dp, bottomEnd = 36.dp)).background(Brand.hero)) {
        Bubbles(small = false)
        Column(Modifier.statusBarsPadding().padding(start = 8.dp, end = 8.dp, top = 4.dp, bottom = 24.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = { model.openPack = null }, modifier = Modifier.testTag("back")) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.back), tint = Color.White)
                }
                Spacer(Modifier.weight(1f))
                IconButton(onClick = { model.confirmDelete = p }, modifier = Modifier.testTag("delete")) {
                    Icon(Icons.Filled.Delete, stringResource(R.string.delete), tint = Color.White)
                }
            }
            Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Box(Modifier.size(112.dp).clip(CircleShape).background(Color.White.copy(alpha = 0.18f)), contentAlignment = Alignment.Center) {
                    TrayTile(p.tray, 84.dp)
                }
                Spacer(Modifier.height(14.dp))
                Text(p.meta.name, color = Color.White, style = MaterialTheme.typography.headlineSmall, textAlign = TextAlign.Center, modifier = Modifier.testTag("pack_name"))
                Text(stringResource(R.string.by_publisher, p.meta.publisher), color = Color.White.copy(alpha = 0.85f), style = MaterialTheme.typography.bodyMedium)
                Spacer(Modifier.height(12.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    val glass = Color.White.copy(alpha = 0.18f)
                    Pill(pluralStringResource(R.plurals.count_stickers, p.meta.stickers.size, p.meta.stickers.size), container = glass, content = Color.White)
                    Pill(if (p.meta.animated) "✨ " + stringResource(R.string.animated_label) else stringResource(R.string.static_label), container = glass, content = Color.White)
                }
                Spacer(Modifier.height(20.dp))
                AddButton(p.added, { actions.add(p) }, large = true, onGradient = true)
            }
        }
    }
}
