package app.mysignet

import android.content.Intent
import android.net.Uri
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28])
class WrappedBackupDocumentTest {
    private val record = "nstw1:" + "A".repeat(175)

    @Test fun `collection transport is decoded to an interoperable encrypted binary file`() {
        val bytes = ByteArray(65608)
        "FSWNENC2".toByteArray().copyInto(bytes)
        val transport = "nstc1:" + android.util.Base64.encodeToString(bytes, android.util.Base64.URL_SAFE or android.util.Base64.NO_WRAP or android.util.Base64.NO_PADDING)
        assertTrue(WrappedBackupDocument.validRecord(transport))
        val intent = WrappedBackupDocument.createIntent(transport)
        assertEquals("application/octet-stream", intent.type)
        assertEquals("signet-accounts.nstc", intent.getStringExtra(Intent.EXTRA_TITLE))
        val context = RuntimeEnvironment.getApplication()
        val uri = Uri.parse("content://test-documents/collection")
        val output = ByteArrayOutputStream()
        shadowOf(context.contentResolver).registerOutputStream(uri, output)
        shadowOf(context.contentResolver).registerInputStream(uri, ByteArrayInputStream(bytes))
        WrappedBackupDocument.write(context.contentResolver, uri, transport)
        assertArrayEquals(bytes, output.toByteArray())
        assertFalse(WrappedBackupDocument.validRecord(transport + "A"))
        assertFalse(WrappedBackupDocument.validRecord("nstc1:" + "A".repeat(87478)))
    }

    @Test fun `asks the owner for a new document with a generic name`() {
        val intent = WrappedBackupDocument.createIntent()
        assertEquals(Intent.ACTION_CREATE_DOCUMENT, intent.action)
        assertTrue(intent.hasCategory(Intent.CATEGORY_OPENABLE))
        assertEquals("text/plain", intent.type)
        assertEquals("imported-account.nstw", intent.getStringExtra(Intent.EXTRA_TITLE))
    }

    @Test fun `writes only the encrypted record and checks its saved bytes`() {
        val context = RuntimeEnvironment.getApplication()
        val uri = Uri.parse("content://test-documents/backup")
        val output = ByteArrayOutputStream()
        shadowOf(context.contentResolver).registerOutputStream(uri, output)
        shadowOf(context.contentResolver).registerInputStream(uri, ByteArrayInputStream(record.toByteArray()))
        WrappedBackupDocument.write(context.contentResolver, uri, record)
        assertEquals(record, output.toString(Charsets.UTF_8.name()))
    }

    @Test fun `refuses raw keys invalid destinations and mismatched saved bytes`() {
        val context = RuntimeEnvironment.getApplication()
        val uri = Uri.parse("content://test-documents/corrupt")
        for (invalid in listOf("22".repeat(32), record + "A", record.dropLast(1) + "!")) {
            assertThrows(IllegalArgumentException::class.java) { WrappedBackupDocument.write(context.contentResolver, uri, invalid) }
        }
        assertThrows(IllegalArgumentException::class.java) {
            WrappedBackupDocument.write(context.contentResolver, Uri.parse("file:///tmp/backup"), record)
        }
        shadowOf(context.contentResolver).registerOutputStream(uri, ByteArrayOutputStream())
        shadowOf(context.contentResolver).registerInputStream(uri, ByteArrayInputStream("wrong bytes".toByteArray()))
        assertThrows(java.io.IOException::class.java) { WrappedBackupDocument.write(context.contentResolver, uri, record) }
    }

    @Test fun `rejects extra data without reading an unbounded document`() {
        val context = RuntimeEnvironment.getApplication()
        val uri = Uri.parse("content://test-documents/oversized")
        val input = ByteArrayInputStream((record + "A".repeat(10000)).toByteArray())
        shadowOf(context.contentResolver).registerOutputStream(uri, ByteArrayOutputStream())
        shadowOf(context.contentResolver).registerInputStream(uri, input)
        assertThrows(java.io.IOException::class.java) { WrappedBackupDocument.write(context.contentResolver, uri, record) }
        assertEquals(9999, input.available())
    }
}
