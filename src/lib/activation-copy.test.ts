import { describe, it, expect } from 'vitest';
import { resolveActivationCopy, activationLineText } from './activation-copy';

describe('resolveActivationCopy (spec §7.1/§7.6/§12)', () => {
  const owner = resolveActivationCopy({ kind: 'owner' });
  const dep = resolveActivationCopy({ kind: 'dependant', depPubkey: 'b'.repeat(64), dependantName: 'Lily' });

  it('keeps the owner copy in the first person', () => {
    expect(owner.nameLabel).toBe('Your legal name');
    expect(owner.confirmLabel).toBe('Activate my real identity');
    expect(owner.confirmBody).toContain('This is the one identity that carries your legal name.');
  });

  it('names the dependant in the dependant copy', () => {
    expect(dep.nameLabel).toBe("Lily's legal name");
    expect(dep.confirmLabel).toBe('Activate their real identity');
    expect(dep.explanationBody.map(activationLineText).join(' ')).toContain('Lily');
  });

  it('never uses a forbidden word', () => {
    for (const copy of [owner, dep]) {
      const all = JSON.stringify(copy);
      expect(all).not.toMatch(/Guest|provisional|burner/i);
    }
  });

  it('tells the guardian the ceremony changes no key and no default', () => {
    expect(dep.explanationBody.map(activationLineText).join(' ')).toContain('Their keys do not change');
  });

  it('keeps the owner explanation word-for-word what it was before the branch', () => {
    expect(owner.explanationTitle).toBe('What your real identity is');
    expect(owner.explanationBody.map(activationLineText)).toEqual([
      'It carries your legal name. It is what a professional verifies, what your family is built on, and what a venue reads at the door.',
      'It is not used for ordinary sign-ins. A site only ever sees it if you pick it yourself and confirm.',
      'It is a separate key from your personas. Sites you have signed into with a persona cannot link the two.',
    ]);
  });

  it('emphasises "not" in the sign-in line, on both targets', () => {
    for (const copy of [owner, dep]) {
      const line = copy.explanationBody.find(
        l => typeof l !== 'string' && l.emphasis === 'not',
      );
      expect(line, 'the "not used for ordinary sign-ins" line must carry emphasis').toBeTruthy();
      // The emphasis must be a verbatim substring, or the renderer drops it.
      expect(activationLineText(line!)).toContain('not');
    }
  });

  it('escapes nothing and passes the name through verbatim', () => {
    const odd = resolveActivationCopy({ kind: 'dependant', depPubkey: 'b'.repeat(64), dependantName: 'Zoë' });
    expect(odd.nameLabel).toBe("Zoë's legal name");
  });
});
