package app.mysignet

import android.security.keystore.KeyProperties
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BiometricPolicyTest {
    @Test fun `a key made on Android 11 or later also opens with the phone's own PIN`() {
        assertTrue(BiometricPolicy.deviceCredentialForNewKey(30))
        assertTrue(BiometricPolicy.deviceCredentialForNewKey(36))
        assertFalse(BiometricPolicy.deviceCredentialForNewKey(29))
    }

    @Test fun `a stored key is prompted for as it was made, never more`() {
        assertTrue(BiometricPolicy.deviceCredentialForStoredKey(34, madeWithIt = true))
        // Made before this change: biometric-only, so the prompt must not offer the PIN it cannot use.
        assertFalse(BiometricPolicy.deviceCredentialForStoredKey(34, madeWithIt = false))
        assertFalse(BiometricPolicy.deviceCredentialForStoredKey(29, madeWithIt = true))
    }

    @Test fun `the key and the prompt name the same factors`() {
        assertEquals(KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL, BiometricPolicy.keyAuthenticators(true))
        assertEquals(KeyProperties.AUTH_BIOMETRIC_STRONG, BiometricPolicy.keyAuthenticators(false))
        assertEquals(BIOMETRIC_STRONG or DEVICE_CREDENTIAL, BiometricPolicy.promptAuthenticators(true))
        assertEquals(BIOMETRIC_STRONG, BiometricPolicy.promptAuthenticators(false))
    }

    @Test fun `a silent prompt is given up on within half a minute`() {
        assertTrue(BiometricPolicy.PROMPT_WATCHDOG_MS in 1..30_000L)
    }

    @Test fun `only the first outcome settles the call`() {
        val once = SettleOnce()
        assertFalse(once.done)
        assertTrue(once.claim())
        assertTrue(once.done)
        // The watchdog's cancel makes the prompt report an error too: ignored.
        assertFalse(once.claim())
    }
}
