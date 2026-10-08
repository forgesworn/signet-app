import { isNativeApp, SignetNative } from './native';
export type HandshakeBeat = 'tick' | 'double' | 'thud';
const DURATION: Record<HandshakeBeat, number> = { tick: 65, double: 300, thud: 180 };
/** Let each pulse finish, with a perceptible gap, before the next starts.
 * Otherwise the saved-contact vibration can interrupt the proof double buzz. */
export function createHandshakeHapticQueue(play: (beat: HandshakeBeat) => void | Promise<void>) {
  let active = false, generation = 0, timer: ReturnType<typeof setTimeout> | undefined;
  const pending: HandshakeBeat[] = [];
  const next = () => {
    const beat = pending.shift();
    if (!beat) { active = false; return; }
    active = true;
    const current = generation;
    void Promise.resolve().then(() => { if (current === generation) return play(beat); }).catch(() => {}).then(() => {
      if (current === generation) timer = setTimeout(next, DURATION[beat] + 120);
    });
  };
  return {
    push(beat: HandshakeBeat) { pending.push(beat); if (!active) next(); },
    cancel() { generation++; clearTimeout(timer); pending.length = 0; active = false; },
  };
}
const queue = createHandshakeHapticQueue(beat => {
  if (isNativeApp()) return SignetNative.handshakeHaptic({ beat });
  navigator.vibrate?.(beat === 'tick' ? 65 : beat === 'double' ? [90, 120, 90] : 180);
});
export function handshakeHaptic(beat: HandshakeBeat) { queue.push(beat); }
export function cancelHandshakeHaptics() { queue.cancel(); }
