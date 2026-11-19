package com.wanger.stickers.ui

import android.app.Application
import android.content.Intent
import android.net.Uri
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.wanger.stickers.ImportException
import com.wanger.stickers.PackMeta
import com.wanger.stickers.PackReader
import com.wanger.stickers.PackStore
import com.wanger.stickers.R
import com.wanger.stickers.StickerContentProvider
import com.wanger.stickers.StoreFullException
import com.wanger.stickers.WhatsApp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileNotFoundException

/** A pack as the screens show it: its metadata, its files and whether every WhatsApp has it. */
class PackUi(val meta: PackMeta, val tray: File?, val stickers: List<File?>, val added: Boolean) {
    val id get() = meta.identifier
}

/** What the bottom sheet shows. */
sealed interface Sheet {
    data object AddPack : Sheet
    data class Imported(val pack: PackUi, val replaced: Boolean) : Sheet
    data class Failed(val message: String) : Sheet
}

/** What "Add to WhatsApp" should do. */
sealed interface AddPlan {
    data object NoWhatsApp : AddPlan
    data object Already : AddPlan
    class Launch(val intent: Intent) : AddPlan
}

/**
 * The app's state and actions (survives rotation). Disk and WhatsApp queries run on the IO
 * dispatcher; the screens read the Compose state below. Built by MainActivity's own factory with
 * the activity's application (the framework's AndroidViewModel factory caches the first one).
 */
class AppModel(private val app: Application) : ViewModel() {
    private val store = PackStore.of(app.filesDir)
    private fun str(id: Int, vararg args: Any) = app.getString(id, *args)

    var packs by mutableStateOf<List<PackUi>>(emptyList())
        private set
    var loaded by mutableStateOf(false)
        private set
    var importing by mutableStateOf(false)
        private set
    var sheet by mutableStateOf<Sheet?>(null)
    var openPack by mutableStateOf<String?>(null)
    var confirmDelete by mutableStateOf<PackUi?>(null)

    private val _messages = MutableSharedFlow<String>(extraBufferCapacity = 4)
    /** Short confirmations for the snackbar. */
    val messages: SharedFlow<String> = _messages

    init {
        refresh()
    }

    private fun ui(m: PackMeta): PackUi {
        val ctx = app
        val apps = WhatsApp.apps(ctx)
        val added = apps.isNotEmpty() && apps.all { WhatsApp.isAdded(ctx, it, m.identifier) == true }
        return PackUi(m, store.file(m.identifier, m.tray), m.stickers.map { store.file(m.identifier, it.file) }, added)
    }

    fun refresh() {
        viewModelScope.launch {
            packs = withContext(Dispatchers.IO) { store.list().map { ui(it) } }
            loaded = true
            if (openPack != null && packs.none { it.id == openPack }) openPack = null
        }
    }

    fun import(uri: Uri) {
        if (importing) return
        importing = true
        sheet = null
        viewModelScope.launch {
            try {
                val (meta, replaced) = withContext(Dispatchers.IO) {
                    val read = (app.contentResolver.openInputStream(uri) ?: throw FileNotFoundException()).use { PackReader.read(it) }
                    store.save(read)
                }
                StickerContentProvider.notifyChanged(app)
                packs = withContext(Dispatchers.IO) { store.list().map { ui(it) } }
                loaded = true
                packs.firstOrNull { it.id == meta.identifier }?.let { sheet = Sheet.Imported(it, replaced) }
            } catch (e: Exception) {
                sheet = Sheet.Failed(messageFor(e))
            } finally {
                importing = false
            }
        }
    }

    fun delete(pack: PackUi) {
        confirmDelete = null
        viewModelScope.launch {
            withContext(Dispatchers.IO) { store.delete(pack.id) }
            StickerContentProvider.notifyChanged(app)
            if (openPack == pack.id) openPack = null
            _messages.tryEmit(str(R.string.deleted))
            refresh()
        }
    }

    /** Which WhatsApp to ask: the one that lacks the pack, a chooser when both lack it. */
    suspend fun plan(pack: PackUi): AddPlan = withContext(Dispatchers.IO) {
        val ctx = app
        val states = WhatsApp.apps(ctx).map { it to WhatsApp.isAdded(ctx, it, pack.id) }
        val missing = states.filter { it.second != true }.map { it.first }
        when {
            states.isEmpty() -> AddPlan.NoWhatsApp
            missing.isEmpty() -> AddPlan.Already
            missing.size == 1 -> AddPlan.Launch(WhatsApp.addIntent(ctx, pack.meta, missing[0]))
            else -> AddPlan.Launch(Intent.createChooser(WhatsApp.addIntent(ctx, pack.meta, null), str(R.string.add_to)))
        }
    }

    fun onPlan(plan: AddPlan, launch: (Intent) -> Boolean) {
        when (plan) {
            AddPlan.NoWhatsApp -> sheet = Sheet.Failed(str(R.string.no_whatsapp))
            AddPlan.Already -> _messages.tryEmit(str(R.string.already_added))
            is AddPlan.Launch -> if (!launch(plan.intent)) sheet = Sheet.Failed(str(R.string.wa_too_old))
        }
    }

    /** WhatsApp's answer to ENABLE_STICKER_PACK. */
    fun onAddResult(ok: Boolean, data: Intent?) {
        if (ok) _messages.tryEmit(str(R.string.added_ok))
        else data?.getStringExtra(WhatsApp.EXTRA_VALIDATION_ERROR)?.let { sheet = Sheet.Failed(str(R.string.wa_refused, it)) }
        refresh()
    }

    fun messageFor(e: Throwable): String {
        val res = app.resources
        return when (e) {
            is StoreFullException -> str(R.string.full)
            is ImportException -> when (e.code) {
                ImportException.Code.NOT_ZIP -> str(R.string.err_not_zip)
                ImportException.Code.TOO_BIG -> str(R.string.err_too_big)
                ImportException.Code.NO_PACK -> str(R.string.err_no_pack)
                ImportException.Code.BAD_META -> str(R.string.err_bad_meta)
                ImportException.Code.IDENTIFIER -> str(R.string.err_identifier)
                ImportException.Code.NAME -> str(R.string.err_name)
                ImportException.Code.PUBLISHER -> str(R.string.err_publisher)
                ImportException.Code.TOO_FEW -> res.getQuantityString(R.plurals.err_too_few, e.count, e.count)
                ImportException.Code.TOO_MANY -> res.getQuantityString(R.plurals.err_too_many, e.count, e.count)
                ImportException.Code.NO_TRAY -> str(R.string.err_no_tray)
                ImportException.Code.BAD_TRAY -> str(R.string.err_bad_tray)
                ImportException.Code.STICKER_MISSING -> str(R.string.err_sticker_missing, e.sticker)
                ImportException.Code.STICKER_NOT_WEBP -> str(R.string.err_sticker_not_webp, e.sticker)
                ImportException.Code.STICKER_NOT_512 -> str(R.string.err_sticker_not_512, e.sticker)
                ImportException.Code.STICKER_MIXED -> str(R.string.err_sticker_mixed, e.sticker)
                ImportException.Code.STICKER_TOO_BIG -> str(R.string.err_sticker_too_big, e.sticker)
                ImportException.Code.STICKER_TOO_LONG -> str(R.string.err_sticker_too_long, e.sticker)
                ImportException.Code.STICKER_FRAME_TOO_SHORT -> str(R.string.err_sticker_frame, e.sticker)
            }
            else -> str(R.string.cant_open)
        }
    }
}
