package app.mysignet

import android.content.ContentResolver
import android.content.Intent
import android.net.Uri
import android.util.Base64
import java.io.DataInputStream
import java.io.IOException

/** File transport for an encrypted envelope only; never receives an nsec or tree root. */
internal object WrappedBackupDocument {
    private val envelope = Regex("^nstw1:[A-Za-z0-9_-]{175}$")

    private val collection = Regex("^nstc1:[A-Za-z0-9_-]{87478}$")
    private fun bytes(record: String): ByteArray? {
        if (record.length == 181 && envelope.matches(record)) return record.toByteArray(Charsets.UTF_8)
        if (record.length != 87484 || !collection.matches(record)) return null
        return try {
            val decoded = Base64.decode(record.substring(6), Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
            if (decoded.size != 65608 || !decoded.copyOfRange(0, 8).contentEquals("FSWNENC2".toByteArray()) ||
                "nstc1:" + Base64.encodeToString(decoded, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP) != record) null else decoded
        } catch (_: IllegalArgumentException) { null }
    }

    fun validRecord(record: String): Boolean = bytes(record) != null

    fun createIntent(record: String = ""): Intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
        addCategory(Intent.CATEGORY_OPENABLE)
        val isCollection = record.startsWith("nstc1:")
        type = if (isCollection) "application/octet-stream" else "text/plain"
        putExtra(Intent.EXTRA_TITLE, if (isCollection) "signet-accounts.nstc" else "imported-account.nstw")
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
    }

    /** The URI comes only from the system picker; read back at most the envelope plus one byte. */
    fun write(resolver: ContentResolver, uri: Uri, record: String) {
        val expected = bytes(record) ?: throw IllegalArgumentException("Invalid encrypted backup file")
        require(uri.scheme == "content") { "Invalid document destination" }
        val output = resolver.openOutputStream(uri, "wt") ?: throw IOException("Cannot open backup destination")
        output.use { it.write(expected); it.flush() }
        val input = resolver.openInputStream(uri) ?: throw IOException("Cannot check saved backup")
        DataInputStream(input).use {
            val saved = ByteArray(expected.size)
            it.readFully(saved)
            if (!saved.contentEquals(expected) || it.read() != -1) throw IOException("Saved backup differs")
        }
    }
}
