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

    @Test fun `a percent-encoded payload is decoded, as Uri_Builder opaquePart sends it`() {
        // KithMoot builds `Uri.Builder().scheme("nostrsigner").opaquePart(json)`, which encodes.
        val event = """{"kind":20460,"content":"50% off, 1+1 #tag ✓","tags":[["d","room"]]}"""
        val encoded = java.net.URLEncoder.encode(event, "UTF-8").replace("+", "%20")
        val r = Nip55Incoming.fromIntent("id1", "dev.forgesworn.kithmoot", "KithMoot", "nostrsigner:$encoded", "sign_event", null, null, null)
        assertEquals(event, r.payload)
        // NIP-44 ciphertext is base64: its + / = arrive escaped and must come back exact.
        val cipher = "AqWa+b/cd=="
        assertEquals(cipher, Nip55Incoming.fromIntent("id2", null, null, "nostrsigner:AqWa%2Bb%2Fcd%3D%3D", "nip44_decrypt", null, null, null).payload)
    }

    @Test fun `a raw payload with a stray percent is kept as sent`() {
        val event = """{"kind":1,"content":"50% off","tags":[]}"""
        assertEquals(event, Nip55Incoming.fromIntent("id1", null, null, "nostrsigner:$event", "sign_event", null, null, null).payload)
        assertEquals("ends in %", Nip55Incoming.percentDecoded("ends in %"))
        assertEquals("%E2%82", Nip55Incoming.percentDecoded("%E2%82"))
        assertEquals("1+1", Nip55Incoming.percentDecoded("1+1"))
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

    @Test fun `nip04_decrypt is answered, nip04_encrypt and the zap decrypt are not`() {
        assertEquals("app.mysignet.NIP04_DECRYPT", Nip55Wire.authority("app.mysignet", "nip04_decrypt"))
        assertEquals("nip04_decrypt", Nip55Wire.methodOf("app.mysignet.NIP04_DECRYPT", "app.mysignet"))
        // The debug build has its own package, and so its own authorities.
        assertEquals("nip04_decrypt", Nip55Wire.methodOf("app.mysignet.debug.NIP04_DECRYPT", "app.mysignet.debug"))
        assertTrue("nip04_decrypt" in Nip55Wire.METHODS)
        assertFalse("nip04_encrypt" in Nip55Wire.METHODS)
        assertFalse("decrypt_zap_event" in Nip55Wire.METHODS)
        assertNull(Nip55Wire.methodOf("app.mysignet.NIP04_ENCRYPT", "app.mysignet"))
        assertNull(Nip55Wire.methodOf("app.mysignet.DECRYPT_ZAP_EVENT", "app.mysignet"))
    }

    @Test fun `an intent type is supported only for the methods this signer answers, in any case`() {
        for (type in listOf("get_public_key", "sign_event", "nip44_encrypt", "nip44_decrypt", "nip04_decrypt", "NIP04_DECRYPT")) {
            assertTrue(type, Nip55Wire.supports(type))
        }
        for (type in listOf("nip04_encrypt", "NIP04_ENCRYPT", "decrypt_zap_event", "ping", "", null)) {
            assertFalse(type ?: "null", Nip55Wire.supports(type))
        }
    }

    @Test fun `the manifest offers a provider authority for every method, and none for nip04_encrypt`() {
        // Unit tests run in the module directory (android/app); the checkout root is a fallback for other runners.
        val manifest = listOf("src/main/AndroidManifest.xml", "app/src/main/AndroidManifest.xml", "android/app/src/main/AndroidManifest.xml")
            .map { java.io.File(it) }.first { it.isFile }.readText()
        val declared = Regex("android:authorities=\"([^\"]*)\"").findAll(manifest)
            .flatMap { it.groupValues[1].split(';') }
            .filter { it.startsWith("\${applicationId}.") }
            .map { it.removePrefix("\${applicationId}.") }
            .filter { it == it.uppercase() } // the method authorities; `fileprovider` is another provider's
            .toSet()
        assertEquals(Nip55Wire.METHODS.map { it.uppercase() }.toSet() + "PING", declared)
        assertFalse("NIP04_ENCRYPT" in declared)
    }

    @Test fun `a NIP-04 ciphertext keeps its query and base64 characters, raw or percent-encoded`() {
        // NIP-04 content is `<base64>?iv=<base64>`; the `?`, `=`, `+` and `/` must reach the page exactly.
        val cipher = "AqWa+b/cd==?iv=Zm9v+/YQ=="
        val raw = Nip55Incoming.fromIntent("id1", "com.vitorpamplona.amethyst", "Amethyst", "nostrsigner:$cipher", "nip04_decrypt", null, "ab".repeat(32), null)
        assertEquals(cipher, raw.payload)
        assertEquals("nip04_decrypt", raw.type)
        assertEquals("ab".repeat(32), raw.peerPubkey)
        val encoded = "nostrsigner:AqWa%2Bb%2Fcd%3D%3D%3Fiv%3DZm9v%2B%2FYQ%3D%3D"
        assertEquals(cipher, Nip55Incoming.fromIntent("id2", null, null, encoded, "nip04_decrypt", null, null, null).payload)
    }

    @Test fun `a nip04_decrypt provider query lays out like the other crypto methods`() {
        val cipher = "AqWa+b/cd==?iv=Zm9v+/YQ=="
        val r = Nip55Incoming.fromProvider("id", "com.app", "An App", "nip04_decrypt", arrayOf(cipher, "ab".repeat(32), "cd".repeat(32)))
        assertEquals(cipher, r.payload); assertEquals("ab".repeat(32), r.peerPubkey); assertEquals("cd".repeat(32), r.currentUser)
        assertTrue(r.viaProvider)
        assertEquals("nip04_decrypt", r.fields()["type"])
    }

    @Test fun `a decrypt answer hands the plaintext back as result and signature, never as an event`() {
        val extras = Nip55Wire.resultExtras("caller-9", "app.mysignet", Nip55Answer("ok", "an old message", null))
        assertEquals("an old message", extras[Nip55Wire.EXTRA_RESULT])
        assertEquals("caller-9", extras[Nip55Wire.EXTRA_ID])
        assertFalse(extras.containsKey(Nip55Wire.EXTRA_EVENT))
        assertFalse(extras.containsKey(Nip55Wire.EXTRA_REJECTED))
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

    @Test fun `a frozen page is up but not answering, until it resumes or a new page attaches`() {
        val deliver: (Nip55Incoming) -> Unit = {}
        val withdraw: (String) -> Unit = {}
        Nip55Requests.attach(deliver, withdraw)
        assertTrue(Nip55Requests.pageAnswering)
        Nip55Requests.pageFrozen(true)
        assertTrue(Nip55Requests.pageUp)
        assertFalse(Nip55Requests.pageAnswering)
        Nip55Requests.pageFrozen(false)
        assertTrue(Nip55Requests.pageAnswering)
        Nip55Requests.pageFrozen(true)
        Nip55Requests.attach(deliver, withdraw)
        assertTrue(Nip55Requests.pageAnswering)
        Nip55Requests.detach(deliver, withdraw)
        assertFalse(Nip55Requests.pageAnswering)
    }

    @Test fun `ask gives up on silence and clears the request`() {
        val request = Nip55Incoming.fromProvider("slow", "x", null, "sign_event", arrayOf("{}"))
        assertNull(Nip55Requests.ask(request, 50))
        assertTrue(Nip55Requests.drain().none { it.id == "slow" })
    }

    private fun assertEquals(expected: Any?, actual: Any?, message: String) = assertEquals(message, expected, actual)

    @Test fun `a result echoes the caller's own id, never the signer's internal one`() {
        val ok = Nip55Wire.resultExtras("caller-7", "app.mysignet", Nip55Answer("ok", "sig", """{"id":"e"}"""))
        assertEquals("caller-7", ok[Nip55Wire.EXTRA_ID])
        assertEquals("sig", ok[Nip55Wire.EXTRA_RESULT])
        assertEquals("sig", ok[Nip55Wire.EXTRA_SIGNATURE])
        assertEquals("""{"id":"e"}""", ok[Nip55Wire.EXTRA_EVENT])
        assertEquals("app.mysignet", ok[Nip55Wire.EXTRA_PACKAGE])
        assertNull(ok[Nip55Wire.EXTRA_REJECTED])
    }

    @Test fun `a refusal or a timeout echoes the caller's id too`() {
        for (answer in listOf(Nip55Answer("rejected", null, null), null)) {
            val r = Nip55Wire.resultExtras("caller-8", "app.mysignet", answer)
            assertEquals("caller-8", r[Nip55Wire.EXTRA_ID])
            assertEquals(true, r[Nip55Wire.EXTRA_REJECTED])
            assertNull(r[Nip55Wire.EXTRA_RESULT])
        }
    }

    @Test fun `a caller that sent no id gets none back`() {
        assertFalse(Nip55Wire.resultExtras(null, "app.mysignet", Nip55Answer("ok", "x", null)).containsKey(Nip55Wire.EXTRA_ID))
        assertFalse(Nip55Wire.resultExtras("", "app.mysignet", null).containsKey(Nip55Wire.EXTRA_ID))
    }
}
