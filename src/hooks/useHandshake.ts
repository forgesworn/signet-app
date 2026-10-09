import { contactInviteWork } from '../lib/contact-invite-work';
import { useEffect, useRef, useState } from 'react';
import type { ContactInvite, ContactCard } from '@forgesworn/signet-contacts';
import type { ContactInviteService } from '../lib/contact-invite-service';
import type { StoredContactInvite, StoredContactExchange } from '../lib/contact-invite-store';
import { contactExchangeKey } from '../lib/contact-exchange-key';
import { handshakeRole, inviteFingerprint, readHandshakeQR, validHandshakeScan, type HandshakeQR } from '../lib/handshake-proof';
import { cancelHandshakeHaptics, handshakeHaptic } from '../lib/handshake-haptics';
import { handshakeSigil } from '../lib/handshake-sigil';
import { ContactCardPhotoError, partnerCardOf } from '../lib/contact-card-share';
import { clearActiveHandshakeNearby, HandshakeNearby, nativeNearby, setActiveHandshakeNearby, takeNearbyEnablePrompt, type NearbyNative } from '../lib/handshake-nearby';

export interface HandshakeHost {
  persona: string; version: number; relays: string[];
  service(valid: () => boolean): ContactInviteService;
  /** `withoutPhoto` only after the user chose to go on without their picture. */
  card(opts?: { withoutPhoto?: boolean }): Promise<ContactCard | undefined>;
  onSaved?(contactId: string): void;
  /** The Bluetooth pipe; defaults to the APK's, none in a browser. */
  nearby?: NearbyNative | null;
  /** Prepare what the policy checks read (the contacts log), while the user
   * is still aiming the camera, so the first check after a scan is quick. */
  warm?(): void;
}
export interface HandshakeView {
  invite?: ContactInvite; peer?: ContactInvite; name?: string; sigil?: string;
  phase: 'reading' | 'waiting' | 'checking' | 'sealed' | 'expired' | 'failed';
  contactId?: string; half?: 'left' | 'right';
  scansConfirmed?: boolean;
  /** `linked`: finishing over Bluetooth. `off`/`denied`: the user can fix it
   * to finish without the internet. Absent: no nearby status to show. */
  nearby?: 'linked' | 'off' | 'denied';
  /** The picture could not be prepared (usually: no internet yet). Nothing
   * was sent; the user may go on without it. */
  photoFailed?: boolean;
}
/** One optical session, bounded to two minutes. No background or persisted
 * optical consent: reopening always requires a fresh QR and camera reads. */
export function useHandshake(host: HandshakeHost) {
  const latest = useRef(host); latest.current = host;
  const [view, setView] = useState<HandshakeView>({ phase: 'reading' });
  const commands = useRef<{ scan(raw: string): void; oneWay(): void; confirm(): void; withoutPhoto(): void }>(null);
  const kick = useRef<() => void>(() => {});
  useEffect(() => {
    let closed = false, running = false, queued = false, oneWay = false, sending = false, doubleBuzz = false, sealed = false, sealing = false, noPhoto = false;
    let nearby: HandshakeNearby | undefined;
    let own: StoredContactInvite | undefined, scanned: HandshakeQR | undefined, readAt: number | undefined;
    let exchangeId: string | undefined, currentExchange: StoredContactExchange | undefined, arrivalId: string | undefined;
    const service = latest.current.service(() => !closed);
    const now = () => Math.floor(Date.now() / 1000);
    const publish = (patch: Partial<HandshakeView>) => { if (!closed) setView(v => ({ ...v, ...patch })); };
    const card = () => latest.current.card(noPhoto ? { withoutPhoto: true } : undefined);
    const finishNearby = () => { if (nearby) { clearActiveHandshakeNearby(nearby); void nearby.close(); } };
    const dial = () => { if (scanned) nearby?.connect({ pubkey: scanned.invite.recipient, secret: scanned.invite.secret }); };
    const confirmScans = () => {
      if (doubleBuzz) return;
      doubleBuzz = true; publish({ scansConfirmed: true }); handshakeHaptic('double');
    };
    const seal = async (optical: boolean) => {
      if (!exchangeId || !own || !currentExchange || closed || sealed || sealing) return;
      sealing = true;
      try {
      const contactId = await service.confirmHandshake(exchangeId, now(), optical && scanned && readAt !== undefined
        ? { own: own.invite, scanned, readAt } : undefined);
      if (closed) return;
      sealed = true;
      handshakeHaptic('thud'); publish({ phase: 'sealed', contactId, sigil: handshakeSigil(currentExchange) });
      finishNearby();
      latest.current.onSaved?.(contactId);
      } finally { sealing = false; }
    };
    const run = async () => {
      if (closed || sealed) return;
      if (running) { queued = true; return; }
      running = true;
      try {
        await contactInviteWork(async () => {
        do {
          queued = false;
          if (!own || closed) return;
          const state = await service.read();
          if (closed) return;
          const arrivals = state.arrivals.filter(a => a.inviteId === own!.id && a.dismissedAt === undefined);
          await service.openInbox(now(), false, host.persona, new Set(arrivals.map(a => a.id)));
          await service.openInbox(now(), true, host.persona);
          let fresh = await service.read();
          const arrival = fresh.arrivals.find(a => a.inviteId === own!.id && a.request && a.dismissedAt === undefined
            && (!scanned || a.request.from === scanned.invite.recipient));
          arrivalId = arrival?.id;
          // The SDK opened it as signed by its sender: a link that carried it speaks for them.
          if (arrival?.request) nearby?.bind(arrival.id, arrival.request.from);
          if (arrival?.request) {
            publish({ name: arrival.request.card?.name, phase: 'waiting' });
            if (!exchangeId && scanned && readAt !== undefined && handshakeRole(host.persona, scanned.invite.recipient) === 'recipient') {
              await service.acceptHandshake(arrival.id, own.invite, scanned, now(), card);
              exchangeId = contactExchangeKey(arrival.request);
              confirmScans();
            } else if (!exchangeId && oneWay) {
              await service.accept(arrival.id, now(), false, false, card, true);
              exchangeId = contactExchangeKey(arrival.request);
            }
          }
          if (!exchangeId && !arrival && !sending && scanned && (handshakeRole(host.persona, scanned.invite.recipient) === 'requester' || oneWay)) {
            sending = true;
            try { exchangeId = await service.request(host.persona, scanned.invite, now(), undefined, card, true); }
            finally { if (!exchangeId) sending = false; }
            publish({ phase: 'waiting' });
          }
          if (exchangeId && scanned) await service.sendOpticalAcceptance(exchangeId, scanned.invite, now());
          await service.flush(now());
          fresh = await service.read();
          currentExchange = fresh.exchanges.find(e => contactExchangeKey(e.request) === exchangeId);
          if (currentExchange) {
            publish({ name: partnerCardOf(currentExchange)?.name });
            if (readAt !== undefined && currentExchange.acceptance && (currentExchange.role === 'recipient' || currentExchange.handshake?.opticalAcceptanceAt !== undefined)) confirmScans();
            if (currentExchange.phase === 'complete') {
              publish({ sigil: handshakeSigil(currentExchange), half: currentExchange.request.from < currentExchange.request.to
                ? currentExchange.role === 'requester' ? 'left' : 'right'
                : currentExchange.role === 'requester' ? 'right' : 'left' });
              if (readAt !== undefined && scanned && handshakeRole(host.persona, scanned.invite.recipient) === currentExchange.role
                && (currentExchange.role === 'recipient' || currentExchange.handshake?.opticalAcceptanceAt !== undefined)) await seal(true);
              else publish({ phase: oneWay || !scanned || scanned.invite.expiresAt === undefined ? 'checking' : 'waiting' });
              // A wake-up during this pass (the return proof just landed) runs
              // another pass at once instead of waiting for the next trigger.
              if (sealed) return;
              continue;
            }
          }
          if (now() >= own.invite.expiresAt!) { publish({ phase: 'expired' }); finishNearby(); return; }
        } while (queued && !closed);
        });
      } catch (error) {
        if (import.meta.env.DEV) window.dispatchEvent(new CustomEvent('signet-handshake-error', { detail: error instanceof Error ? error.message : 'Unknown error' }));
        // Nothing was signed or sent: the card is built after every check and
        // before the message. The user decides whether to go on without it.
        if (error instanceof ContactCardPhotoError && !noPhoto) publish({ photoFailed: true });
        else if (!closed) { publish({ phase: 'failed' }); finishNearby(); }
      }
      finally { running = false; }
    };
    kick.current = () => { void run(); };
    commands.current = {
      scan(raw) {
        if (!own || closed || now() >= own.invite.expiresAt!) return;
        const qr = readHandshakeQR(raw, now());
        if (!qr || !handshakeRole(host.persona, qr.invite.recipient)) return;
        if (scanned && inviteFingerprint(scanned.invite) !== inviteFingerprint(qr.invite)) return;
        const first = !scanned;
        scanned = qr;
        if (first) {
          handshakeHaptic('tick'); publish({ peer: qr.invite, phase: 'waiting' });
          // The phone that sends first dials; the other keeps advertising.
          if (handshakeRole(host.persona, qr.invite.recipient) === 'requester') dial();
        }
        const hadValidScan = readAt !== undefined;
        if (readAt === undefined && validHandshakeScan(own.invite, qr, now())) { readAt = now(); }
        if (first || (!hadValidScan && readAt !== undefined)) void run();
      },
      oneWay() { oneWay = true; dial(); if (scanned || arrivalId) void run(); },
      withoutPhoto() { if (closed || noPhoto) return; noPhoto = true; publish({ photoFailed: false }); void run(); },
      confirm() { if (!running && currentExchange?.phase === 'complete') void contactInviteWork(() => seal(false)).catch(() => publish({ phase: 'failed' })); },
    };
    latest.current.warm?.();
    void (async () => {
      try {
        own = await service.create(host.persona, 'Handshake', host.relays, 'single-use', now(), now() + 120);
        if (closed) { await service.setEnabled(own.id, false, now()); return; }
        publish({ invite: own.invite });
        const native = latest.current.nearby === undefined ? nativeNearby() : latest.current.nearby;
        if (native) {
          const invite = own;
          const carrier = nearby = new HandshakeNearby(native, {
            ownSecret: invite.invite.secret,
            onEvent: event => service.receiveDirect(event, { identity: host.persona, inviteId: invite.id, now: now() }),
            onChange: () => {
              publish({ nearby: carrier.linked ? 'linked' : carrier.availability === 'off' || carrier.availability === 'denied' ? carrier.availability : undefined });
              void run();
            },
          });
          setActiveHandshakeNearby(carrier);
          void carrier.open(takeNearbyEnablePrompt());
        }
        await run();
      } catch { publish({ phase: 'failed' }); }
    })();
    const expiry = setInterval(() => {
      if (own && now() >= own.invite.expiresAt! && !sealed && !(oneWay && currentExchange?.phase === 'complete')) { publish({ phase: 'expired' }); finishNearby(); }
    }, 1000);
    return () => {
      cancelHandshakeHaptics();
      finishNearby();
      closed = true; clearInterval(expiry); kick.current = () => {};
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
