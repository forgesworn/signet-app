import { isNativeApp, SignetNative } from './native';
export type HandshakeBeat = 'tick' | 'double' | 'thud';
export function handshakeHaptic(beat: HandshakeBeat) {
  if (isNativeApp()) void SignetNative.handshakeHaptic({ beat }).catch(() => {});
  else navigator.vibrate?.(beat === 'tick' ? 15 : beat === 'double' ? [40, 80, 40] : 90);
}
