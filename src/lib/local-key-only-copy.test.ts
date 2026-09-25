import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localKeyOnlyCopy, BACKUP_WORDS_ON_SIGNER } from './local-key-only-copy';

describe('localKeyOnlyCopy', () => {
  it('is null when local keys are available', () => {
    expect(localKeyOnlyCopy('contacts', 'local')).toBeNull();
    expect(localKeyOnlyCopy('credentials', undefined)).toBeNull();
  });

  it('explains Heartwood mode without telling the user to disconnect', () => {
    const c = localKeyOnlyCopy('contacts', 'bunker')!;
    expect(c.body).toMatch(/Heartwood/);
    expect(c.body).not.toMatch(/disconnect/i);
    expect(c.title).toBe('Add Contact');
  });

  it('names the extension and the guardian phone for the other modes', () => {
    expect(localKeyOnlyCopy('credentials', 'nip07')!.body).toMatch(/extension/i);
    expect(localKeyOnlyCopy('credentials', 'paired-child')!.body).toMatch(/guardian/i);
    expect(localKeyOnlyCopy('credentials', 'paired-child')!.title).toBe('Verify Someone');
  });
});

describe('BACKUP_WORDS_ON_SIGNER', () => {
  it('names the signer and never tells the user to disconnect it', () => {
    expect(BACKUP_WORDS_ON_SIGNER).toBe('Backup words live with your Heartwood signer.');
    expect(BACKUP_WORDS_ON_SIGNER).not.toMatch(/disconnect/i);
  });
});

describe('GuardianSettings backup surface (spec §7.7)', () => {
  const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'pages', 'GuardianSettings.tsx');
  const text = readFileSync(file, 'utf8');

  it('has no backup-words reveal action', () => {
    expect(text).not.toMatch(/getDependantMnemonic/);
    expect(text).not.toMatch(/backup words/i);
    expect(text).not.toMatch(/handleViewBackup/);
    expect(text).not.toMatch(/backupMnemonic/);
  });

  it('states where recovery actually lives, for both viewers', () => {
    expect(text).toContain('Part of your own recovery words.');
    expect(text).toContain('Your guardian holds recovery for this Signet.');
  });
});

describe('useDependants exports no dependant-mnemonic reader (spec §7.7)', () => {
  const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'useDependants.ts');
  const text = readFileSync(file, 'utf8');

  it('does not define or export getDependantMnemonic', () => {
    expect(text).not.toMatch(/getDependantMnemonic/);
  });

  it('still keeps loadGuardianMnemonic private for derivation', () => {
    expect(text).toMatch(/const loadGuardianMnemonic = useCallback/);
  });
});

describe('GuardianSettings real-identity row (spec §7.6)', () => {
  const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'pages', 'GuardianSettings.tsx');
  const text = readFileSync(file, 'utf8');

  it('gates the natural-person persona row on activation', () => {
    expect(text).toContain('resolveDependantRealIdentityRow');
    expect(text).toContain("realIdentityRow === 'active'");
  });

  it('offers activation when dormant and defers to the guardian on the child surface', () => {
    expect(text).toContain('Real identity');
    expect(text).toContain('Not set up');
    expect(text).toContain('Real identity — ask your guardian');
  });

  it('never labels a dependant slot "Natural Person" as a bare fallback', () => {
    expect(text).not.toContain("|| 'Natural Person'");
  });

  it('explains an unavailable real identity instead of rendering nothing', () => {
    expect(text).toContain("realIdentityRow === 'unavailable'");
    expect(text).toContain('Real identity — unavailable');
    expect(text).toContain("This dependant was imported without a real-identity key, so a real identity can&rsquo;t be added here.");
  });
});
