package app.mysignet

import android.Manifest
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.PowerManager
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
        private const val GCM_TAG_BITS = 128
    }

    // ── NIP-55: requests from other apps on this phone ─────────────────────
    //
    // The web layer listens for `nip55Request`, drains what arrived before it
    // was up with `nip55Pending`, and answers each one with `nip55Respond`.
    // See Nip55Requests for the hand-over and src/lib/nip55.ts for what the
    // web layer does with a request.
    private val deliverToPage: (Nip55Incoming) -> Unit = { request ->
        notifyListeners("nip55Request", incomingJson(request), true)
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
        Nip55Requests.attach(deliverToPage)
    }

    override fun handleOnDestroy() {
        Nip55Requests.detach(deliverToPage)
        super.handleOnDestroy()
    }

    @PluginMethod
    fun nip55Pending(call: PluginCall) {
        val requests = com.getcapacitor.JSArray()
        for (request in Nip55Requests.drain()) requests.put(incomingJson(request))
        call.resolve(JSObject().put("requests", requests))
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

    private fun generateKey(): SecretKey {
        val kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        kg.init(
            KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                // Auth-per-use, bound to Class-3 (strong) biometrics only.
                .setUserAuthenticationRequired(true)
                .setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
                .setInvalidatedByBiometricEnrollment(true)
                .build()
        )
        return kg.generateKey()
    }

    private fun getKey(): SecretKey? = keystore().getKey(KEY_ALIAS, null) as? SecretKey

    private fun promptInfo(title: String): BiometricPrompt.PromptInfo =
        BiometricPrompt.PromptInfo.Builder()
            .setTitle(title)
            .setAllowedAuthenticators(BIOMETRIC_STRONG)
            .setNegativeButtonText("Cancel")
            .build()

    private fun runBiometric(call: PluginCall, cipher: Cipher, title: String, onSuccess: (Cipher) -> Unit) {
        val executor = ContextCompat.getMainExecutor(context)
        activity.runOnUiThread {
            // Everything here runs on the UI thread AFTER the plugin method's
            // try/catch has already returned. A throw from BiometricPrompt
            // construction or authenticate() would otherwise be swallowed,
            // leaving the retained PluginCall unresolved and the JS promise
            // hung forever ("Setting up…"). Wrap so any failure rejects the
            // call instead of hanging.
            try {
                val prompt = BiometricPrompt(
                    activity as androidx.fragment.app.FragmentActivity,
                    executor,
                    object : BiometricPrompt.AuthenticationCallback() {
                        override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                            val c = result.cryptoObject?.cipher
                            if (c == null) { call.reject("no cipher") } else {
                                try { onSuccess(c) } catch (t: Throwable) { call.reject("crypto: ${t.message}") }
                            }
                        }
                        override fun onAuthenticationError(code: Int, msg: CharSequence) {
                            call.reject("biometric: $msg")
                        }
                    }
                )
                prompt.authenticate(promptInfo(title), BiometricPrompt.CryptoObject(cipher))
            } catch (t: Throwable) {
                call.reject("biometric-prompt: ${t.message}")
            }
        }
    }

    // ── Enroll: wrap the master key ───────────────────────────────────────
    @PluginMethod
    fun biometricEnroll(call: PluginCall) {
        val secret = call.getString("secret")
        if (secret.isNullOrEmpty() || secret.length != 64) { call.reject("bad secret"); return }
        try {
            keystore().deleteEntry(KEY_ALIAS) // fresh key per enrollment
            val key = generateKey()
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, key)
            runBiometric(call, cipher, "Confirm to secure your Signet") { c ->
                val ct = c.doFinal(secret.toByteArray(Charsets.UTF_8))
                val blob = Base64.encodeToString(c.iv + ct, Base64.NO_WRAP)
                context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .edit().putString(PREF_WRAPPED, blob).apply()
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
            val blob = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getString(PREF_WRAPPED, null) ?: run { call.reject("not enrolled"); return }
            val raw = Base64.decode(blob, Base64.NO_WRAP)
            val iv = raw.copyOfRange(0, 12)
            val ct = raw.copyOfRange(12, raw.size)
            val key = getKey() ?: run { call.reject("keystore key missing"); return }
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(GCM_TAG_BITS, iv))
            runBiometric(call, cipher, "Unlock your Signet") { c ->
                val secret = String(c.doFinal(ct), Charsets.UTF_8)
                call.resolve(JSObject().put("secret", secret))
            }
        } catch (t: Throwable) {
            call.reject("unlock: ${t.message}")
        }
    }

    @PluginMethod
    fun biometricClear(call: PluginCall) {
        try { keystore().deleteEntry(KEY_ALIAS) } catch (_: Throwable) {}
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(PREF_WRAPPED).apply()
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
