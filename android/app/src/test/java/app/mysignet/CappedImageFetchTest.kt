package app.mysignet

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CappedImageFetchTest {
    private fun literal(host: String) = CappedImageFetch.literalHostIsPublic(host)

    @Test fun `public literals pass`() {
        assertTrue(literal("8.8.8.8"))
        assertTrue(literal("2606:4700:4700::1111"))
        assertTrue(literal("2002:808:808::")) // 6to4 of 8.8.8.8
        assertTrue(literal("example.com")) // names are the Dns hook's job
    }

    @Test fun `internal v4 literals are refused`() {
        for (h in listOf("127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254",
            "100.64.0.1", "0.0.0.0", "224.0.0.1")) assertFalse(h, literal(h))
    }

    @Test fun `odd numeric hosts are refused`() {
        for (h in listOf("2130706433", "127.1", "1..2", "999.1.1.1")) assertFalse(h, literal(h))
    }

    @Test fun `internal and translated v6 literals are refused`() {
        for (h in listOf("::1", "::", "fe80::1", "fc00::1", "fd12::1", "fec0::1", "ff02::1",
            "64:ff9b::a9fe:a9fe", "64:ff9b::808:808", "64:ff9b:1::1",
            "2002:a9fe:a9fe::", "2002:7f00:1::",
            "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "::7f00:1")) assertFalse(h, literal(h))
    }
}
