/**
 * NIP-46 connect approval: the outward effects, in order, each behind the
 * one-answer guard (AuthRequestSettlement, keyed per connect request).
 *
 * An approval can wait seconds for a device-held route and then walks the
 * relay candidates; the user can back out at any point. Every outward effect
 * is gated immediately before it runs (synchronous check, no await between
 * check and effect):
 *   - installing the transient serving route   → stillOpen()
 *   - arming the NIP-46 listener on a relay    → stillOpen()
 *   - persisting the connected-client record   → stillOpen()
 *   - publishing the connect response          → claim() (settles the request),
 *     taken at the last moment: the response is encrypted and signed through
 *     the signer first (for a device-held key that can take seconds — the
 *     routed connection opens, then two round trips), and only the relay
 *     publish itself sits behind the claim. A Cancel at any point before the
 *     publish therefore sends nothing.
 * If the request was withdrawn, denied or replaced, nothing further happens
 * and whatever this approval set up is undone: the route IT installed is
 * cleared (never a newer one for the same persona — App keys the route by an
 * install token) and the connected-client record is put back as it was
 * before this approval (an earlier pairing is restored, never deleted) —
 * only while the stored record is still the one this approval saved. A Cancel that
 * lands while the claimed send is in flight is honoured once it resolves
 * (finishDelivery): the pairing is undone and the route cleared, so the app
 * stops answering that client. A failed send hands the claim back (unclaim)
 * so the next relay can try.
 */
export interface ConnectDeliveryDeps<C> {
  relayCandidates: readonly string[];
  stillOpen: () => boolean;
  claim: () => boolean;
  unclaim: () => void;
  /** After a successful send: true ⇒ the user cancelled while it was in flight. */
  finishDelivery: () => boolean;
  installRoute: () => void;
  clearRoute: () => void;
  arm: (relayUrl: string) => Promise<void>;
  /** The connected-client record for this app as it was before this approval, if any. */
  loadExisting: () => Promise<C | undefined>;
  saveClient: (relayUrl: string) => Promise<void>;
  restoreClient: (previous: C) => Promise<void>;
  deleteClient: () => Promise<void>;
  /**
   * True while the stored record is still exactly the one THIS approval
   * saved (App compares a per-save nonce). A newer pairing for the same app,
   * a revocation, or any later rewrite makes it false, and the rollback then
   * leaves the record alone.
   */
  stillOurs: () => Promise<boolean>;
  /**
   * Encrypt + sign the connect response, then publish it. `beforePublish`
   * must be called immediately before the relay publish (and may be called
   * again after it); when it returns false the send must throw
   * ConnectWithdrawnError without publishing.
   */
  send: (relayUrl: string, beforePublish: () => boolean) => Promise<boolean>;
}

/** Thrown by a send whose request was withdrawn at the moment of publishing. */
export class ConnectWithdrawnError extends Error {
  constructor() { super('Connect request withdrawn before publishing.'); }
}

export type ConnectDeliveryResult =
  | { status: 'connected'; relayUrl: string }
  | { status: 'withdrawn' }
  | { status: 'cancelled' }
  | { status: 'failed'; failures: string[] };

export async function deliverConnectApproval<C>(d: ConnectDeliveryDeps<C>): Promise<ConnectDeliveryResult> {
  if (!d.stillOpen()) return { status: 'withdrawn' };
  const previous = await d.loadExisting().catch(() => undefined);
  if (!d.stillOpen()) return { status: 'withdrawn' };
  d.installRoute();

  // Put the record back exactly as it was before this approval — but only
  // if the stored record is still the one this approval wrote.
  const undoSave = async () => {
    if (!(await d.stillOurs().catch(() => false))) return;
    await (previous !== undefined ? d.restoreClient(previous) : d.deleteClient()).catch(() => {});
  };
  const withdraw = async (persisted: boolean): Promise<ConnectDeliveryResult> => {
    if (persisted) await undoSave();
    d.clearRoute();
    return { status: 'withdrawn' };
  };

  const failures: string[] = [];
  for (const relayUrl of d.relayCandidates) {
    let persisted = false;
    try {
      if (!d.stillOpen()) return await withdraw(false);
      await d.arm(relayUrl);
      if (!d.stillOpen()) return await withdraw(false);
      await d.saveClient(relayUrl);
      persisted = true;
      if (!d.stillOpen()) return await withdraw(true);
      let claimed = false;
      let withdrawnAtPublish = false;
      const beforePublish = () => {
        if (claimed) return true;
        claimed = d.claim();
        if (!claimed) withdrawnAtPublish = true;
        return claimed;
      };
      let ok = false;
      try {
        ok = await d.send(relayUrl, beforePublish);
      } catch (e) {
        if (withdrawnAtPublish || e instanceof ConnectWithdrawnError) return await withdraw(true);
        throw e;
      } finally {
        if (!ok && claimed) d.unclaim();
      }
      if (!ok) throw new Error(`Failed to send connect response via ${relayUrl}`);
      if (d.finishDelivery()) {
        // Cancelled while the response was in flight: undo the pairing and
        // stop serving that client, so it is not left connected.
        await undoSave();
        d.clearRoute();
        return { status: 'cancelled' };
      }
      return { status: 'connected', relayUrl };
    } catch (e) {
      failures.push(`${relayUrl}: ${e instanceof Error ? e.message : String(e)}`);
      if (persisted) await undoSave();
    }
  }
  return { status: 'failed', failures };
}
