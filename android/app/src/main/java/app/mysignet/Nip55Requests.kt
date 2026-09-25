package app.mysignet

import android.util.Log
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * The hand-over between the native side, which receives NIP-55 requests,
 * and the web layer, which decides and signs.
 *
 * A request is registered here with a callback, then pushed to the web
 * layer through the plugin if the page is up, or held until the page asks
 * for what it missed. The answer comes back by the plugin and is routed to
 * the callback by id. A request nobody answers is timed out by whoever
 * registered it.
 */
object Nip55Requests {
    private const val TAG = "Nip55"
    /** Where the web layer is reached, when it is. Set by the plugin on load, cleared when the bridge goes. */
    @Volatile private var sink: ((Nip55Incoming) -> Unit)? = null
    private val waiting = ConcurrentHashMap<String, (Nip55Answer) -> Unit>()
    private val held = ArrayDeque<Nip55Incoming>()

    fun newId(): String = UUID.randomUUID().toString()

    fun attach(deliver: (Nip55Incoming) -> Unit) { sink = deliver; Log.i(TAG, "page attached, held=${synchronized(held) { held.size }}") }
    fun detach(deliver: (Nip55Incoming) -> Unit) { if (sink === deliver) sink = null }

    /** Whether the page is there to answer right now. */
    val pageUp: Boolean get() = sink != null

    /** Registers a request and sends it on, or holds it for the page to drain. */
    fun submit(request: Nip55Incoming, onAnswer: (Nip55Answer) -> Unit) {
        waiting[request.id] = onAnswer
        val deliver = sink
        Log.i(TAG, "submit ${request.id} ${request.type} from ${request.callerPackage} provider=${request.viaProvider} pageUp=${deliver != null}")
        if (deliver != null) deliver(request) else synchronized(held) { held.addLast(request) }
    }

    /** Everything that arrived while the page was down, in order. */
    fun drain(): List<Nip55Incoming> = synchronized(held) { held.toList().also { held.clear() } }.also { Log.i(TAG, "drain ${it.size}") }

    fun answer(id: String, answer: Nip55Answer) {
        val callback = waiting.remove(id)
        Log.i(TAG, "answer $id ${answer.status} known=${callback != null}")
        callback?.invoke(answer)
    }

    /** Forgets a request the requester gave up on. */
    fun cancel(id: String) {
        waiting.remove(id)
        synchronized(held) { held.removeAll { it.id == id } }
    }

    /** Submits and blocks, for the provider, which has to answer on the spot. Null means nobody answered in time. */
    fun ask(request: Nip55Incoming, timeoutMs: Long): Nip55Answer? {
        val latch = CountDownLatch(1)
        var answer: Nip55Answer? = null
        submit(request) { answer = it; latch.countDown() }
        if (!latch.await(timeoutMs, TimeUnit.MILLISECONDS)) { cancel(request.id); return null }
        return answer
    }
}
