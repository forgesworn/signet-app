/**
 * One answer per sign-in request.
 *
 * An approval can take seconds (a routed NIP-46 round trip to the signer, an
 * unlock, a reconnect wait) and Deny / Back stay reachable meanwhile. Without
 * a synchronous guard, a Deny tapped mid-approval sends `error=denied` and the
 * approval then completes and sends a signature — two contradictory answers
 * to the same consumer. React state cannot be that guard: a `set*(null)` is
 * not visible to a running handler until a render commits it.
 *
 * Keyed by request identity (requestId + challenge; a per-object nonce for a
 * request carrying neither), all transitions are synchronous:
 *   open ──beginApproval──▶ in-flight ──claimDelivery──▶ settled
 *     │                        │  └─endApproval (failed, undelivered)──▶ open
 *     │                        └─deny (explicit Cancel/Deny takes over)──▶ settled
 *     └──deny──▶ settled
 * An explicit denial may take over an in-flight approval (the approval's
 * later claimDelivery then fails, so there is still exactly one answer); an
 * approval cannot start on a settled request, and only an in-flight approval
 * can deliver. A request that is already answered can still be dismissed —
 * the caller clears it without sending anything.
 */
export interface AuthRequestIdentity {
  requestId?: string;
  challenge?: string;
}

const nonces = new WeakMap<object, string>();
let nonceSeq = 0;

/** A stable per-object key for a request that has no ids (e.g. a NIP-46 connect request). */
export function requestObjectKey(request: object): string {
  let nonce = nonces.get(request);
  if (!nonce) {
    nonce = `#${++nonceSeq}`;
    nonces.set(request, nonce);
  }
  return nonce;
}

export function authRequestKey(request: AuthRequestIdentity): string {
  if (request.requestId || request.challenge) {
    return `${request.requestId ?? ''}:${request.challenge ?? ''}`;
  }
  // Nothing identifies it: give this request object its own key, so unrelated
  // id-less requests never share one settlement.
  return requestObjectKey(request);
}

export type BeginApprovalResult = 'ok' | 'in-flight' | 'settled';

export class AuthRequestSettlement {
  private readonly state = new Map<string, 'in-flight' | 'settled'>();
  /** Claimed, and the delivery it was claimed for has not finished yet. */
  private readonly delivering = new Set<string>();
  /** An explicit cancel landed while a claimed delivery was still running. */
  private readonly cancelRequested = new Set<string>();

  beginApproval(key: string): BeginApprovalResult {
    const s = this.state.get(key);
    if (s) return s;
    this.state.set(key, 'in-flight');
    return 'ok';
  }

  /** An approval ended. If it never delivered, the request is open again (retry or deny). */
  endApproval(key: string): void {
    if (this.state.get(key) === 'in-flight') this.state.delete(key);
    this.delivering.delete(key);
    this.cancelRequested.delete(key);
  }

  /** Claim the one delivery for an in-flight approval. False ⇒ deliver nothing. */
  claimDelivery(key: string): boolean {
    if (this.state.get(key) !== 'in-flight') return false;
    this.state.set(key, 'settled');
    this.delivering.add(key);
    return true;
  }

  /**
   * An explicit cancel that found the request already claimed: if that
   * claimed delivery is still running, remember the cancel so the approval
   * undoes what it set up once the delivery resolves. True ⇒ recorded.
   */
  requestCancelDuringDelivery(key: string): boolean {
    if (!this.delivering.has(key)) return false;
    this.cancelRequested.add(key);
    return true;
  }

  /** The claimed delivery finished. True ⇒ the user cancelled meanwhile: undo it. */
  finishDelivery(key: string): boolean {
    this.delivering.delete(key);
    const cancelled = this.cancelRequested.has(key);
    this.cancelRequested.delete(key);
    return cancelled;
  }

  /**
   * Hand a claimed delivery back (the send it was taken for failed), so the
   * same in-flight approval can try again — e.g. the next relay candidate.
   */
  unclaimDelivery(key: string): void {
    this.delivering.delete(key);
    if (this.state.get(key) === 'settled') this.state.set(key, 'in-flight');
  }

  /**
   * Answer with a denial. 'denied' ⇒ send the denial. 'took-over' ⇒ an
   * approval was in flight; it is now settled as denied (send the denial; the
   * approval will deliver nothing). 'already-answered' ⇒ send nothing, just
   * dismiss the request.
   */
  deny(key: string): 'denied' | 'took-over' | 'already-answered' {
    const s = this.state.get(key);
    if (s === 'settled') return 'already-answered';
    this.state.set(key, 'settled');
    return s === 'in-flight' ? 'took-over' : 'denied';
  }

  isInFlight(key: string): boolean {
    return this.state.get(key) === 'in-flight';
  }
}
