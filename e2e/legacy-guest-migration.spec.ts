import { test, expect } from '@playwright/test';
import { createIdentityAndUnlock } from './fixtures';

test('an identity with the retired no-lock marker is walked onto a PIN', async ({ page }) => {
  await createIdentityAndUnlock(page, { name: 'Shade' });

  // Seed the retired tier's markers onto the identity this session just made,
  // then reload: the notice must preempt all routing.
  //
  // Two rows are required, per `src/lib/db.ts` / `src/lib/auth.ts`:
  //   - `gracePeriodState` (keyPath 'id' = the identity id) — what the
  //     App.tsx probe (`getGraceState(identity.id)`) checks to flip to the
  //     notice screen. Seeding only this row and not `graceKey` (a Task 10
  //     review finding) would show the notice but leave "Secure my Signet"
  //     with nothing to recover — dead-ending on an error instead of the
  //     SetupAuth choose-method screen this test asserts.
  //   - `graceKey` (singleton, id 'current') — `{ handle: CryptoKey,
  //     wrapped: base64(iv||ciphertext) }`, read by `authenticateGrace()` via
  //     `decryptWithKey`. `handle` is a genuine non-extractable AES-256-GCM
  //     key generated here in page context (structured-clonable into IDB);
  //     `wrapped` is that key encrypting an arbitrary 64-char placeholder
  //     string. This test only reaches the notice -> choose-method screen
  //     (never taps through actual PIN entry, which is the only path that
  //     would need the recovered value to be this identity's REAL
  //     encryption key), so a well-formed but fabricated wrap is sufficient.
  await page.evaluate(async () => {
    localStorage.setItem('signet-auth-method', 'grace');
    const req = indexedDB.open('my-signet');
    const db: IDBDatabase = await new Promise(res => { req.onsuccess = () => res(req.result); });
    const ids: string[] = await new Promise(res => {
      const r = db.transaction('identity').objectStore('identity').getAllKeys();
      r.onsuccess = () => res(r.result as string[]);
    });
    const target = ids.find(k => k !== 'bunkerSecret' && !k.startsWith('dependant:'));

    const handle = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode('f'.repeat(64));
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, handle, plaintext));
    const combined = new Uint8Array(12 + ciphertext.length);
    combined.set(iv);
    combined.set(ciphertext, 12);
    let binary = '';
    combined.forEach(b => { binary += String.fromCharCode(b); });
    const wrapped = btoa(binary);

    await new Promise(res => {
      const tx = db.transaction(['gracePeriodState', 'graceKey'], 'readwrite');
      tx.objectStore('gracePeriodState').put({ id: target });
      tx.objectStore('graceKey').put({ id: 'current', handle, wrapped });
      tx.oncomplete = () => res(null);
    });
  });

  await page.reload();
  await expect(page.getByText(/have been retired/i)).toBeVisible();
  await page.getByRole('button', { name: 'Secure my Signet' }).click();
  await expect(page.getByRole('button', { name: /6-digit PIN/ })).toBeVisible();
});
