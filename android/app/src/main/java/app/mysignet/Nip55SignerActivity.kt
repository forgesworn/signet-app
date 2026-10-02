package app.mysignet

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper

/**
 * The activity another app starts for a NIP-55 result.
 *
 * It has no screen of its own: it lifts the request off the intent, hands
 * it to the web layer, and brings My Signet to the front so the person can
 * approve there. When the web layer answers, the result goes back to the
 * caller and this activity is gone. A caller that goes away, or that gets
 * no answer within a few minutes, gets a cancel and the request is
 * withdrawn from the app.
 */
class Nip55SignerActivity : Activity() {
    private var requestId: String? = null
    /** The caller's own NIP-55 `id`, echoed on whatever result goes back. Separate from [requestId], which is ours. */
    private var callerId: String? = null
    private val timeout = Handler(Looper.getMainLooper())
    private val giveUp = Runnable { requestId?.let { Nip55Requests.cancel(it) }; finishRejected() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        handle(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        requestId?.let { Nip55Requests.cancel(it) }
        timeout.removeCallbacks(giveUp)
        handle(intent)
    }

    private fun handle(intent: Intent?) {
        val id = Nip55Requests.newId()
        requestId = id
        callerId = intent?.getStringExtra(Nip55Wire.EXTRA_ID)
        val request = Nip55Incoming.fromIntent(
            id = id,
            callerPackage = callingPackage,
            callerLabel = Nip55Wire.labelOf(packageManager, callingPackage),
            dataString = intent?.dataString,
            type = intent?.getStringExtra(Nip55Wire.EXTRA_TYPE),
            currentUser = intent?.getStringExtra(Nip55Wire.EXTRA_CURRENT_USER),
            pubkey = intent?.getStringExtra(Nip55Wire.EXTRA_PUBKEY) ?: intent?.getStringExtra(Nip55Wire.EXTRA_PUBKEY_ALT),
            permissions = intent?.getStringExtra(Nip55Wire.EXTRA_PERMISSIONS),
        )
        android.util.Log.i("Nip55", "intent ${request.type} from ${callingPackage} payload=${request.payload?.length ?: 0}")
        if (request.type == null || request.type.lowercase() !in Nip55Wire.METHODS) {
            finishRejected()
            return
        }
        timeout.postDelayed(giveUp, TIMEOUT_MS)
        Nip55Requests.submit(request) { answer -> runOnUiThread { deliver(request, answer) } }
        // The person decides in the app itself. Bring it up; if the page is
        // not running yet it starts, and drains what is waiting once it is.
        startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT))
    }

    private fun deliver(request: Nip55Incoming, answer: Nip55Answer) {
        requestId = null
        android.util.Log.i("Nip55", "deliver ${request.id} ${answer.status}")
        timeout.removeCallbacks(giveUp)
        if (!answer.ok) { finishRejected(); return }
        setResult(RESULT_OK, resultIntent(answer))
        finish()
    }

    private fun finishRejected() {
        setResult(RESULT_CANCELED, resultIntent(null))
        finish()
    }

    private fun resultIntent(answer: Nip55Answer?): Intent = Intent().apply {
        for ((key, value) in Nip55Wire.resultExtras(callerId, packageName, answer)) when (value) {
            is Boolean -> putExtra(key, value)
            else -> putExtra(key, value.toString())
        }
    }

    override fun onDestroy() {
        timeout.removeCallbacks(giveUp)
        // isFinishing is false on a configuration-change recreate (the
        // activity is being torn down only to be rebuilt with the same
        // request); only a genuine finish — the caller's task swiped away,
        // or giveUp/onNewIntent already finished us — should withdraw.
        if (isFinishing) requestId?.let { Nip55Requests.cancel(it) }
        super.onDestroy()
    }

    companion object {
        /** As long as a person takes to find the phone, unlock, and read. */
        private const val TIMEOUT_MS = 5 * 60_000L
    }
}
