import { isNativeApp, SignetNative } from './native';

/**
 * The handshake NFC tap (APK). Held back to back, the two phones swap session
 * codes in one touch: each offers its own as an emulated card and reads the
 * other's in reader mode, alternating so that one reads while the other is
 * read. The codes carry no persona; everything after a tap is the same sealed
 * reveal and SDK exchange as after a camera read.
 */
export interface HandshakeNfc {
  status(): Promise<{ supported: boolean; enabled: boolean }>;
  /** Resolves with a stop function. */
  start(code: string, onPeer: (code: string) => void): Promise<() => void>;
}

export function nativeNfc(): HandshakeNfc | null {
  if (!isNativeApp()) return null;
  return {
    status: () => SignetNative.nfcStatus(),
    async start(code, onPeer) {
      const sub = await SignetNative.addListener('nfcPeer', e => { if (typeof e.code === 'string') onPeer(e.code); });
      try { await SignetNative.nfcStart({ code }); } catch (error) { void sub.remove(); throw error; }
      return () => { void sub.remove(); void SignetNative.nfcStop().catch(() => {}); };
    },
  };
}
