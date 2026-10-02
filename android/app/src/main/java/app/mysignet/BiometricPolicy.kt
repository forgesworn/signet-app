package app.mysignet

import android.security.keystore.KeyProperties
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL

/**
 * Which factors may open the key that wraps the master key, and how long a
 * prompt may stay silent. Pure, so it is checked on the JVM.
 *
 * A key made from Android 11 (API 30) on also opens with the phone's own PIN,
 * pattern or password, so a finger that will not read, a lockout, or a
 * fingerprint removed in Settings never strands the person. Such a key is not
 * tied to the enrolled fingerprints: once the phone's PIN opens it, anyone
 * able to add a fingerprint already knows that PIN, so the tie would only
 * ever lock the owner out. Before API 30 a key with a crypto operation cannot
 * take the device credential, and stays biometric-only. A key made before
 * this change stays as it was made until biometrics is set up again.
 */
object BiometricPolicy {
    /** A prompt that has neither answered nor failed in this long is cancelled and reported. */
    const val PROMPT_WATCHDOG_MS = 30_000L

    /** Whether a key made now may also be opened with the device credential. */
    fun deviceCredentialForNewKey(sdkInt: Int): Boolean = sdkInt >= 30

    /** Whether the stored key may be: only if it was made that way, on a phone that still allows it. */
    fun deviceCredentialForStoredKey(sdkInt: Int, madeWithIt: Boolean): Boolean = sdkInt >= 30 && madeWithIt

    /** For `KeyGenParameterSpec.setUserAuthenticationParameters`. */
    fun keyAuthenticators(deviceCredential: Boolean): Int =
        if (deviceCredential) KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL
        else KeyProperties.AUTH_BIOMETRIC_STRONG

    /** For `BiometricPrompt.PromptInfo.Builder.setAllowedAuthenticators`. */
    fun promptAuthenticators(deviceCredential: Boolean): Int =
        if (deviceCredential) BIOMETRIC_STRONG or DEVICE_CREDENTIAL else BIOMETRIC_STRONG
}

/**
 * Lets the first of several racing outcomes (an answer, an error, the
 * watchdog) settle a plugin call, and drops the rest. Main thread only.
 */
class SettleOnce {
    private var settled = false
    val done: Boolean get() = settled
    fun claim(): Boolean {
        if (settled) return false
        settled = true
        return true
    }
}
