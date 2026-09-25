import { describe, it, expect } from 'vitest';
import {
  directoryIdForDependant,
  newContactId,
  newOperationId,
  newDeviceId,
  ensureContactsDeviceId,
  shouldMintContactsDeviceId,
  importContactId,
  importOperationId,
  importSourceKey,
} from './contacts-v2-ids';

const HEX32 = /^[0-9a-f]{32}$/;
const PK = 'ab'.repeat(32);

describe('directoryIdForDependant', () => {
  it('maps a tree-derived dependant to dependant:<lowercased id>', () => {
    expect(directoryIdForDependant({ id: PK })).toBe(`dependant:${PK}`);
    expect(directoryIdForDependant({ id: PK.toUpperCase() })).toBe(`dependant:${PK}`);
  });

  it('maps an imported dependant by the same rule — no separate pk: form', () => {
    // Imported dependants have no derivation index; the id itself is the
    // stable key, so they resolve through the identical rule as tree-derived
    // ones — this is what lets a paired-child device (which also has no
    // derivation index) compute the same directory id as the guardian.
    expect(directoryIdForDependant({ id: PK })).toBe(`dependant:${PK}`);
  });
});

describe('random ids', () => {
  it('mints 32-hex ids that differ between calls', () => {
    const a = newContactId();
    const b = newContactId();
    expect(a).toMatch(HEX32);
    expect(b).toMatch(HEX32);
    expect(a).not.toBe(b);
    expect(newOperationId()).toMatch(HEX32);
    expect(newDeviceId()).toMatch(HEX32);
  });

  it('keeps a valid stored device id and replaces a malformed one', () => {
    const stored = 'c'.repeat(32);
    expect(ensureContactsDeviceId(stored)).toBe(stored);
    expect(ensureContactsDeviceId(undefined)).toMatch(HEX32);
    expect(ensureContactsDeviceId('not-hex')).toMatch(HEX32);
  });
});

describe('shouldMintContactsDeviceId', () => {
  it('mints only once preferences have loaded, the key is present, and no id is stored yet', () => {
    expect(shouldMintContactsDeviceId({ prefsLoading: false, encryptionKey: 'key', contactsDeviceId: undefined })).toBe(true);
  });

  it('never mints while preferences are still loading — the bare-default snapshot must not be saved', () => {
    expect(shouldMintContactsDeviceId({ prefsLoading: true, encryptionKey: 'key', contactsDeviceId: undefined })).toBe(false);
  });

  it('never mints without an unlock key', () => {
    expect(shouldMintContactsDeviceId({ prefsLoading: false, encryptionKey: null, contactsDeviceId: undefined })).toBe(false);
  });

  it('never re-mints once a device id is already stored', () => {
    expect(shouldMintContactsDeviceId({ prefsLoading: false, encryptionKey: 'key', contactsDeviceId: 'd'.repeat(32) })).toBe(false);
  });

  it('is false when both loading and locked at once', () => {
    expect(shouldMintContactsDeviceId({ prefsLoading: true, encryptionKey: null, contactsDeviceId: undefined })).toBe(false);
  });
});

describe('deterministic import ids', () => {
  it('derives the same contact id for the same directory and pubkey', () => {
    expect(importContactId('owner', PK)).toBe(importContactId('owner', PK));
    expect(importContactId('owner', PK)).toMatch(HEX32);
  });

  it('separates directories, record classes and field groups', () => {
    expect(importContactId('owner', PK)).not.toBe(importContactId('dependant:0', PK));
    expect(importOperationId('owner', 'contact', PK, 'add')).not.toBe(
      importOperationId('owner', 'ken', PK, 'add'),
    );
    expect(importOperationId('owner', 'contact', PK, 'add')).not.toBe(
      importOperationId('owner', 'contact', PK, 'identity'),
    );
    expect(importOperationId('owner', 'contact', PK, 'add')).toMatch(HEX32);
  });

  it('builds a source key from record class and pubkey', () => {
    expect(importSourceKey('contact', PK)).toBe(`contact:${PK}`);
    expect(importSourceKey('ken', PK)).toBe(`ken:${PK}`);
  });
});
