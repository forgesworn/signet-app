import { contactInviteWork } from '../lib/contact-invite-work';
import { useEffect, useRef, useState } from 'react';
import type { ContactInvite, ContactCard } from '@forgesworn/signet-contacts';
import type { ContactInviteService } from '../lib/contact-invite-service';
import type { StoredContactInvite, StoredContactExchange } from '../lib/contact-invite-store';
import { contactExchangeKey } from '../lib/contact-exchange-key';
import { handshakeRole, inviteFingerprint, readHandshakeQR, validHandshakeScan, type HandshakeQR } from '../lib/handshake-proof';
import { cancelHandshakeHaptics, handshakeHaptic } from '../lib/handshake-haptics';
import { handshakeSigil } from '../lib/handshake-sigil';
import { partnerCardOf } from '../lib/contact-card-share';

export interface HandshakeHost {
  persona: string; version: number; relays: string[];
  service(valid: () => boolean): ContactInviteService;
  card(): Promise<ContactCard | undefined>;
  onSaved?(contactId: string): void;
}
export interface HandshakeView {
  invite?: ContactInvite; peer?: ContactInvite; name?: string; sigil?: string;
  phase: 'reading' | 'waiting' | 'checking' | 'sealed' | 'expired' | 'failed';
  contactId?: string; half?: 'left' | 'right';
}
/** One optical session, bounded to two minutes. No background or persisted
 * optical consent: reopening always requires a fresh QR and camera reads. */
export function useHandshake(host: HandshakeHost) {
  const latest = useRef(host); latest.current = host;
  const [view, setView] = useState<HandshakeView>({ phase: 'reading' });
  const commands = useRef<{ scan(raw: string): void; oneWay(): void; confirm(): void }>(null);
  const kick = useRef<() => void>(() => {});
  useEffect(() => {
    let closed = false, running = false, queued = false, oneWay = false, sending = false, doubleBuzz = false, sealed = false, sealing = false;
    let own: StoredContactInvite | undefined, scanned: HandshakeQR | undefined, readAt: number | undefined;
    let exchangeId: string | undefined, currentExchange: StoredContactExchange | undefined, arrivalId: string | undefined;
    const service = latest.current.service(() => !closed);
    const now = () => Math.floor(Date.now() / 1000);
    const publish = (patch: Partial<HandshakeView>) => { if (!closed) setView(v => ({ ...v, ...patch })); };
    const seal = async (optical: boolean) => {
      if (!exchangeId || !own || !currentExchange || closed || sealed || sealing) return;
      sealing = true;
      try {
      const contactId = await service.confirmHandshake(exchangeId, now(), optical && scanned && readAt !== undefined
        ? { own: own.invite, scanned, readAt } : undefined);
      if (closed) return;
      sealed = true;
      handshakeHaptic('thud'); publish({ phase: 'sealed', contactId, sigil: handshakeSigil(currentExchange) });
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
          if (arrival?.request) {
            publish({ name: arrival.request.card?.name, phase: 'waiting' });
            if (!exchangeId && scanned && readAt !== undefined && handshakeRole(host.persona, scanned.invite.recipient) === 'recipient') {
              await service.acceptHandshake(arrival.id, own.invite, scanned, now(), () => latest.current.card());
              exchangeId = contactExchangeKey(arrival.request);
              if (!doubleBuzz) { handshakeHaptic('double'); doubleBuzz = true; }
            } else if (!exchangeId && oneWay) {
              await service.accept(arrival.id, now(), false, false, () => latest.current.card(), true);
              exchangeId = contactExchangeKey(arrival.request);
            }
          }
          if (!exchangeId && !arrival && !sending && scanned && (handshakeRole(host.persona, scanned.invite.recipient) === 'requester' || oneWay)) {
            sending = true;
            exchangeId = await service.request(host.persona, scanned.invite, now(), undefined, () => latest.current.card(), true);
            publish({ phase: 'waiting' });
          }
          if (exchangeId && scanned) await service.sendOpticalAcceptance(exchangeId, scanned.invite, now());
          await service.flush(now());
          fresh = await service.read();
          currentExchange = fresh.exchanges.find(e => contactExchangeKey(e.request) === exchangeId);
          if (currentExchange) {
            publish({ name: partnerCardOf(currentExchange)?.name });
            if (readAt !== undefined && currentExchange.acceptance && (currentExchange.role === 'recipient' || currentExchange.handshake?.opticalAcceptanceAt !== undefined) && !doubleBuzz) { handshakeHaptic('double'); doubleBuzz = true; }
            if (currentExchange.phase === 'complete') {
              publish({ sigil: handshakeSigil(currentExchange), half: currentExchange.request.from < currentExchange.request.to
                ? currentExchange.role === 'requester' ? 'left' : 'right'
                : currentExchange.role === 'requester' ? 'right' : 'left' });
              if (readAt !== undefined && scanned && handshakeRole(host.persona, scanned.invite.recipient) === currentExchange.role
                && (currentExchange.role === 'recipient' || currentExchange.handshake?.opticalAcceptanceAt !== undefined)) await seal(true);
              else publish({ phase: oneWay || !scanned || scanned.invite.expiresAt === undefined ? 'checking' : 'waiting' });
              return;
            }
          }
          if (now() >= own.invite.expiresAt!) { publish({ phase: 'expired' }); return; }
        } while (queued && !closed);
        });
      } catch (error) {
        if (import.meta.env.DEV) window.dispatchEvent(new CustomEvent('signet-handshake-error', { detail: error instanceof Error ? error.message : 'Unknown error' }));
        if (!closed) publish({ phase: 'failed' });
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
        if (first) { handshakeHaptic('tick'); publish({ peer: qr.invite, phase: 'waiting' }); }
        const hadValidScan = readAt !== undefined;
        if (readAt === undefined && validHandshakeScan(own.invite, qr, now())) { readAt = now(); }
        if (first || (!hadValidScan && readAt !== undefined)) void run();
      },
      oneWay() { oneWay = true; if (scanned || arrivalId) void run(); },
      confirm() { if (!running && currentExchange?.phase === 'complete') void contactInviteWork(() => seal(false)).catch(() => publish({ phase: 'failed' })); },
    };
    void (async () => {
      try {
        own = await service.create(host.persona, 'Handshake', host.relays, 'single-use', now(), now() + 120);
        if (closed) { await service.setEnabled(own.id, false, now()); return; }
        publish({ invite: own.invite }); await run();
      } catch { publish({ phase: 'failed' }); }
    })();
    const expiry = setInterval(() => {
      if (own && now() >= own.invite.expiresAt! && !sealed && !(oneWay && currentExchange?.phase === 'complete')) publish({ phase: 'expired' });
    }, 1000);
    return () => {
      cancelHandshakeHaptics();
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
  return { view, scan: (raw: string) => commands.current?.scan(raw), oneWay: () => commands.current?.oneWay(), confirm: () => commands.current?.confirm() };
}
