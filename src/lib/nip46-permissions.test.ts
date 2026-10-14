import { describe, expect, it } from 'vitest';
import { parseNip46Permissions, nip46PermissionAllows } from './nip46-permissions';
import { buildConnectedClientFromNostrConnect, parseNostrConnectURI } from './nip46';

const perms = ['sign_event:30420', 'sign_event:5'];
const uri = 'nostrconnect://' + 'a'.repeat(64) + '?relay=wss%3A%2F%2Frelay.example&secret=12345678&perms=';
describe('explicit NIP-46 permission ceilings', () => {
  it('parses, displays and persists exact requested kinds', () => {
    const req = parseNostrConnectURI(uri + encodeURIComponent(perms.join(',')))!;
    expect(req.permissions).toEqual(perms);
    expect(buildConnectedClientFromNostrConnect(req).permissions).toEqual(perms);
    expect(nip46PermissionAllows(perms, 'sign_event', 30420)).toBe(true);
    expect(nip46PermissionAllows(perms, 'sign_event', 5)).toBe(true);
    for (const kind of [0, 1, 13, 21236, 24133]) expect(nip46PermissionAllows(perms, 'sign_event', kind)).toBe(false);
    for (const method of ['nip44_encrypt', 'nip44_decrypt', 'nip04_encrypt', 'nip04_decrypt']) expect(nip46PermissionAllows(perms, method)).toBe(false);
  });
  it.each(['', 'sign_event:65536', 'sign_event:05', 'sign_event:-1', 'sign_event:5:1', 'nip44_encrypt:5', 'unknown', 'sign_event,', 'a'.repeat(1025)])('rejects malformed or unknown requested rights: %s', raw => {
    expect(parseNip46Permissions(raw)).toBeNull();
    expect(parseNostrConnectURI(uri + encodeURIComponent(raw))).toBeNull();
  });
  it('rejects duplicate permission params and corrupt persisted scopes', () => {
    expect(parseNostrConnectURI(uri + 'sign_event:5&perms=sign_event')).toBeNull();
    expect(nip46PermissionAllows([], 'sign_event', 5)).toBe(false);
    expect(nip46PermissionAllows(['unknown'], 'nip44_encrypt')).toBe(false);
    expect(nip46PermissionAllows(perms, 'sign_event')).toBe(false);
  });
  it('preserves legacy clients and supports exact crypto scopes', () => {
    expect(nip46PermissionAllows(undefined, 'sign_event', 1)).toBe(true);
    expect(nip46PermissionAllows(['nip44_encrypt'], 'nip44_encrypt')).toBe(true);
    expect(nip46PermissionAllows(['nip44_encrypt'], 'nip44_decrypt')).toBe(false);
  });
});
