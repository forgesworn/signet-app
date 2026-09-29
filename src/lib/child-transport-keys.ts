/**
 * The child's NIP-46 server transport keys (child-direct spec §8.2): one
 * fresh random keypair per persona, stored encrypted at rest. Apps pair with
 * `bunker://<transport pubkey>`; envelopes are decrypted/signed with this
 * LOCAL key, so serving an app costs no Heartwood round trip — only the real
 * signing (as the persona) goes to the device. Never derived from, and never
 * equal to, a persona key.
 */
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex } from '@noble/hashes/utils.js';
import { loadChildTransportKeys, saveChildTransportKeys, type ChildTransportKeys } from './db';

const HEX64 = /^[0-9a-f]{64}$/;

// Read-modify-write of one row: serialise so two callers never mint two keys
// for the same persona (the loser's key would be overwritten after an app
// already paired with it).
let chain: Promise<unknown> = Promise.resolve();

export async function loadOrCreateTransportKeys(personas: string[], encryptionKey: string): Promise<ChildTransportKeys> {
  const wanted = [...new Set(personas.map(p => (p ?? '').toLowerCase()).filter(p => HEX64.test(p)))];
  const run = chain.then(async () => {
    const stored = await loadChildTransportKeys(encryptionKey);
    let changed = false;
    for (const persona of wanted) {
      if (stored[persona]) continue;
      let sk = generateSecretKey();
      let pub = getPublicKey(sk);
      while (pub === persona) { sk.fill(0); sk = generateSecretKey(); pub = getPublicKey(sk); }
      stored[persona] = { publicKey: pub, privateKey: bytesToHex(sk) };
      sk.fill(0);
      changed = true;
    }
    if (changed) await saveChildTransportKeys(stored, encryptionKey);
    const out: ChildTransportKeys = {};
    for (const persona of wanted) out[persona] = stored[persona];
    return out;
  });
  chain = run.catch(() => { /* keep the chain alive */ });
  return run;
}
