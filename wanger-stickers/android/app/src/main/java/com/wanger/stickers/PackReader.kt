package com.wanger.stickers

import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.security.MessageDigest
import java.util.Locale
import java.util.zip.ZipException
import java.util.zip.ZipInputStream

/** Why a file can't become a WhatsApp pack. [sticker] is 1-based (0 = the pack as a whole). */
class ImportException(val code: Code, val sticker: Int = 0, val count: Int = 0) : Exception("$code sticker=$sticker count=$count") {
    enum class Code {
        NOT_ZIP, TOO_BIG, NO_PACK, BAD_META, IDENTIFIER, NAME, PUBLISHER, TOO_FEW, TOO_MANY, NO_TRAY, BAD_TRAY,
        STICKER_MISSING, STICKER_NOT_WEBP, STICKER_NOT_512, STICKER_MIXED, STICKER_TOO_BIG, STICKER_TOO_LONG, STICKER_FRAME_TOO_SHORT,
    }
}

data class StickerEntry(val file: String, val emojis: List<String>)

/** A pack as the app stores it and WhatsApp reads it (contents.json fields + our bookkeeping). */
data class PackMeta(
    val identifier: String,
    val name: String,
    val publisher: String,
    val animated: Boolean,
    val tray: String,
    val stickers: List<StickerEntry>,
    /** WhatsApp's image_data_version: bumped on every re-import so WhatsApp refreshes its copy. */
    val version: Int = 1,
    val importedAt: Long = 0,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("identifier", identifier).put("name", name).put("publisher", publisher)
        .put("animated_sticker_pack", animated).put("tray_image_file", tray)
        .put("image_data_version", version).put("imported_at", importedAt)
        .put("stickers", JSONArray().apply {
            for (s in stickers) put(JSONObject().put("image_file", s.file).put("emojis", JSONArray(s.emojis)))
        })

    companion object {
        fun fromJson(o: JSONObject): PackMeta {
            val list = o.getJSONArray("stickers")
            return PackMeta(
                identifier = o.getString("identifier"),
                name = o.getString("name"),
                publisher = o.getString("publisher"),
                animated = o.optBoolean("animated_sticker_pack", false),
                tray = o.getString("tray_image_file"),
                stickers = (0 until list.length()).map { i ->
                    val s = list.getJSONObject(i)
                    StickerEntry(s.getString("image_file"), strings(s.optJSONArray("emojis")))
                },
                version = o.optInt("image_data_version", 1),
                importedAt = o.optLong("imported_at", 0),
            )
        }

        internal fun strings(a: JSONArray?): List<String> = if (a == null) emptyList() else (0 until a.length()).map { a.optString(it, "") }
    }
}

/** A checked pack: metadata with normalised file names (01.webp…, tray.png) and their bytes. */
class ReadPack(val meta: PackMeta, val files: Map<String, ByteArray>)

/**
 * Reads the bot's WhatsApp ZIP (stickers + tray.png + pack.json in contents.json shape) or a
 * `.wastickers` file (title.txt, author.txt, tray, webp files) and checks every WhatsApp rule
 * before anything is stored, so the user sees a precise reason instead of WhatsApp's generic
 * "problem with this pack". Pure JVM code: no Android classes besides org.json.
 */
object PackReader {
    private const val DEFAULT_EMOJI = "😀"
    private val WS = Regex("\\s+")

    fun read(input: InputStream): ReadPack {
        val files = LinkedHashMap<String, ByteArray>()
        val oversize = HashSet<String>()
        var total = 0L
        var entries = 0
        try {
            ZipInputStream(BufferedInputStream(input)).use { zip ->
                while (true) {
                    val e = zip.nextEntry ?: break
                    if (++entries > Limits.MAX_ENTRIES) throw ImportException(ImportException.Code.TOO_BIG)
                    if (e.isDirectory) continue
                    val name = e.name.substringAfterLast('/').substringAfterLast('\\')
                    if (name.isEmpty() || name.startsWith(".") || e.name.startsWith("__MACOSX")) continue
                    val cap = capFor(name.lowercase()) ?: continue
                    val bytes = readCapped(zip, cap)
                    total += bytes.size
                    if (total > Limits.MAX_ZIP_BYTES) throw ImportException(ImportException.Code.TOO_BIG)
                    if (bytes.size > cap) oversize += name
                    if (!files.containsKey(name)) files[name] = bytes
                }
            }
        } catch (e: ZipException) {
            throw ImportException(ImportException.Code.NOT_ZIP)
        } catch (e: IOException) {
            throw ImportException(ImportException.Code.NOT_ZIP)
        } catch (e: IllegalArgumentException) {
            throw ImportException(ImportException.Code.NOT_ZIP) // malformed entry names
        }
        if (entries == 0) throw ImportException(ImportException.Code.NOT_ZIP)
        val raw = when {
            files.containsKey("pack.json") -> fromPackJson(files)
            files.containsKey("title.txt") -> fromWaStickers(files)
            else -> throw ImportException(ImportException.Code.NO_PACK)
        }
        return check(raw, files, oversize)
    }

    /** Which entries we keep, and how many bytes each may have (one more = "too big"). */
    private fun capFor(lower: String): Int? = when {
        lower == "pack.json" || lower == "title.txt" || lower == "author.txt" -> Limits.MAX_META_BYTES
        lower.endsWith(".webp") -> Limits.ANIMATED_MAX_BYTES
        lower.endsWith(".png") -> Limits.TRAY_MAX_BYTES
        else -> null
    }

    private fun readCapped(input: InputStream, cap: Int): ByteArray {
        val out = ByteArrayOutputStream()
        val buf = ByteArray(16 * 1024)
        while (out.size() <= cap) {
            val n = input.read(buf, 0, minOf(buf.size, cap + 1 - out.size()))
            if (n < 0) break
            out.write(buf, 0, n)
        }
        return out.toByteArray()
    }

    private class Raw(val identifier: String, val name: String, val publisher: String, val animated: Boolean?, val tray: String?, val stickers: List<StickerEntry>)

    private fun fromPackJson(files: Map<String, ByteArray>): Raw {
        try {
            val o = JSONObject(String(files.getValue("pack.json"), Charsets.UTF_8))
            val list = o.getJSONArray("stickers")
            val stickers = (0 until list.length()).map { i ->
                val s = list.getJSONObject(i)
                StickerEntry(s.getString("image_file").substringAfterLast('/'), PackMeta.strings(s.optJSONArray("emojis")))
            }
            if (stickers.map { it.file }.toSet().size != stickers.size) throw ImportException(ImportException.Code.BAD_META)
            return Raw(
                identifier = o.optString("identifier", ""),
                name = o.optString("name", ""),
                publisher = o.optString("publisher", ""),
                animated = if (o.has("animated_sticker_pack")) o.optBoolean("animated_sticker_pack") else null,
                tray = o.optString("tray_image_file", "tray.png").substringAfterLast('/'),
                stickers = stickers,
            )
        } catch (e: JSONException) {
            throw ImportException(ImportException.Code.BAD_META)
        }
    }

    /** .wastickers carries no identifier and no emojis: the identifier comes from name + publisher. */
    private fun fromWaStickers(files: Map<String, ByteArray>): Raw {
        val name = String(files.getValue("title.txt"), Charsets.UTF_8).trim()
        val publisher = files["author.txt"]?.let { String(it, Charsets.UTF_8).trim() }.orEmpty()
        val pngs = files.keys.filter { it.lowercase().endsWith(".png") }
        val tray = pngs.firstOrNull { it.equals("tray.png", true) } ?: pngs.firstOrNull { it.lowercase().contains("tray") } ?: pngs.firstOrNull()
        val webps = files.keys.filter { it.lowercase().endsWith(".webp") }.sorted()
        val digest = MessageDigest.getInstance("SHA-256").digest("$name\n$publisher".toByteArray(Charsets.UTF_8))
        val id = "wst_" + digest.take(8).joinToString("") { String.format(Locale.ROOT, "%02x", it) }
        return Raw(id, name, publisher, null, tray, webps.map { StickerEntry(it, emptyList()) })
    }

    private fun oneLine(s: String, max: Int): String {
        val t = s.replace(WS, " ").trim()
        if (t.length <= max) return t
        // cut at a code-point boundary (WhatsApp counts UTF-16 units)
        var end = max
        if (Character.isLowSurrogate(t[end]) && Character.isHighSurrogate(t[end - 1])) end--
        return t.substring(0, end).trim()
    }

    private fun emojis(list: List<String>): List<String> {
        val clean = list.map { it.trim() }.filter { it.isNotEmpty() }.distinct()
        return if (clean.isEmpty()) listOf(DEFAULT_EMOJI) else clean.take(Limits.EMOJI_MAX)
    }

    private fun check(raw: Raw, files: Map<String, ByteArray>, oversize: Set<String>): ReadPack {
        if (!Limits.IDENTIFIER.matches(raw.identifier) || raw.identifier.contains("..") || raw.identifier.isBlank())
            throw ImportException(ImportException.Code.IDENTIFIER)
        val name = oneLine(raw.name, Limits.NAME_MAX_CHARS)
        if (name.isEmpty()) throw ImportException(ImportException.Code.NAME)
        val publisher = oneLine(raw.publisher, Limits.PUBLISHER_MAX_CHARS)
        if (publisher.isEmpty()) throw ImportException(ImportException.Code.PUBLISHER)
        val n = raw.stickers.size
        if (n < Limits.MIN_STICKERS) throw ImportException(ImportException.Code.TOO_FEW, count = n)
        if (n > Limits.MAX_STICKERS) throw ImportException(ImportException.Code.TOO_MANY, count = n)

        val trayName = raw.tray ?: throw ImportException(ImportException.Code.NO_TRAY)
        val tray = files[trayName] ?: throw ImportException(ImportException.Code.NO_TRAY)
        val png = Media.png(tray)
        if (png == null || trayName in oversize || tray.size > Limits.TRAY_MAX_BYTES ||
            png.width !in Limits.TRAY_MIN_SIDE..Limits.TRAY_MAX_SIDE || png.height !in Limits.TRAY_MIN_SIDE..Limits.TRAY_MAX_SIDE
        ) throw ImportException(ImportException.Code.BAD_TRAY)

        val out = LinkedHashMap<String, ByteArray>()
        val entries = ArrayList<StickerEntry>(n)
        var animated = raw.animated
        raw.stickers.forEachIndexed { i, s ->
            val k = i + 1
            val bytes = files[s.file] ?: throw ImportException(ImportException.Code.STICKER_MISSING, k)
            if (s.file in oversize) throw ImportException(ImportException.Code.STICKER_TOO_BIG, k) // cut short while reading
            val info = Media.webp(bytes) ?: throw ImportException(ImportException.Code.STICKER_NOT_WEBP, k)
            if (info.width != Limits.STICKER_SIDE || info.height != Limits.STICKER_SIDE) throw ImportException(ImportException.Code.STICKER_NOT_512, k)
            if (animated == null) animated = info.animated
            if (info.animated != animated) throw ImportException(ImportException.Code.STICKER_MIXED, k)
            val max = if (info.animated) Limits.ANIMATED_MAX_BYTES else Limits.STATIC_MAX_BYTES
            if (bytes.size > max) throw ImportException(ImportException.Code.STICKER_TOO_BIG, k)
            if (info.animated) {
                if (info.durationMs > Limits.MAX_DURATION_MS) throw ImportException(ImportException.Code.STICKER_TOO_LONG, k)
                if (info.frames > 0 && info.minFrameMs < Limits.MIN_FRAME_MS) throw ImportException(ImportException.Code.STICKER_FRAME_TOO_SHORT, k)
            }
            val file = String.format(Locale.ROOT, "%02d.webp", k) // never localised digits
            out[file] = bytes
            entries += StickerEntry(file, emojis(s.emojis))
        }
        out["tray.png"] = tray
        val meta = PackMeta(raw.identifier, name, publisher, animated == true, "tray.png", entries)
        return ReadPack(meta, out)
    }
}
