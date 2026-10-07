import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * No Blossom upload may be signed by an identity, persona, Professional or
 * dependant key: the server operator would see that pubkey beside the file.
 * `uploadToBlossom` / `deleteFromBlossom` therefore take a backend only from
 * `blossom-uploader.ts` (a fresh random key, or one derived from the blob's
 * content key). This pins the call sites: any file that calls them must also
 * build its signer there, and the app shell must not call them at all.
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

  it.each(callers.map(f => [f.rel, f.text]))('%s builds its signer from blossom-uploader', (_rel, text) => {
    expect(text).toMatch(/derivedUploaderBackend|randomUploaderBackend/);
    expect(text).not.toMatch(/naturalPerson|nip07Backend|npBunkerBackend/);
  });

  it('App.tsx never calls uploadToBlossom directly', () => {
    const app = files.find(f => f.rel === 'App.tsx')!;
    expect(app.text).not.toMatch(/\buploadToBlossom\b/);
  });
});
