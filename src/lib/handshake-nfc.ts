import { isNativeApp, SignetNative } from './native';

/**
 * The handshake NFC tap (APK). Held back to back, the two phones swap session
 * codes in one touch: each offers its own as an emulated card and reads the
 * other's in reader mode, alternating so that one reads while the other is
 * read. The codes carry no persona; everything after a tap is the same sealed
 * reveal and SDK exchange as after a camera read.
 */
export interface HandshakeNfcHandle {
  /** The session is over (tap crossed, sealed, declined, failed, expired): stop
   * offering the code and stop reacting to tags, but keep reader mode on as a
   * silent reader while the screen shows, so the OS tag dispatcher never reads
   * the other phone and toasts "no supported app". Safe to call twice. */
  quiet(): void;
  /** Full release (leaving the screen): reader mode off too. */
  stop(): void;
}
export interface HandshakeNfc {
  status(): Promise<{ supported: boolean; enabled: boolean }>;
  /** Resolves with the handle. Starting again re-keys the running session. */
  start(code: string, onPeer: (code: string) => void): Promise<HandshakeNfcHandle>;
}

export function nativeNfc(): HandshakeNfc | null {
  if (!isNativeApp()) return null;
  return {
    status: () => SignetNative.nfcStatus(),
    async start(code, onPeer) {
      const sub = await SignetNative.addListener('nfcPeer', e => { if (typeof e.code === 'string') onPeer(e.code); });
      let session: number;
      try { session = (await SignetNative.nfcStart({ code })).session; } catch (error) { void sub.remove(); throw error; }
      let removed = false, quieted = false, stopped = false;
      const unlisten = () => { if (!removed) { removed = true; void sub.remove(); } };
      // Each call carries this start's session number: native ignores one that is not
      // the current session's, so a late call from an old screen cannot touch a newer one.
      return {
        quiet: () => { if (quieted || stopped) return; quieted = true; unlisten(); void SignetNative.nfcQuiet({ session }).catch(() => {}); },
        stop: () => { if (stopped) return; stopped = true; unlisten(); void SignetNative.nfcStop({ session }).catch(() => {}); },
      };
    },
  };
}
