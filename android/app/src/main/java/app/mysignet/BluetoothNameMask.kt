package app.mysignet

import android.annotation.SuppressLint
import android.bluetooth.BluetoothManager
import android.content.Context
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** The local Bluetooth adapter's name. `set` is false when the stack refused it. */
interface AdapterName {
    /** Null when it cannot be read now (radio off, no permission). */
    fun get(): String?
    fun set(name: String): Boolean
}

/** Where the real name waits while the mask is on. It survives a crash. */
interface NameStore {
    fun saved(): String?
    fun save(name: String)
    fun clear()
}

/**
 * While the handshake advertises, anyone in range can connect without pairing
 * and read the phone's Bluetooth name (GATT 0x2A00), often the owner's name.
 * So the phone is called [MASK] for that time: the same for everyone, so a
 * crowd of handshaking phones cannot be told apart by name.
 *
 * The rename is phone-wide and persisted by the Bluetooth stack, so the real
 * name is saved BEFORE renaming, and put back only while the name is still
 * the mask: a rename the owner made meanwhile is never undone. Paired devices
 * know the phone by address and keys, not name, so connections are unaffected.
 */
class BluetoothNameMask(
    private val adapter: AdapterName,
    private val store: NameStore,
    private val sleep: (Long) -> Unit = { Thread.sleep(it) },
) {
    companion object {
        const val MASK = "Phone"
        private const val WAIT_MS = 1500L
        private const val STEP_MS = 50L
    }

    /** The stack renames asynchronously; true once it reports [name]. */
    private fun settled(name: String): Boolean {
        var waited = 0L
        while (true) {
            if (adapter.get() == name) return true
            if (waited >= WAIT_MS) return false
            sleep(STEP_MS)
            waited += STEP_MS
        }
    }

    /** Before advertising. True when the adapter now reports the mask. */
    @Synchronized
    fun mask(): Boolean {
        val current = adapter.get() ?: return false
        // Already masked: by an earlier session (its record stands) or by the
        // owner's own choice (no record, nothing to restore).
        if (current == MASK) return true
        // Saved first, so a crash after the rename can still undo it. A record
        // left by a crash whose mask the owner has since replaced is stale.
        store.save(current)
        if (!adapter.set(MASK)) {
            store.clear()
            return false
        }
        return settled(MASK)
    }

    /** True when nothing is left to restore; false to try again later. */
    @Synchronized
    fun restore(): Boolean {
        val saved = store.saved() ?: return true
        val current = adapter.get() ?: return false
        if (current != MASK || saved == MASK) {
            // The owner renamed it meanwhile, or the mask never took.
            store.clear()
            return true
        }
        if (!adapter.set(saved) || !settled(saved)) return false
        store.clear()
        return true
    }
}

/** The real adapter. Reading or setting the name needs Nearby devices (12+). */
@SuppressLint("MissingPermission")
class SystemAdapterName(private val context: Context) : AdapterName {
    private val adapter get() = context.getSystemService(BluetoothManager::class.java)?.adapter
    override fun get(): String? = try {
        adapter?.takeIf { it.isEnabled }?.name
    } catch (_: SecurityException) { null }
    override fun set(name: String): Boolean = try {
        adapter?.setName(name) == true
    } catch (_: SecurityException) { false }
}

class PrefsNameStore(context: Context) : NameStore {
    private val prefs = context.getSharedPreferences("signet_bluetooth_name", Context.MODE_PRIVATE)
    override fun saved(): String? = prefs.getString("real", null)
    // commit, not apply: the record must be on disk before the rename happens.
    override fun save(name: String) { prefs.edit().putString("real", name).commit() }
    override fun clear() { prefs.edit().remove("real").commit() }
}

/**
 * The app's one mask. Every mask and restore runs in order on one thread, so a
 * restore requested as a screen closes can never land after the next screen's
 * mask. Restores never block the caller (the main thread, on activity stop).
 */
object HandshakeName {
    private val worker = Executors.newSingleThreadExecutor { r -> Thread(r, "signet-bt-name").apply { isDaemon = true } }
    @Volatile private var mask: BluetoothNameMask? = null
    private fun of(context: Context): BluetoothNameMask =
        mask ?: synchronized(this) {
            mask ?: BluetoothNameMask(SystemAdapterName(context.applicationContext), PrefsNameStore(context.applicationContext)).also { mask = it }
        }

    /** Waits (bounded) so the advert never starts under the real name. */
    fun maskBeforeAdvertising(context: Context): Boolean = try {
        worker.submit<Boolean> { of(context).mask() }.get(3, TimeUnit.SECONDS)
    } catch (_: Exception) { false }

    /** As the radio stops, and at start-up or boot after a crash. */
    fun restoreLater(context: Context) {
        val m = of(context)
        worker.execute { m.restore() }
    }
}
