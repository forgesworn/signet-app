import {expect, it} from 'vitest';
import {sha256} from '@noble/hashes/sha2.js';
import {bytesToHex} from '@noble/hashes/utils.js';
import {open, seal} from './frame';

it('matches the independent frozen Wildbloom FSWNENC2 vault vector byte for byte', async () => {
  // Public test-vectors/fswnenc2-vault.json from forgesworn/wildbloom; never owner material.
  const key = Uint8Array.from({length: 32}, (_, i) => 0x40 + i);
  const nonce = Uint8Array.from({length: 8}, (_, i) => 0xd0 + i);
  const salt = Uint8Array.from({length: 32}, (_, i) => 0xe0 + i);
  const bytes = new TextEncoder().encode('ForgeSworn envelope v2 known-answer vector\n');
  const file = await seal(key, 'known-answer.txt', 'text/plain', bytes, nonce, 'known-answer', salt);
  expect(file.length).toBe(65_608);
  expect(bytesToHex(sha256(file))).toBe('93e54b2690d4fb818b9dfaa81011cc2a2415c83e21659b6b3fcd982f3838b2cb');
  expect(await open(key, file)).toEqual({meta: {name: 'known-answer.txt', size: bytes.length, type: 'text/plain'}, bytes});
});
