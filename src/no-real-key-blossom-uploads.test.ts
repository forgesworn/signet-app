import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { uploadToBlossom, deleteFromBlossom } from './lib/blossom';
import { LocalSigningBackend } from './lib/signing-backend';

/**
 * No Blossom upload may be signed by an identity, persona, Professional or
 * dependant key: the server operator would see that pubkey beside the file.
 * `uploadToBlossom` / `deleteFromBlossom` therefore take a backend only from
 * `blossom-uploader.ts`: both take the branded `UploaderBackend` type, which
 * only that module mints, so the compiler refuses a real key (the
 * `@ts-expect-error` test below). This pins the call sites as a review prompt:
 * a new caller must be added here on purpose, and the app shell must not call
 * them at all.
 */
const SRC = join(dirname(fileURLToPath(import.meta.url)));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('Blossom uploads are never signed by a real key', () => {
  const files = walk(SRC).map(f => ({ rel: relative(SRC, f), text: readFileSync(f, 'utf8') }));
  const callers = files.filter(f => /\b(uploadToBlossom|deleteFromBlossom)\s*\(|\bupload\s*\?\?\s*uploadToBlossom/.test(f.text)
    && !['lib/blossom.ts'].includes(f.rel));

  it('finds the known call sites', () => {
    expect(callers.map(f => f.rel).sort()).toEqual(['lib/avatar.ts', 'lib/contact-picture-backup.ts', 'pages/PhotoCapture.tsx']);
  });

  it('App.tsx never calls uploadToBlossom directly', () => {
    const app = files.find(f => f.rel === 'App.tsx')!;
    expect(app.text).not.toMatch(/\buploadToBlossom\b/);
  });
});

describe('the uploader backend type is branded', () => {
  it('a plain LocalSigningBackend cannot be passed to uploadToBlossom or deleteFromBlossom', () => {
    const real = new LocalSigningBackend('11'.repeat(32));
    // Never invoked: the point is that the compiler rejects both calls.
    const never = () => {
      // @ts-expect-error a real key is not an UploaderBackend
      void uploadToBlossom(new Blob(['x']), 'https://blossom.example', real, true);
      // @ts-expect-error a real key is not an UploaderBackend
      void deleteFromBlossom('ab'.repeat(32), 'https://blossom.example', real);
    };
    expect(typeof never).toBe('function');
    real.destroy();
  });
});
