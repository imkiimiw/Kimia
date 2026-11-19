package com.wanger.stickers.ui

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.wanger.stickers.R
import java.io.File

/** The Wanger mark (a peeled sticker with a W) on a frosted tile. */
@Composable
fun Logo(size: Dp, modifier: Modifier = Modifier) {
    Box(modifier.size(size).clip(RoundedCornerShape(size * 0.3f)).background(Color.White.copy(alpha = 0.2f)), contentAlignment = Alignment.Center) {
        Image(painterResource(R.drawable.logo_mark), null, Modifier.size(size * 0.78f))
    }
}

/** Soft light circles over a gradient (hero and pack headers). */
@Composable
fun BoxScope.Bubbles(small: Boolean = true) {
    Canvas(Modifier.matchParentSize()) {
        drawCircle(Color.White.copy(alpha = 0.10f), radius = size.width * 0.42f, center = Offset(size.width * 0.92f, size.height * 0.02f))
        drawCircle(Color.White.copy(alpha = 0.07f), radius = size.width * 0.28f, center = Offset(size.width * 0.04f, size.height * 0.98f))
        if (small) drawCircle(Color.White.copy(alpha = 0.09f), radius = size.width * 0.06f, center = Offset(size.width * 0.62f, size.height * 0.30f))
    }
}

/** A small rounded label. */
@Composable
fun Pill(text: String, modifier: Modifier = Modifier, container: Color = MaterialTheme.colorScheme.surfaceVariant, content: Color = MaterialTheme.colorScheme.onSurfaceVariant) {
    Surface(modifier, shape = CircleShape, color = container, contentColor = content) {
        Text(text, Modifier.padding(horizontal = 12.dp, vertical = 5.dp), style = MaterialTheme.typography.labelMedium)
    }
}

/** A sticker on its tile (transparent stickers need a calm background). */
@Composable
fun StickerTile(file: File?, modifier: Modifier = Modifier, animate: Boolean = true, description: String? = null, corner: Dp = 18.dp) {
    Box(modifier.clip(RoundedCornerShape(corner)).background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.55f)).padding(6.dp)) {
        StickerImage(file, Modifier.matchParentSize(), animate = animate, description = description)
    }
}

/** The pack icon on a gradient-rimmed tile. */
@Composable
fun TrayTile(file: File?, size: Dp, modifier: Modifier = Modifier) {
    Box(modifier.size(size).clip(RoundedCornerShape(size * 0.3f)).background(Brand.badge).padding(2.dp)) {
        Box(Modifier.matchParentSize().clip(RoundedCornerShape(size * 0.28f)).background(MaterialTheme.colorScheme.surfaceContainerLowest).padding(size * 0.12f)) {
            StickerImage(file, Modifier.matchParentSize())
        }
    }
}

/** "Add to WhatsApp" — or a green "✓ In WhatsApp" once every installed WhatsApp has the pack. */
@Composable
fun AddButton(added: Boolean, onAdd: () -> Unit, modifier: Modifier = Modifier, large: Boolean = false, onGradient: Boolean = false, wide: Boolean = large) {
    AnimatedContent(added, transitionSpec = { (fadeIn() + scaleIn(initialScale = 0.9f)) togetherWith fadeOut() }, label = "add", modifier = modifier) { isAdded ->
        val h = if (large) 54.dp else if (wide) 46.dp else 40.dp
        if (isAdded) {
            val green = if (onGradient) Color.White else doneGreen()
            Surface(
                shape = CircleShape,
                color = if (onGradient) Color.White.copy(alpha = 0.18f) else green.copy(alpha = 0.14f),
                contentColor = green,
                modifier = (if (wide) Modifier.fillMaxWidth() else Modifier).height(h).testTag("in_whatsapp"),
            ) {
                Row(Modifier.padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.Center) {
                    Icon(Icons.Filled.Check, null, Modifier.size(18.dp))
                    Text(stringResource(R.string.in_whatsapp), Modifier.padding(start = 6.dp), style = MaterialTheme.typography.labelLarge)
                }
            }
        } else {
            Button(
                onClick = onAdd,
                modifier = (if (wide) Modifier.fillMaxWidth() else Modifier).height(h).testTag("add"),
                shape = CircleShape,
                contentPadding = PaddingValues(horizontal = if (large) 24.dp else 16.dp),
                colors = if (onGradient) ButtonDefaults.buttonColors(containerColor = Color.White, contentColor = Brand.Violet) else ButtonDefaults.buttonColors(),
            ) {
                Icon(Icons.Filled.Add, null, Modifier.size(if (large) 22.dp else 18.dp))
                Text(stringResource(R.string.add), Modifier.padding(start = 6.dp), style = if (large) MaterialTheme.typography.titleMedium else MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Bold)
            }
        }
    }
}

/** A numbered gradient dot (onboarding steps). */
@Composable
fun StepNumber(n: Int) {
    Box(Modifier.size(34.dp).clip(CircleShape).background(Brand.badge), contentAlignment = Alignment.Center) {
        Text("%d".format(n), color = Color.White, style = MaterialTheme.typography.titleSmall)
    }
}
