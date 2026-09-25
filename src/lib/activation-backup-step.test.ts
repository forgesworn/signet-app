import { describe, it, expect } from 'vitest';
import { resolveActivationBackupStep } from './activation-backup-step';

describe('resolveActivationBackupStep', () => {
  it('is none when there is no mnemonic to back up', () => {
    expect(resolveActivationBackupStep({ hasMnemonic: false, backedUp: false, liteImported: false })).toBe('none');
    expect(resolveActivationBackupStep({ hasMnemonic: false, backedUp: true, liteImported: true })).toBe('none');
  });

  it('is first-backup when a mnemonic exists and has never been written down', () => {
    expect(resolveActivationBackupStep({ hasMnemonic: true, backedUp: false, liteImported: false })).toBe('first-backup');
  });

  it('prefers first-backup over the Lite reminder', () => {
    expect(resolveActivationBackupStep({ hasMnemonic: true, backedUp: false, liteImported: true })).toBe('first-backup');
  });

  it('is lite-reminder for a backed-up Lite import', () => {
    expect(resolveActivationBackupStep({ hasMnemonic: true, backedUp: true, liteImported: true })).toBe('lite-reminder');
  });

  it('is none for a backed-up identity that did not come from Lite', () => {
    expect(resolveActivationBackupStep({ hasMnemonic: true, backedUp: true, liteImported: false })).toBe('none');
  });
});
