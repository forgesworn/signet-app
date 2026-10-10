import { contactInviteWork } from '../lib/contact-invite-work';
import { useEffect, useRef, useState } from 'react';
import type { ContactInvite, ContactCard } from '@forgesworn/signet-contacts';
import type { NostrEvent } from 'signet-protocol';
import type { ContactInviteService } from '../lib/contact-invite-service';
import type { StoredContactInvite, StoredContactExchange } from '../lib/contact-invite-store';
import { contactExchangeKey } from '../lib/contact-exchange-key';
import { handshakeRole, readHandshakeCode } from '../lib/handshake-proof';
import { bindingTemplate, createHandshakeSession, openReveal, sealReveal, sessionDialler, sessionQR, verifyRevealBinding,
  type HandshakeSession, type RevealBody, type SessionCard } from '../lib/handshake-reveal';
import { watchReveals } from '../lib/handshake-reveal-relay';
import { publishToRelays } from '../lib/sync-relays';
import { cancelHandshakeHaptics, handshakeHaptic } from '../lib/handshake-haptics';
import { handshakeSigil } from '../lib/handshake-sigil';
import { ContactCardPhotoError, partnerCardOf } from '../lib/contact-card-share';
import { clearActiveHandshakeNearby, HandshakeNearby, nativeNearby, setActiveHandshakeNearby, takeNearbyEnablePrompt, type NearbyNative } from '../lib/handshake-nearby';
import { nativeNfc, type HandshakeNfc } from '../lib/handshake-nfc';

export interface HandshakeHost {
  persona: string; version: number; relays: string[];
  service(valid: () => boolean): ContactInviteService;
  /** `withoutPhoto` only after the user chose to go on without their picture. */
  card(opts?: { withoutPhoto?: boolean }): Promise<ContactCard | undefined>;
  onSaved?(contactId: string): void;
  /** The Bluetooth pipe; defaults to the APK's, none in a browser. */
  nearby?: NearbyNative | null;
  /** The NFC tap; defaults to the APK's, none in a browser. */
  nfc?: HandshakeNfc | null;
  /** Prepare what the policy checks read (the contacts log), while the user
   * is still aiming the camera, so the first check after a scan is quick. */
  warm?(): void;
  /** Where reveals travel when there is no Bluetooth; replaceable in tests. */
  revealRelays?: {
    watch(relays: string[], session: string, onEvent: (event: NostrEvent) => void): () => void;
    publish(event: NostrEvent, relays: string[]): Promise<boolean>;
  };
}
export interface HandshakeView {
  /** The session code this screen shows. It names no one. */
  code?: string; name?: string; sigil?: string;
  phase: 'reading' | 'waiting' | 'checking' | 'sealed' | 'expired' | 'failed';
  contactId?: string; half?: 'top' | 'bottom';
  /** This phone read the other screen's code: by its camera, or by a tap (`via`). */
  scanned?: boolean; via?: 'camera' | 'tap';
  scansConfirmed?: boolean;
  /** `linked`: finishing over Bluetooth. `off`/`denied`: the user can fix it
   * to finish without the internet. Absent: no nearby status to show. */
  nearby?: 'linked' | 'off' | 'denied';
  /** The picture could not be prepared (usually: no internet yet). Nothing
   * was sent; the user may go on without it. */
  photoFailed?: boolean;
  /** The other phone showed a code from an older build. */
  outdated?: boolean;
  /** More than one phone answered before this one scanned: the seam check
   * cannot tell which is in front of you, so it asks for a scan instead. */
  ambiguous?: boolean;
  /** A tap works here too: hold the phones back to back. */
  tapAvailable?: boolean;
}
const defaultRelays = { watch: watchReveals, publish: (event: NostrEvent, relays: string[]) => publishToRelays(event, relays) };
const REVEAL_HOLD_MS = 5000, LATE_DIAL_MS = 3000, RETRY_MS = 3000, RESEND_MS = 5000, MAX_CANDIDATES = 16, MAX_FAILED_REVEALS = 512, MAX_SEEN = 1024;

/** One unlinkable session, bounded to two minutes (handshake-reveal.ts). No
 * background or persisted optical consent: reopening always requires a fresh
 * session and fresh camera reads. */
export function useHandshake(host: HandshakeHost) {
  const latest = useRef(host); latest.current = host;
  const [view, setView] = useState<HandshakeView>({ phase: 'reading' });
  const commands = useRef<{ scan(raw: string): void; tap(raw: string): void; oneWay(): void; confirm(): void; withoutPhoto(): void }>(null);
  const kick = useRef<() => void>(() => {});
  useEffect(() => {
    let closed = false, running = false, queued = false, oneWay = false, sending = false, doubleBuzz = false, sealed = false, sealing = false, noPhoto = false;
    let nearby: HandshakeNearby | undefined, radioEnded = false, backgrounded = false;
    const nearbyBudget = { events: 0 };
    const session: HandshakeSession = createHandshakeSession();
    const relays = latest.current.revealRelays ?? defaultRelays;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    let own: StoredContactInvite | undefined;
    /** The other screen's session as this phone read it (camera or tap), and when. */
    let peerCard: SessionCard | undefined, readAt: number | undefined, via: 'camera' | 'tap' = 'camera';
    let stopNfc: (() => void) | undefined;
    /** A plain invite link the camera read: only ever the one-way seam check. */
    let legacy: ContactInvite | undefined;
    /** The reveal this session acts on, and ones that came before this phone scanned. */
    let peerReveal: RevealBody | undefined;
    const candidates: Array<{ body: RevealBody; eventId: string }> = [];
    let ownBinding: NostrEvent | undefined, ownRevealSent = false, lastRevealAt = 0, revealing = false, revealHoldUntil = 0;
    let failedReveals = 0, conflict = false;
    const seenReveals = new Set<string>();
    let exchangeId: string | undefined, currentExchange: StoredContactExchange | undefined, arrivalId: string | undefined;
    const service = latest.current.service(() => !closed);
    const now = () => Math.floor(Date.now() / 1000);
    const later = (ms: number, fn: () => void) => {
      const t = setTimeout(() => { timers.delete(t); if (!closed) fn(); }, ms);
      timers.add(t);
    };
    const publish = (patch: Partial<HandshakeView>) => {
      if (closed) return;
      // Failed closed stays failed: a pass already in flight cannot move it on.
      if (conflict && patch.phase && patch.phase !== 'failed') { const { phase: _phase, ...rest } = patch; patch = rest; }
      setView(v => ({ ...v, ...patch }));
    };
    const card = () => latest.current.card(noPhoto ? { withoutPhoto: true } : undefined);
    const finishNearby = () => { if (nearby) { clearActiveHandshakeNearby(nearby); void nearby.close(); nearby = undefined; } };
    /** Sealed, expired, failed or left: the radios stay off for good. */
    const endNearby = () => { radioEnded = true; finishNearby(); stopNfc?.(); stopNfc = undefined; };
    /** Both screens read, and the peer's persona signed for both sessions with
     * a proof only the holder of the camera-read session could make. */
    const verified = () => !conflict && !!(peerCard && peerReveal && verifyRevealBinding(peerReveal, peerCard.publicKey, session));
    /** The peer acted on our invite: it has our reveal, so we can stop resending. */
    const progressed = () => !!arrivalId || !!currentExchange?.acceptance;
    /** The invite the SDK exchange runs on: a verified reveal; an unverified
     * one only once the user chose the seam check; or a plain invite link. */
    const peerInvite = (): ContactInvite | undefined => verified() || (oneWay && peerReveal) ? peerReveal!.invite : legacy;
    /** The lower session dials at once; the higher waits for that link and
     * dials itself if it never comes (the other phone did not scan). */
    const dial = () => {
      const peer = peerCard?.publicKey;
      if (!peer || !nearby) return;
      if (sessionDialler(session.publicKey, peer)) { nearby.connect({ session: peer }, { quiet: true }); return; }
      nearby.expect(peer);
      later(LATE_DIAL_MS, () => { if (nearby && !nearby.reaches(peer)) nearby.connect({ session: peer }, { quiet: true }); });
    };
    const confirmScans = () => {
      if (doubleBuzz) return;
      doubleBuzz = true; publish({ scansConfirmed: true }); handshakeHaptic('double');
    };
    /** The seam check acts on an unverified reveal: the link that carried it
     * (if any) speaks for its persona, so the request can go back over it. */
    const takeUnverified = (candidate: { body: RevealBody; eventId: string }) => {
      peerReveal = candidate.body;
      nearby?.bind(candidate.eventId, candidate.body.invite.recipient);
    };
    /** A reveal sealed to this session. Kept only if it is for the screen this
     * camera read; before any scan, a few are held to check once it happens. */
    const acceptReveal = (event: NostrEvent): boolean => {
      // Only failures count against the allowance, so junk cannot crowd out
      // the genuine reveal; a relay replaying what it sent costs nothing.
      if (closed || sealed || conflict || failedReveals >= MAX_FAILED_REVEALS || seenReveals.has(event.id)) return false;
      if (seenReveals.size < MAX_SEEN) seenReveals.add(event.id);
      const body = openReveal(event, session, now());
      if (!body || body.invite.recipient === host.persona) { failedReveals++; return false; }
      if (peerCard) {
        if (!verifyRevealBinding(body, peerCard.publicKey, session)) { failedReveals++; return false; }
        if (verified() && peerReveal!.invite.recipient !== body.invite.recipient) {
          // Two personas both proved the session this camera read: fail closed.
          conflict = true; publish({ phase: 'failed' }); endNearby(); return false;
        }
        if (!peerReveal || !verified()) { peerReveal = body; nearby?.bindSession(peerCard.publicKey, body.invite.recipient); }
      } else if (!candidates.some(c => c.body.binding.id === body.binding.id)) {
        if (candidates.length >= MAX_CANDIDATES) return false;
        candidates.push({ body, eventId: event.id });
        if (oneWay && peerReveal && peerReveal.invite.recipient !== body.invite.recipient && !exchangeId && !sending) {
          // A second persona answered before anything was sent: stop guessing.
          peerReveal = undefined; publish({ ambiguous: true });
        } else if (oneWay && !peerReveal && new Set(candidates.map(c => c.body.invite.recipient)).size === 1) takeUnverified(candidates[0]);
        publish({ phase: 'waiting' });
      }
      void run();
      return true;
    };
    /** Our own reveal, once our camera read the other screen. Bluetooth first;
     * while a link may still form, it waits rather than touch a relay. It is
     * sent again, freshly sealed, until the peer acts on it: a reveal the peer
     * dropped before scanning (a full store) then lands after its scan. */
    const sendReveal = async () => {
      if (revealing || !peerCard || !own || closed || sealed || conflict || progressed()
        || now() >= own.invite.expiresAt! || now() >= peerCard.expiresAt) return;
      if (ownRevealSent && Date.now() - lastRevealAt < RESEND_MS) return;
      revealing = true;
      let sent = false;
      try {
        ownBinding ??= await service.signRevealBinding(host.persona, bindingTemplate(session, peerCard.publicKey, own.invite, now()));
        const event = sealReveal({ v: 2, to: peerCard.publicKey, invite: own.invite, binding: ownBinding }, peerCard.publicKey, now());
        if (nearby?.reaches(peerCard.publicKey)) sent = await nearby.deliverSession(peerCard.publicKey, event);
        else if (!ownRevealSent && nearby?.availability === 'ready' && Date.now() < revealHoldUntil) return;
        if (!sent && !closed && !sealed) sent = await relays.publish(event, peerCard.relays);
        if (sent) { ownRevealSent = true; lastRevealAt = Date.now(); }
      } finally {
        revealing = false;
        if (!closed && !sealed && !progressed() && now() < own.invite.expiresAt!) later(sent ? RESEND_MS : RETRY_MS, () => void run());
      }
    };
    const seal = async (mutual: boolean) => {
      if (!exchangeId || !own || !currentExchange || closed || sealed || sealing || conflict) return;
      sealing = true;
      try {
      const evidence = mutual && peerCard && peerReveal && readAt !== undefined
        ? { inviteId: own.id, ownSession: session, cameraPeerSession: peerCard.publicKey, peerExpiresAt: peerCard.expiresAt,
          peerReveal, readAt, via } : undefined;
      const contactId = await service.confirmHandshake(exchangeId, now(), evidence);
      if (closed) return;
      sealed = true;
      handshakeHaptic('thud'); publish({ phase: 'sealed', contactId, sigil: handshakeSigil(currentExchange) });
      endNearby();
      latest.current.onSaved?.(contactId);
      } finally { sealing = false; }
    };
    const run = async () => {
      // Failed closed (a conflict): nothing more is sent, and "failed" stays.
      if (closed || sealed || conflict) return;
      if (running) { queued = true; return; }
      running = true;
      try {
        await contactInviteWork(async () => {
        do {
          queued = false;
          // A pass woken while the seal was saving (the save bumps the app's
          // version) waited for it here; it must not undo "Sealed".
          if (!own || closed || sealed || conflict) return;
          await sendReveal();
          if (verified()) confirmScans();
          const invite = peerInvite();
          const role = invite ? handshakeRole(host.persona, invite.recipient) : null;
          const state = await service.read();
          if (closed) return;
          const arrivals = state.arrivals.filter(a => a.inviteId === own!.id && a.dismissedAt === undefined);
          await service.openInbox(now(), false, host.persona, new Set(arrivals.map(a => a.id)));
          await service.openInbox(now(), true, host.persona);
          let fresh = await service.read();
          const arrival = fresh.arrivals.find(a => a.inviteId === own!.id && a.request && a.dismissedAt === undefined
            && (!invite || a.request.from === invite.recipient));
          arrivalId = arrival?.id;
          // The SDK opened it as signed by its sender: a link that carried it speaks for them.
          if (arrival?.request) nearby?.bind(arrival.id, arrival.request.from);
          if (arrival?.request) {
            publish({ name: arrival.request.card?.name, phase: 'waiting' });
            if (!exchangeId && verified() && role === 'recipient') {
              await service.acceptHandshake(arrival.id, own.invite, { invite: invite! }, now(), card);
              exchangeId = contactExchangeKey(arrival.request);
            } else if (!exchangeId && !verified() && oneWay) {
              await service.accept(arrival.id, now(), false, false, card, true);
              exchangeId = contactExchangeKey(arrival.request);
            }
          }
          // Verified: the lower persona sends. Unverified: only the seam check
          // (or a plain invite link) sends, from whichever phone holds an invite.
          if (!exchangeId && !arrival && !sending && invite && (verified() ? role === 'requester' : oneWay || !!legacy)) {
            sending = true;
            try { exchangeId = await service.request(host.persona, invite, now(), undefined, card, true); }
            finally { if (!exchangeId) sending = false; }
            publish({ phase: 'waiting' });
          }
          await service.flush(now());
          fresh = await service.read();
          currentExchange = fresh.exchanges.find(e => contactExchangeKey(e.request) === exchangeId);
          if (currentExchange) {
            publish({ name: partnerCardOf(currentExchange)?.name });
            if (currentExchange.phase === 'complete') {
              publish({ sigil: handshakeSigil(currentExchange), half: currentExchange.request.from < currentExchange.request.to
                ? currentExchange.role === 'requester' ? 'top' : 'bottom'
                : currentExchange.role === 'requester' ? 'bottom' : 'top' });
              if (verified() && readAt !== undefined && role === currentExchange.role) await seal(true);
              else {
                publish({ phase: 'checking' });
                // Nothing more crosses for a seam check: the radio can go.
                endNearby();
              }
              // A wake-up during this pass runs another pass at once instead of
              // waiting for the next trigger.
              if (sealed) return;
              continue;
            }
          }
          if (now() >= own.invite.expiresAt!) { publish({ phase: 'expired' }); endNearby(); return; }
        } while (queued && !closed);
        });
      } catch (error) {
        if (import.meta.env.DEV) window.dispatchEvent(new CustomEvent('signet-handshake-error', { detail: error instanceof Error ? error.message : 'Unknown error' }));
        // Nothing was signed or sent: the card is built after every check and
        // before the message. The user decides whether to go on without it.
        if (error instanceof ContactCardPhotoError && !noPhoto) publish({ photoFailed: true });
        else if (!closed) { publish({ phase: 'failed' }); endNearby(); }
      }
      finally { running = false; }
    };
    /** The other phone's session, read by this camera or crossed by a tap. */
    const takeSession = (scannedCard: SessionCard, how: 'camera' | 'tap') => {
      // This phone's own code reflected back, or the same peer read again (a tap
      // repeats while the phones touch): nothing new.
      if (legacy || conflict || sealed || sealing || scannedCard.publicKey === session.publicKey
        || scannedCard.publicKey === peerCard?.publicKey) return;
      // A second, different session: another screen or card reached this one.
      // One peer per screen, so fail closed rather than let the first code
      // silently win (an NFC device brushed past could have been first).
      if (peerCard) { conflict = true; publish({ phase: 'failed' }); endNearby(); return; }
      peerCard = scannedCard; readAt = now(); via = how;
      const proven = candidates.filter(c => verifyRevealBinding(c.body, scannedCard.publicKey, session));
      if (new Set(proven.map(c => c.body.invite.recipient)).size > 1) { conflict = true; publish({ phase: 'failed' }); endNearby(); return; }
      peerReveal = proven[0]?.body ?? peerReveal;
      if (peerReveal && verified()) nearby?.bindSession(scannedCard.publicKey, peerReveal.invite.recipient);
      handshakeHaptic('tick'); publish({ scanned: true, via: how, phase: 'waiting', outdated: false });
      revealHoldUntil = Date.now() + REVEAL_HOLD_MS;
      later(REVEAL_HOLD_MS, () => void run());
      dial();
      void run();
    };
    kick.current = () => { void run(); };
    commands.current = {
      scan(raw) {
        if (!own || closed || now() >= own.invite.expiresAt!) return;
        const code = readHandshakeCode(raw, now());
        if (!code) return;
        if (code.kind === 'outdated') { publish({ outdated: true }); return; }
        if (code.kind === 'invite') {
          if (peerCard || legacy || code.invite.recipient === host.persona) return;
          legacy = code.invite;
          handshakeHaptic('tick'); publish({ scanned: true, phase: 'waiting', outdated: false });
          void run();
          return;
        }
        takeSession(code.card, 'camera');
      },
      /** An NFC tap delivered the other phone's session code. */
      tap(raw) {
        if (!own || closed || now() >= own.invite.expiresAt!) return;
        const code = readHandshakeCode(raw, now());
        if (code?.kind === 'session') takeSession(code.card, 'tap');
      },
      oneWay() {
        // Without its own scan this phone cannot tell reveals apart: with more
        // than one persona answering, it asks for a scan rather than guess.
        if (!peerReveal && !peerCard && new Set(candidates.map(c => c.body.invite.recipient)).size > 1) { publish({ ambiguous: true }); return; }
        oneWay = true;
        if (!peerReveal && !peerCard && candidates.length) takeUnverified(candidates[0]);
        if (peerCard || legacy || peerReveal || arrivalId) void run();
      },
      withoutPhoto() { if (closed || noPhoto) return; noPhoto = true; publish({ photoFailed: false }); void run(); },
      confirm() { if (!running && currentExchange?.phase === 'complete') void contactInviteWork(() => seal(false)).catch(() => publish({ phase: 'failed' })); },
    };
    /** Bluetooth runs only while this screen is visible. The always-on bunker
     * suspends hide-lock, so the screen can stay mounted behind another app;
     * the radio stops then, and a fresh carrier (same session) starts if the
     * user returns. */
    const startNearby = () => {
      const invite = own;
      const native = latest.current.nearby === undefined ? nativeNearby() : latest.current.nearby;
      if (closed || radioEnded || backgrounded || nearby || !invite || !native || document.visibilityState === 'hidden') return;
      const carrier = nearby = new HandshakeNearby(native, {
        session, budget: nearbyBudget,
        onEvent: async event => {
          if (event.tags[0]?.[1] === session.publicKey) return acceptReveal(event) ? 'stored' : 'rejected';
          return service.receiveDirect(event, { identity: host.persona, inviteId: invite.id, now: now() });
        },
        onChange: () => {
          if (nearby !== carrier) return;
          // A link that came up after the reveal verified speaks for it too.
          if (verified()) carrier.bindSession(peerCard!.publicKey, peerReveal!.invite.recipient);
          publish({ nearby: carrier.linked ? 'linked' : carrier.availability === 'off' || carrier.availability === 'denied' ? carrier.availability : undefined });
          void run();
        },
      });
      setActiveHandshakeNearby(carrier);
      void carrier.open(takeNearbyEnablePrompt());
      if (peerCard) dial();
    };
    const away = () => { finishNearby(); publish({ nearby: undefined }); };
    const visibility = () => { if (document.visibilityState === 'hidden') away(); else startNearby(); };
    document.addEventListener('visibilitychange', visibility);
    let stopLifecycle: (() => void) | undefined;
    const lifecycleNative = latest.current.nearby === undefined ? nativeNearby() : latest.current.nearby;
    // The shell's word wins: the always-on bunker re-marks a backgrounded
    // page visible, so only the shell's foreground may restart the radio.
    void lifecycleNative?.lifecycle?.(state => { backgrounded = state === 'background'; if (backgrounded) away(); else startNearby(); })
      .then(stop => { if (closed) stop(); else stopLifecycle = stop; }).catch(() => {});
    latest.current.warm?.();
    let stopWatching: (() => void) | undefined;
    void (async () => {
      try {
        own = await service.create(host.persona, 'Handshake', host.relays, 'single-use', now(), now() + 120);
        if (closed) { await service.setEnabled(own.id, false, now()); return; }
        const code = sessionQR({ publicKey: session.publicKey, expiresAt: own.invite.expiresAt!, relays: own.invite.relays });
        if (!code) throw new Error('No relay for the handshake code');
        publish({ code });
        stopWatching = relays.watch(own.invite.relays, session.publicKey, event => { acceptReveal(event); });
        const nfc = latest.current.nfc === undefined ? nativeNfc() : latest.current.nfc;
        if (nfc) void (async () => {
          const status = await nfc.status();
          if (!status.supported || !status.enabled || closed || radioEnded) return;
          const stop = await nfc.start(code, raw => commands.current?.tap(raw));
          if (closed || radioEnded) { stop(); return; }
          stopNfc = stop; publish({ tapAvailable: true });
        })().catch(() => {});
        startNearby();
        await run();
      } catch { publish({ phase: 'failed' }); }
    })();
    const expiry = setInterval(() => {
      if (own && now() >= own.invite.expiresAt! && !sealed && !conflict && !(oneWay && currentExchange?.phase === 'complete')) { publish({ phase: 'expired' }); endNearby(); }
    }, 1000);
    return () => {
      cancelHandshakeHaptics();
      endNearby();
      stopWatching?.();
      document.removeEventListener('visibilitychange', visibility);
      stopLifecycle?.();
      closed = true; clearInterval(expiry); kick.current = () => {};
      for (const t of timers) clearTimeout(t);
      timers.clear();
      // The session secret is the only proof this phone read the other screen.
      session.secret.fill(0);
      if (own) {
        const retiring = latest.current.service(() => true);
        void retiring.setEnabled(own.id, false, now()).catch(() => {});
        if (exchangeId && !sealed) void retiring.cancel(exchangeId).catch(() => {});
      }
      // Leaving never grants confirmation; the durable signed outbox may resume,
      // but a handshake cannot materialise until its proof has been recorded.
    };
  }, [host.persona]);
  useEffect(() => { kick.current(); }, [host.version]);
  return { view, scan: (raw: string) => commands.current?.scan(raw), oneWay: () => commands.current?.oneWay(), confirm: () => commands.current?.confirm(),
    withoutPhoto: () => commands.current?.withoutPhoto() };
}
