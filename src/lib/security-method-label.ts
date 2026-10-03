/**
 * What Security settings says the app is unlocked with. It used to say
 * "Biometrics + PIN fallback" for every biometric install, but enabling
 * biometrics replaces the PIN-wrapped key, so there was no PIN to fall back
 * to. Where the phone's own PIN does open the biometric key (native, Android
 * 11+), it says so.
 */
export function securityMethodLabel(method: 'biometric' | 'pin' | null, acceptsDevicePin: boolean): string {
  if (method === 'biometric') return acceptsDevicePin ? "Biometrics, or your phone's PIN" : 'Biometrics';
  if (method === 'pin') return 'PIN';
  return 'Not yet set up';
}
