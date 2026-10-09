package app.mysignet

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothServerSocket
import android.bluetooth.BluetoothSocket
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import android.util.Base64
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.IOException
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * The handshake's Bluetooth carrier: unpaired LE L2CAP connection-oriented
 * channels (Android 12+), no GATT, no OS pairing dialog. It is a byte pipe and
 * parses nothing. Frames are a 4-byte big-endian length then the bytes. Before
 * the web layer authenticates a link (`trust`), at most two frames of at most
 * 64 bytes are read (the HELLO and AUTH), and then nothing more until it is
 * trusted or closed; a trusted link carries frames up to 48 KiB. Everything a
 * link carries is verified in JS: this class decides nothing about identity.
 *
 * The advertisement is our service data only: an 8-byte token derived from the
 * QR secret, and the channel's dynamic PSM. No device name, no TX power.
 */
@SuppressLint("MissingPermission") // Callers check the Nearby devices permission first.
class HandshakeNearby(
    private val context: Context,
    private val emit: (event: String, fields: Map<String, String>) -> Unit,
) {
    companion object {
        val SERVICE: ParcelUuid = ParcelUuid(UUID.fromString("3c83510c-116d-4d25-8117-75036a0eb14e"))
        const val TOKEN_BYTES = 8
        private const val PREAUTH_FRAMES = 2
        private const val PREAUTH_MAX = 64
        private const val TRUSTED_MAX = 48 * 1024
        private const val MAX_FRAMES = 512
        private const val MAX_INCOMING = 2
        private const val MAX_OUTGOING = 1
        /** A link that has not authenticated by then is closed, so idle
         * connections cannot hold the slots. */
        private const val PREAUTH_DEADLINE_MS = 8000L
        /** A peer that stops reading cannot keep a closed screen's link open. */
        private const val HARD_CLOSE_MS = 1500L

        /** L2CAP CoC is Android 10+, but scanning there needs location; this needs 12+. */
        fun platformSupported(): Boolean = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
    }

    private val main = Handler(Looper.getMainLooper())
    private val adapter: BluetoothAdapter?
        get() = context.getSystemService(BluetoothManager::class.java)?.adapter
    private val links = ConcurrentHashMap<String, Link>()
    private val ids = AtomicInteger()
    /** Devices whose outgoing link the page judged to fail authentication
     * this session: a copied token cannot win every rescan. A remote close,
     * a busy peer or a failed connect never lands here. */
    private val avoid = ConcurrentHashMap.newKeySet<String>()
    @Volatile private var generation = 0
    @Volatile private var paused = false
    @Volatile private var server: BluetoothServerSocket? = null
    @Volatile private var advertising: AdvertiseCallback? = null
    @Volatile private var attempt: Attempt? = null

    fun supported(): Boolean {
        if (!platformSupported() || !context.packageManager.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE)) return false
        val a = adapter ?: return false
        // Peripheral (advertising) support can only be read while the radio is on.
        return !a.isEnabled || a.isMultipleAdvertisementSupported
    }

    fun enabled(): Boolean = adapter?.isEnabled == true

    private inner class Link(val id: String, private val socket: BluetoothSocket, val outgoing: Boolean, val address: String?) {
        @Volatile var trusted = false
        private val trustGate = CountDownLatch(1)
        private val writer = Executors.newSingleThreadExecutor()
        private val out = DataOutputStream(socket.outputStream)
        private val closed = AtomicBoolean(false)

        fun send(bytes: ByteArray) {
            if (closed.get()) return
            try {
                writer.execute {
                    try { out.writeInt(bytes.size); out.write(bytes); out.flush() } catch (_: IOException) { close() }
                }
            } catch (_: RejectedExecutionException) {
                // Closed between the check and the call; the frame is moot.
            }
        }
        fun trust() { trusted = true; trustGate.countDown() }
        /** Let frames already queued (a receipt) go out before the socket
         * closes, but never wait on a peer that has stopped reading. */
        fun closeAfterWrites() {
            try { writer.execute { close() } } catch (_: Exception) { close() }
            main.postDelayed({ close() }, HARD_CLOSE_MS)
        }
        fun close() {
            if (!closed.compareAndSet(false, true)) return
            links.remove(id)
            trustGate.countDown()
            try { socket.close() } catch (_: IOException) {}
            writer.shutdown()
            emit("nearbyClosed", mapOf("link" to id))
        }
        fun read() {
            Thread {
                try {
                    val input = DataInputStream(socket.inputStream)
                    var frames = 0
                    while (!closed.get()) {
                        if (!trusted && frames >= PREAUTH_FRAMES) {
                            trustGate.await(PREAUTH_DEADLINE_MS, TimeUnit.MILLISECONDS)
                            if (!trusted) break
                        }
                        val size = input.readInt()
                        val cap = if (trusted) TRUSTED_MAX else PREAUTH_MAX
                        if (size <= 0 || size > cap || ++frames > MAX_FRAMES) break
                        val bytes = ByteArray(size)
                        input.readFully(bytes)
                        emit("nearbyFrame", mapOf("link" to id, "data" to Base64.encodeToString(bytes, Base64.NO_WRAP)))
                    }
                } catch (_: IOException) {
                } catch (_: InterruptedException) {
                }
                close()
            }.apply { isDaemon = true; name = "signet-nearby-$id" }.start()
        }
    }

    @Synchronized
    private fun register(socket: BluetoothSocket, outgoing: Boolean, address: String?): String? {
        val count = links.values.count { it.outgoing == outgoing }
        if (paused || count >= (if (outgoing) MAX_OUTGOING else MAX_INCOMING)) {
            try { socket.close() } catch (_: IOException) {}
            return null
        }
        val link = Link("n${ids.incrementAndGet()}", socket, outgoing, address)
        links[link.id] = link
        // Announced before any frame can be read, so the page always knows the link first.
        emit("nearbyLink", mapOf("link" to link.id, "direction" to if (outgoing) "out" else "in"))
        main.postDelayed({ if (!link.trusted) link.close() }, PREAUTH_DEADLINE_MS)
        link.read()
        return link.id
    }

    /** Listen on a fresh channel and advertise `token` with its PSM. */
    fun advertise(token: ByteArray, done: (psm: Int?, error: String?) -> Unit) {
        val a = adapter
        val advertiser = a?.bluetoothLeAdvertiser
        if (paused) { done(null, "background"); return }
        if (a == null || advertiser == null || !a.isEnabled || token.size != TOKEN_BYTES) { done(null, "unavailable"); return }
        stopAdvertising()
        val gen = generation
        val socket = try { a.listenUsingInsecureL2capChannel() } catch (e: IOException) { done(null, "listen"); return }
        server = socket
        val psm = socket.psm
        Thread {
            while (gen == generation) {
                val accepted = try { socket.accept() } catch (_: IOException) { break }
                if (gen != generation) { try { accepted.close() } catch (_: IOException) {}; break }
                register(accepted, false, null)
            }
        }.apply { isDaemon = true; name = "signet-nearby-accept" }.start()
        val data = AdvertiseData.Builder()
            .setIncludeDeviceName(false)
            .setIncludeTxPowerLevel(false)
            .addServiceData(SERVICE, token + byteArrayOf((psm shr 8).toByte(), psm.toByte()))
            .build()
        val settings = AdvertiseSettings.Builder()
            .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
            .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM)
            .setConnectable(true)
            .setTimeout(0)
            .build()
        val callback = object : AdvertiseCallback() {
            override fun onStartSuccess(settingsInEffect: AdvertiseSettings) { done(psm, null) }
            override fun onStartFailure(errorCode: Int) { done(null, "advertise-$errorCode") }
        }
        advertising = callback
        try { advertiser.startAdvertising(settings, data, callback) } catch (e: Exception) { done(null, "advertise") }
    }

    /** One scan-and-dial. Its timer, scan and socket are its own, so a stale
     * attempt can never stop a newer one, and leaving closes a hung dial. */
    private inner class Attempt {
        val finished = AtomicBoolean(false)
        @Volatile var callback: ScanCallback? = null
        @Volatile var socket: BluetoothSocket? = null
        fun stopScan() {
            callback?.let { cb -> try { adapter?.bluetoothLeScanner?.stopScan(cb) } catch (_: Exception) {} }
            callback = null
        }
        fun abandon() {
            finished.set(true)
            stopScan()
            try { socket?.close() } catch (_: IOException) {}
        }
    }

    /** Scan for `token`; connect to the PSM its advertisement carries. */
    fun connect(token: ByteArray, timeoutMs: Long, done: (link: String?, error: String?) -> Unit) {
        val scanner = adapter?.bluetoothLeScanner
        if (paused) { done(null, "background"); return }
        if (scanner == null || token.size != TOKEN_BYTES) { done(null, "unavailable"); return }
        attempt?.abandon()
        val gen = generation
        val current = Attempt()
        attempt = current
        val mask = ByteArray(TOKEN_BYTES + 2) { if (it < TOKEN_BYTES) 0xFF.toByte() else 0 }
        val filter = ScanFilter.Builder().setServiceData(SERVICE, token + byteArrayOf(0, 0), mask).build()
        val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build()
        val callback = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult) {
                val record = result.scanRecord?.getServiceData(SERVICE) ?: return
                if (record.size != TOKEN_BYTES + 2 || !record.copyOfRange(0, TOKEN_BYTES).contentEquals(token)) return
                if (avoid.contains(result.device.address)) return
                val psm = ((record[TOKEN_BYTES].toInt() and 0xFF) shl 8) or (record[TOKEN_BYTES + 1].toInt() and 0xFF)
                if (psm == 0 || !current.finished.compareAndSet(false, true)) return
                current.stopScan()
                Thread {
                    try {
                        val socket = result.device.createInsecureL2capChannel(psm)
                        current.socket = socket
                        socket.connect()
                        if (gen != generation || paused) { socket.close(); done(null, "stopped"); return@Thread }
                        val id = register(socket, true, result.device.address)
                        // The link owns the socket now; leaving closes it after its writes.
                        current.socket = null
                        if (id == null) done(null, "busy") else done(id, null)
                    } catch (_: IOException) {
                        done(null, "connect")
                    } catch (_: SecurityException) {
                        done(null, "permission")
                    }
                }.apply { isDaemon = true; name = "signet-nearby-dial" }.start()
            }
            override fun onScanFailed(errorCode: Int) {
                if (current.finished.compareAndSet(false, true)) { current.stopScan(); done(null, "scan-$errorCode") }
            }
        }
        current.callback = callback
        try { scanner.startScan(listOf(filter), settings, callback) } catch (e: Exception) {
            current.finished.set(true); current.callback = null; done(null, "scan"); return
        }
        main.postDelayed({
            if (current.finished.compareAndSet(false, true)) { current.stopScan(); done(null, "timeout") }
        }, timeoutMs.coerceIn(1000L, 120_000L))
    }

    /** Outgoing frames come from our own page; the cap is only a sanity bound. */
    fun send(link: String, bytes: ByteArray): Boolean {
        val l = links[link] ?: return false
        if (bytes.isEmpty() || bytes.size > TRUSTED_MAX) return false
        l.send(bytes)
        return true
    }

    fun trust(link: String): Boolean { val l = links[link] ?: return false; l.trust(); return true }

    fun close(link: String, avoidDevice: Boolean = false) {
        val l = links[link] ?: return
        if (avoidDevice && l.outgoing && !l.trusted && l.address != null) avoid.add(l.address)
        l.closeAfterWrites()
    }

    /** Stop advertising and accepting; links already made carry on. A phone
     * that no longer needs an incoming link stops showing its advert. */
    fun quiet() = stopAdvertising()

    private fun stopAdvertising() {
        advertising?.let { cb -> try { adapter?.bluetoothLeAdvertiser?.stopAdvertising(cb) } catch (_: Exception) {} }
        advertising = null
        try { server?.close() } catch (_: IOException) {}
        server = null
    }

    /** Leaving the screen: stop advertising and scanning, close every link. */
    fun stop() {
        generation++
        attempt?.abandon()
        attempt = null
        stopAdvertising()
        for (link in links.values) link.closeAfterWrites()
        avoid.clear()
    }

    /** The activity left the screen: nothing may start until it returns. */
    fun pause() { paused = true; stop() }
    fun resume() { paused = false }
}
