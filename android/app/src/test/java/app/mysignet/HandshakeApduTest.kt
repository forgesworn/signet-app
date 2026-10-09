package app.mysignet

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class HandshakeApduTest {
    private val readerCode = "SGH2:ABC123 \$%*+-./:".toByteArray(Charsets.US_ASCII)
    private val cardCode = "SGH2:XYZ789".toByteArray(Charsets.US_ASCII)

    @Test fun `one touch swaps both codes`() {
        val heard = mutableListOf<String>()
        val read = HandshakeApdu.read({ HandshakeApdu.respond(it, cardCode) { peer -> heard += peer } }, readerCode)
        assertEquals("SGH2:XYZ789", read)
        assertEquals(listOf("SGH2:ABC123 \$%*+-./:"), heard)
    }

    @Test fun `a phone with no handshake screen open offers nothing`() {
        var heard = false
        assertNull(HandshakeApdu.read({ HandshakeApdu.respond(it, null) { heard = true } }, readerCode))
        assertFalse(heard)
    }

    @Test fun `refuses anything that is not a session code`() {
        for (bad in listOf("", "SGH2:", "SGH1:ABC", "SGH2:abc", "SGH2:A\u00e9", "npub1xyz", "SGH2:" + "A".repeat(246))) {
            assertFalse(bad, HandshakeApdu.validCode(bad.toByteArray(Charsets.UTF_8)))
        }
        assertTrue(HandshakeApdu.validCode(("SGH2:" + "A".repeat(245)).toByteArray(Charsets.US_ASCII)))
        var heard = false
        val junk = byteArrayOf(0x80.toByte(), 0x10, 0, 0, 3, 0x41, 0x42, 0x43, 0)
        assertArrayEquals(byteArrayOf(0x6A, 0x80.toByte()), HandshakeApdu.respond(junk, cardCode) { heard = true })
        assertFalse(heard)
    }

    @Test fun `refuses a wrong AID, a short command and an unknown instruction`() {
        val select = HandshakeApdu.select()
        val wrong = select.copyOf().also { it[6] = 0x00 }
        assertArrayEquals(byteArrayOf(0x6D, 0x00), HandshakeApdu.respond(wrong, cardCode) {})
        assertArrayEquals(byteArrayOf(0x90.toByte(), 0x00), HandshakeApdu.respond(select, cardCode) {})
        val truncated = byteArrayOf(0x80.toByte(), 0x10, 0, 0, 20, 0x53)
        assertArrayEquals(byteArrayOf(0x67, 0x00), HandshakeApdu.respond(truncated, cardCode) {})
        assertArrayEquals(byteArrayOf(0x6D, 0x00), HandshakeApdu.respond(byteArrayOf(0, 0xB0.toByte(), 0, 0, 0), cardCode) {})
    }

    @Test fun `a reader ignores a card that answers with junk`() {
        val junkCard: (ByteArray) -> ByteArray = { cmd ->
            if (cmd[1] == 0xA4.toByte()) byteArrayOf(0x90.toByte(), 0x00) else "hello".toByteArray() + byteArrayOf(0x90.toByte(), 0x00)
        }
        assertNull(HandshakeApdu.read(junkCard, readerCode))
    }
}
