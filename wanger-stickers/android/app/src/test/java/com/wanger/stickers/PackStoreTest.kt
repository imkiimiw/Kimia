package com.wanger.stickers

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class PackStoreTest {
    @get:Rule val tmp = TemporaryFolder()
    private var now = 1000L
    private fun store(root: File = File(tmp.root, "packs")) = PackStore(root) { now }
    private fun pack(id: String = "ws_a_w1", n: Int = 3) = TestData.read(TestData.packZip(n = n, identifier = id))

    @Test fun savesListsAndServesOnlyListedFiles() {
        val s = store()
        val (meta, replaced) = s.save(TestData.read(TestData.fixture("static.zip")))
        assertFalse(replaced)
        assertEquals(1, meta.version)
        assertEquals(1000L, meta.importedAt)
        assertEquals(listOf("ws_gi4x_w1"), s.list().map { it.identifier })
        assertEquals("پک تست Wanger", s.get("ws_gi4x_w1")!!.name)
        assertNotNull(s.file("ws_gi4x_w1", "01.webp"))
        assertNotNull(s.file("ws_gi4x_w1", "tray.png"))
        for (bad in listOf("meta.json", "../meta.json", "04.webp", "", "/etc/passwd")) assertNull(bad, s.file("ws_gi4x_w1", bad))
        assertNull(s.file("nope", "01.webp"))
        // folders are named by a hash, never by the identifier
        assertTrue(File(tmp.root, "packs").list()!!.all { it.matches(Regex("^p_[0-9a-f]{32}$")) })
        // a second instance (process restart) sees the same packs
        assertEquals(meta, store().get("ws_gi4x_w1"))
    }

    @Test fun reimportReplacesAndBumpsTheVersion() {
        val s = store()
        s.save(pack(n = 3))
        now = 2000
        val (meta, replaced) = s.save(pack(n = 5))
        assertTrue(replaced)
        assertEquals(2, meta.version)
        assertEquals(1, s.list().size)
        assertEquals(5, s.get("ws_a_w1")!!.stickers.size)
        assertNotNull(s.file("ws_a_w1", "05.webp"))
        assertArrayEquals(pack(n = 5).files.getValue("tray.png"), s.file("ws_a_w1", "tray.png")!!.readBytes())
    }

    @Test fun holdsAtMostTenPacks() {
        val s = store()
        for (i in 1..10) { now = i.toLong(); s.save(pack("ws_a_w$i")) }
        assertEquals("ws_a_w10", s.list().first().identifier) // newest first
        try {
            s.save(pack("ws_a_w11"))
            throw AssertionError("expected StoreFullException")
        } catch (e: StoreFullException) {
        }
        s.save(pack("ws_a_w3")) // replacing one is still fine
        assertTrue(s.delete("ws_a_w4"))
        assertFalse(s.delete("ws_a_w4"))
        s.save(pack("ws_a_w11"))
        assertEquals(10, s.list().size)
    }

    @Test fun cleansUpInterruptedSaves() {
        val root = File(tmp.root, "packs")
        store(root).save(pack())
        File(root, ".tmp-123").mkdirs()
        File(root, ".old-456/x").apply { parentFile!!.mkdirs(); writeText("x") }
        val s = store(root)
        assertEquals(listOf("p_"), root.list()!!.map { it.take(2) })
        assertEquals(1, s.list().size)
    }
}
