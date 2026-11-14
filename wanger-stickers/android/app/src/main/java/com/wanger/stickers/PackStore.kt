package com.wanger.stickers

import org.json.JSONException
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.util.Locale
import java.util.UUID

/** Thrown when a new pack would pass WhatsApp's 10-packs-per-app limit. */
class StoreFullException : Exception("store full")

/**
 * The packs on this phone: one folder per pack in the app's private storage, named by a hash of
 * the identifier (an identifier never becomes a path), holding meta.json, 01.webp… and tray.png.
 * A save writes a new folder and swaps it in, so WhatsApp never reads a half-written pack.
 * One instance per process ([of]); the ContentProvider and the screens share it.
 */
class PackStore(val root: File, private val clock: () -> Long = System::currentTimeMillis) {

    init {
        root.mkdirs()
        // leftovers of an interrupted save
        root.listFiles()?.filter { it.name.startsWith(".") }?.forEach { it.deleteRecursively() }
    }

    private fun dirOf(identifier: String): File {
        val h = MessageDigest.getInstance("SHA-256").digest(identifier.toByteArray(Charsets.UTF_8))
        return File(root, "p_" + h.take(16).joinToString("") { String.format(Locale.ROOT, "%02x", it) })
    }

    private fun readMeta(dir: File): PackMeta? = try {
        PackMeta.fromJson(JSONObject(File(dir, META).readText(Charsets.UTF_8)))
    } catch (e: IOException) {
        null
    } catch (e: JSONException) {
        null
    }

    /** All packs, newest import first. */
    @Synchronized
    fun list(): List<PackMeta> =
        (root.listFiles() ?: emptyArray()).filter { it.isDirectory && it.name.startsWith("p_") }
            .mapNotNull { readMeta(it) }.sortedByDescending { it.importedAt }

    @Synchronized
    fun get(identifier: String): PackMeta? = dirOf(identifier).takeIf { it.isDirectory }?.let { readMeta(it) }

    /** A pack's file, only when the name is one the pack lists (its tray or a sticker). */
    @Synchronized
    fun file(identifier: String, name: String): File? {
        val meta = get(identifier) ?: return null
        if (name != meta.tray && meta.stickers.none { it.file == name }) return null
        return File(dirOf(identifier), name).takeIf { it.isFile }
    }

    /**
     * Stores a checked pack; a pack with the same identifier is replaced and its image_data_version
     * bumped so WhatsApp refreshes its copy. Returns the stored metadata and whether it replaced one.
     */
    @Synchronized
    fun save(pack: ReadPack): Pair<PackMeta, Boolean> {
        val old = get(pack.meta.identifier)
        if (old == null && list().size >= Limits.MAX_PACKS) throw StoreFullException()
        val meta = pack.meta.copy(version = (old?.version ?: 0) + 1, importedAt = clock())
        val tmp = File(root, ".tmp-" + UUID.randomUUID())
        try {
            if (!tmp.mkdirs()) throw IOException("mkdir")
            for ((name, bytes) in pack.files) File(tmp, name).writeBytes(bytes)
            File(tmp, META).writeText(meta.toJson().toString(), Charsets.UTF_8)
            val target = dirOf(meta.identifier)
            if (target.exists()) {
                val trash = File(root, ".old-" + UUID.randomUUID())
                if (!target.renameTo(trash)) throw IOException("rename old")
                if (!tmp.renameTo(target)) {
                    trash.renameTo(target)
                    throw IOException("rename new")
                }
                trash.deleteRecursively()
            } else if (!tmp.renameTo(target)) throw IOException("rename new")
        } finally {
            if (tmp.exists()) tmp.deleteRecursively()
        }
        return meta to (old != null)
    }

    @Synchronized
    fun delete(identifier: String): Boolean = dirOf(identifier).let { it.isDirectory && it.deleteRecursively() }

    companion object {
        private const val META = "meta.json"

        @Volatile
        private var instance: PackStore? = null

        /** The process-wide store under the app's private files folder. */
        fun of(filesDir: File): PackStore {
            val want = File(filesDir, "packs")
            instance?.let { if (it.root == want) return it }
            synchronized(this) {
                instance?.let { if (it.root == want) return it }
                return PackStore(want).also { instance = it }
            }
        }
    }
}
