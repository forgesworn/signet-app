import { describe, it, expect } from 'vitest';
import { securityMethodLabel } from './security-method-label';

describe('securityMethodLabel', () => {
  it('never promises a PIN fallback the install does not have', () => {
    expect(securityMethodLabel('biometric', false)).toBe('Biometrics');
    expect(securityMethodLabel('biometric', false)).not.toMatch(/PIN/);
  });

  it("names the phone's PIN where it really opens the biometric key", () => {
    expect(securityMethodLabel('biometric', true)).toBe("Biometrics, or your phone's PIN");
  });

  it('PIN and nothing set up read as before', () => {
    expect(securityMethodLabel('pin', false)).toBe('PIN');
    expect(securityMethodLabel(null, false)).toBe('Not yet set up');
  });
});
