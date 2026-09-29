/**
 * `nostrconnect://` on a direct-paired child (A40, child-direct spec §8.2).
 *
 * The connect response comes from the chosen persona's LOCAL transport key —
 * the same key the child's gated NIP-46 route already serves under — so
 * accepting a pairing costs no Heartwood round trip and never touches the
 * router. The app's later requests land on that existing gated route (every
 * sign / NIP-44 through the child's gate); no temporary, ungated route is
 * installed and no owner-route connected-client record is written.
 */
import type { BunkerRoute } from '../hooks/useBunkerServer';
import type { SigningBackend } from './signing-backend';
import { deliverConnectApproval, type ConnectDeliveryResult } from './connect-delivery';

/** The child's gated route serving `persona`, or null (dormant, unknown, not yet routed). */
export function childConnectRoute(routes: readonly BunkerRoute[], persona: string | null | undefined): BunkerRoute | null {
  const p = (persona ?? '').toLowerCase();
  if (!p) return null;
  return routes.find(r => !!r.childGate && r.signingBackend?.activePublicKeyHex.toLowerCase() === p) ?? null;
}

export interface ChildConnectDeps {
  route: BunkerRoute;
  relayCandidates: readonly string[];
  stillOpen: () => boolean;
  claim: () => boolean;
  unclaim: () => void;
  finishDelivery: () => boolean;
  /** Arm the NIP-46 listener for the route's transport pubkey on that relay. */
  arm: (routePubkey: string, relayUrl: string) => Promise<void>;
  /** Encrypt + sign the ack with `backend` (the transport key) and publish it. */
  send: (backend: SigningBackend, relayUrl: string, beforePublish: () => boolean) => Promise<boolean>;
  /** The app connected: note it on the gate's connected apps. */
  onConnected: () => void;
}

export async function deliverChildNostrConnect(d: ChildConnectDeps): Promise<ConnectDeliveryResult> {
  const transport = d.route.backend;
  const result = await deliverConnectApproval<never>({
    relayCandidates: d.relayCandidates,
    stillOpen: d.stillOpen,
    claim: d.claim,
    unclaim: d.unclaim,
    finishDelivery: d.finishDelivery,
    installRoute: () => { /* the gated persona route already serves this key */ },
    clearRoute: () => { /* nothing installed */ },
    arm: (relayUrl) => d.arm(d.route.pubkey, relayUrl),
    loadExisting: async () => undefined,
    saveClient: async () => { /* the gate decides per request; no owner record */ },
    restoreClient: async () => {},
    deleteClient: async () => {},
    stillOurs: async () => false,
    send: (relayUrl, beforePublish) => d.send(transport, relayUrl, beforePublish),
  });
  if (result.status === 'connected') {
    try { d.onConnected(); } catch { /* bookkeeping only */ }
  }
  return result;
}
