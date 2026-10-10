package app.mysignet

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BluetoothNameMaskTest {
    /** A stack that applies a rename after [lag] reads, like the real asynchronous one. */
    private class Adapter(var name: String?, private val lag: Int = 0) : AdapterName {
        var refuse = false
        val sets = mutableListOf<String>()
        private var pending: String? = null
        private var reads = 0
        override fun get(): String? {
            pending?.let { if (++reads > lag) { name = it; pending = null } }
            return name
        }
        override fun set(name: String): Boolean {
            if (refuse || this.name == null) return false
            sets += name; pending = name; reads = 0
            return true
        }
    }
    private class Store : NameStore {
        var value: String? = null
        val log = mutableListOf<String>()
        override fun saved() = value
        override fun save(name: String) { value = name; log += "save:$name" }
        override fun clear() { value = null; log += "clear" }
    }
    private fun mask(adapter: Adapter, store: Store) = BluetoothNameMask(adapter, store) { }

    @Test fun `saves the real name before renaming, waits for the stack, then restores it`() {
        val adapter = Adapter("Owner's phone", lag = 3); val store = Store()
        val order = mutableListOf<String>()
        val m = BluetoothNameMask(object : AdapterName {
            override fun get() = adapter.get()
            override fun set(name: String): Boolean { order += "set:$name (saved=${store.value})"; return adapter.set(name) }
        }, store) { }
        assertTrue(m.mask())
        assertEquals("Phone", adapter.name)
        assertEquals("set:Phone (saved=Owner's phone)", order[0])
        assertTrue(m.restore())
        assertEquals("Owner's phone", adapter.name)
        assertNull(store.value)
    }

    @Test fun `a refused rename leaves the name and no record`() {
        val adapter = Adapter("Owner's phone").apply { refuse = true }; val store = Store()
        assertFalse(mask(adapter, store).mask())
        assertEquals("Owner's phone", adapter.name)
        assertNull(store.value)
    }

    @Test fun `never undoes a rename the owner made while masked`() {
        val adapter = Adapter("Owner's phone"); val store = Store(); val m = mask(adapter, store)
        m.mask()
        adapter.name = "Kitchen tablet"
        assertTrue(m.restore())
        assertEquals("Kitchen tablet", adapter.name)
        assertNull(store.value)
    }

    @Test fun `keeps the record while the radio is off, and restores once it is back`() {
        val adapter = Adapter("Owner's phone"); val store = Store(); val m = mask(adapter, store)
        m.mask()
        adapter.name = null
        assertFalse(m.restore())
        assertEquals("Owner's phone", store.value)
        adapter.name = "Phone"
        assertTrue(m.restore())
        assertEquals("Owner's phone", adapter.name)
    }

    @Test fun `a fresh start after a crash restores the saved name`() {
        val adapter = Adapter("Phone"); val store = Store().apply { value = "Owner's phone" }
        assertTrue(mask(adapter, store).restore())
        assertEquals("Owner's phone", adapter.name)
    }

    @Test fun `a second session while still masked keeps the original record`() {
        val adapter = Adapter("Owner's phone"); val store = Store(); val m = mask(adapter, store)
        m.mask(); m.mask()
        assertEquals("Owner's phone", store.value)
        assertEquals(listOf("Phone"), adapter.sets)
    }

    @Test fun `an owner who chose the name Phone is left alone`() {
        val adapter = Adapter("Phone"); val store = Store(); val m = mask(adapter, store)
        assertTrue(m.mask())
        assertTrue(m.restore())
        assertEquals("Phone", adapter.name)
        assertTrue(adapter.sets.isEmpty())
        assertTrue(store.log.isEmpty())
    }

    @Test fun `a restore the stack never confirms keeps the record for next time`() {
        val adapter = Adapter("Owner's phone", lag = 1000); val store = Store(); val m = mask(adapter, store)
        assertFalse(m.mask())
        assertEquals("Owner's phone", store.value)
    }
}
