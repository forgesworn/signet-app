// Self-test for the relay-mode consumer. Run from the repo root:
//
//   node test-consumer/relay.test.mjs
//
// Builds gift-wrapped auth responses exactly the way signet-app's
// relay-publish.ts builds them (rumor → seal → wrap), then checks the
// consumer accepts a genuine one and rejects the ways it can go wrong.
import assert from 'node:assert/strict';
import { newSession, verifyWrappedResponse } from './vendor/signet-relay.js';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { nip44 } from 'nostr-tools';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const encrypt = (senderSk, recipientPk, text) =>
  nip44.encrypt(text, nip44.getConversationKey(senderSk, recipientPk));

function eventId(e) {
  return bytesToHex(sha256(new TextEncoder().encode(
    JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]),
  )));
}

/** Mirror of signet-app: signAuthChallenge → buildAuthResponseEventTemplate → giftWrap. */
function buildResponse({ signerSk, recipientPk, challenge, origin, status = 'approved', breakAuthSig = false }) {
  const signerPk = getPublicKey(signerSk);
  const authEvent = finalizeEvent({
    kind: 21236,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['challenge', challenge], ['origin', origin]],
    content: '',
  }, signerSk);
  if (breakAuthSig) authEvent.sig = authEvent.sig.slice(0, 126) + (authEvent.sig.endsWith('00') ? '11' : '00');

  const payload = { type: 'signet-auth-response', requestId: challenge, authEvent };
  const rumorTemplate = {
    kind: 29999,
    pubkey: signerPk,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['session', challenge], ['status', status]],
    content: JSON.stringify(payload),
  };
  const rumor = { ...rumorTemplate, id: eventId(rumorTemplate) };

  const seal = finalizeEvent({
    kind: 13,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content: encrypt(signerSk, recipientPk, JSON.stringify(rumor)),
  }, signerSk);

  const ephSk = generateSecretKey();
  return finalizeEvent({
    kind: 1059,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['p', recipientPk]],
    content: encrypt(ephSk, recipientPk, JSON.stringify(seal)),
  }, ephSk);
}

const session = newSession();
const signerSk = generateSecretKey();
const challenge = 'a'.repeat(64);
const origin = 'https://harness.example';
const expected = { challenge, origin };

const cases = [
  ['genuine response', () => verifyWrappedResponse(
    buildResponse({ signerSk, recipientPk: session.publicKey, challenge, origin }), session, expected), 'signed'],

  ['challenge we did not send', () => verifyWrappedResponse(
    buildResponse({ signerSk, recipientPk: session.publicKey, challenge: 'b'.repeat(64), origin }), session, expected), 'failed'],

  ['origin we did not send', () => verifyWrappedResponse(
    buildResponse({ signerSk, recipientPk: session.publicKey, challenge, origin: 'https://elsewhere.example' }), session, expected), 'failed'],

  ['tampered auth signature', () => verifyWrappedResponse(
    buildResponse({ signerSk, recipientPk: session.publicKey, challenge, origin, breakAuthSig: true }), session, expected), 'failed'],

  ['wrapped to somebody else', () => verifyWrappedResponse(
    buildResponse({ signerSk, recipientPk: getPublicKey(generateSecretKey()), challenge, origin }), session, expected), 'failed'],

  ['status denied', () => verifyWrappedResponse(
    buildResponse({ signerSk, recipientPk: session.publicKey, challenge, origin, status: 'denied' }), session, expected), 'denied'],

  ['not a gift wrap', () => verifyWrappedResponse(
    finalizeEvent({ kind: 1, created_at: 1, tags: [], content: 'hello' }, signerSk), session, expected), 'failed'],
];

let failures = 0;
for (const [name, run, want] of cases) {
  const result = run();
  if (result.verdict === want) {
    console.log(`  ok   ${name} → ${result.verdict}`);
  } else {
    failures++;
    console.log(`  FAIL ${name} → ${result.verdict} (expected ${want}): ${result.headline}`);
  }
}
console.log(failures === 0 ? `\n${cases.length} checks passed` : `\n${failures} of ${cases.length} checks FAILED`);
process.exit(failures === 0 ? 0 : 1);
