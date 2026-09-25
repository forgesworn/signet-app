import { assertContactMailboxCapacity } from './contact-invite-limits';
import { contactExchangeKey } from './contact-exchange-key';
import { randomBytes, bytesToHex } from '@noble/hashes/utils.js';
import { createContactRequest, beginContactExchange, acceptContactExchange, receiveContactAcceptance,
  receiveContactReveal, confirmContactRevealSent, parseContactInvite, contactVerificationWords, CONTACT_SENDER_PENDING_LIMIT } from '@forgesworn/signet-contacts';
import type { ContactIdentityDecryptBudget, ContactInvite, ContactExchangeState } from '@forgesworn/signet-contacts';
import { wrapContactExchange, openContactIdentityPacket } from '@forgesworn/signet-contacts/adapters/invite-nostr-tools';
import type { ContactIdentitySigner } from '@forgesworn/signet-contacts/adapters/invite-nostr-tools';
import { compactContactInviteVault, conflictedContactExchanges, createStoredContactInvite, isChildContactExchange, loadContactInviteVault, updateContactInviteVault } from './contact-invite-store';
import type { ContactInviteVault, ContactInviteOutbox, StoredContactExchange, ContactInviteAppOrigin, ChildExchangePairing } from './contact-invite-store';
export type ChildExchangeCancelReason = 'repair' | 'expired' | 'withdrawn';
import { publishToRelays } from './sync-relays';
import type { NostrEvent } from 'signet-protocol';

/** Calls never publish before their encrypted state/outbox has been persisted. */
export class ContactInviteService {
  constructor(private options: {
    directoryId: string; encryptionKey: string; budget: ContactIdentityDecryptBudget;
    signer(pubkey: string): Promise<ContactIdentitySigner>; isCurrent(): boolean; onChanged(): void;
    /** Enforce dependant policy before either sending or accepting. */
    mayConnect(peer: string): boolean | Promise<boolean>;
    /** Keep an opened request pending for guardian review without connecting. */
    mayReceive?(peer: string): boolean | Promise<boolean>;
    appAllowed?(app: ContactInviteAppOrigin, identity: string, action: 'create' | 'receive', automatic: boolean): Promise<boolean>;
    automaticAttempts?: Set<string>;
    onCompleted?(exchange: StoredContactExchange): Promise<string>;
    /** Dependant directories only (D5): the dependant's live pairing, or null
     * when it is no longer paired. Throw when the session itself changed. */
    childPairing?(): Promise<ChildExchangePairing | null>;
    /** Called after a child exchange is declined: `repair` (stale pairing, no
     * reply), `expired` (peer never answered), `withdrawn` (request no longer
     * approved). Must be idempotent; a withdrawn complete row can repeat. */
    onChildExchangeCancelled?(exchange: StoredContactExchange, reason: ChildExchangeCancelReason): Promise<void>;
    /** Whether the child request behind a current-pairing exchange lets it
     * publish or record: `go` only when the plan is approved and the receipt
     * approved or completed; `wait` while the receipt is still pending. */
    childAuthority?(exchange: StoredContactExchange): Promise<'go' | 'wait' | 'withdraw'>;
  }) {}
  /** Child exchanges whose stamp no longer matches the live pairing. An
   * unstamped child row always counts as mismatched. */
  private async staleChildExchanges(exchanges: StoredContactExchange[]): Promise<Set<string>> {
    const stale = new Set<string>();
    if (!this.options.childPairing) return stale;
    const children = exchanges.filter(isChildContactExchange);
    if (!children.length) return stale;
    const live = await this.options.childPairing(); this.check();
    for (const exchange of children) {
      if (!exchange.pairing || !live || exchange.pairing.endpoint !== live.endpoint || exchange.pairing.client !== live.client)
        stale.add(contactExchangeKey(exchange.request));
    }
    return stale;
  }
  /** Guard every child exchange before anything publishes or records.
   * `blocked` must not publish or record; `retired` replies may be dismissed.
   * Stale pairings are declined and reported (D5); an exchange whose request is
   * no longer approved is withdrawn; an expired one is reported before
   * compaction declines it, so its approved request can settle. */
  private async guardChildExchanges(now?: number): Promise<{ blocked: Set<string>; retired: Set<string> }> {
    const state = await this.read();
    const stale = await this.staleChildExchanges(state.exchanges);
    const blocked = new Set(stale), retired = new Set(stale);
    if (stale.size) {
      const reported = state.exchanges.filter(e => stale.has(contactExchangeKey(e.request)) && e.phase !== 'declined'
        && !(e.phase === 'complete' && e.contactId));
      await this.update(fresh => ({ ...fresh, exchanges: fresh.exchanges.map(e => stale.has(contactExchangeKey(e.request)) && e.phase !== 'complete'
        ? { ...e, phase: 'declined' } : e) }));
      for (const exchange of reported) { this.check(); await this.options.onChildExchangeCancelled?.(exchange, 'repair'); }
    }
    if (!this.options.childAuthority) return { blocked, retired };
    for (const exchange of state.exchanges.filter(isChildContactExchange)) {
      const key = contactExchangeKey(exchange.request);
      if (stale.has(key) || exchange.phase === 'declined') { if (exchange.phase === 'declined') retired.add(key); continue; }
      // A recorded contact with nothing left to record needs no authority.
      if (exchange.phase === 'complete' && exchange.contactId && (!exchange.wordsConfirmedAt || exchange.wordsRecordedAt === exchange.wordsConfirmedAt)) continue;
      if (exchange.phase !== 'complete' && now !== undefined && exchange.request.expiresAt <= now) {
        blocked.add(key); retired.add(key);
        // Report first: a failed report is retried next cycle, not lost.
        await this.options.onChildExchangeCancelled?.(exchange, 'expired'); await this.cancel(key);
        continue;
      }
      const verdict = await this.options.childAuthority(exchange); this.check();
      if (verdict === 'go') continue;
      blocked.add(key);
      if (verdict === 'withdraw') {
        retired.add(key);
        if (exchange.phase !== 'complete') await this.cancel(key);
        await this.options.onChildExchangeCancelled?.(exchange, 'withdrawn');
      }
    }
    return { blocked, retired };
  }
  /** Beforehand check for a single child exchange at publication time. */
  private async childMayProceed(exchange: StoredContactExchange): Promise<boolean> {
    if (!isChildContactExchange(exchange) || !this.options.childPairing) return true;
    if ((await this.staleChildExchanges([exchange])).size) return false;
    return !this.options.childAuthority || await this.options.childAuthority(exchange) === 'go';
  }
  private check() { if (!this.options.isCurrent()) throw new Error('Contact invite session changed'); }
  async read(): Promise<ContactInviteVault> { this.check(); return loadContactInviteVault(this.options.directoryId, this.options.encryptionKey); }
  private async update(change: (state: ContactInviteVault) => ContactInviteVault) {
    this.check();
    let changed = false;
    const value = await updateContactInviteVault(this.options.directoryId, this.options.encryptionKey, state => {
      this.check(); const next = change(state); changed = JSON.stringify(next) !== JSON.stringify(state); return next;
    });
    this.check(); if (changed) this.options.onChanged(); return value;
  }
  async cleanup(now?: number) {
    await this.guardChildExchanges(now);
    await this.update(state => compactContactInviteVault(state, now));
  }
  async create(identityPubkey: string, name: string, relays: string[], mode: 'standing' | 'single-use', now: number, expiresAt?: number, caption?: string, intendedPubkey?: string) {
    await this.cleanup(now);
    const row = createStoredContactInvite({ identityPubkey, name, relays, mode, now, expiresAt, caption, intendedPubkey });
    await this.update(state => {
      assertContactMailboxCapacity(state, identityPubkey, now, row.invite.relays, 'invite');
      return { ...state, invites: [...state.invites, row] };
    });
    return row;
  }
  /** Idempotent issuance for an authenticated app request. The caller checks its grant. */
  async issueAppInvite(identityPubkey: string, relays: string[], mode: 'single-use' | 'standing', now: number, app: ContactInviteAppOrigin) {
    await this.cleanup(now);
    const row = { ...createStoredContactInvite({ identityPubkey, name: `via ${app.appName}`.slice(0, 100), relays, mode, now,
      expiresAt: mode === 'single-use' ? now + 30 * 86400 : undefined }), app };
    const state = await this.update(state => {
      const old = state.invites.find(i => i.app?.grantId === app.grantId && i.app.requestId === app.requestId);
      if (old) {
        if (old.app!.requestHash !== app.requestHash || old.identityPubkey !== identityPubkey) throw new Error('App request changed');
        return state;
      }
      if (state.invites.filter(i => i.app?.grantId === app.grantId).length + state.exchanges.filter(e => e.app?.grantId === app.grantId).length >= 500) throw new Error('This app has reached its introduction limit');
      assertContactMailboxCapacity(state, identityPubkey, now, relays, 'invite');
      return { ...state, invites: [...state.invites, row] };
    });
    return state.invites.find(i => i.app?.grantId === app.grantId && i.app.requestId === app.requestId)!;
  }
  async disableAppInvites(grantId: string, now: number) {
    await this.update(state => ({ ...state, invites: state.invites.map(i => i.app?.grantId === grantId && i.enabled
      ? { ...i, enabled: false, updatedAt: Math.max(now, i.updatedAt + 1) } : i) }));
  }
  async setEnabled(id: string, enabled: boolean, now: number) {
    const invite = (await this.read()).invites.find(row => row.id === id);
    if (enabled && invite?.app && !await this.options.appAllowed?.(invite.app, invite.identityPubkey, 'create', false)) throw new Error('This app no longer has invitation permission');
    await this.update(state => {
      const row = state.invites.find(invite => invite.id === id);
      if (enabled && row && !row.enabled) {
        if ((row.invite.expiresAt !== undefined && row.invite.expiresAt <= now)
          || (row.mode === 'single-use' && state.arrivals.some(a => a.inviteId === id))) throw new Error('Create a new invite after this one expires or is used.');
        assertContactMailboxCapacity(state, row.identityPubkey, now, row.invite.relays, 'invite');
      }
      return { ...state, invites: state.invites.map(i => i.id === id
        ? { ...i, enabled, updatedAt: Math.max(now, i.updatedAt + 1) } : i) };
    });
  }
  async request(identityPubkey: string, invite: ContactInvite, now: number, app?: ContactInviteAppOrigin) {
    await this.cleanup(now);
    if (app) {
      if (!await this.options.appAllowed?.(app, identityPubkey, 'receive', false)) throw new Error('App invitation permission ended');
      const old = (await this.read()).exchanges.find(e => e.app?.grantId === app.grantId && e.app.requestId === app.requestId);
      if (old) {
        if (old.app!.requestHash !== app.requestHash) throw new Error('App request changed');
        return;
      }
    }
    const parsed = parseContactInvite(JSON.stringify(invite), now);
    if (!parsed || !await this.options.mayConnect(parsed.recipient)) throw new Error('This contact is not allowed by the contact policy');
    assertContactMailboxCapacity(await this.read(), identityPubkey, now, parsed.relays, 'exchange');
    if (app && this.options.automaticAttempts) {
      const attempt = `request:${this.options.directoryId}:${identityPubkey}:${app.grantId}:${app.requestId}`;
      if (this.options.automaticAttempts.has(attempt)) throw new Error('App handover already attempted during this unlock');
      if (this.options.automaticAttempts.size >= 512) throw new Error('Unlock again to receive more app invitations');
      // Reserve before asking a hardware signer. Relay polling may retry an
      // acknowledgement, but must not repeat a refused signing prompt.
      this.options.automaticAttempts.add(attempt);
    }
    const nonce = bytesToHex(randomBytes(32));
    const request = createContactRequest({ id: bytesToHex(randomBytes(16)), from: identityPubkey, to: parsed.recipient,
      nonce, reply: { secret: bytesToHex(randomBytes(32)), relays: parsed.relays }, now,
      expiresAt: Math.min(now + 30 * 86400, parsed.expiresAt ?? Infinity) });
    const signer = await this.options.signer(identityPubkey); this.check();
    const event = await wrapContactExchange(request, parsed.secret, signer); this.check();
    if (!await this.options.mayConnect(parsed.recipient)) throw new Error('The contact policy changed');
    if (app && !await this.options.appAllowed?.(app, identityPubkey, 'receive', false)) throw new Error('App invitation permission ended');
    const exchange: StoredContactExchange = { ...beginContactExchange(request, nonce), ...(app ? { app } : {}), origin: { id: contactExchangeKey(request), ownerIdentityPubkey: identityPubkey, method: app ? 'app' : 'link', addedAt: now * 1000, ...(app ? { appName: app.appName } : {}), ...(parsed.caption ? { caption: parsed.caption } : {}) } };
    await this.update(state => {
      if (app) {
        const old = state.exchanges.find(e => e.app?.grantId === app.grantId && e.app.requestId === app.requestId);
        if (old) {
          if (old.app!.requestHash !== app.requestHash) throw new Error('App request changed');
          return state;
        }
        if (state.invites.filter(i => i.app?.grantId === app.grantId).length + state.exchanges.filter(e => e.app?.grantId === app.grantId).length >= 500) throw new Error('This app has reached its introduction limit');
      }
      assertContactMailboxCapacity(state, identityPubkey, now, parsed.relays, 'exchange');
      return { ...state, exchanges: [...state.exchanges, exchange],
        outbox: [...state.outbox, { id: event.id, identityPubkey, event, relays: parsed.relays, exchangeId: contactExchangeKey(request), messageType: 'request' }] };
    });
  }
  /** Child-managed exchange entry point. The caller has already persisted a
   * pairing-bound plan; this method keeps its request id/nonce/reply secret
   * stable and returns the exact signed outbox event for guarded delivery. */
  async requestChildPlan(args: { identityPubkey: string; exchangeId: string; nonce: string; replySecret: string; invite: ContactInvite; now: number; pairing: ChildExchangePairing }): Promise<NostrEvent> {
    if (!/^[0-9a-f]{32}$/.test(args.exchangeId) || !/^[0-9a-f]{64}$/.test(args.nonce) || !/^[0-9a-f]{64}$/.test(args.replySecret)
      || !/^[0-9a-f]{64}$/.test(args.pairing?.endpoint ?? '') || !/^[0-9a-f]{64}$/.test(args.pairing?.client ?? '')) throw new Error('Invalid child exchange plan');
    const pairing: ChildExchangePairing = { endpoint: args.pairing.endpoint, client: args.pairing.client };
    const livePairing = async () => {
      const live = await this.options.childPairing?.(); this.check();
      if (!live || live.endpoint !== pairing.endpoint || live.client !== pairing.client) throw new Error('The child pairing changed');
    };
    await livePairing();
    await this.cleanup(args.now);
    const parsed = parseContactInvite(JSON.stringify(args.invite), args.now);
    if (!parsed || !await this.options.mayConnect(parsed.recipient)) throw new Error('This contact is not allowed by the contact policy');
    const storageId = contactExchangeKey({ id: args.exchangeId, from: args.identityPubkey, to: parsed.recipient });
    const existing = (await this.read()).exchanges.find(e => contactExchangeKey(e.request) === storageId);
    if (existing) {
      if (JSON.stringify(existing.pairing) !== JSON.stringify(pairing)) throw new Error('The child pairing changed');
      const outbox = (await this.read()).outbox.find(row => row.exchangeId === storageId && row.messageType === 'request');
      if (!outbox) throw new Error('Child exchange exists without its request event');
      return outbox.event;
    }
    const request = createContactRequest({ id: args.exchangeId, from: args.identityPubkey, to: parsed.recipient,
      nonce: args.nonce, reply: { secret: args.replySecret, relays: parsed.relays }, now: args.now,
      expiresAt: Math.min(args.now + 30 * 86400, parsed.expiresAt ?? Infinity) });
    const signer = await this.options.signer(args.identityPubkey); this.check();
    const event = await wrapContactExchange(request, parsed.secret, signer); this.check();
    if (!await this.options.mayConnect(parsed.recipient)) throw new Error('The contact policy changed');
    await livePairing();
    const exchange: StoredContactExchange = { ...beginContactExchange(request, args.nonce), origin: { id: args.exchangeId,
      ownerIdentityPubkey: args.identityPubkey, method: 'accepted-request', addedAt: args.now * 1000, ...(parsed.caption ? { caption: parsed.caption } : {}) }, pairing };
    await this.update(state => {
      if (state.exchanges.some(e => contactExchangeKey(e.request) === storageId)) return state;
      assertContactMailboxCapacity(state, args.identityPubkey, args.now, parsed.relays, 'exchange');
      return { ...state, exchanges: [...state.exchanges, exchange], outbox: [...state.outbox,
        { id: event.id, identityPubkey: args.identityPubkey, event, relays: parsed.relays, exchangeId: storageId, messageType: 'request' }] };
    });
    return event;
  }
  async dismiss(arrivalId: string, now: number) {
    await this.update(state => compactContactInviteVault({ ...state, arrivals: state.arrivals.map(a => a.id === arrivalId ? { ...a, dismissedAt: now } : a) }));
  }
  /** Explicit inbox opening consumes the same per-unlock budget across identities. */
  async openInbox(now: number, exchangesOnly = false, identityPubkey?: string, automaticArrivals?: ReadonlySet<string>) {
    // Refuse replies to a child exchange from an earlier pairing before any
    // identity decrypt is spent on them.
    const { blocked, retired } = await this.guardChildExchanges(now);
    const state = await this.read();
    for (const arrival of state.arrivals) {
      if (arrival.channel === 'exchange' && retired.has(arrival.inviteId) && arrival.dismissedAt === undefined) { await this.dismiss(arrival.id, now); continue; }
      // Still waiting for the guardian's decision to be recorded: keep, unopened.
      if (arrival.channel === 'exchange' && blocked.has(arrival.inviteId)) continue;
      if (automaticArrivals && !automaticArrivals.has(arrival.id)) continue;
      if ((identityPubkey && arrival.identityPubkey !== identityPubkey) || arrival.dismissedAt !== undefined || !arrival.packet || arrival.request || (exchangesOnly && arrival.channel !== 'exchange')) continue;
      this.check();
      if (!this.options.budget.consume(exchangesOnly || automaticArrivals ? arrival.id : undefined)) {
        if (this.options.budget.remaining === 0) break;
        continue;
      }
      let signer: ContactIdentitySigner;
      let message;
      try {
        signer = await this.options.signer(arrival.identityPubkey); this.check();
        message = await openContactIdentityPacket(arrival.packet, signer); this.check();
      } catch { this.check(); continue; }
      if (!message) { await this.dismiss(arrival.id, now); continue; }
      if (arrival.channel !== 'exchange') {
        const invite = (await this.read()).invites.find(row => row.id === arrival.inviteId && row.identityPubkey === arrival.identityPubkey);
        if (!invite) { await this.dismiss(arrival.id, now); continue; }
        if (message.type !== 'signet-contact-request' || now < message.createdAt || now >= message.expiresAt
          || !await (this.options.mayReceive ?? this.options.mayConnect)(message.from)) { await this.dismiss(arrival.id, now); continue; }
        await this.update(fresh => {
          const count = fresh.arrivals.filter(a => a.inviteId === arrival.inviteId && a.request?.from === message.from && a.dismissedAt === undefined).length;
          return { ...fresh, arrivals: fresh.arrivals.map(a => a.id === arrival.id
            ? count >= CONTACT_SENDER_PENDING_LIMIT ? { ...a, dismissedAt: now } : { ...a, request: message } : a) };
        });
      } else {
        const fresh = await this.read();
        const old = fresh.exchanges.find(e => contactExchangeKey(e.request) === arrival.inviteId);
        if (!old || conflictedContactExchanges(fresh).has(contactExchangeKey(old.request)) || !await this.options.mayConnect(old.role === 'requester' ? old.request.to : old.request.from)) continue;
        let next: ContactExchangeState;
        let outbox: ContactInviteOutbox | undefined;
        if (message.type === 'signet-contact-accept' && old.role === 'requester') {
          try { next = receiveContactAcceptance(old, message, now); }
          catch { await this.dismiss(arrival.id, now); continue; }
          if (!old.reveal) {
            const event = await wrapContactExchange(next.reveal!, old.request.reply.secret, signer); this.check();
            outbox = { id: event.id, identityPubkey: arrival.identityPubkey, event, relays: old.request.reply.relays, exchangeId: contactExchangeKey(old.request), messageType: 'reveal' };
          }
        } else if (message.type === 'signet-contact-reveal' && old.role === 'recipient') {
          try { next = receiveContactReveal(old, message, now); }
          catch { await this.dismiss(arrival.id, now); continue; }
        } else { await this.dismiss(arrival.id, now); continue; }
        await this.update(current => {
          const existing = current.exchanges.find(e => contactExchangeKey(e.request) === contactExchangeKey(old.request));
          if (JSON.stringify(existing) !== JSON.stringify(old)) throw new Error('Contact exchange changed; reopen the inbox');
          return { ...current, exchanges: current.exchanges.map(e => contactExchangeKey(e.request) === contactExchangeKey(old.request) ? next : e),
            arrivals: current.arrivals.map(a => a.id === arrival.id ? { ...a, dismissedAt: now } : a),
            outbox: outbox ? [...current.outbox, outbox] : current.outbox };
        });
      }
    }
  }
  async processAppInvites(now: number) {
    const state = await this.read();
    for (const invite of state.invites) {
      if (!invite.app || !invite.enabled) continue;
      if (!await this.options.appAllowed?.(invite.app, invite.identityPubkey, 'create', false)) {
        await this.disableAppInvites(invite.app.grantId, now); continue;
      }
      if (invite.mode !== 'single-use' || !invite.app.autoAcceptUntil || now >= invite.app.autoAcceptUntil
        || !await this.options.appAllowed?.(invite.app, invite.identityPubkey, 'create', true)) continue;
      const first = state.arrivals.filter(a => a.inviteId === invite.id).sort((a, b) => a.receivedAt - b.receivedAt || (a.id < b.id ? -1 : 1))[0];
      if (!first || first.dismissedAt !== undefined || !this.options.automaticAttempts || this.options.automaticAttempts.has(first.id)) continue;
      // One automatic attempt per unlock, including hardware refusal. Manual
      // inbox opening remains available and uses the same decrypt budget.
      this.options.automaticAttempts.add(first.id);
      try {
        await this.openInbox(now, false, invite.identityPubkey, new Set([first.id]));
        if (!await this.options.appAllowed?.(invite.app, invite.identityPubkey, 'create', true)) continue;
        await this.accept(first.id, now, false, true);
      } catch { this.check(); }
    }
  }
  async accept(arrivalId: string, now: number, acceptDifferentRecipient = false, automatic = false) {
    const startedAt = Date.now();
    const state = await this.read();
    const arrival = state.arrivals.find(a => a.id === arrivalId);
    const request = arrival?.request;
    const invite = state.invites.find(row => row.id === arrival?.inviteId && row.identityPubkey === request?.to);
    if (invite?.app && !await this.options.appAllowed?.(invite.app, request!.to, 'create', automatic)) throw new Error('App invitation permission ended');
    if (automatic && (!invite?.enabled || invite.mode !== 'single-use' || !invite.app?.autoAcceptUntil || now >= invite.app.autoAcceptUntil)) throw new Error('Automatic acceptance ended');
    if (!acceptDifferentRecipient && invite?.intendedPubkey && invite.intendedPubkey !== request?.from) throw new Error('This invite is for a different contact');
    if (!request || arrival.dismissedAt !== undefined || !await this.options.mayConnect(request.from)) throw new Error('Request cannot be accepted');
    if (state.exchanges.some(e => contactExchangeKey(e.request) === contactExchangeKey(request))) return;
    assertContactMailboxCapacity(state, request.to, now, request.reply.relays, 'exchange');
    const next: StoredContactExchange = { ...acceptContactExchange(request, bytesToHex(randomBytes(32)), now), ...(invite?.app ? { app: invite.app } : {}),
      origin: { id: contactExchangeKey(request), ownerIdentityPubkey: request.to, method: invite?.app ? 'app' : 'accepted-request', addedAt: now * 1000, ...(invite?.app ? { appName: invite.app.appName } : {}),
        ...(invite ? { inviteId: invite.id, inviteName: invite.name } : {}) } };
    const signer = await this.options.signer(request.to); this.check();
    const event = await wrapContactExchange(next.acceptance!, request.reply.secret, signer); this.check();
    if (!await this.options.mayConnect(request.from)) throw new Error('The contact policy changed');
    if (invite?.app && !await this.options.appAllowed?.(invite.app, request.to, 'create', automatic)) throw new Error('App invitation permission ended');
    if (automatic && now + Math.floor(Math.max(0, Date.now() - startedAt) / 1000) >= invite!.app!.autoAcceptUntil!) throw new Error('Automatic acceptance ended while waiting for the signer');
    await this.update(fresh => {
      if (fresh.exchanges.some(e => contactExchangeKey(e.request) === contactExchangeKey(request))) return fresh;
      const currentArrival = fresh.arrivals.find(a => a.id === arrivalId);
      const currentInvite = fresh.invites.find(i => i.id === currentArrival?.inviteId);
      if (!currentArrival?.request || currentArrival.dismissedAt !== undefined
        || JSON.stringify(currentArrival.request) !== JSON.stringify(request)) throw new Error('Request changed; reopen the inbox');
      if (!acceptDifferentRecipient && currentInvite?.intendedPubkey && currentInvite.intendedPubkey !== request.from) throw new Error('This invite is for a different contact');
      assertContactMailboxCapacity(fresh, request.to, now, request.reply.relays, 'exchange');
      return { ...fresh, exchanges: [...fresh.exchanges, next],
        outbox: [...fresh.outbox, { id: event.id, identityPubkey: request.to, event, relays: request.reply.relays, exchangeId: contactExchangeKey(request), messageType: 'acceptance' }],
        arrivals: fresh.arrivals.map(a => a.id === arrivalId ? { ...a, dismissedAt: now } : a) };
    });
  }
  async materialiseContact(exchangeId: string): Promise<string> {
    const state = await this.read();
    const exchange = state.exchanges.find(e => contactExchangeKey(e.request) === exchangeId);
    if (!exchange || exchange.phase !== 'complete' || !this.options.onCompleted || conflictedContactExchanges(state).has(exchangeId)
      || !await this.childMayProceed(exchange)) throw new Error('The exchange is not ready.');
    this.check();
    const contactId = await this.options.onCompleted(exchange); this.check();
    await this.update(fresh => ({ ...fresh, exchanges: fresh.exchanges.map(e => contactExchangeKey(e.request) === exchangeId ? { ...e, contactId } : e) }));
    return contactId;
  }
  async cancel(exchangeId: string) {
    await this.update(state => ({ ...state, exchanges: state.exchanges.map(e => contactExchangeKey(e.request) === exchangeId
      && e.phase !== 'complete' ? { ...e, phase: 'declined' } : e) }));
  }
  async confirmWords(exchangeId: string, heard: string, now: number) {
    const normalise = (value: string) => value.trim().toLocaleLowerCase('en').replace(/\s+/g, ' ');
    if (!Number.isSafeInteger(now) || now < 0 || heard.length > 200) throw new Error('Invalid word confirmation');
    await this.update(state => ({ ...state, exchanges: state.exchanges.map(exchange => {
      if (contactExchangeKey(exchange.request) !== exchangeId) return exchange;
      if (conflictedContactExchanges(state).has(exchangeId)) throw new Error('This exchange has conflicting transcripts. Start a new request.');
      if (exchange.phase !== 'complete' || !exchange.acceptance || !exchange.reveal || now < exchange.reveal.createdAt) throw new Error('The exchange is not complete');
      const own = exchange.role === 'requester' ? exchange.request.from : exchange.request.to;
      const expected = contactVerificationWords(exchange.request, exchange.acceptance, exchange.reveal, own).theySay;
      if (normalise(heard) !== normalise(expected)) throw new Error('Those words do not match. Check them with the other person again.');
      return { ...exchange, wordsConfirmedAt: exchange.wordsConfirmedAt ?? now };
    }) }));
  }
  async flush(now: number) {
    const startedAt = Date.now();
    const publicationTime = () => now + Math.floor(Math.max(0, Date.now() - startedAt) / 1000);
    const { blocked } = await this.guardChildExchanges(now);
    for (const row of (await this.read()).outbox) {
      if (row.acknowledgedAt || (row.exchangeId && blocked.has(row.exchangeId))) continue;
      const fresh = await this.read();
      const exchange = fresh.exchanges.find(e => contactExchangeKey(e.request) === row.exchangeId);
      if (exchange?.app && !await this.options.appAllowed?.(exchange.app, exchange.role === 'requester' ? exchange.request.from : exchange.request.to, exchange.role === 'requester' ? 'receive' : 'create', false)) {
        await this.cancel(contactExchangeKey(exchange.request)); continue;
      }
      if (exchange && (exchange.request.expiresAt <= now || exchange.phase === 'declined')) continue;
      if (exchange && !await this.options.mayConnect(exchange.role === 'requester' ? exchange.request.to : exchange.request.from)) {
        await this.cancel(contactExchangeKey(exchange.request)); continue;
      }
      const conflicts = conflictedContactExchanges(fresh);
      if ( (row.exchangeId ? conflicts.has(row.exchangeId) : conflicts.size > 0)) continue;
      this.check();
      if (!await publishToRelays(row.event, row.relays, {
        isCurrent: this.options.isCurrent,
        beforeSend: async () => {
          const latest = await this.read();
          const pending = latest.outbox.find(o => o.id === row.id && !o.acknowledgedAt);
          const live = latest.exchanges.find(e => contactExchangeKey(e.request) === row.exchangeId);
          if (!pending || JSON.stringify(pending.event) !== JSON.stringify(row.event)
            || (row.exchangeId && (!live || conflictedContactExchanges(latest).has(row.exchangeId)))) throw new Error('Contact outbox changed');
          if (live) {
            if (!await this.childMayProceed(live)) throw new Error('The child request is no longer approved');
            if (live.phase === 'declined' || live.request.expiresAt <= publicationTime()
              || !await this.options.mayConnect(live.role === 'requester' ? live.request.to : live.request.from)) throw new Error('The contact policy changed');
            if (live.app && !await this.options.appAllowed?.(live.app, live.role === 'requester' ? live.request.from : live.request.to,
              live.role === 'requester' ? 'receive' : 'create', false)) throw new Error('App invitation permission ended');
          }
          this.check();
          if (live && live.request.expiresAt <= publicationTime()) throw new Error('Contact exchange expired during publication');
        },
      })) continue;
      this.check();
      await this.update(state => ({ ...state, outbox: state.outbox.map(o => o.id === row.id ? { ...o, acknowledgedAt: now } : o) }));
    }
    // A requester calls its reveal complete only after the relay acknowledges it.
    // Other exchanges cannot hold this one up.
    await this.update(state => ({ ...state, exchanges: state.exchanges.map(e => e.role === 'requester'
      && !conflictedContactExchanges(state).has(contactExchangeKey(e.request)) && e.phase === 'reveal-pending' && (state.outbox.some(o => o.exchangeId === contactExchangeKey(e.request) && o.messageType === 'reveal' && o.acknowledgedAt)
        || (!state.outbox.some(o => o.exchangeId === contactExchangeKey(e.request)) && state.outbox.some(o => o.identityPubkey === e.request.from)
          && !state.outbox.some(o => o.identityPubkey === e.request.from && !o.acknowledgedAt)))
      ? confirmContactRevealSent(e) : e) }));
    if (this.options.onCompleted) {
      for (const exchange of (await this.read()).exchanges) {
        if (exchange.phase !== 'complete' || blocked.has(contactExchangeKey(exchange.request)) || (exchange.contactId && (!exchange.wordsConfirmedAt || exchange.wordsRecordedAt === exchange.wordsConfirmedAt)) || conflictedContactExchanges(await this.read()).has(contactExchangeKey(exchange.request))) continue;
        if (!await this.childMayProceed(exchange)) continue;
        this.check();
        const contactId = await this.options.onCompleted(exchange); this.check();
        await this.update(state => ({ ...state, exchanges: state.exchanges.map(e => contactExchangeKey(e.request) === contactExchangeKey(exchange.request) ? { ...e, contactId, ...(exchange.wordsConfirmedAt ? { wordsRecordedAt: exchange.wordsConfirmedAt } : {}) } : e) }));
      }
    }
  }
}
