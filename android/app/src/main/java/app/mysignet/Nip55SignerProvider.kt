package app.mysignet

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri

/**
 * The silent path: `content://app.mysignet.SIGN_EVENT` and its siblings,
 * for an app the person has already told this phone to allow always.
 *
 * A query is answered on the spot when the page is up and remembers a
 * grant that covers it; otherwise the answer is null, which NIP-55 defines
 * as "ask by intent", and the app comes back through [Nip55SignerActivity]
 * where a person can decide. A caller the person refused for good gets a
 * `rejected` row so it stops asking.
 */
class Nip55SignerProvider : ContentProvider() {
    override fun onCreate(): Boolean = true

    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor? {
        val ctx = context ?: return null
        val method = Nip55Wire.methodOf(uri.authority ?: return null, ctx.packageName) ?: return null
        if (method == "ping") return MatrixCursor(arrayOf(Nip55Wire.EXTRA_RESULT)).apply { addRow(arrayOf("pong")) }
        if (!Nip55Requests.pageUp) return null
        val request = Nip55Incoming.fromProvider(Nip55Requests.newId(), callingPackage, Nip55Wire.labelOf(ctx.packageManager, callingPackage), method, projection)
        val answer = Nip55Requests.ask(request, TIMEOUT_MS) ?: return null
        if (answer.deferred) return null
        if (!answer.ok) return MatrixCursor(arrayOf(Nip55Wire.EXTRA_REJECTED)).apply { addRow(arrayOf("true")) }
        return MatrixCursor(arrayOf(Nip55Wire.EXTRA_RESULT, Nip55Wire.EXTRA_EVENT, Nip55Wire.EXTRA_SIGNATURE)).apply {
            addRow(arrayOf(answer.result ?: "", answer.event ?: "", answer.result ?: ""))
        }
    }

    override fun getType(uri: Uri): String? = null
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = 0

    companion object {
        /** A provider call blocks the caller; a silent answer is quick or it is not silent. */
        private const val TIMEOUT_MS = 15_000L
    }
}
