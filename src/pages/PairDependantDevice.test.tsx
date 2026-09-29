// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex } from '@noble/hashes/utils.js';

vi.mock('../components/QRCode', () => ({ QRCode: ({ data }: { data: string }) => <div data-testid="qr" data-uri={data} /> }));
vi.mock('../lib/heartwood-mgmt', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/heartwood-mgmt')>();
  return { ...actual, listClients: vi.fn(), nostrconnectV2: vi.fn(), revokeClient: vi.fn() };
});

import { listClients, type HeartwoodMgmtClient } from '../lib/heartwood-mgmt';
import { buildPersonaFirstDependant } from '../lib/dependant-record';
import { buildChildPairRequestEvent, pairCheckWords, parseChildPairUri } from '../lib/child-pair-wire';
import { CHILD_DEVICE_COPY } from '../lib/child-device-copy';
import type { DependantIdentity } from '../types';
import type { NostrEvent } from 'signet-protocol';
import type { PairingTransport } from '../hooks/useChildDevicePairing';
import { PairDependantDevice } from './PairDependantDevice';

const mList = vi.mocked(listClients);
const HW = 'wss://hw.example.com', RAIL = 'wss://rail.example.com';

function makeDep(derivationPath = 'dependant-0'): DependantIdentity {
  return buildPersonaFirstDependant({
    guardianPubkey: 'f'.repeat(64), enteredName: 'Lily', derivationPath,
    naturalPerson: { publicKey: getPublicKey(generateSecretKey()), privateKey: '' },
    persona: { publicKey: getPublicKey(generateSecretKey()), privateKey: '' }, createdAt: 1,
  });
}

class FakeTransport implements PairingTransport {
  handlers: ((ev: NostrEvent) => void)[] = [];
  subscribe(_f: unknown[], _r: string[], on: (ev: NostrEvent) => void) { this.handlers.push(on); return () => { this.handlers = []; }; }
  async publish() { return { ok: true, message: '' }; }
}

let t: FakeTransport;
function renderPage(dep: DependantIdentity, over: { signingMode?: string; operator?: HeartwoodMgmtClient | null; onOpenOperatorImport?: () => void } = {}) {
  let current = dep;
  const props = {
    dependant: dep, relayUrl: RAIL, bunkerServerEnabled: false,
    ensureDependantBunkerEndpoint: vi.fn(), clearDependantBunkerEndpoint: vi.fn(), saveDependantPairingSecret: vi.fn(),
    requestAuth: vi.fn(async () => 'k'.repeat(64)), onBack: vi.fn(), signingMode: over.signingMode ?? 'bunker',
    direct: {
      operator: over.operator === undefined ? ({ isOpen: true } as unknown as HeartwoodMgmtClient) : over.operator,
      operatorStatus: { capabilities: ['pairing_identity_v1'], masterNpubHex: 'e'.repeat(64), truncated: false },
      guardianNpPubkey: 'f'.repeat(64), railRelay: RAIL, hwRelays: [HW], encryptionKey: 'k'.repeat(64), grants: [],
      onDependantUpdated: vi.fn(async (d: DependantIdentity) => { current = d; }), transport: t,
      onOpenOperatorImport: over.onOpenOperatorImport,
    },
  };
  const r = render(<PairDependantDevice {...props} />);
  return { ...r, props, current: () => current };
}

beforeEach(() => {
  t = new FakeTransport();
  mList.mockReset();
  mList.mockResolvedValue([]);
});

describe('PairDependantDevice — flow choice', () => {
  it('an imported dependant keeps the legacy phone-served flow', () => {
    renderPage(makeDep('imported'));
    expect(screen.getByText('The Bunker is off')).toBeTruthy();
  });
  it('a guardian not on a Heartwood keeps the legacy flow', () => {
    renderPage(makeDep(), { signingMode: 'local' });
    expect(screen.getByText('The Bunker is off')).toBeTruthy();
  });
});

describe('PairDependantDevice — child-direct', () => {
  it('no operator key → explains and links to the import card', async () => {
    const onOpen = vi.fn();
    renderPage(makeDep(), { operator: null, onOpenOperatorImport: onOpen });
    await screen.findByText(CHILD_DEVICE_COPY.blocked['no-operator-key'].heading);
    expect(screen.queryByTestId('qr')).toBeNull();
    fireEvent.click(screen.getByText(CHILD_DEVICE_COPY.blocked['no-operator-key'].action));
    expect(onOpen).toHaveBeenCalled();
  });

  it('renders a QR with a parsable signet-child URI, then the check words on a request', async () => {
    const r = renderPage(makeDep());
    const qr = await screen.findByTestId('qr');
    const uri = qr.getAttribute('data-uri')!;
    const offer = parseChildPairUri(uri, Math.floor(Date.now() / 1000))!;
    expect(offer).not.toBeNull();
    expect(offer.rail).toBe(r.current().bunkerEndpoint!.publicKey);
    const sk = generateSecretKey(), pub = getPublicKey(sk);
    const nowS = Math.floor(Date.now() / 1000);
    const ev = await buildChildPairRequestEvent({ v: 1, code: offer.code, clientPubkey: pub, createdAt: nowS,
      nostrconnect: `nostrconnect://${pub}?relay=${encodeURIComponent(HW)}&secret=s3cr3t` }, bytesToHex(sk), offer.rail);
    t.handlers.forEach(h => h(ev));
    await screen.findByText(CHILD_DEVICE_COPY.confirmMatch);
    const words = pairCheckWords(offer.code, pub);
    await waitFor(() => expect(screen.getByTestId('pair-check-words').textContent).toBe(words.join('')));
    expect(screen.getByText(CHILD_DEVICE_COPY.confirmNoMatch)).toBeTruthy();
  });

  it('an already paired phone shows its status and an unpair action', async () => {
    const dep = { ...makeDep(), childDevice: { mode: 'heartwood-direct' as const, slotLabel: 'l', secretFingerprint: 'ab', slotIndex: 1,
      clientPubkey: 'a'.repeat(64), boundPersona: 'b'.repeat(64), pairedAt: 1 } };
    renderPage(dep);
    expect(await screen.findByText(CHILD_DEVICE_COPY.pairedAlready('Lily'))).toBeTruthy();
    expect(screen.getByText(CHILD_DEVICE_COPY.unpair)).toBeTruthy();
    expect(screen.queryByTestId('qr')).toBeNull();
  });
});
