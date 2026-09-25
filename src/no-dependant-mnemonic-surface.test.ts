import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Spec §7.7 invariant. No dependant settings surface — guardian mode or
 * paired-child mode — may display the guardian mnemonic, a dependant private
 * key, or an export derived from either. `getDependantMnemonic` returned the
 * GUARDIAN's words for every tree-derived dependant, and `loadGuardianMnemonic`
 * is the hook-private derive path behind it; neither belongs in a rendered
 * surface. This guard stops the removal being undone by a future paste.
 */
const SRC = dirname(fileURLToPath(import.meta.url));
const SCANNED = [join(SRC, 'pages'), join(SRC, 'components')];
/** App.tsx renders surfaces directly and wires every page's handlers, so it is
 *  scanned alongside the page/component trees. */
const SCANNED_FILES = [join(SRC, 'App.tsx')];
const FORBIDDEN = ['getDependantMnemonic', 'loadGuardianMnemonic'];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe('no dependant-mnemonic surface in pages, components or App.tsx', () => {
  const files = [...SCANNED.flatMap(walk), ...SCANNED_FILES];

  it('scans a non-trivial number of files', () => {
    expect(files.length).toBeGreaterThan(30);
  });

  it('references neither getDependantMnemonic nor loadGuardianMnemonic', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      text.split('\n').forEach((line, i) => {
        for (const needle of FORBIDDEN) {
          if (line.includes(needle)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders, `Forbidden dependant-mnemonic references:\n${offenders.join('\n')}`).toEqual([]);
  });
});
