// @vitest-environment jsdom
// The guardian's half on a STORED record: the endpoint as read back from the
// dependants store signs a notice the child's pairing accepts. And the one
// older child reader that subscribes to the endpoint author WITHOUT a `d`
// filter (the contact-reply inbox) rejects the notice.
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { useDependants } from './useDependants';
import { saveIdentityEncrypted, purgeAllUserData } from '../lib/db';
import { createNewIdentity } from '../lib/signet';
import type { PairedChildRecord, SignetIdentity } from '../types';
import { buildLegacyUnpairedNotice, acceptLegacyUnpairedNotice } from '../lib/legacy-child-unpair';
import { openChildContactReply } from '../lib/child-contact-exchange';
import { LocalSigningBackend } from '../lib/signing-backend';

const KEY = 'a'.repeat(64);
const RELAY = 'wss://relay.example';

describe('legacy unpair notice from a stored dependant record', () => {
  beforeEach(async () => { await purgeAllUserData(); });

  it('the endpoint read back from the store builds a notice the child pairing accepts; the old contact-reply inbox rejects it', async () => {
    const id = createNewIdentity('Guardian', 'natural-person', false);
    const g: SignetIdentity = { ...id, mnemonic: '', naturalPerson: { ...id.naturalPerson, privateKey: '' }, persona: { ...id.persona, privateKey: '' } };
    await saveIdentityEncrypted(g, KEY);
    const hook = renderHook(() => useDependants(g.naturalPerson.publicKey, g.id, KEY));
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    let depId = '';
    await act(async () => {
      const dep = await hook.result.current.addDependant('Robin', undefined, { deviceDerive: async () => ({
        naturalPerson: { publicKey: '1'.repeat(64), privateKey: '' as const }, persona: { publicKey: '2'.repeat(64), privateKey: '' as const },
      }) });
      depId = dep.id;
    });
    const endpointPriv = bytesToHex(generateSecretKey());
    const endpointPub = getPublicKey(hexToBytes(endpointPriv));
    const clientPriv = bytesToHex(generateSecretKey());
    const clientPub = getPublicKey(hexToBytes(clientPriv));
    await act(async () => {
      await hook.result.current.mutateDependantRecord(depId, KEY, d => d && ({
        ...d, bunkerEndpoint: { publicKey: endpointPub, privateKey: endpointPriv, createdAt: 1, authorizedClientPubkey: clientPub },
      }));
    });
    const fresh = (await hook.result.current.loadFreshDependants(KEY)).find(d => d.id === depId)!;
    const notice = buildLegacyUnpairedNotice(fresh.bunkerEndpoint);
    expect(notice).not.toBeNull();
    const child: PairedChildRecord = {
      id: depId, bunkerUri: `bunker://${fresh.bunkerEndpoint!.publicKey}?relay=${encodeURIComponent(RELAY)}&secret=x`,
      clientKeypair: { publicKey: clientPub, privateKey: clientPriv }, dependantPubkey: depId, dependantName: 'Robin',
      pairedAt: Math.floor(Date.now() / 1000) - 60, hasPaired: true,
    };
    expect(acceptLegacyUnpairedNotice(notice!, child)).toBe(true);

    const backend = new LocalSigningBackend(clientPriv);
    try {
      const opened = await openChildContactReply(notice!, {
        scope: { guardian: g.naturalPerson.publicKey, child: depId, endpoint: endpointPub, client: clientPub, personas: ['2'.repeat(64)] },
        client: backend, now: Math.floor(Date.now() / 1000), isCurrent: () => true,
      });
      expect(opened).toBeNull();
    } finally { backend.destroy(); }
  }, 60_000);
});
