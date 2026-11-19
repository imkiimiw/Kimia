package com.wanger.stickers.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsBottomHeight
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ElevatedCard
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.wanger.stickers.R

/** What the screens can ask the activity to do (pickers, other apps). */
class Actions(val pickFile: () -> Unit, val openBot: () -> Unit, val add: (PackUi) -> Unit)

@Composable
fun HomeScreen(model: AppModel, actions: Actions, snackbar: SnackbarHostState) {
    val packs = model.packs
    Scaffold(
        snackbarHost = { SnackbarHost(snackbar, Modifier.navigationBarsPadding()) },
        contentWindowInsets = WindowInsets(0),
    ) { pad ->
        LazyColumn(Modifier.fillMaxSize().testTag("home"), contentPadding = PaddingValues(top = pad.calculateTopPadding(), bottom = 8.dp)) {
            item(key = "hero") { Hero(packs, actions.openBot) }
            when {
                !model.loaded -> item(key = "loading") {
                    Box(Modifier.fillMaxWidth().padding(48.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                }
                packs.isEmpty() -> item(key = "empty") { EmptyState(actions) }
                else -> {
                    item(key = "title") {
                        Row(Modifier.padding(start = 24.dp, end = 16.dp, top = 22.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(stringResource(R.string.section_packs), style = MaterialTheme.typography.titleLarge)
                                Text(stringResource(R.string.packs_of, packs.size, com.wanger.stickers.Limits.MAX_PACKS), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            FilledTonalButton(onClick = { model.sheet = Sheet.AddPack }, shape = RoundedCornerShape(16.dp), modifier = Modifier.testTag("new_pack")) {
                                Icon(Icons.Filled.Add, null, Modifier.size(18.dp))
                                Text(stringResource(R.string.add_pack), Modifier.padding(start = 6.dp))
                            }
                        }
                    }
                    items(packs, key = { it.id }) { p ->
                        PackCard(p, onOpen = { model.openPack = p.id }, onAdd = { actions.add(p) }, onDelete = { model.confirmDelete = p }, modifier = Modifier.animateItem())
                    }
                }
            }
            item(key = "footer") {
                Text(
                    stringResource(R.string.footer),
                    Modifier.fillMaxWidth().padding(horizontal = 32.dp, vertical = 20.dp),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.8f),
                    textAlign = TextAlign.Center,
                )
                Spacer(Modifier.windowInsetsBottomHeight(WindowInsets.navigationBars))
            }
        }
    }
}

@Composable
private fun Hero(packs: List<PackUi>, onBot: () -> Unit) {
    Box(Modifier.fillMaxWidth().clip(RoundedCornerShape(bottomStart = 36.dp, bottomEnd = 36.dp)).background(Brand.hero)) {
        Bubbles()
        Column(Modifier.statusBarsPadding().padding(start = 24.dp, end = 24.dp, top = 12.dp, bottom = 28.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Logo(46.dp)
                Column(Modifier.padding(start = 12.dp).weight(1f)) {
                    Text(stringResource(R.string.app_name), color = Color.White, style = MaterialTheme.typography.titleLarge)
                    Text(stringResource(R.string.hero_kicker), color = Color.White.copy(alpha = 0.8f), style = MaterialTheme.typography.labelMedium)
                }
                Surface(onClick = onBot, shape = CircleShape, color = Color.White.copy(alpha = 0.18f), contentColor = Color.White, modifier = Modifier.testTag("hero_bot")) {
                    Row(Modifier.padding(horizontal = 14.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text("🤖", fontSize = 15.sp)
                        Text(stringResource(R.string.bot_short), Modifier.padding(start = 6.dp), style = MaterialTheme.typography.labelLarge)
                    }
                }
            }
            Spacer(Modifier.height(22.dp))
            Text(stringResource(R.string.hero_title), color = Color.White, style = MaterialTheme.typography.headlineMedium)
            Spacer(Modifier.height(6.dp))
            Text(stringResource(R.string.hero_body), color = Color.White.copy(alpha = 0.88f), style = MaterialTheme.typography.bodyMedium)
            if (packs.isNotEmpty()) {
                Spacer(Modifier.height(20.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Stat(packs.size, R.string.stat_packs, Modifier.weight(1f))
                    Stat(packs.sumOf { it.meta.stickers.size }, R.string.stat_stickers, Modifier.weight(1f))
                    Stat(packs.count { it.added }, R.string.stat_added, Modifier.weight(1f))
                }
            }
        }
    }
}

@Composable
private fun Stat(n: Int, label: Int, modifier: Modifier) {
    Column(modifier.clip(RoundedCornerShape(20.dp)).background(Color.White.copy(alpha = 0.16f)).padding(horizontal = 14.dp, vertical = 10.dp)) {
        Text("%d".format(n), color = Color.White, style = MaterialTheme.typography.titleLarge)
        Text(stringResource(label), color = Color.White.copy(alpha = 0.82f), style = MaterialTheme.typography.labelMedium, maxLines = 1)
    }
}

@Composable
fun PackCard(p: PackUi, onOpen: () -> Unit, onAdd: () -> Unit, onDelete: () -> Unit, modifier: Modifier = Modifier) {
    ElevatedCard(
        onClick = onOpen,
        shape = RoundedCornerShape(28.dp),
        colors = CardDefaults.elevatedCardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow),
        elevation = CardDefaults.elevatedCardElevation(defaultElevation = 2.dp),
        modifier = modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 7.dp).testTag("pack_${p.id}"),
    ) {
        Column(Modifier.padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                TrayTile(p.tray, 54.dp)
                Column(Modifier.padding(horizontal = 12.dp).weight(1f)) {
                    Text(p.meta.name, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.testTag("name"))
                    Text(stringResource(R.string.by_publisher, p.meta.publisher), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Row(Modifier.padding(top = 6.dp)) {
                        Pill(pluralStringResource(R.plurals.count_stickers, p.meta.stickers.size, p.meta.stickers.size))
                        if (p.meta.animated) Pill("✨ " + stringResource(R.string.animated_label), Modifier.padding(start = 6.dp), container = MaterialTheme.colorScheme.secondaryContainer, content = MaterialTheme.colorScheme.onSecondaryContainer)
                    }
                }
                var menu by remember { mutableStateOf(false) }
                Box {
                    IconButton(onClick = { menu = true }) { Icon(Icons.Filled.MoreVert, stringResource(R.string.more)) }
                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }, shape = RoundedCornerShape(16.dp)) {
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.delete)) },
                            leadingIcon = { Icon(Icons.Filled.Delete, null, tint = MaterialTheme.colorScheme.error) },
                            onClick = { menu = false; onDelete() },
                        )
                    }
                }
            }
            Spacer(Modifier.height(14.dp))
            // a strip of the first stickers, playing
            val shown = if (p.stickers.size > 5) p.stickers.take(4) else p.stickers.take(5)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                shown.forEach { StickerTile(it, Modifier.weight(1f).aspectRatio(1f), animate = p.meta.animated) }
                if (p.stickers.size > 5) {
                    Box(Modifier.weight(1f).aspectRatio(1f).clip(RoundedCornerShape(18.dp)).background(MaterialTheme.colorScheme.primaryContainer), contentAlignment = Alignment.Center) {
                        Text("+%d".format(p.stickers.size - 4), color = MaterialTheme.colorScheme.onPrimaryContainer, style = MaterialTheme.typography.titleMedium)
                    }
                }
                repeat(5 - shown.size - (if (p.stickers.size > 5) 1 else 0)) { Spacer(Modifier.weight(1f)) }
            }
            Spacer(Modifier.height(14.dp))
            AddButton(p.added, onAdd, wide = true)
        }
    }
}

@Composable
private fun EmptyState(actions: Actions) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp).testTag("empty"), horizontalAlignment = Alignment.CenterHorizontally) {
        Spacer(Modifier.height(28.dp))
        Illustration()
        Spacer(Modifier.height(20.dp))
        Text(stringResource(R.string.empty_title), style = MaterialTheme.typography.headlineSmall, textAlign = TextAlign.Center)
        Spacer(Modifier.height(6.dp))
        Text(stringResource(R.string.empty_body), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
        Spacer(Modifier.height(20.dp))
        Surface(shape = RoundedCornerShape(28.dp), color = MaterialTheme.colorScheme.surfaceContainerLow, tonalElevation = 1.dp, shadowElevation = 1.dp) {
            Column(Modifier.fillMaxWidth().padding(18.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                listOf(R.string.step_1, R.string.step_2, R.string.step_3, R.string.step_4).forEachIndexed { i, s ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        StepNumber(i + 1)
                        Text(stringResource(s), Modifier.padding(start = 12.dp), style = MaterialTheme.typography.bodyMedium)
                    }
                }
            }
        }
        Spacer(Modifier.height(20.dp))
        Button(onClick = actions.pickFile, modifier = Modifier.fillMaxWidth().height(56.dp).testTag("open_file"), shape = RoundedCornerShape(20.dp)) {
            Icon(painterResource(R.drawable.ic_folder), null, Modifier.size(20.dp))
            Text(stringResource(R.string.open_file), Modifier.padding(start = 8.dp), style = MaterialTheme.typography.titleMedium)
        }
        Spacer(Modifier.height(10.dp))
        OutlinedButton(onClick = actions.openBot, modifier = Modifier.fillMaxWidth().height(52.dp), shape = RoundedCornerShape(20.dp)) {
            Icon(Icons.AutoMirrored.Filled.Send, null, Modifier.size(18.dp))
            Text(stringResource(R.string.open_bot), Modifier.padding(start = 8.dp), style = MaterialTheme.typography.labelLarge)
        }
    }
}

/** Three tilted stickers with sparkles: the empty state's picture (no image files needed). */
@Composable
private fun Illustration() {
    Box(Modifier.size(width = 260.dp, height = 170.dp), contentAlignment = Alignment.Center) {
        Box(Modifier.size(170.dp).clip(CircleShape).background(MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.6f)))
        val faces = listOf("😎", "🥳", "😍")
        listOf(-14f to (-62).dp, 0f to 0.dp, 13f to 62.dp).forEachIndexed { i, (angle, dx) ->
            val shape = RoundedCornerShape(30.dp)
            Box(
                Modifier.offset(x = dx, y = if (i == 1) (-8).dp else 10.dp).rotate(angle).size(if (i == 1) 104.dp else 88.dp)
                    .shadow(10.dp, shape).clip(shape).background(Brand.tiles[i]).border(4.dp, Color.White, shape),
                contentAlignment = Alignment.Center,
            ) { Text(faces[i], fontSize = if (i == 1) 50.sp else 40.sp) }
        }
        Text("✦", Modifier.offset(x = 108.dp, y = (-62).dp), color = Brand.Pink, fontSize = 22.sp)
        Text("✦", Modifier.offset(x = (-112).dp, y = (-54).dp), color = Brand.Sky, fontSize = 16.sp)
        Text("✦", Modifier.offset(x = (-96).dp, y = 66.dp), color = Brand.Purple, fontSize = 12.sp)
        Spacer(Modifier.width(0.dp))
    }
}
