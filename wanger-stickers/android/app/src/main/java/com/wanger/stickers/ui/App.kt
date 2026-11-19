package com.wanger.stickers.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHostState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.unit.LayoutDirection

/** The whole app: the pack list, or one pack sliding in from the reading direction; sheets on top. */
@Composable
fun App(model: AppModel, actions: Actions) {
    val snackbar = remember { SnackbarHostState() }
    LaunchedEffect(Unit) { model.messages.collect { snackbar.showSnackbar(it) } }
    BackHandler(enabled = model.openPack != null) { model.openPack = null }
    val forward = if (LocalLayoutDirection.current == LayoutDirection.Rtl) -1 else 1
    Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        AnimatedContent(
            targetState = model.openPack,
            transitionSpec = {
                val opening = targetState != null
                val dir = if (opening) forward else -forward
                (slideInHorizontally(tween(320)) { it / 3 * dir } + fadeIn(tween(320))) togetherWith
                    (slideOutHorizontally(tween(260)) { -it / 4 * dir } + fadeOut(tween(200)))
            },
            label = "screen",
        ) { id ->
            val pack = id?.let { i -> model.packs.firstOrNull { it.id == i } }
            if (pack == null) HomeScreen(model, actions, snackbar) else PackScreen(pack, model, actions, snackbar)
        }
        Sheets(model, actions)
    }
}
