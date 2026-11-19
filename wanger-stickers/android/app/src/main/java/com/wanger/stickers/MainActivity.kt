package com.wanger.stickers

import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.core.net.toUri
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.wanger.stickers.ui.Actions
import com.wanger.stickers.ui.App
import com.wanger.stickers.ui.AppModel
import com.wanger.stickers.ui.WangerTheme
import kotlinx.coroutines.launch

/**
 * The only screen host. Packs arrive as the bot's ZIP: opened from Telegram ("Open with"), shared
 * to the app, or picked with the system file picker (no storage permission needed).
 */
class MainActivity : ComponentActivity() {
    private val model: AppModel by viewModels { viewModelFactory { initializer { AppModel(application) } } }

    private val pick = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri -> uri?.let { model.import(it) } }
    private val addToWhatsApp = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        model.onAddResult(r.resultCode == RESULT_OK, r.data)
    }

    private val actions by lazy {
        Actions(
            pickFile = {
                try {
                    pick.launch(MIME_TYPES)
                } catch (e: ActivityNotFoundException) {
                    model.sheet = com.wanger.stickers.ui.Sheet.Failed(getString(R.string.cant_open))
                }
            },
            openBot = {
                try {
                    startActivity(Intent(Intent.ACTION_VIEW, getString(R.string.bot_url).toUri()))
                } catch (e: ActivityNotFoundException) {
                    model.sheet = com.wanger.stickers.ui.Sheet.Failed(getString(R.string.bot_url))
                }
            },
            add = { pack ->
                lifecycleScope.launch {
                    model.onPlan(model.plan(pack)) { intent ->
                        try {
                            addToWhatsApp.launch(intent)
                            true
                        } catch (e: ActivityNotFoundException) {
                            false
                        }
                    }
                }
            },
        )
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        // light status-bar icons: both screens start with the gradient header
        enableEdgeToEdge(statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT))
        super.onCreate(savedInstanceState)
        setContent { WangerTheme { App(model, actions) } }
        if (savedInstanceState == null) handle(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handle(intent)
    }

    override fun onResume() {
        super.onResume()
        model.refresh() // the user may have added or removed packs in WhatsApp meanwhile
    }

    /** A file opened with ("View") or shared to ("Send") the app. */
    private fun handle(intent: Intent?) {
        val uri: Uri? = when (intent?.action) {
            Intent.ACTION_VIEW -> intent.data
            Intent.ACTION_SEND -> if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
            else @Suppress("DEPRECATION") intent.getParcelableExtra(Intent.EXTRA_STREAM)
            else -> null
        }
        if (uri != null) model.import(uri)
    }

    companion object {
        private val MIME_TYPES = arrayOf("application/zip", "application/x-zip-compressed", "application/x-zip", "application/octet-stream")
    }
}
