import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { generateEncryptionKey, isAuthSetUp, getAuthMethod, clearAuthData, authenticateGrace, authenticatePIN, endGraceWithPin } from './auth';
import * as gdb from './db';

// Minimal localStorage shim for Node
const store: Record<string, string> = {};
beforeEach(() => {
  Object.keys(store).forEach(k => delete store[k]);
  globalThis.localStorage = {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
    clear: () => { Object.keys(store).forEach(k => delete store[k]); },
    get length() { return Object.keys(store).length; },
    key: (i: number) => Object.keys(store)[i] ?? null,
  } as Storage;
});

describe('generateEncryptionKey', () => {
  it('returns a 64-character hex string', () => {
    const key = generateEncryptionKey();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces unique values', () => {
    const keys = new Set(Array.from({ length: 10 }, () => generateEncryptionKey()));
    expect(keys.size).toBe(10);
  });
});

describe('isAuthSetUp', () => {
  it('returns false when no auth method stored', () => {
    expect(isAuthSetUp()).toBe(false);
  });

  it('returns true when biometric auth stored', () => {
    localStorage.setItem('signet-auth-method', 'biometric');
    expect(isAuthSetUp()).toBe(true);
  });

  it('returns true when PIN auth stored', () => {
    localStorage.setItem('signet-auth-method', 'pin');
    expect(isAuthSetUp()).toBe(true);
  });
});

describe('getAuthMethod', () => {
  it('returns null when no method stored', () => {
    expect(getAuthMethod()).toBeNull();
  });

  it('returns biometric when stored', () => {
    localStorage.setItem('signet-auth-method', 'biometric');
    expect(getAuthMethod()).toBe('biometric');
  });

  it('returns pin when stored', () => {
    localStorage.setItem('signet-auth-method', 'pin');
    expect(getAuthMethod()).toBe('pin');
  });

  it('returns null for unexpected values', () => {
    localStorage.setItem('signet-auth-method', 'magic');
    expect(getAuthMethod()).toBeNull();
  });
});

describe('clearAuthData', () => {
  it('removes all auth keys from localStorage', () => {
    localStorage.setItem('signet-auth-method', 'pin');
    localStorage.setItem('signet-auth-credential-id', 'abc');
    localStorage.setItem('signet-auth-encrypted-key', 'xyz');
    localStorage.setItem('signet-pin-attempts', '2');
    localStorage.setItem('signet-pin-locked', 'true');
    clearAuthData();
    expect(isAuthSetUp()).toBe(false);
    expect(localStorage.getItem('signet-auth-credential-id')).toBeNull();
    expect(localStorage.getItem('signet-auth-encrypted-key')).toBeNull();
    expect(localStorage.getItem('signet-pin-attempts')).toBeNull();
    expect(localStorage.getItem('signet-pin-locked')).toBeNull();
  });
});

/**
 * LEGACY (spec §9). The writer (`setupGrace`) is gone — these fixtures seed the
 * `graceKey` row directly so the surviving read + migrate path stays covered.
 * Byte-format mirrors auth.ts's private `encryptWithKey`: base64(iv[12] || ct).
 */
async function seedGraceKey(encryptionKey: string): Promise<void> {
  const handle = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    /* extractable */ false,
    ['encrypt', 'decrypt'],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, handle, new TextEncoder().encode(encryptionKey)),
  );
  const combined = new Uint8Array(12 + ct.length);
  combined.set(iv);
  combined.set(ct, 12);
  let binary = '';
  combined.forEach(b => { binary += String.fromCharCode(b); });
  const { openDB } = await import('idb');
  const raw = await openDB('my-signet', 25, {
    upgrade(d) {
      if (!d.objectStoreNames.contains('graceKey')) d.createObjectStore('graceKey', { keyPath: 'id' });
    },
  });
  await raw.put('graceKey', { id: 'current', handle, wrapped: btoa(binary) });
  raw.close();
  localStorage.setItem('signet-auth-method', 'grace');
}

// One factory for both legacy describes: db.ts caches its connection on first
// use, so swapping the factory per-test would leave `gdb` reading a stale
// database while `seedGraceKey` wrote to the new one.
beforeAll(async () => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  await gdb.getGraceKey();  // force db.ts to bind its cached connection
});

describe('legacy no-lock read path', () => {
  beforeEach(async () => {
    await gdb.clearGraceKey();
  });

  it('authenticateGrace returns the encryption key from a seeded handle', async () => {
    const key = generateEncryptionKey();
    await seedGraceKey(key);
    expect(getAuthMethod()).toBe('grace');
    expect(await authenticateGrace()).toBe(key);
  });

  it('returns null when there is no stored handle', async () => {
    expect(await authenticateGrace()).toBeNull();
  });
});

describe('endGrace', () => {
  beforeEach(async () => {
    await gdb.clearGraceKey();
  });

  it('re-wraps under a PIN, flips method, and deletes the stored handle', async () => {
    const key = generateEncryptionKey();
    await seedGraceKey(key);
    await endGraceWithPin('123456', key);
    expect(getAuthMethod()).toBe('pin');
    expect(await gdb.getGraceKey()).toBeUndefined();
    expect(await authenticatePIN('123456')).toBe(key);
  });

  it('leaves the stored handle intact if PIN setup throws', async () => {
    const key = generateEncryptionKey();
    await seedGraceKey(key);
    await expect(endGraceWithPin('', key)).rejects.toBeTruthy();
    expect(await gdb.getGraceKey()).toBeDefined();
  });
});

