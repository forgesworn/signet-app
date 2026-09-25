package app.mysignet

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class Nip55WireTest {
    @Test fun `an intent's payload is the scheme-specific part, untouched`() {
        val event = """{"kind":20460,"content":"","tags":[["d","room"]]}"""
        val r = Nip55Incoming.fromIntent("id1", "dev.forgesworn.kithmoot", "KithMoot", "nostrsigner:$event", "sign_event", "npub1abc", null, null)
        assertEquals(event, r.payload)
        assertEquals("sign_event", r.type)
        assertEquals("npub1abc", r.currentUser)
        assertFalse(r.viaProvider)
        assertNull(Nip55Incoming.fromIntent("id2", null, null, "nostrsigner:", "get_public_key", null, null, null).payload)
        assertNull(Nip55Incoming.fromIntent("id3", null, null, "https://x/", "sign_event", null, null, null).payload)
    }

    @Test fun `a provider query lays the projection out the Amber way`() {
        val r = Nip55Incoming.fromProvider("id", "com.app", "An App", "nip44_encrypt", arrayOf("hello", "ab".repeat(32), "cd".repeat(32)))
        assertEquals("hello", r.payload); assertEquals("ab".repeat(32), r.peerPubkey); assertEquals("cd".repeat(32), r.currentUser)
        assertTrue(r.viaProvider)
        val fields = r.fields()
        assertEquals("nip44_encrypt", fields["type"])
        assertNull(fields["permissions"])
        assertEquals(true, fields["viaProvider"])
    }

    @Test fun `authorities name the method`() {
        assertEquals("app.mysignet.SIGN_EVENT", Nip55Wire.authority("app.mysignet", "sign_event"))
        assertEquals("sign_event", Nip55Wire.methodOf("app.mysignet.SIGN_EVENT", "app.mysignet"))
        assertEquals("ping", Nip55Wire.methodOf("app.mysignet.PING", "app.mysignet"))
        assertNull(Nip55Wire.methodOf("app.mysignet.NIP04_ENCRYPT", "app.mysignet"))
        assertNull(Nip55Wire.methodOf("com.other.SIGN_EVENT", "app.mysignet"))
    }

    @Test fun `the registry holds a request while the page is down and routes the answer by id`() {
        assertTrue(Nip55Answer("ok", "sig", "{}").ok)
        assertTrue(Nip55Answer("deferred", null, null).deferred)

        var got: Nip55Answer? = null
        val request = Nip55Incoming.fromProvider("r9", "x", null, "sign_event", arrayOf("{}"))
        Nip55Requests.submit(request) { got = it }
        assertEquals(listOf(request), Nip55Requests.drain(), "held while the page is down")
        Nip55Requests.answer("other", Nip55Answer("ok", null, null))
        assertNull(got)
        Nip55Requests.answer("r9", Nip55Answer("rejected", null, null))
        assertEquals("rejected", got?.status)
    }

    @Test fun `ask gives up on silence and clears the request`() {
        val request = Nip55Incoming.fromProvider("slow", "x", null, "sign_event", arrayOf("{}"))
        assertNull(Nip55Requests.ask(request, 50))
        assertTrue(Nip55Requests.drain().none { it.id == "slow" })
    }

    private fun assertEquals(expected: Any?, actual: Any?, message: String) = assertEquals(message, expected, actual)
}
