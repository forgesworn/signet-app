/**
 * A `nostrconnect://` URI exactly as Bark builds it, so a change on either
 * side that breaks Bark → My Signet pairing fails here (signet-app-internal#194).
 *
 * Generated with Bark 1.3.18 (`forgesworn/bark` src/background.js
 * `buildNostrConnectRequest(DEFAULT_NOSTRCONNECT_RELAYS)`). The client key and
 * secret are throwaway values from that one run. To refresh after a Bark
 * release, run in the bark checkout:
 *
 *   node --input-type=module -e "const m = await import('./src/background.js');
 *     console.log(m.buildNostrConnectRequest(m.DEFAULT_NOSTRCONNECT_RELAYS).uri)"
 */
import { describe, expect, it } from 'vitest';
import { parseNostrConnectURI } from './nip46';
import { nip46PermissionAllows, parseNip46Permissions } from './nip46-permissions';
import { routeQR } from './qr-router';

const BARK_1_3_18_URI =
  'nostrconnect://36ba3bd61f9df7c012c1c321f93e1af0f9cfb460f3a7f9ae40f0f895c6f249b7'
  + '?relay=wss%3A%2F%2Frelay.nsec.app&secret=36aab26008e36fbaaa4aa93c24512cbe'
  + '&perms=get_public_key%2Cnip04_encrypt%2Cnip04_decrypt%2Cnip44_encrypt%2Cnip44_decrypt'
  + '%2Csign_event%3A0%2Csign_event%3A1%2Csign_event%3A3%2Csign_event%3A4%2Csign_event%3A5'
  + '%2Csign_event%3A6%2Csign_event%3A7%2Csign_event%3A1059%2Csign_event%3A9734%2Csign_event%3A9735'
  + '%2Csign_event%3A10002%2Csign_event%3A22242%2Csign_event%3A24133%2Csign_event%3A27117'
  + '%2Csign_event%3A27235%2Csign_event%3A30023%2Csign_event%3A30078%2Csign_event%3A30808'
  + '&name=Bark&url=https%3A%2F%2Fgithub.com%2Fforgesworn%2Fbark';

describe('Bark nostrconnect:// fixture', () => {
  it('parses into a connect request with Bark\'s name, URL, relay and secret', () => {
    const req = parseNostrConnectURI(BARK_1_3_18_URI);
    expect(req).not.toBeNull();
    expect(req!.clientPubkey).toBe('36ba3bd61f9df7c012c1c321f93e1af0f9cfb460f3a7f9ae40f0f895c6f249b7');
    expect(req!.relayUrl).toBe('wss://relay.nsec.app');
    expect(req!.relayUrls).toEqual(['wss://relay.nsec.app']);
    expect(req!.secret).toBe('36aab26008e36fbaaa4aa93c24512cbe');
    expect(req!.appName).toBe('Bark');
    // My Signet keeps only the origin of a client-supplied URL.
    expect(req!.appUrl).toBe('https://github.com');
  });

  it('keeps all 23 requested permissions, and every token is one the server accepts', () => {
    const req = parseNostrConnectURI(BARK_1_3_18_URI)!;
    expect(req.permissions).toHaveLength(23);
    expect(parseNip46Permissions(req.permissions!.join(','))).toEqual(req.permissions);
  });

  it('grants what Bark signs with and nothing it did not ask for', () => {
    const perms = parseNostrConnectURI(BARK_1_3_18_URI)!.permissions;
    for (const method of ['nip04_encrypt', 'nip04_decrypt', 'nip44_encrypt', 'nip44_decrypt']) {
      expect(nip46PermissionAllows(perms, method)).toBe(true);
    }
    for (const kind of [0, 1, 3, 7, 1059, 30023]) expect(nip46PermissionAllows(perms, 'sign_event', kind)).toBe(true);
    expect(nip46PermissionAllows(perms, 'sign_event', 30420)).toBe(false);
  });

  it('routes as a NostrConnect pairing when scanned', () => {
    expect(routeQR(BARK_1_3_18_URI).type).toBe('nostr-connect');
  });
});
