import { isNativeApp, SignetNative } from './native';
export type HandshakeBeat = 'tick' | 'double' | 'thud';
export function handshakeHaptic(beat: HandshakeBeat) {
  if (isNativeApp()) void SignetNative.handshakeHaptic({ beat }).catch(() => {});
  else navigator.vibrate?.(beat === 'tick' ? 65 : beat === 'double' ? [90, 120, 90] : 180);
}
