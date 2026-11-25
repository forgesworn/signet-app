import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const app = readFileSync(join(root, 'App.tsx'), 'utf8');
const carousel = readFileSync(join(root, 'components', 'Carousel.tsx'), 'utf8');

/**
 * App.tsx is too large to mount in a test, so these pin the source: a child's
 * phone (`isPairedChild`) is refused at the handler, not only hidden in the UI.
 */
describe('a child\'s phone cannot publish, edit or rename (App.tsx handlers)', () => {
  it('refuses to publish a public profile', () => {
    expect(app).toMatch(/if \(isPairedChild\) return \{ ok: false, message: CHILD_SIDE_COPY\.publicProfileGuardianOnly \};/);
  });

  it('refuses to retract one', () => {
    expect(app).toMatch(/if \(childDirect\) return; \/\/ A42\n\s+if \(isPairedChild\) throw new Error\(CHILD_SIDE_COPY\.publicProfileGuardianOnly\);/);
  });

  it('refuses to save public-profile fields and to upload a public picture', () => {
    expect(app).toMatch(/onSavePersonaConfig=\{async \(target, config\) => \{\n\s+if \(isPairedChild\) throw new Error\(CHILD_SIDE_COPY\.publicProfileGuardianOnly\);/);
    expect(app).toMatch(/onUploadPersonaPicture=\{async \(file, kind, crop\) => \{\n\s+if \(isPairedChild\) throw new Error\(CHILD_SIDE_COPY\.publicProfileGuardianOnly\);/);
  });

  it('wraps persona rename and persona creation so every caller is refused', () => {
    expect(app).toContain('updateDisplayName: updateDisplayNameRaw, addPersona: addPersonaRaw');
    expect(app).toMatch(/const updateDisplayName = useCallback\([^]*?if \(isPairedChild\) return Promise\.reject\(new Error\(CHILD_SIDE_COPY\.namesGuardianManaged\)\);/);
    expect(app).toMatch(/const addPersona = useCallback\([^]*?if \(isPairedChild\) return Promise\.reject\(new Error\(CHILD_SIDE_COPY\.guardianManages\)\);/);
  });

  it('gives the inline card rename and the Advanced page the child-phone flags', () => {
    expect(app).toContain('onRenameActive={isPairedChild ? undefined : async (target, name) => {');
    expect(app).toContain('publicProfileGuardianOnly={isPairedChild}');
    expect(carousel).toContain('props.onRenameActive && !foreign && !props.isPairedChild');
  });

  it('leaves the guardian\'s dependant publish path alone (no child guard in its handlers)', () => {
    expect(app).toMatch(/onRepublishDepProfile=\{async \(depPubkey, target\) => \{\n\s+const result = await publishPersonaProfile\(target, depPubkey\);/);
    expect(app).toMatch(/onSaveDepPersonaConfig=\{async \(depPubkey, target, config\) => \{\n\s+const dep = dependants\.find/);
  });
});
