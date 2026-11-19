package com.wanger.stickers.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.wanger.stickers.R

/** Vazirmatn (SIL OFL 1.1, assets/licenses/Vazirmatn-OFL.txt): Persian and Latin in one family. */
val Vazirmatn = FontFamily(
    Font(R.font.vazirmatn_regular, FontWeight.Normal),
    Font(R.font.vazirmatn_medium, FontWeight.Medium),
    Font(R.font.vazirmatn_bold, FontWeight.Bold),
    Font(R.font.vazirmatn_extrabold, FontWeight.ExtraBold),
)

/** The Wanger palette: violet → purple → pink, with a sky accent and a "done" green. */
object Brand {
    val Violet = Color(0xFF5B34E8)
    val Purple = Color(0xFF8E44FF)
    val Pink = Color(0xFFE04FB0)
    val Sky = Color(0xFF3BC9F5)
    val Green = Color(0xFF17A653)
    val GreenDark = Color(0xFF5FDB94)
    val hero = Brush.linearGradient(listOf(Violet, Purple, Pink))
    val badge = Brush.linearGradient(listOf(Violet, Pink))
    val tiles = listOf(
        Brush.linearGradient(listOf(Color(0xFF7B5CFF), Color(0xFFB36BFF))),
        Brush.linearGradient(listOf(Color(0xFFFF6FA8), Color(0xFFFF9E6B))),
        Brush.linearGradient(listOf(Color(0xFF3BC9F5), Color(0xFF6B8CFF))),
    )
}

private val Light = lightColorScheme(
    primary = Color(0xFF6236F0),
    onPrimary = Color.White,
    primaryContainer = Color(0xFFE8E0FF),
    onPrimaryContainer = Color(0xFF1F0061),
    secondary = Color(0xFFC2378F),
    onSecondary = Color.White,
    secondaryContainer = Color(0xFFFFD8EC),
    onSecondaryContainer = Color(0xFF3D0029),
    tertiary = Color(0xFF0B7FA6),
    background = Color(0xFFF7F5FC),
    onBackground = Color(0xFF1B1A22),
    surface = Color(0xFFF7F5FC),
    onSurface = Color(0xFF1B1A22),
    surfaceVariant = Color(0xFFEDE9F7),
    onSurfaceVariant = Color(0xFF5D586E),
    surfaceContainerLowest = Color.White,
    surfaceContainerLow = Color.White,
    surfaceContainer = Color(0xFFF1EEF9),
    surfaceContainerHigh = Color(0xFFEBE7F5),
    surfaceContainerHighest = Color(0xFFE5E1F0),
    outline = Color(0xFF8C86A0),
    outlineVariant = Color(0xFFDCD7E9),
    error = Color(0xFFBA1A1A),
    errorContainer = Color(0xFFFFDAD6),
    onErrorContainer = Color(0xFF410002),
)

private val Dark = darkColorScheme(
    primary = Color(0xFFC9B8FF),
    onPrimary = Color(0xFF2E0E8C),
    primaryContainer = Color(0xFF4A27C9),
    onPrimaryContainer = Color(0xFFE8E0FF),
    secondary = Color(0xFFFFAFD6),
    onSecondary = Color(0xFF5E1146),
    secondaryContainer = Color(0xFF7B2860),
    onSecondaryContainer = Color(0xFFFFD8EC),
    tertiary = Color(0xFF7FD3F5),
    background = Color(0xFF100E17),
    onBackground = Color(0xFFE7E2F0),
    surface = Color(0xFF100E17),
    onSurface = Color(0xFFE7E2F0),
    surfaceVariant = Color(0xFF2A2638),
    onSurfaceVariant = Color(0xFFCAC4D8),
    surfaceContainerLowest = Color(0xFF0B0A11),
    surfaceContainerLow = Color(0xFF1A1724),
    surfaceContainer = Color(0xFF1F1B2A),
    surfaceContainerHigh = Color(0xFF292535),
    surfaceContainerHighest = Color(0xFF343040),
    outline = Color(0xFF948EA6),
    outlineVariant = Color(0xFF3F3A4F),
    error = Color(0xFFFFB4AB),
    errorContainer = Color(0xFF93000A),
    onErrorContainer = Color(0xFFFFDAD6),
)

private fun TextStyle.v() = copy(fontFamily = Vazirmatn)

private val Base = Typography()
private val Type = Typography(
    displayLarge = Base.displayLarge.v(), displayMedium = Base.displayMedium.v(), displaySmall = Base.displaySmall.v(),
    headlineLarge = Base.headlineLarge.v().copy(fontWeight = FontWeight.ExtraBold),
    headlineMedium = Base.headlineMedium.v().copy(fontWeight = FontWeight.ExtraBold),
    headlineSmall = Base.headlineSmall.v().copy(fontWeight = FontWeight.ExtraBold),
    titleLarge = Base.titleLarge.v().copy(fontWeight = FontWeight.Bold),
    titleMedium = Base.titleMedium.v().copy(fontWeight = FontWeight.Bold),
    titleSmall = Base.titleSmall.v().copy(fontWeight = FontWeight.Bold),
    bodyLarge = Base.bodyLarge.v(), bodyMedium = Base.bodyMedium.v(), bodySmall = Base.bodySmall.v(),
    labelLarge = Base.labelLarge.v().copy(fontWeight = FontWeight.Bold),
    labelMedium = Base.labelMedium.v().copy(fontWeight = FontWeight.Medium),
    labelSmall = Base.labelSmall.v().copy(fontWeight = FontWeight.Medium),
)

private val Shape = Shapes(
    extraSmall = RoundedCornerShape(10.dp),
    small = RoundedCornerShape(14.dp),
    medium = RoundedCornerShape(20.dp),
    large = RoundedCornerShape(28.dp),
    extraLarge = RoundedCornerShape(32.dp),
)

@Composable
fun WangerTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = if (dark) Dark else Light, typography = Type, shapes = Shape, content = content)
}

/** The "already in WhatsApp" green for the current theme. */
@Composable
fun doneGreen(): Color = if (isSystemInDarkTheme()) Brand.GreenDark else Brand.Green
