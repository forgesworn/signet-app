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
        private const val MAX_LINKS = 2
        private const val TRUST_WAIT_S = 15L

        /** L2CAP CoC is Android 10+, but scanning there needs location; this needs 12+. */
        fun platformSupported(): Boolean = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
    }

    private val main = Handler(Looper.getMainLooper())
    private val dialer = Executors.newSingleThreadExecutor()
    private val adapter: BluetoothAdapter?
        get() = context.getSystemService(BluetoothManager::class.java)?.adapter
    private val links = ConcurrentHashMap<String, Link>()
    private val ids = AtomicInteger()
    @Volatile private var generation = 0
    @Volatile private var server: BluetoothServerSocket? = null
    @Volatile private var advertising: AdvertiseCallback? = null
    @Volatile private var scanning: ScanCallback? = null

    fun supported(): Boolean {
        if (!platformSupported() || !context.packageManager.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE)) return false
        val a = adapter ?: return false
        // Peripheral (advertising) support can only be read while the radio is on.
        return !a.isEnabled || a.isMultipleAdvertisementSupported
    }

    fun enabled(): Boolean = adapter?.isEnabled == true

    private inner class Link(val id: String, private val socket: BluetoothSocket) {
        @Volatile var trusted = false
        private val trustGate = CountDownLatch(1)
        private val writer = Executors.newSingleThreadExecutor()
        private val out = DataOutputStream(socket.outputStream)
        private val closed = AtomicBoolean(false)

        fun send(bytes: ByteArray) {
            if (closed.get()) return
            writer.execute {
                try { out.writeInt(bytes.size); out.write(bytes); out.flush() } catch (_: IOException) { close() }
            }
        }
        fun trust() { trusted = true; trustGate.countDown() }
        /** Let frames already queued (a receipt) go out before the socket closes. */
        fun closeAfterWrites() {
            try { writer.execute { close() } } catch (_: Exception) { close() }
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
                            trustGate.await(TRUST_WAIT_S, TimeUnit.SECONDS)
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

    private fun register(socket: BluetoothSocket, direction: String): String? {
        if (links.size >= MAX_LINKS) { try { socket.close() } catch (_: IOException) {}; return null }
        val link = Link("n${ids.incrementAndGet()}", socket)
        links[link.id] = link
        // Announced before any frame can be read, so the page always knows the link first.
        emit("nearbyLink", mapOf("link" to link.id, "direction" to direction))
        link.read()
        return link.id
    }

    /** Listen on a fresh channel and advertise `token` with its PSM. */
    fun advertise(token: ByteArray, done: (psm: Int?, error: String?) -> Unit) {
        val a = adapter
        val advertiser = a?.bluetoothLeAdvertiser
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
                register(accepted, "in")
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

    /** Scan for `token`; connect to the PSM its advertisement carries. */
    fun connect(token: ByteArray, timeoutMs: Long, done: (link: String?, error: String?) -> Unit) {
        val scanner = adapter?.bluetoothLeScanner
        if (scanner == null || token.size != TOKEN_BYTES) { done(null, "unavailable"); return }
        stopScanning()
        val gen = generation
        val finished = AtomicBoolean(false)
        val mask = ByteArray(TOKEN_BYTES + 2) { if (it < TOKEN_BYTES) 0xFF.toByte() else 0 }
        val filter = ScanFilter.Builder().setServiceData(SERVICE, token + byteArrayOf(0, 0), mask).build()
        val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build()
        val callback = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult) {
                val record = result.scanRecord?.getServiceData(SERVICE) ?: return
                if (record.size != TOKEN_BYTES + 2 || !record.copyOfRange(0, TOKEN_BYTES).contentEquals(token)) return
                val psm = ((record[TOKEN_BYTES].toInt() and 0xFF) shl 8) or (record[TOKEN_BYTES + 1].toInt() and 0xFF)
                if (psm == 0 || !finished.compareAndSet(false, true)) return
                stopScanning()
                dialer.execute {
                    try {
                        val socket = result.device.createInsecureL2capChannel(psm)
                        socket.connect()
                        if (gen != generation) { socket.close(); done(null, "stopped"); return@execute }
                        val id = register(socket, "out")
                        if (id == null) done(null, "busy") else done(id, null)
                    } catch (_: IOException) {
                        done(null, "connect")
                    } catch (_: SecurityException) {
                        done(null, "permission")
                    }
                }
            }
            override fun onScanFailed(errorCode: Int) {
                if (finished.compareAndSet(false, true)) { stopScanning(); done(null, "scan-$errorCode") }
            }
        }
        scanning = callback
        try { scanner.startScan(listOf(filter), settings, callback) } catch (e: Exception) {
            finished.set(true); scanning = null; done(null, "scan"); return
        }
        main.postDelayed({
            if (finished.compareAndSet(false, true)) { stopScanning(); done(null, "timeout") }
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

    fun close(link: String) { links[link]?.closeAfterWrites() }

    private fun stopAdvertising() {
        advertising?.let { cb -> try { adapter?.bluetoothLeAdvertiser?.stopAdvertising(cb) } catch (_: Exception) {} }
        advertising = null
        try { server?.close() } catch (_: IOException) {}
        server = null
    }

    private fun stopScanning() {
        scanning?.let { cb -> try { adapter?.bluetoothLeScanner?.stopScan(cb) } catch (_: Exception) {} }
        scanning = null
    }

    /** Leaving the screen: stop advertising and scanning, close every link. */
    fun stop() {
        generation++
        stopScanning()
        stopAdvertising()
        for (link in links.values) link.closeAfterWrites()
    }
}
