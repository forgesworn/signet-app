// Test fakes for the tap-and-Bluetooth pairing: two phones' native Bluetooth pipes joined
// by an in-memory radio, and two phones' NFC joined by a `tap()`. Imported only by tests.
import { vi } from 'vitest';
import type { NearbyNative } from './handshake-nearby';
import type { HandshakeNfc } from './handshake-nfc';

type Handlers = Parameters<NearbyNative['listen']>[0];

/** Frames cross asynchronously and in order, like an L2CAP stream. */
export function radio() {
  const adverts = new Map<string, Phone>();
  let next = 0;
  class Phone implements NearbyNative {
    handlers?: Handlers; links = new Map<string, { peer: Phone; id: string }>(); stopped = false;
    statusValue = { supported: true, enabled: true, permitted: true };
    status = vi.fn(async () => this.statusValue);
    quiet = vi.fn(async () => {});
    permission = vi.fn(async () => ({ granted: true }));
    enable = vi.fn(async () => ({ enabled: true }));
    async advertise({ token }: { token: string }) { adverts.set(token, this); return { psm: 0x80 }; }
    async connect({ token }: { token: string }) {
      const peer = adverts.get(token);
      if (!peer || peer.stopped) throw new Error('not found');
      const mine = `L${++next}`, theirs = `L${++next}`;
      this.links.set(mine, { peer, id: theirs }); peer.links.set(theirs, { peer: this, id: mine });
      this.handlers!.link({ link: mine, direction: 'out' }); peer.handlers!.link({ link: theirs, direction: 'in' });
      return { link: mine };
    }
    async send({ link, data }: { link: string; data: string }) {
      const route = this.links.get(link);
      if (!route) throw new Error('closed');
      setTimeout(() => route.peer.handlers?.frame({ link: route.id, data }), 0);
    }
    async trust() {}
    async close({ link }: { link: string }) {
      const route = this.links.get(link);
      this.links.delete(link);
      if (route) { route.peer.links.delete(route.id); setTimeout(() => route.peer.handlers?.closed({ link: route.id }), 0); }
    }
    async stop() { this.stopped = true; for (const link of [...this.links.keys()]) await this.close({ link }); }
    async listen(handlers: Handlers) { this.handlers = handlers; return () => { this.handlers = undefined; }; }
    /** Cut every link as if the radio dropped. */
    drop() { for (const link of [...this.links.keys()]) void this.close({ link }); }
  }
  return { phone: () => new Phone() };
}
export type FakeBluetooth = ReturnType<ReturnType<typeof radio>['phone']>;

/** One phone's NFC: records the code it is currently offering and hands it a peer's code on a tap. */
export interface FakeNfcPhone extends HandshakeNfc {
  code: string | null;
  codes: string[];
  stopped: number;
  statusValue: { supported: boolean; enabled: boolean };
  /** This phone reads `raw` from the phone it touched. */
  hear(raw: string): void;
}
export function fakeNfcPhone(): FakeNfcPhone {
  let onPeer: ((raw: string) => void) | null = null;
  const phone: FakeNfcPhone = {
    code: null, codes: [], stopped: 0, statusValue: { supported: true, enabled: true },
    status: async () => phone.statusValue,
    async start(code, handler) {
      phone.code = code; phone.codes.push(code); onPeer = handler;
      const mine = handler;
      return {
        quiet: () => {}, stop: () => { phone.stopped++; if (onPeer === mine) onPeer = null; },
      };
    },
    hear: raw => onPeer?.(raw),
  };
  return phone;
}
/** A touch: each phone hears the code the other is offering. */
export function tapTogether(a: FakeNfcPhone, b: FakeNfcPhone) {
  const ac = a.code, bc = b.code;
  if (bc) a.hear(bc);
  if (ac) b.hear(ac);
}
