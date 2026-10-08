package app.mysignet

import android.Manifest
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.VibrationEffect
import android.os.Vibrator
import android.view.WindowManager
import android.provider.Settings
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

@CapacitorPlugin(
    name = "SignetNative",
    permissions = [Permission(strings = [Manifest.permission.CAMERA], alias = "camera")]
)
class SignetNativePlugin : Plugin() {

    companion object {
        private const val KEY_ALIAS = "signet-biometric-unlock"
        private const val PREFS = "signet_native_auth"
        private const val PREF_WRAPPED = "wrapped_master_key" // base64(iv || gcm-ct)
        /** The stored key also opens with the device credential (see BiometricPolicy). */
        private const val PREF_DEVICE_CREDENTIAL = "wrapped_key_device_credential"
        private const val GCM_TAG_BITS = 128
    }

    // ── NIP-55: requests from other apps on this phone ─────────────────────
    //
    // The web layer listens for `nip55Request`, drains what arrived before it
    // was up with `nip55Pending`, and answers each one with `nip55Respond`.
    // See Nip55Requests for the hand-over and src/lib/nip55.ts for what the
    // web layer does with a request. `nip55Withdrawn` carries the id of a
    // request whose caller gave up; the page drops it unanswered.
    private val deliverToPage: (Nip55Incoming) -> Unit = { request ->
        notifyListeners("nip55Request", incomingJson(request), true)
    }

    private val withdrawFromPage: (String) -> Unit = { id ->
        notifyListeners("nip55Withdrawn", JSObject().put("id", id), true)
    }

    private fun incomingJson(request: Nip55Incoming): JSObject = JSObject().apply {
        for ((key, value) in request.fields()) when (value) {
            null -> put(key, org.json.JSONObject.NULL)
            is Boolean -> put(key, value)
            else -> put(key, value.toString())
        }
    }

    override fun load() {
        super.load()
        Nip55Requests.attach(deliverToPage, withdrawFromPage)
    }

    override fun handleOnDestroy() {
        Nip55Requests.detach(deliverToPage, withdrawFromPage)
        super.handleOnDestroy()
    }

    /** Foreground screen only; does not keep keys alive when the app is hidden. */
    @PluginMethod
    fun handshakeAwake(call: PluginCall) {
        val active = call.getBoolean("active") ?: false
        activity.runOnUiThread {
            if (active) activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            else activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            call.resolve()
        }
    }

    @PluginMethod
    fun handshakeHaptic(call: PluginCall) {
        val vibrator = context.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
        val beat = call.getString("beat")
        if (beat !in listOf("tick", "double", "thud")) { call.reject("Unknown handshake beat"); return }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val effect = if (beat == "double") VibrationEffect.createWaveform(longArrayOf(0, 40, 80, 40), -1)
            else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) VibrationEffect.createPredefined(
                if (beat == "tick") VibrationEffect.EFFECT_TICK else VibrationEffect.EFFECT_HEAVY_CLICK)
            else VibrationEffect.createOneShot(if (beat == "tick") 15L else 90L, VibrationEffect.DEFAULT_AMPLITUDE)
            vibrator.vibrate(effect)
        } else {
            @Suppress("DEPRECATION")
            vibrator.vibrate(if (beat == "double") longArrayOf(0, 40, 80, 40) else longArrayOf(0, if (beat == "tick") 15L else 90L), -1)
        }
        call.resolve()
    }

    @PluginMethod
    fun nip55Pending(call: PluginCall) {
        val requests = com.getcapacitor.JSArray()
        for (request in Nip55Requests.drain()) requests.put(incomingJson(request))
        call.resolve(JSObject().put("requests", requests))
    }

    /** The page's Page Lifecycle `freeze` / `resume`; see Nip55Requests.pageAnswering. */
    @PluginMethod
    fun nip55PageFrozen(call: PluginCall) {
        Nip55Requests.pageFrozen(call.getBoolean("frozen") ?: false)
        call.resolve()
    }

    @PluginMethod
    fun nip55Respond(call: PluginCall) {
        Nip55Requests.answer(
            call.getString("id") ?: "",
            Nip55Answer(
                status = call.getString("status") ?: "rejected",
                result = call.getString("result")?.takeIf { it.isNotEmpty() },
                event = call.getString("event")?.takeIf { it.isNotEmpty() },
            ),
        )
        call.resolve()
    }

    // ── Biometric availability ────────────────────────────────────────────
    @PluginMethod
    fun isBiometricAvailable(call: PluginCall) {
        val ok = BiometricManager.from(context)
            .canAuthenticate(BIOMETRIC_STRONG) == BiometricManager.BIOMETRIC_SUCCESS
        call.resolve(JSObject().put("available", ok))
    }

    // ── Keystore helpers ──────────────────────────────────────────────────
    private fun keystore(): KeyStore =
        KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    private fun generateKey(deviceCredential: Boolean): SecretKey {
        val kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        kg.init(
            KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                // Auth-per-use, Class-3 (strong) biometrics, and the device
                // credential as well where BiometricPolicy allows it.
                .setUserAuthenticationRequired(true)
                .setUserAuthenticationParameters(0, BiometricPolicy.keyAuthenticators(deviceCredential))
                .setInvalidatedByBiometricEnrollment(!deviceCredential)
                .build()
        )
        return kg.generateKey()
    }

    private fun getKey(): SecretKey? = keystore().getKey(KEY_ALIAS, null) as? SecretKey

    private fun prefs() = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun promptInfo(title: String, deviceCredential: Boolean): BiometricPrompt.PromptInfo =
        BiometricPrompt.PromptInfo.Builder()
            .setTitle(title)
            .setAllowedAuthenticators(BiometricPolicy.promptAuthenticators(deviceCredential))
            .apply {
                // The system prompt offers the phone's PIN itself; a negative
                // button is not allowed alongside the device credential.
                if (!deviceCredential) setNegativeButtonText("Cancel")
            }
            .build()

    private fun runBiometric(call: PluginCall, cipher: Cipher, title: String, deviceCredential: Boolean, onSuccess: (Cipher) -> Unit) {
        val executor = ContextCompat.getMainExecutor(context)
        activity.runOnUiThread {
            // Everything here runs on the UI thread AFTER the plugin method's
            // try/catch has already returned. A throw from BiometricPrompt
            // construction or authenticate() would otherwise be swallowed,
            // leaving the retained PluginCall unresolved and the JS promise
            // hung forever ("Setting up…"). Wrap so any failure rejects the
            // call instead of hanging.
            try {
                val host = activity as androidx.fragment.app.FragmentActivity
                // A NIP-55 request can reach a locked app whose page is still
                // running in the background, and the page asks for the unlock
                // before the activity is back in front. BiometricPrompt started
                // on a stopped activity does nothing at all, no prompt and no
                // callback ("Called after onSaveInstanceState()"), which left
                // the unlock screen on "Waiting for biometric..." for good.
                // Start it once the activity is resumed; if the activity goes
                // first, say so.
                whenResumed(host.lifecycle, { promptBiometric(call, host, executor, cipher, title, deviceCredential, onSuccess) }) {
                    call.reject("biometric: the app closed before it could ask")
                }
            } catch (t: Throwable) {
                call.reject("biometric-prompt: ${t.message}")
            }
        }
    }

    private fun promptBiometric(
        call: PluginCall,
        host: androidx.fragment.app.FragmentActivity,
        executor: java.util.concurrent.Executor,
        cipher: Cipher,
        title: String,
        deviceCredential: Boolean,
        onSuccess: (Cipher) -> Unit,
    ) {
        val once = SettleOnce()
        val watchdog = Handler(Looper.getMainLooper())
        var prompt: BiometricPrompt? = null
        // Whatever else goes wrong, the call settles: a prompt that neither
        // answers nor fails is cancelled after BiometricPolicy.PROMPT_WATCHDOG_MS
        // and the page offers to try again.
        val giveUp = Runnable {
            if (once.claim()) {
                try { prompt?.cancelAuthentication() } catch (_: Throwable) {}
                call.reject("biometric: timed out")
            }
        }
        try {
            prompt = BiometricPrompt(
                host,
                executor,
                object : BiometricPrompt.AuthenticationCallback() {
                    override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                        if (!once.claim()) return
                        watchdog.removeCallbacks(giveUp)
                        val c = result.cryptoObject?.cipher
                        if (c == null) { call.reject("no cipher") } else {
                            try { onSuccess(c) } catch (t: Throwable) { call.reject("crypto: ${t.message}") }
                        }
                    }
                    override fun onAuthenticationError(code: Int, msg: CharSequence) {
                        if (!once.claim()) return
                        watchdog.removeCallbacks(giveUp)
                        call.reject("biometric: $msg")
                    }
                }
            )
            watchdog.postDelayed(giveUp, BiometricPolicy.PROMPT_WATCHDOG_MS)
            prompt.authenticate(promptInfo(title, deviceCredential), BiometricPrompt.CryptoObject(cipher))
        } catch (t: Throwable) {
            watchdog.removeCallbacks(giveUp)
            if (once.claim()) call.reject("biometric-prompt: ${t.message}")
        }
    }

    // ── Enroll: wrap the master key ───────────────────────────────────────
    @PluginMethod
    fun biometricEnroll(call: PluginCall) {
        val secret = call.getString("secret")
        if (secret.isNullOrEmpty() || secret.length != 64) { call.reject("bad secret"); return }
        try {
            keystore().deleteEntry(KEY_ALIAS) // fresh key per enrollment
            val deviceCredential = BiometricPolicy.deviceCredentialForNewKey(Build.VERSION.SDK_INT)
            val key = generateKey(deviceCredential)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, key)
            runBiometric(call, cipher, "Confirm to secure your Signet", deviceCredential) { c ->
                val ct = c.doFinal(secret.toByteArray(Charsets.UTF_8))
                val blob = Base64.encodeToString(c.iv + ct, Base64.NO_WRAP)
                prefs().edit()
                    .putString(PREF_WRAPPED, blob)
                    .putBoolean(PREF_DEVICE_CREDENTIAL, deviceCredential)
                    .apply()
                call.resolve(JSObject().put("ok", true))
            }
        } catch (t: Throwable) {
            call.reject("enroll: ${t.message}")
        }
    }

    // ── Unlock: unwrap and return the master key ──────────────────────────
    @PluginMethod
    fun biometricUnlock(call: PluginCall) {
        try {
            val blob = prefs().getString(PREF_WRAPPED, null) ?: run { call.reject("not enrolled"); return }
            val raw = Base64.decode(blob, Base64.NO_WRAP)
            val iv = raw.copyOfRange(0, 12)
            val ct = raw.copyOfRange(12, raw.size)
            val key = getKey() ?: run { call.reject("keystore key missing"); return }
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(GCM_TAG_BITS, iv))
            val deviceCredential = BiometricPolicy.deviceCredentialForStoredKey(
                Build.VERSION.SDK_INT, prefs().getBoolean(PREF_DEVICE_CREDENTIAL, false),
            )
            runBiometric(call, cipher, "Unlock your Signet", deviceCredential) { c ->
                val secret = String(c.doFinal(ct), Charsets.UTF_8)
                call.resolve(JSObject().put("secret", secret))
            }
        } catch (t: Throwable) {
            call.reject("unlock: ${t.message}")
        }
    }

    @PluginMethod
    fun biometricDeviceCredential(call: PluginCall) {
        val allowed = prefs().getString(PREF_WRAPPED, null) != null &&
            BiometricPolicy.deviceCredentialForStoredKey(Build.VERSION.SDK_INT, prefs().getBoolean(PREF_DEVICE_CREDENTIAL, false))
        call.resolve(JSObject().put("allowed", allowed))
    }

    @PluginMethod
    fun biometricClear(call: PluginCall) {
        try { keystore().deleteEntry(KEY_ALIAS) } catch (_: Throwable) {}
        prefs().edit().remove(PREF_WRAPPED).remove(PREF_DEVICE_CREDENTIAL).apply()
        call.resolve()
    }

    // ── Foreground bunker service control ─────────────────────────────────
    @PluginMethod
    fun startBunkerService(call: PluginCall) {
        val pubkeys = call.getString("pubkeysCsv") ?: ""
        val relay = call.getString("relayUrl") ?: ""
        if (relay.isEmpty()) { call.reject("no relay"); return }
        BunkerForegroundService.start(context, pubkeys, relay)
        call.resolve()
    }

    @PluginMethod
    fun startTemporaryBunkerService(call: PluginCall) {
        val relay = call.getString("relayUrl") ?: ""
        val duration = call.getDouble("durationMs") ?: 0.0
        if (relay.isEmpty() || !duration.isFinite() || duration <= 0) {
            call.reject("invalid temporary serving window")
            return
        }
        BunkerForegroundService.startTemporary(context, call.getString("pubkeysCsv") ?: "", relay, duration.toLong())
        call.resolve()
    }

    @PluginMethod
    fun stopTemporaryBunkerService(call: PluginCall) {
        BunkerForegroundService.stopTemporary(context)
        call.resolve()
    }

    @PluginMethod
    fun returnToPreviousApp(call: PluginCall) {
        activity.runOnUiThread {
            activity.moveTaskToBack(true)
            call.resolve()
        }
    }

    @PluginMethod
    fun stopBunkerService(call: PluginCall) {
        BunkerForegroundService.stop(context)
        call.resolve()
    }

    @PluginMethod
    fun serviceHeartbeat(call: PluginCall) {
        BunkerForegroundService.heartbeat(
            context,
            call.getString("pubkeysCsv") ?: "",
            call.getString("relayUrl") ?: ""
        )
        call.resolve()
    }

    // ── Battery exemption ─────────────────────────────────────────────────
    @PluginMethod
    fun isBatteryExempt(call: PluginCall) {
        val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
        call.resolve(JSObject().put("exempt", pm.isIgnoringBatteryOptimizations(context.packageName)))
    }

    @PluginMethod
    fun requestBatteryExemption(call: PluginCall) {
        val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
            .setData(Uri.parse("package:${context.packageName}"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
        call.resolve()
    }

    // ── Contact pictures: capped image download ───────────────────────────
    //
    // The APK leg of src/lib/picture-download.ts. Answers { ok, status, base64 }
    // or { ok: false, status, reason }; never rejects for a failed download.
    // See CappedImageFetch for the cap, the deadline and the threads.
    @PluginMethod
    fun fetchImageCapped(call: PluginCall) {
        val url = call.getString("url")
        val maxBytes = call.getInt("maxBytes")
        val timeoutMs = call.getInt("timeoutMs")
        if (url == null || maxBytes == null || timeoutMs == null) {
            call.reject("url, maxBytes and timeoutMs are required")
            return
        }
        CappedImageFetch.start(url, maxBytes, timeoutMs) { result -> call.resolve(result.toJs()) }
    }

    // ── Camera permission ─────────────────────────────────────────────────
    @PluginMethod
    fun requestCameraPermission(call: PluginCall) {
        if (getPermissionState("camera") == com.getcapacitor.PermissionState.GRANTED) {
            call.resolve(JSObject().put("granted", true))
        } else {
            requestPermissionForAlias("camera", call, "cameraPermCallback")
        }
    }

    @PermissionCallback
    fun cameraPermCallback(call: PluginCall) {
        val granted = getPermissionState("camera") == com.getcapacitor.PermissionState.GRANTED
        call.resolve(JSObject().put("granted", granted))
    }
}
