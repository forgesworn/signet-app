import { describe, expect, it } from 'vitest';
import { confirmKinterest, FAMILY_PURPOSE, isKinterestAuthority, KINTEREST_SCOPE, parseKinterestRequest } from './kinterest-authority';
import { parseNip55Request, planNip55 } from './nip55';
import type { UnsignedEvent } from 'signet-protocol';
const t: UnsignedEvent = { pubkey: 'a'.repeat(64), kind: 30078, created_at: 1756800000, content: FAMILY_PURPOSE,
  tags: [['d', `kin-jar/family-authorisation/v2/${'b'.repeat(64)}`], ['scope', KINTEREST_SCOPE], ['family', 'b'.repeat(64)], ['challenge', 'c'.repeat(64)], ['approval', 'request']] };
describe('reserved Kinterest consent ceremony', () => {
  it('recognises the namespace even when the request is malformed', () => {
    expect(isKinterestAuthority({ ...t, kind: 1 })).toBe(true);
    expect(parseKinterestRequest({ ...t, kind: 1 })).toBeNull();
  });
  it('refuses pre-confirmed and duplicate-tag requests', () => {
    expect(parseKinterestRequest(confirmKinterest(t))).toBeNull();
    expect(parseKinterestRequest({ ...t, tags: [...t.tags, ['family', 'b'.repeat(64)]] })).toBeNull();
    expect(() => confirmKinterest(confirmKinterest(t))).toThrow();
  });
  it('refuses the reserved ceremony through both NIP-55 paths even with a remembered grant', () => {
    const parsed = parseNip55Request({ id:'r',callerPackage:'example.test',type:'sign_event',payload:JSON.stringify(t),peerPubkey:null,currentUser:null,permissions:null,viaProvider:false });
    const grant = { pubkey:t.pubkey,allowAlways:true,denyAlways:false,grantedAt:0 };
    expect(planNip55(parsed,false,grant,[t.pubkey],t.pubkey).kind).toBe('reject');
    expect(planNip55(parsed,true,grant,[t.pubkey],t.pubkey).kind).toBe('reject');
  });
  it('changes the request to a confirmation only after interactive approval', () => {
    expect(parseKinterestRequest(t)?.familyPk).toBe('b'.repeat(64));
    expect(confirmKinterest(t).tags).toContainEqual(['approval', 'confirmed']);
  });
});
