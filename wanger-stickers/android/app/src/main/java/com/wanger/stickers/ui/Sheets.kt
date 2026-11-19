package com.wanger.stickers.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.painter.Painter
import androidx.compose.ui.graphics.vector.rememberVectorPainter
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import com.wanger.stickers.R

/** Whichever bottom sheet the model asks for, plus the delete confirmation and the import wait. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun Sheets(model: AppModel, actions: Actions) {
    val sheet = model.sheet
    if (sheet != null) {
        val state = rememberModalBottomSheetState(skipPartiallyExpanded = true)
        ModalBottomSheet(onDismissRequest = { model.sheet = null }, sheetState = state, containerColor = MaterialTheme.colorScheme.surfaceContainerLow) {
            Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp).padding(bottom = 24.dp).navigationBarsPadding()) {
                when (sheet) {
                    Sheet.AddPack -> AddPackSheet(model, actions)
                    is Sheet.Imported -> ImportedSheet(sheet, model, actions)
                    is Sheet.Failed -> FailedSheet(sheet.message) { model.sheet = null }
                }
            }
        }
    }
    model.confirmDelete?.let { p ->
        AlertDialog(
            onDismissRequest = { model.confirmDelete = null },
            icon = { Icon(Icons.Filled.Delete, null, tint = MaterialTheme.colorScheme.error) },
            title = { Text(stringResource(R.string.delete_title), textAlign = TextAlign.Center) },
            text = { Text(stringResource(R.string.delete_q, p.meta.name)) },
            confirmButton = { TextButton(onClick = { model.delete(p) }, modifier = Modifier.testTag("confirm_delete")) { Text(stringResource(R.string.delete), color = MaterialTheme.colorScheme.error) } },
            dismissButton = { TextButton(onClick = { model.confirmDelete = null }) { Text(stringResource(R.string.cancel)) } },
            shape = RoundedCornerShape(28.dp),
        )
    }
    if (model.importing) {
        Dialog(onDismissRequest = {}) {
            Surface(shape = RoundedCornerShape(28.dp), color = MaterialTheme.colorScheme.surfaceContainerLow, modifier = Modifier.testTag("importing")) {
                Row(Modifier.padding(horizontal = 28.dp, vertical = 24.dp), verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(Modifier.size(32.dp), strokeWidth = 3.dp)
                    Text(stringResource(R.string.reading), Modifier.padding(start = 18.dp), style = MaterialTheme.typography.titleMedium)
                }
            }
        }
    }
}

@Composable
private fun AddPackSheet(model: AppModel, actions: Actions) {
    Text(stringResource(R.string.sheet_add_title), style = MaterialTheme.typography.headlineSmall)
    Spacer(Modifier.height(16.dp))
    Option(painterResource(R.drawable.ic_folder), R.string.open_file, R.string.opt_file_sub, "opt_file") { model.sheet = null; actions.pickFile() }
    Spacer(Modifier.height(10.dp))
    Option(rememberVectorPainter(Icons.AutoMirrored.Filled.Send), R.string.open_bot, R.string.opt_bot_sub, "opt_bot") { model.sheet = null; actions.openBot() }
    Spacer(Modifier.height(16.dp))
    Text("💡 " + stringResource(R.string.tip_open_with), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

@Composable
private fun Option(icon: Painter, title: Int, sub: Int, tag: String, onClick: () -> Unit) {
    Surface(onClick = onClick, shape = RoundedCornerShape(22.dp), color = MaterialTheme.colorScheme.surfaceContainerHigh, modifier = Modifier.fillMaxWidth().testTag(tag)) {
        Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(48.dp).clip(RoundedCornerShape(16.dp)).background(Brand.badge), contentAlignment = Alignment.Center) {
                Icon(icon, null, tint = Color.White, modifier = Modifier.size(24.dp))
            }
            Column(Modifier.padding(start = 14.dp)) {
                Text(stringResource(title), style = MaterialTheme.typography.titleMedium)
                Text(stringResource(sub), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

@Composable
private fun ImportedSheet(s: Sheet.Imported, model: AppModel, actions: Actions) {
    val p = s.pack
    Column(Modifier.fillMaxWidth().testTag("imported"), horizontalAlignment = Alignment.CenterHorizontally) {
        Text(stringResource(if (s.replaced) R.string.updated_title else R.string.ready_title), style = MaterialTheme.typography.headlineSmall, textAlign = TextAlign.Center)
        Spacer(Modifier.height(16.dp))
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            TrayTile(p.tray, 56.dp)
            Column(Modifier.padding(start = 12.dp).weight(1f)) {
                Text(p.meta.name, style = MaterialTheme.typography.titleMedium, modifier = Modifier.testTag("imported_name"))
                Text(pluralStringResource(if (p.meta.animated) R.plurals.details_animated else R.plurals.details, p.meta.stickers.size, p.meta.publisher, p.meta.stickers.size), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        Spacer(Modifier.height(14.dp))
        // up to two rows of the pack's stickers
        p.stickers.take(8).chunked(4).forEach { row ->
            Row(Modifier.fillMaxWidth().padding(bottom = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                row.forEach { StickerTile(it, Modifier.weight(1f).aspectRatio(1f), animate = p.meta.animated) }
                repeat(4 - row.size) { Spacer(Modifier.weight(1f)) }
            }
        }
        Spacer(Modifier.height(10.dp))
        if (p.added) AddButton(true, {}, large = true)
        else AddButton(false, { model.sheet = null; actions.add(p) }, large = true)
        TextButton(onClick = { model.sheet = null; model.openPack = p.id }, modifier = Modifier.fillMaxWidth().padding(top = 4.dp).testTag("open_imported")) {
            Text(stringResource(R.string.open_pack))
        }
    }
}

@Composable
private fun FailedSheet(message: String, onOk: () -> Unit) {
    Column(Modifier.fillMaxWidth().testTag("failed"), horizontalAlignment = Alignment.CenterHorizontally) {
        Box(Modifier.size(64.dp).clip(CircleShape).background(MaterialTheme.colorScheme.errorContainer), contentAlignment = Alignment.Center) {
            Icon(Icons.Filled.Warning, null, tint = MaterialTheme.colorScheme.onErrorContainer, modifier = Modifier.size(30.dp))
        }
        Spacer(Modifier.height(14.dp))
        Text(stringResource(R.string.title_error), style = MaterialTheme.typography.titleLarge, textAlign = TextAlign.Center)
        Spacer(Modifier.height(8.dp))
        Text(message, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center, modifier = Modifier.testTag("failed_message"))
        Spacer(Modifier.height(20.dp))
        Button(onClick = onOk, modifier = Modifier.fillMaxWidth().height(52.dp), shape = RoundedCornerShape(18.dp)) { Text(stringResource(R.string.ok)) }
    }
}

/** A sticker as big as the screen allows, with its emojis; swipe-free: tap the neighbours. */
@Composable
fun StickerPreview(p: PackUi, index: Int, onDismiss: () -> Unit) {
    Dialog(onDismissRequest = onDismiss) {
        Surface(shape = RoundedCornerShape(32.dp), color = MaterialTheme.colorScheme.surfaceContainerLow, modifier = Modifier.testTag("preview")) {
            Column(Modifier.padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                StickerTile(p.stickers.getOrNull(index), Modifier.size(260.dp), animate = p.meta.animated, corner = 28.dp)
                Spacer(Modifier.height(14.dp))
                Text(p.meta.stickers.getOrNull(index)?.emojis.orEmpty().joinToString(" "), fontSize = 30.sp)
                Spacer(Modifier.height(4.dp))
                Text(stringResource(R.string.sticker_of, index + 1, p.stickers.size), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.height(12.dp))
                TextButton(onClick = onDismiss) { Text(stringResource(R.string.close)) }
            }
        }
    }
}
