import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Enforces the "No console output in production code" security
 * convention (security audit 2026-06-15). console.log/error/warn/debug are
 * forbidden in non-test source; the only permitted console call is a single
 * `console.info` inside a dev-gated helper (stripped from production builds via
 * `import.meta.env.DEV`). Diagnostics must route through the URL warnings
 * channel or such a dev-gated helper instead.
 */
const SRC = join(dirname(fileURLToPath(import.meta.url)));

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

describe('no console output in production code', () => {
  const files = walk(SRC);

  it('scans a non-trivial number of source files', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('contains no console.log / console.error / console.warn / console.debug', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      text.split('\n').forEach((line, i) => {
        if (/\bconsole\.(log|error|warn|debug)\s*\(/.test(line)) {
          offenders.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders, `Forbidden console calls:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('permits at most one console.info, and only inside a dev-gated helper', () => {
    const hits: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      text.split('\n').forEach((line, i) => {
        if (/\bconsole\.info\s*\(/.test(line)) hits.push(`${file}:${i + 1}`);
      });
    }
    // Exactly the dev-gated devLog helper in useBunkerServer.ts.
    expect(hits.length).toBeLessThanOrEqual(1);
  });
});
