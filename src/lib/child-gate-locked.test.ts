import { describe, it, expect } from 'vitest';
import { ChildGateRefusedError, childGateWireError } from './child-bunker';

// Device run 2026-11-17 (F15): a child's request cut short by the app locking
// used to read "This phone is no longer paired." while the phone was paired.
describe('a request cut short by the app locking', () => {
  it('says the app locked, not that the phone is unpaired; an app on the NIP-46 wire still reads denied', () => {
    expect(new ChildGateRefusedError('locked').message).toBe('My Signet locked before your guardian answered. Unlock and try again.');
    expect(new ChildGateRefusedError('unpaired').message).toBe('This phone is no longer paired.');
    expect(childGateWireError('locked')).toBe('denied');
    expect(childGateWireError('unpaired')).toBe('unpaired');
  });
});
