// Self-test for the harness verifier. Run from the repo root (it borrows
// nostr-tools from the app's node_modules to mint real signatures):
//
//   node test-consumer/verify.test.mjs
//
// Proves the verifier accepts a genuine kind-21236 sign-in signature and
// rejects each way one can go wrong — otherwise a green "signed ✓" on the
// callback page would mean nothing.
import assert from 'node:assert/strict';
import { verifyCallback } from './vendor/signet-verify.js';
import { finalizeEvent, getPublicKey, generateSecretKey } from 'nostr-tools/pure';
import { nip19 } from 'nostr-tools';

const sk = generateSecretKey();
const challenge = 'a'.repeat(64);
const origin = 'http://localhost:5175';
const launch = { challenge, origin };
const event = finalizeEvent({
  kind: 21236,
  created_at: Math.floor(Date.now() / 1000),
  tags: [['challenge', challenge], ['origin', origin]],
  content: '',
}, sk);

const good = new URLSearchParams({
  pubkey: event.pubkey,
  npub: nip19.npubEncode(event.pubkey),
  signature: event.sig,
  eventId: event.id,
  t: String(event.created_at),
});

const cases = [
  ['genuine signature', () => verifyCallback(good, launch), 'signed'],
  ['challenge we did not send', () => verifyCallback(good, { challenge: 'b'.repeat(64), origin }), 'failed'],
  ['origin we did not send', () => verifyCallback(good, { challenge, origin: 'https://elsewhere.example' }), 'failed'],
  ['tampered signature', () => {
    const p = new URLSearchParams(good);
    p.set('signature', event.sig.slice(0, 126) + (event.sig.endsWith('00') ? '11' : '00'));
    return verifyCallback(p, launch);
  }, 'failed'],
  ['npub for a different key', () => {
    const p = new URLSearchParams(good);
    p.set('npub', nip19.npubEncode(getPublicKey(generateSecretKey())));
    return verifyCallback(p, launch);
  }, 'failed'],
  ['missing signature', () => {
    const p = new URLSearchParams(good);
    p.delete('signature');
    return verifyCallback(p, launch);
  }, 'failed'],
  ['no launch context', () => verifyCallback(good, null), 'unverifiable'],
  ['empty launch list', () => verifyCallback(good, []), 'unverifiable'],
  ['the right launch among several recent ones', () => verifyCallback(good, [
    { challenge: 'c'.repeat(64), origin },
    launch,
    { challenge: 'd'.repeat(64), origin },
  ]), 'signed'],
  ['only stale launches', () => verifyCallback(good, [
    { challenge: 'c'.repeat(64), origin },
    { challenge: 'd'.repeat(64), origin },
  ]), 'failed'],
  ['no created_at', () => {
    const p = new URLSearchParams(good);
    p.delete('t');
    return verifyCallback(p, launch);
  }, 'unverifiable'],
  ['user denied', () => verifyCallback(new URLSearchParams({ error: 'denied' }), launch), 'denied'],
];

let failures = 0;
for (const [name, run, expected] of cases) {
  const result = run();
  try {
    assert.equal(result.verdict, expected);
    console.log(`  ok   ${name} → ${result.verdict}`);
  } catch {
    failures++;
    console.log(`  FAIL ${name} → ${result.verdict} (expected ${expected}): ${result.headline}`);
  }
}
console.log(failures === 0 ? `\n${cases.length} checks passed` : `\n${failures} of ${cases.length} checks FAILED`);
process.exit(failures === 0 ? 0 : 1);
