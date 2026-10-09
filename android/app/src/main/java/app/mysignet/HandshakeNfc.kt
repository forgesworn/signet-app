package app.mysignet

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.nfc.NfcAdapter
import android.nfc.Tag
import android.nfc.cardemulation.HostApduService
import android.nfc.tech.IsoDep
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import java.lang.ref.WeakReference
import java.security.SecureRandom

/**
 * The handshake's NFC wire: two APDUs between a reader and an emulated card.
 * Pure, so it is tested on the JVM. The reader SELECTs our AID, then sends its
 * own session code; the card answers with its own. One touch, both codes cross.
 * A session code names no one (see handshake-reveal.ts); anything that is not
 * a well-formed one is refused before it reaches the page.
 */
object HandshakeApdu {
    /** Proprietary AID: F0 + "SIGNETH". */
    val AID = byteArrayOf(0xF0.toByte(), 0x53, 0x49, 0x47, 0x4E, 0x45, 0x54, 0x48)
    private val OK = byteArrayOf(0x90.toByte(), 0x00)
    private val NOT_AVAILABLE = byteArrayOf(0x6A, 0x82.toByte())
    private val WRONG_DATA = byteArrayOf(0x6A, 0x80.toByte())
    private val WRONG_LENGTH = byteArrayOf(0x67, 0x00)
    private val UNKNOWN = byteArrayOf(0x6D, 0x00)
    private const val EXCHANGE_CLA = 0x80.toByte()
    private const val EXCHANGE_INS = 0x10.toByte()
    const val MAX_CODE = 250
    private const val PREFIX = "SGH2:"
    private const val ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:"

    fun select(): ByteArray = byteArrayOf(0x00, 0xA4.toByte(), 0x04, 0x00, AID.size.toByte()) + AID + byteArrayOf(0x00)
    fun exchange(code: ByteArray): ByteArray {
        require(validCode(code))
        return byteArrayOf(EXCHANGE_CLA, EXCHANGE_INS, 0x00, 0x00, code.size.toByte()) + code + byteArrayOf(0x00)
    }
    fun validCode(bytes: ByteArray): Boolean =
        bytes.size in PREFIX.length + 1..MAX_CODE &&
            bytes.all { b -> b.toInt() in 0x20..0x7E && ALPHABET.indexOf(b.toInt().toChar()) >= 0 } &&
            String(bytes, Charsets.US_ASCII).startsWith(PREFIX)

    private fun isSelect(c: ByteArray): Boolean =
        c.size >= 5 + AID.size && c[0] == 0x00.toByte() && c[1] == 0xA4.toByte() && c[2] == 0x04.toByte() &&
            (c[4].toInt() and 0xFF) == AID.size && c.copyOfRange(5, 5 + AID.size).contentEquals(AID)

    /** Card side. `ownCode` null: no handshake screen is open, so nothing is offered. */
    fun respond(command: ByteArray, ownCode: ByteArray?, onPeer: (String) -> Unit): ByteArray {
        if (ownCode == null || !validCode(ownCode)) return NOT_AVAILABLE
        if (isSelect(command)) return OK
        if (command.size >= 5 && command[0] == EXCHANGE_CLA && command[1] == EXCHANGE_INS) {
            val lc = command[4].toInt() and 0xFF
            if (lc == 0 || command.size < 5 + lc || command.size > 6 + lc) return WRONG_LENGTH
            val peer = command.copyOfRange(5, 5 + lc)
            if (!validCode(peer)) return WRONG_DATA
            onPeer(String(peer, Charsets.US_ASCII))
            return ownCode + OK
        }
        return UNKNOWN
    }

    private fun ok(response: ByteArray) =
        response.size >= 2 && response[response.size - 2] == 0x90.toByte() && response[response.size - 1] == 0x00.toByte()

    /** Reader side: the peer's code, or null. */
    fun read(transceive: (ByteArray) -> ByteArray, ownCode: ByteArray): String? {
        if (!validCode(ownCode) || !ok(transceive(select()))) return null
        val response = transceive(exchange(ownCode))
        if (!ok(response)) return null
        val peer = response.copyOfRange(0, response.size - 2)
        return if (validCode(peer)) String(peer, Charsets.US_ASCII) else null
    }
}

/** Answers the reader on the other phone while a handshake screen is open. */
class HandshakeNfcService : HostApduService() {
    override fun processCommandApdu(commandApdu: ByteArray?, extras: Bundle?): ByteArray =
        HandshakeApdu.respond(commandApdu ?: ByteArray(0), HandshakeNfc.cardCode(), HandshakeNfc::deliver)
    override fun onDeactivated(reason: Int) {}
}

/**
 * Reader mode turns card emulation off, so a phone cannot read and be read at
 * once. While the handshake screen is open each phone alternates at random
 * (300 to 800 ms a slot): two phones held back to back soon land one reading,
 * one being read, and a single touch swaps both codes. Nothing is offered or
 * read once the screen closes or the app leaves the screen.
 */
@SuppressLint("MissingPermission")
object HandshakeNfc {
    @Volatile private var code: ByteArray? = null
    @Volatile private var paused = false
    @Volatile private var listener: ((String) -> Unit)? = null
    private val main = Handler(Looper.getMainLooper())
    private val random = SecureRandom()
    private var activity: WeakReference<Activity>? = null
    private var reading = false
    private val cycler = Runnable { cycle() }

    fun supported(context: Context): Boolean =
        context.packageManager.hasSystemFeature(PackageManager.FEATURE_NFC_HOST_CARD_EMULATION) && NfcAdapter.getDefaultAdapter(context) != null
    fun enabled(context: Context): Boolean = NfcAdapter.getDefaultAdapter(context)?.isEnabled == true
    fun cardCode(): ByteArray? = if (paused) null else code
    fun deliver(peer: String) { if (!paused) listener?.invoke(peer) }

    fun start(activity: Activity, ownCode: String, onPeer: (String) -> Unit) {
        val bytes = ownCode.toByteArray(Charsets.US_ASCII)
        require(HandshakeApdu.validCode(bytes))
        main.post {
            stopNow()
            code = bytes; listener = onPeer; paused = false
            this.activity = WeakReference(activity)
            cycle()
        }
    }
    private fun cycle() {
        val act = activity?.get() ?: return
        val adapter = NfcAdapter.getDefaultAdapter(act) ?: return
        if (code == null || paused) { readerOff(act, adapter); return }
        if (reading) readerOff(act, adapter) else readerOn(act, adapter)
        main.postDelayed(cycler, 300L + random.nextInt(500))
    }
    private fun readerOn(act: Activity, adapter: NfcAdapter) {
        val flags = NfcAdapter.FLAG_READER_NFC_A or NfcAdapter.FLAG_READER_NFC_B or
            NfcAdapter.FLAG_READER_SKIP_NDEF_CHECK or NfcAdapter.FLAG_READER_NO_PLATFORM_SOUNDS
        try {
            adapter.enableReaderMode(act, { tag -> onTag(tag) }, flags, Bundle().apply { putInt(NfcAdapter.EXTRA_READER_PRESENCE_CHECK_DELAY, 250) })
            reading = true
        } catch (_: Exception) { reading = false }
    }
    private fun readerOff(act: Activity, adapter: NfcAdapter) {
        try { adapter.disableReaderMode(act) } catch (_: Exception) {}
        reading = false
    }
    private fun onTag(tag: Tag) {
        val own = code ?: return
        val iso = IsoDep.get(tag) ?: return
        try {
            iso.connect()
            iso.timeout = 1500
            HandshakeApdu.read({ iso.transceive(it) }, own)?.let { deliver(it) }
        } catch (_: Exception) {
        } finally {
            try { iso.close() } catch (_: Exception) {}
        }
    }
    /** The activity left the screen: offer nothing, read nothing, until it returns. */
    fun pause() { paused = true; main.post { main.removeCallbacks(cycler); offNow() } }
    fun resume() { main.post { if (code != null && paused) { paused = false; cycle() } } }
    fun stop() { main.post { stopNow() } }
    private fun stopNow() {
        code = null; listener = null; paused = false
        main.removeCallbacks(cycler)
        offNow()
        activity = null
    }
    private fun offNow() {
        val act = activity?.get() ?: return
        NfcAdapter.getDefaultAdapter(act)?.let { readerOff(act, it) }
    }
}
