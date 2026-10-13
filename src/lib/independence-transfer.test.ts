import { beforeEach, describe, expect, it } from 'vitest';
import type { ContactOperation, DependantIdentity } from '../types';
import type { NostrEvent } from 'signet-protocol';
import { createNewIdentity, deriveDependantIdentity } from './signet';
import { rememberDerivedKeysFor } from './crypto-store';
import { getDb, getDependants, listContactOperationsV2, purgeAllUserData, saveContactOperationV2, saveContactOperationsV2, saveDependant, saveIdentityEncrypted } from './db';
import { buildIndependenceTransfer, independenceTransferProblem, publishIndependenceMirror } from './independence-transfer';
import { closeIndependenceSource, independenceDirectoryMarker, independenceDraftWords, listIndependenceArchives, readIndependenceSource } from './independence-store';
import { contactsVaultAdapter } from './private-vault-contacts';
import { profilesVaultAdapter } from './private-vault-profiles';
import { localVaultBackend } from './private-vault';
import { readVaultHeads } from 'signet-protocol/experimental';
import { openVaultPayload } from './vault-envelope';
import { applyOperations } from './contacts-v2-reducer';

const KEY = '01'.repeat(32);
const NEW_WORDS = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const NOW = 1_800_000_000;
const CONTACT = '11'.repeat(16);
function fixture() {
  const guardian = createNewIdentity('Guardian', 'persona', false);
  const slots = deriveDependantIdentity(guardian.mnemonic, 'dependant-0');
  const dependant: DependantIdentity = { id: slots.persona.publicKey, guardianPubkey: guardian.naturalPerson.publicKey,
    displayName: 'Sam', naturalPerson: { ...slots.naturalPerson, displayName: '' },
    persona: { ...slots.persona, displayName: 'Sam' }, naturalPersonActive: false,
    primaryKeypair: 'persona', autonomyStage: 'full-control', derivationPath: 'dependant-0', createdAt: 1 };
  const op = (action: ContactOperation['action'], value: unknown, index: number): ContactOperation => ({
    operationId: index.toString(16).padStart(32, '0'), directoryId: `dependant:${dependant.id}`, contactId: CONTACT,
    actorPubkey: guardian.persona.publicKey, actorRole: 'guardian', actorDeviceId: 'ab'.repeat(16),
    logicalClock: index, action, value, createdAt: NOW * 1000 });
  const operations = [op('add', { type: 'person', displayName: 'Alex', tier: 'kin', ownerIdentityPubkey: dependant.persona.publicKey }, 1),
    op('add-identity', { itemId: '22'.repeat(16), pubkey: 'cc'.repeat(32), provenance: 'direct', verification: 'mutual',
      direct: { ownerPubkey: dependant.persona.publicKey, sharedSecret: 'de'.repeat(32), verifiedAt: 1 } }, 2),
    op('vouch', { guardianPubkey: guardian.persona.publicKey, tier: 'kin' }, 3),
    op('ceiling', { guardianPubkey: guardian.persona.publicKey, maxTier: 'ken' }, 4),
    op('block', { scope: { kind: 'contact' }, reason: 'Safety' }, 5), op('note', { note: 'Local name and note' }, 6)];
  const plan = () => buildIndependenceTransfer({ dependant, operations, mnemonic: NEW_WORDS,
    review: { [CONTACT]: { tier: 'kith', keepBlocked: true } }, deviceId: 'cd'.repeat(16), now: NOW * 1000 });
  const closure = { directoryId: `dependant:${dependant.id}`, dependantId: dependant.id,
    guardianPubkey: guardian.naturalPerson.publicKey, derivationPath: dependant.derivationPath, displayName: 'Sam',
    completedAt: NOW * 1000, choice: 'archive' as const };
  return { guardian, dependant, operations, plan, closure };
}
beforeEach(async () => { await purgeAllUserData(); rememberDerivedKeysFor(KEY); });

describe('independent directory mirror', () => {
  it('preserves names and lists, adopts reviewed trust and blocks, and requires new proofs', () => {
    const { plan, dependant } = fixture();
    const result = plan(), record = result.records[0];
    expect(record.directoryId).toBe('owner');
    expect(record.displayName).toBe('Alex'); expect(record.notes).toBe('Local name and note');
    expect(record.tier).toBe('kith'); expect(record.vouches).toEqual([]); expect(record.ceilings).toEqual([]);
    expect(record.blocks[0].blockedBy).toBe(result.identity.persona.publicKey);
    expect(record.identities[0]).toMatchObject({ pubkey: 'cc'.repeat(32), verification: 'unverified' });
    expect(record.identities[0].direct).toBeUndefined();
    expect(record.primaryIdentityPubkey).toBe(result.identity.persona.publicKey);
    expect(result.contacts).not.toContain(dependant.persona.privateKey);
    expect(result.contacts).not.toContain('de'.repeat(32));
    expect(result.profiles).not.toContain(NEW_WORDS);
    expect(result.identity.isChild).toBe(false); expect(result.identity.guardianPubkey).toBeUndefined();
  });

  it('requires every live contact to be reviewed and refuses mixed-family input', () => {
    const { dependant, operations } = fixture();
    const args = { dependant, operations, mnemonic: NEW_WORDS, review: {}, deviceId: 'cd'.repeat(16), now: NOW * 1000 };
    expect(() => buildIndependenceTransfer(args)).toThrow('Review every contact');
    expect(() => buildIndependenceTransfer({ ...args, operations: [{ ...operations[0], directoryId: 'owner' }] })).toThrow('Invalid source');
    expect(independenceTransferProblem({ ...dependant, childDevice: {} as DependantIdentity['childDevice'] })).toContain('Unpair');
  });

  it('reads both encrypted mirrors back and restores contacts through the ordinary new-phone adapters', async () => {
    const { plan } = fixture(), result = plan();
    const events = new Map<string, NostrEvent>();
    await publishIndependenceMirror({ ...result, encryptionKey: KEY, relays: ['wss://relay.example'], now: NOW,
      isCurrent: () => true, io: (_dataset, backend) => ({
        publish: async event => { events.set(event.id, event); return true; },
        reader: () => ({ checkpoints: async author => [...events.values()].filter(e => e.pubkey === author),
          chunk: async id => events.get(id) ?? null, open: (content, author) => openVaultPayload(content, backend, author, { legacyFallback: false }) }),
      }) });
    const restoredIdentity = { ...result.identity, persona: { ...result.identity.persona, displayName: '', displayNameUpdatedAt: 0 } };
    await saveIdentityEncrypted(restoredIdentity, KEY);
    for (const dataset of ['profiles', 'contacts:owner'] as const) {
      const backend = localVaultBackend(NEW_WORDS, dataset);
      try {
        const restored = await readVaultHeads({ checkpoints: async author => [...events.values()].filter(e => e.pubkey === author),
          chunk: async id => events.get(id) ?? null, open: (content, author) => openVaultPayload(content, backend, author, { legacyFallback: false }) },
        { author: backend.activePublicKeyHex, purpose: `signet:vault:${dataset}`, rotation: 0, now: NOW });
        expect(restored).toMatchObject({ state: 'ready' });
        if (restored.state !== 'ready') throw new Error('Recovery failed');
        const adapter = dataset === 'profiles' ? profilesVaultAdapter({ identityId: restoredIdentity.id,
          ownerPubkey: restoredIdentity.naturalPerson.publicKey, encryptionKey: KEY, mnemonic: NEW_WORDS,
          deviceHeldKeys: false, isCurrent: () => true }) : contactsVaultAdapter('owner', KEY, () => true);
        for (const snapshot of restored.snapshots) await adapter.merge(snapshot.plaintext, NOW);
      } finally { backend.destroy(); }
    }
    expect([...applyOperations(await listContactOperationsV2('owner', KEY)).values()]).toEqual(result.records);
  }, 30_000);

  it('refuses relay ACKs without restore and retains the source and retry words', async () => {
    const { dependant, operations, plan } = fixture();
    await saveDependant(dependant, KEY); await saveContactOperationsV2(operations, KEY);
    const words = await independenceDraftWords(dependant.id, KEY, () => true);
    expect(await independenceDraftWords(dependant.id, KEY, () => true)).toBe(words);
    await expect(publishIndependenceMirror({ ...plan(), encryptionKey: KEY, relays: ['wss://relay.example'], now: NOW,
      isCurrent: () => true, io: () => ({ publish: async () => true, reader: () => ({ checkpoints: async () => [], chunk: async () => null, open: async () => null }) }) }))
      .rejects.toThrow('could not be restored');
    expect(await getDependants(dependant.guardianPubkey, KEY)).toHaveLength(1);
    expect(await listContactOperationsV2(`dependant:${dependant.id}`, KEY)).toHaveLength(operations.length);
  }, 30_000);
});

describe('guardian cutover', () => {
  it('atomically archives and freezes the source and refuses stale identity or contact resurrection', async () => {
    const { dependant, operations, closure } = fixture();
    await saveDependant(dependant, KEY); await saveContactOperationsV2(operations, KEY);
    await independenceDraftWords(dependant.id, KEY, () => true);
    const source = await readIndependenceSource(dependant.guardianPubkey, dependant.id, KEY);
    await closeIndependenceSource({ closure, key: KEY, expectedFingerprint: source.fingerprint, isCurrent: () => true });
    expect(await getDependants(dependant.guardianPubkey, KEY)).toEqual([]);
    expect(await listContactOperationsV2(closure.directoryId, KEY)).toEqual([]);
    const archived = (await listIndependenceArchives(dependant.guardianPubkey, KEY))[0];
    expect(archived.contacts?.[0].displayName).toBe('Alex');
    const raw = await (await getDb()).get('privateVaultState', independenceDirectoryMarker(closure.directoryId));
    expect(JSON.stringify(raw)).not.toContain('Alex'); expect(JSON.stringify(raw)).not.toContain('Local name');
    await saveDependant(dependant, KEY);
    expect(await getDependants(dependant.guardianPubkey, KEY)).toEqual([]);
    await expect(saveContactOperationsV2(operations, KEY)).rejects.toThrow('read-only');
    await expect(saveContactOperationV2(operations[0], KEY)).rejects.toThrow('read-only');
    await expect(contactsVaultAdapter(closure.directoryId, KEY, () => true, dependant).merge(JSON.stringify({ v: 1 }), NOW)).rejects.toThrow('transferred');
  }, 30_000);

  it('refuses changed or unreadable source rows and deletes only the chosen family copy', async () => {
    const { dependant, operations, closure } = fixture();
    await saveDependant(dependant, KEY); await saveContactOperationsV2(operations, KEY);
    const source = await readIndependenceSource(dependant.guardianPubkey, dependant.id, KEY);
    await saveContactOperationsV2([{ ...operations[0], operationId: 'fe'.repeat(16), action: 'rename', value: { displayName: 'Edited' }, logicalClock: 50 }], KEY);
    await expect(closeIndependenceSource({ closure, key: KEY, expectedFingerprint: source.fingerprint, isCurrent: () => true })).rejects.toThrow('changed');
    expect(await getDependants(dependant.guardianPubkey, KEY)).toHaveLength(1);
    await saveContactOperationsV2([{ ...operations[0], directoryId: 'owner', operationId: 'fa'.repeat(16) }], KEY);
    await closeIndependenceSource({ closure: { ...closure, choice: 'delete' }, key: KEY, isCurrent: () => true });
    expect((await listIndependenceArchives(dependant.guardianPubkey, KEY))[0].contacts).toBeUndefined();
    expect(await listContactOperationsV2('owner', KEY)).toHaveLength(1);
  }, 30_000);

  it('does not transfer a log whose reader dropped a corrupt encrypted row', async () => {
    const { dependant, operations } = fixture();
    await saveDependant(dependant, KEY); await saveContactOperationsV2(operations, KEY);
    const db = await getDb();
    const row = await db.get('contactOpsV2', operations[0].operationId);
    await db.put('contactOpsV2', { ...row, encryptedData: 'broken ciphertext' });
    await expect(readIndependenceSource(dependant.guardianPubkey, dependant.id, KEY)).rejects.toThrow('could not be read');
  }, 30_000);

  it('propagates closure through the ordinary profiles vault and never restores stale dependant rows', async () => {
    const { guardian, dependant, operations, closure } = fixture();
    await saveIdentityEncrypted(guardian, KEY); await saveDependant(dependant, KEY); await saveContactOperationsV2(operations, KEY);
    const adapter = profilesVaultAdapter({ identityId: guardian.id, ownerPubkey: guardian.naturalPerson.publicKey,
      encryptionKey: KEY, mnemonic: guardian.mnemonic, deviceHeldKeys: false, isCurrent: () => true });
    const stale = await adapter.snapshot();
    await closeIndependenceSource({ closure, key: KEY, isCurrent: () => true });
    const completed = await adapter.snapshot();
    expect(JSON.parse(completed).independentDependants).toEqual([closure]);
    expect(completed).not.toContain('Local name and note');
    // Simulate another/new guardian installation with a stale identity copy.
    await purgeAllUserData(); rememberDerivedKeysFor(KEY);
    await saveIdentityEncrypted(guardian, KEY); await saveDependant(dependant, KEY); await saveContactOperationsV2(operations, KEY);
    await adapter.merge(completed, NOW);
    await adapter.merge(stale, NOW - 1);
    expect(await getDependants(guardian.naturalPerson.publicKey, KEY)).toEqual([]);
    expect(await listContactOperationsV2(closure.directoryId, KEY)).toEqual([]);
    expect((await listIndependenceArchives(guardian.naturalPerson.publicKey, KEY))[0].contacts?.[0].displayName).toBe('Alex');
  }, 30_000);
});
