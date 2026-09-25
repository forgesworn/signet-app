// Biometric auth using WebAuthn with PIN fallback
import { deriveAesKey, aesEncrypt, aesDecrypt, IV_LENGTH } from './aes-crypto';
import * as db from './db';
import { isNativeApp, SignetNative } from './native';

const CREDENTIAL_ID_KEY = 'signet-auth-credential-id';
const ENCRYPTED_KEY_KEY = 'signet-auth-encrypted-key';
const AUTH_METHOD_KEY = 'signet-auth-method';

/** Check if WebAuthn with biometrics is available */
export async function isBiometricAvailable(): Promise<boolean> {
  if (isNativeApp()) {
    try {
      return (await SignetNative.isBiometricAvailable()).available;
    } catch {
      return false;
    }
  }
  if (!window.PublicKeyCredential) return false;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

/** The PRF salt used with WebAuthn PRF extension — app-specific, constant */
const PRF_SALT = new Uint8Array([
  0x73, 0x69, 0x67, 0x6e, 0x65, 0x74, 0x2d, 0x70,  // "signet-p"
  0x72, 0x66, 0x2d, 0x73, 0x61, 0x6c, 0x74, 0x2d,  // "rf-salt-"
  0x76, 0x31, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,  // "v1" + padding
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,  // 32 bytes total
]);

/** Get the relying party ID for WebAuthn */
function getRpId(): string {
  return window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? window.location.hostname
    : 'mysignet.app';
}

/**
 * Result of a biometric setup attempt. `prfSupported: false` means the
 * device lacks the WebAuthn PRF extension and we had to fall back to
 * credential-ID-derived key material (which is stored in localStorage,
 * meaning offline extraction of browser data could enable brute-force).
 * Callers should surface this to the user so they can opt into PIN as
 * the primary unlock instead.
 */
export interface SetupBiometricResult {
  ok: boolean;
  prfSupported: boolean;
}

/**
 * Set up biometric auth — creates a WebAuthn credential.
 * Tries PRF extension first (hardware-derived key). Falls back to credential-ID-based
 * key derivation if PRF is unavailable (weaker but still biometric-gated).
 */
export async function setupBiometric(encryptionKey: string): Promise<SetupBiometricResult> {
  try {
    if (isNativeApp()) {
      // Android Keystore + BiometricPrompt path — WebAuthn doesn't exist in
      // the WebView. The plugin wraps the master key with a hardware-bound,
      // biometric-gated AES key; hardware-backed, so report prfSupported
      // (suppresses the weak-fallback warning, which doesn't apply here).
      const { ok } = await SignetNative.biometricEnroll({ secret: encryptionKey });
      if (!ok) return { ok: false, prfSupported: false };
      localStorage.setItem(ENCRYPTED_KEY_KEY, JSON.stringify({ native: true }));
      localStorage.setItem(AUTH_METHOD_KEY, 'biometric');
      return { ok: true, prfSupported: true };
    }

    const challenge = crypto.getRandomValues(new Uint8Array(32));

    // Request PRF extension during credential creation
    const createOptions: PublicKeyCredentialCreationOptions & { extensions?: Record<string, unknown> } = {
      challenge,
      rp: { name: 'MySignet', id: getRpId() },
      user: {
        id: crypto.getRandomValues(new Uint8Array(16)),
        name: 'signet-user',
        displayName: 'Signet User',
      },
      pubKeyCredParams: [{ alg: -7, type: 'public-key' }],
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        userVerification: 'required',
        residentKey: 'preferred',
      },
      extensions: { prf: {} },
      timeout: 60000,
    };

    const credential = await navigator.credentials.create({
      publicKey: createOptions,
    }) as PublicKeyCredential | null;

    if (!credential) return { ok: false, prfSupported: false };

    const credId = btoa(String.fromCharCode(...new Uint8Array(credential.rawId)));
    // Don't persist CREDENTIAL_ID_KEY yet — the PRF/encryption steps below
    // can still throw, and writing the credential reference first would
    // leave an orphaned CREDENTIAL_ID_KEY with no matching ENCRYPTED_KEY_KEY
    // on a mid-setup failure. Persist it only alongside the other two keys,
    // once encryption has actually succeeded, on each return path below.

    // Check if PRF extension is supported by the authenticator
    const extensions = (credential as PublicKeyCredential & { getClientExtensionResults(): Record<string, unknown> }).getClientExtensionResults();
    const prfSupported = !!(extensions?.prf && (extensions.prf as Record<string, unknown>)?.enabled);

    if (prfSupported) {
      // PRF available: get hardware-derived key material via assertion
      const prfKey = await getPRFKey(credId);
      if (prfKey) {
        const derivedKey = await deriveKeyFromPRF(prfKey);
        const encrypted = await encryptWithKey(encryptionKey, derivedKey);
        localStorage.setItem(CREDENTIAL_ID_KEY, credId);
        localStorage.setItem(ENCRYPTED_KEY_KEY, JSON.stringify({ encrypted, prf: true }));
        localStorage.setItem(AUTH_METHOD_KEY, 'biometric');
        return { ok: true, prfSupported: true };
      }
    }

    // PRF not available: fall back to credential-ID-based derivation (weaker)
    // The biometric assertion still gates access, but the key material is derived from
    // the credential ID which is stored in localStorage. This is secure against live
    // attacks (need biometric) but not against offline extraction of localStorage.
    const deviceSalt = crypto.getRandomValues(new Uint8Array(16));
    const derivedKey = await deriveKeyFromCredential(credId, deviceSalt);
    const encrypted = await encryptWithKey(encryptionKey, derivedKey);

    localStorage.setItem(CREDENTIAL_ID_KEY, credId);
    localStorage.setItem(
      ENCRYPTED_KEY_KEY,
      JSON.stringify({ encrypted, salt: btoa(String.fromCharCode(...deviceSalt)), prf: false }),
    );
    localStorage.setItem(AUTH_METHOD_KEY, 'biometric');

    return { ok: true, prfSupported: false };
  } catch {
    return { ok: false, prfSupported: false };
  }
}

/** Get PRF output from the authenticator via assertion */
async function getPRFKey(credIdB64: string): Promise<ArrayBuffer | null> {
  try {
    const credIdBytes = Uint8Array.from(atob(credIdB64), c => c.charCodeAt(0));
    const challenge = crypto.getRandomValues(new Uint8Array(32));

    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge,
        allowCredentials: [{ id: credIdBytes, type: 'public-key', transports: ['internal'] }],
        userVerification: 'required',
        extensions: { prf: { eval: { first: PRF_SALT } } } as Record<string, unknown>,
        timeout: 60000,
      },
    }) as PublicKeyCredential | null;

    if (!assertion) return null;

    const extensions = (assertion as PublicKeyCredential & { getClientExtensionResults(): Record<string, unknown> }).getClientExtensionResults();
    const prfResults = extensions?.prf as Record<string, unknown> | undefined;
    const results = prfResults?.results as Record<string, ArrayBuffer> | undefined;

    return results?.first ?? null;
  } catch {
    return null;
  }
}

/** Derive an AES-256-GCM key from PRF output (hardware-derived, high entropy) */
async function deriveKeyFromPRF(prfOutput: ArrayBuffer): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey('raw', prfOutput, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: PRF_SALT, info: new TextEncoder().encode('signet-encryption-key') },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Set up PIN auth — derives encryption key from PIN via PBKDF2 */
export async function setupPIN(pin: string, encryptionKey: string): Promise<void> {
  if (!/^\d{6}$/.test(pin)) throw new Error('PIN must be 6 digits');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const derivedKey = await deriveKeyFromPIN(pin, salt);
  const encrypted = await encryptWithKey(encryptionKey, derivedKey);

  localStorage.setItem(
    ENCRYPTED_KEY_KEY,
    JSON.stringify({ encrypted, salt: btoa(String.fromCharCode(...salt)) }),
  );
  localStorage.setItem(AUTH_METHOD_KEY, 'pin');
}

/**
 * LEGACY (spec §9, one release only). Read path for the retired no-lock handle,
 * kept so an identity created under it can be migrated onto a PIN/biometric.
 * There is no writer any more — `setupGrace` is gone. Delete this, the two
 * `endGrace*` helpers and the `'grace'` literal in `getAuthMethod` after the
 * migration release.
 *
 * Returns the encryption key, or null if the stored record is absent or
 * decryption fails.
 */
export async function authenticateGrace(): Promise<string | null> {
  try {
    const rec = await db.getGraceKey();
    if (!rec) return null;
    return await decryptWithKey(rec.wrapped, rec.handle);
  } catch {
    return null;
  }
}

/** Authenticate with biometric — returns the encryption key */
export async function authenticateBiometric(): Promise<string | null> {
  try {
    if (isNativeApp()) {
      const raw = localStorage.getItem(ENCRYPTED_KEY_KEY);
      if (!raw) return null;
      const stored = JSON.parse(raw) as Record<string, unknown>;
      if (stored.native !== true) return null; // web-era record on native — treat as absent
      const { secret } = await SignetNative.biometricUnlock();
      return typeof secret === 'string' && secret.length === 64 ? secret : null;
    }

    const credIdB64 = localStorage.getItem(CREDENTIAL_ID_KEY);
    if (!credIdB64) return null;

    const raw = localStorage.getItem(ENCRYPTED_KEY_KEY);
    if (!raw) return null;
    const stored = JSON.parse(raw) as Record<string, unknown>;
    if (typeof stored.encrypted !== 'string') return null;

    const usesPRF = stored.prf === true;

    if (usesPRF) {
      // PRF path: get hardware-derived key from authenticator
      const prfKey = await getPRFKey(credIdB64);
      if (!prfKey) return null;
      const derivedKey = await deriveKeyFromPRF(prfKey);
      return await decryptWithKey(stored.encrypted, derivedKey);
    } else {
      // Fallback path: biometric assertion + credential-ID-based key
      const credIdBytes = Uint8Array.from(atob(credIdB64), c => c.charCodeAt(0));
      const challenge = crypto.getRandomValues(new Uint8Array(32));

      const assertion = await navigator.credentials.get({
        publicKey: {
          challenge,
          allowCredentials: [{ id: credIdBytes, type: 'public-key', transports: ['internal'] }],
          userVerification: 'required',
          timeout: 60000,
        },
      }) as PublicKeyCredential | null;

      if (!assertion) return null;

      if (typeof stored.salt !== 'string') return null;
      const salt = Uint8Array.from(atob(stored.salt), c => c.charCodeAt(0));
      const derivedKey = await deriveKeyFromCredential(credIdB64, salt);
      return await decryptWithKey(stored.encrypted, derivedKey);
    }
  } catch {
    return null;
  }
}

/** Authenticate with PIN — returns the encryption key, or null on wrong PIN */
export async function authenticatePIN(pin: string): Promise<string | null> {
  try {
    const raw = localStorage.getItem(ENCRYPTED_KEY_KEY);
    if (!raw) return null;
    const stored = JSON.parse(raw) as Record<string, unknown>;
    if (typeof stored.encrypted !== 'string' || typeof stored.salt !== 'string') return null;

    const salt = Uint8Array.from(atob(stored.salt), c => c.charCodeAt(0));
    const derivedKey = await deriveKeyFromPIN(pin, salt);
    return await decryptWithKey(stored.encrypted, derivedKey);
  } catch {
    return null; // wrong PIN or corrupt data
  }
}

/** Check if auth is set up */
export function isAuthSetUp(): boolean {
  return localStorage.getItem(AUTH_METHOD_KEY) !== null;
}

/** Get auth method */
export function getAuthMethod(): 'biometric' | 'pin' | 'grace' | null {
  const val = localStorage.getItem(AUTH_METHOD_KEY);
  if (val === 'biometric' || val === 'pin' || val === 'grace') return val;
  return null;
}

/** Generate a random 256-bit encryption key (hex string) */
export function generateEncryptionKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Change PIN — verifies the current PIN then re-wraps the encryption key with the new PIN.
 * Returns true on success, false if the current PIN is wrong.
 */
export async function changePIN(currentPin: string, newPin: string): Promise<boolean> {
  const encryptionKey = await authenticatePIN(currentPin);
  if (!encryptionKey) return false;
  await setupPIN(newPin, encryptionKey);
  return true;
}

/**
 * Switch from PIN to biometric auth.
 * Requires the decrypted encryption key (caller must have already authenticated).
 * Returns a `SetupBiometricResult` so callers can surface the PRF-fallback
 * warning when `prfSupported === false`.
 */
export async function enableBiometric(encryptionKey: string): Promise<SetupBiometricResult> {
  return setupBiometric(encryptionKey);
}

/**
 * Switch from biometric to PIN auth.
 * Requires the decrypted encryption key (caller must have already authenticated).
 */
export async function disableBiometric(encryptionKey: string, newPin: string): Promise<void> {
  if (isNativeApp()) { void SignetNative.biometricClear().catch(() => {}); }
  // Remove WebAuthn credential reference
  localStorage.removeItem(CREDENTIAL_ID_KEY);
  // Re-wrap encryption key with the new PIN
  await setupPIN(newPin, encryptionKey);
}

/**
 * End the grace period by re-wrapping the encryption key under a PIN.
 * Atomically: setupPIN throws on invalid PIN (leaving the grace key intact);
 * clearGraceKey is only reached on success.
 */
export async function endGraceWithPin(pin: string, encryptionKey: string): Promise<void> {
  await setupPIN(pin, encryptionKey); // throws on invalid pin; flips method to 'pin'
  await db.clearGraceKey();           // only reached on success → atomic
}

/**
 * End the grace period by re-wrapping the encryption key under biometric.
 * Throws if biometric setup fails (grace key remains intact).
 */
export async function endGraceWithBiometric(encryptionKey: string): Promise<void> {
  const result = await setupBiometric(encryptionKey);
  if (!result.ok) throw new Error('Biometric setup failed');
  await db.clearGraceKey();
}

/** Clear all auth data from localStorage (for account deletion) */
export function clearAuthData(): void {
  if (isNativeApp()) { void SignetNative.biometricClear().catch(() => {}); }
  localStorage.removeItem(CREDENTIAL_ID_KEY);
  localStorage.removeItem(ENCRYPTED_KEY_KEY);
  localStorage.removeItem(AUTH_METHOD_KEY);
  localStorage.removeItem('signet-pin-attempts');
  localStorage.removeItem('signet-pin-locked');
}

// --- Internal helpers ---

/** Derive an AES-256-GCM key from a PIN string using PBKDF2. */
async function deriveKeyFromPIN(pin: string, salt: Uint8Array): Promise<CryptoKey> {
  return deriveAesKey(pin, salt);
}

/** Derive an AES-256-GCM key from a credential ID string using PBKDF2. */
async function deriveKeyFromCredential(credId: string, salt: Uint8Array): Promise<CryptoKey> {
  return deriveAesKey(credId, salt);
}

/**
 * Encrypt plaintext with a pre-derived key.
 * Wire format: base64(iv[12] || ciphertext) — no salt, key is already derived.
 */
async function encryptWithKey(plaintext: string, key: CryptoKey): Promise<string> {
  const { iv, ciphertext } = await aesEncrypt(plaintext, key);
  const combined = new Uint8Array(IV_LENGTH + ciphertext.length);
  combined.set(iv);
  combined.set(ciphertext, IV_LENGTH);
  let binary = '';
  combined.forEach(b => { binary += String.fromCharCode(b); });
  return btoa(binary);
}

/**
 * Decrypt a payload produced by `encryptWithKey`.
 * Wire format: base64(iv[12] || ciphertext) — minimum 29 bytes (12 IV + 16 tag + 1 plaintext).
 */
async function decryptWithKey(encrypted: string, key: CryptoKey): Promise<string> {
  const combined = Uint8Array.from(atob(encrypted), c => c.charCodeAt(0));
  if (combined.length < 29) throw new Error('Ciphertext too short');
  const iv = combined.slice(0, IV_LENGTH);
  const ciphertext = combined.slice(IV_LENGTH);
  return aesDecrypt(iv, ciphertext, key);
}
