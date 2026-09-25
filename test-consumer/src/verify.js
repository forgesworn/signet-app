// Real cryptographic verification of a Sign-in-with-Signet callback.
//
// Bundled to ../vendor/signet-verify.js (see ../build-vendor.sh) so the
// static harness can verify a signature with no build step and no network.
//
// What this proves, in order:
//   1. the callback carries the params the contract requires;
//   2. the npub is the same key as the hex pubkey;
//   3. the kind-21236 event rebuilt from OUR challenge + origin hashes to
//      the eventId Signet returned  → the signature is bound to this
//      sign-in attempt, not replayed from another one;
//   4. the Schnorr signature verifies against that id under that pubkey.
//
// Check 3 needs the launch context (what we asked for). Without it we can
// still run 1, 2 and 4 — that proves Signet produced a valid signature over
// SOME event, just not that it is the one we requested.
//
// The caller may pass several recent launches rather than one. On a phone the
// callback often lands in a NEW tab (the signer app opens it), and
// sessionStorage is per-tab, so the harness keeps its recent launches in
// localStorage instead — any of which could be the one that came back. A
// match against any recent launch is still proof of binding: the challenge is
// 32 random bytes, so an event id can only rebuild from the launch that
// actually produced it.

import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bech32 } from '@scure/base';

const HEX64 = /^[0-9a-f]{64}$/i;
const HEX128 = /^[0-9a-f]{128}$/i;

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Decode an npub (bech32, hrp "npub") back to a 64-char hex pubkey. */
export function npubToHex(npub) {
  const { prefix, words } = bech32.decode(npub, 200);
  if (prefix !== 'npub') throw new Error(`expected npub, got ${prefix}`);
  return bytesToHex(new Uint8Array(bech32.fromWords(words)));
}

/**
 * NIP-01 event id: sha256 of the canonical serialisation
 * [0, pubkey, created_at, kind, tags, content].
 */
export function eventIdFor(event) {
  const serialised = JSON.stringify([
    0, event.pubkey, event.created_at, event.kind, event.tags, event.content,
  ]);
  return bytesToHex(sha256(new TextEncoder().encode(serialised)));
}

/**
 * Rebuild the kind-21236 auth event Signet says it signed.
 *
 * Tag order matters — it is part of the hash. It mirrors signAuthChallenge
 * in signet-app: challenge, origin, then the optional avatar trio.
 */
export function rebuildAuthEvent({ pubkey, createdAt, challenge, origin, avatar }) {
  const tags = [['challenge', challenge], ['origin', origin]];
  if (avatar && avatar.hash && avatar.url && avatar.key) {
    tags.push(['avatar_hash', avatar.hash]);
    tags.push(['avatar_url', avatar.url]);
    tags.push(['avatar_key', avatar.key]);
  }
  return { pubkey, kind: 21236, created_at: createdAt, tags, content: '' };
}

function check(name, status, detail) {
  return { name, status, detail };
}

/**
 * Verify a callback.
 *
 * @param params    URLSearchParams of the callback URL.
 * @param launches  What the harness asked for: a { challenge, origin } object,
 *                  or an array of recent ones, newest first. Optional.
 * @returns { verdict, headline, checks }
 *          verdict: 'signed' | 'denied' | 'failed' | 'unverifiable'
 */
export function verifyCallback(params, launches) {
  const checks = [];
  const candidates = (Array.isArray(launches) ? launches : [launches])
    .filter((l) => l && l.challenge && l.origin);
  const get = (k) => params.get(k);

  const error = get('error');
  if (error) {
    return {
      verdict: 'denied',
      headline: `Signet returned error=${error}`,
      checks: [check('callback outcome', 'info', `error=${error} — no signature to verify`)],
    };
  }

  const pubkey = get('pubkey');
  const npub = get('npub');
  const signature = get('signature');
  const eventId = get('eventId');
  const createdAtRaw = get('t');

  // 1. Required params.
  const missing = [];
  if (!pubkey) missing.push('pubkey');
  if (!npub) missing.push('npub');
  if (!signature) missing.push('signature');
  if (!eventId) missing.push('eventId');
  if (missing.length > 0) {
    return {
      verdict: 'failed',
      headline: `Callback is missing ${missing.join(', ')}`,
      checks: [check('required params', 'fail', `missing: ${missing.join(', ')}`)],
    };
  }
  checks.push(check('required params', 'pass', 'pubkey, npub, signature, eventId all present'));

  // 2. Shapes.
  const shapeProblems = [];
  if (!HEX64.test(pubkey)) shapeProblems.push('pubkey is not 64 hex chars');
  if (!HEX128.test(signature)) shapeProblems.push('signature is not 128 hex chars');
  if (!HEX64.test(eventId)) shapeProblems.push('eventId is not 64 hex chars');
  if (shapeProblems.length > 0) {
    checks.push(check('param shapes', 'fail', shapeProblems.join('; ')));
    return { verdict: 'failed', headline: shapeProblems[0], checks };
  }
  checks.push(check('param shapes', 'pass', 'pubkey, signature and eventId are well-formed hex'));

  // 3. npub agrees with the hex pubkey.
  try {
    const decoded = npubToHex(npub);
    if (decoded.toLowerCase() !== pubkey.toLowerCase()) {
      checks.push(check('npub matches pubkey', 'fail', `npub decodes to ${decoded.slice(0, 16)}… but pubkey is ${pubkey.slice(0, 16)}…`));
      return { verdict: 'failed', headline: 'The npub and the hex pubkey are different keys', checks };
    }
    checks.push(check('npub matches pubkey', 'pass', 'both name the same key'));
  } catch (e) {
    checks.push(check('npub matches pubkey', 'fail', `npub did not decode: ${e.message}`));
    return { verdict: 'failed', headline: 'The npub in the callback is malformed', checks };
  }

  // 4. Signature verifies against the returned event id.
  let sigValid = false;
  try {
    sigValid = schnorr.verify(hexToBytes(signature), hexToBytes(eventId), hexToBytes(pubkey));
  } catch (e) {
    checks.push(check('signature verifies', 'fail', `verification threw: ${e.message}`));
    return { verdict: 'failed', headline: 'The signature could not be checked', checks };
  }
  if (!sigValid) {
    checks.push(check('signature verifies', 'fail', 'BIP-340 Schnorr verification failed for this key and event id'));
    return { verdict: 'failed', headline: 'The signature does not verify — Signet returned a bad signature', checks };
  }
  checks.push(check('signature verifies', 'pass', 'BIP-340 Schnorr signature is valid for this key over this event id'));

  // 5. The event id is the one OUR request should have produced.
  const createdAt = createdAtRaw ? parseInt(createdAtRaw, 10) : NaN;
  if (candidates.length === 0) {
    checks.push(check('bound to our challenge', 'skip', 'no launch context in this browser — cannot rebuild the event'));
    return {
      verdict: 'unverifiable',
      headline: 'Signature is valid, but this browser has no record of what was asked for',
      checks,
    };
  }
  if (!Number.isInteger(createdAt)) {
    checks.push(check('bound to our challenge', 'skip', 'callback carried no t= (created_at), so the event cannot be rebuilt'));
    return {
      verdict: 'unverifiable',
      headline: 'Signature is valid, but Signet did not return created_at so it cannot be tied to our challenge',
      checks,
    };
  }

  const avatar = {
    hash: get('avatar_hash') || '',
    url: get('avatar_url') || '',
    key: get('avatar_key') || '',
  };
  const avatarTrio = avatar.hash && avatar.url && avatar.key ? avatar : undefined;
  let matched = null;
  let firstRebuiltId = '';
  for (const candidate of candidates) {
    const rebuiltId = eventIdFor(rebuildAuthEvent({
      pubkey,
      createdAt,
      challenge: candidate.challenge,
      origin: candidate.origin,
      avatar: avatarTrio,
    }));
    if (!firstRebuiltId) firstRebuiltId = rebuiltId;
    if (rebuiltId.toLowerCase() === eventId.toLowerCase()) {
      matched = candidate;
      break;
    }
  }
  if (!matched) {
    checks.push(check('bound to our challenge', 'fail',
      `rebuilding kind 21236 from ${candidates.length === 1 ? 'our challenge and origin' : `each of the ${candidates.length} recent attempts`} gives ${firstRebuiltId.slice(0, 16)}…, but Signet returned ${eventId.slice(0, 16)}…`));
    return {
      verdict: 'failed',
      headline: 'The signature is valid but it is not over the challenge we sent',
      checks,
    };
  }
  checks.push(check('bound to our challenge', 'pass', 'the rebuilt kind-21236 event hashes to exactly the id Signet signed'));

  // 6. Freshness — informational only.
  const ageSeconds = Math.floor(Date.now() / 1000) - createdAt;
  checks.push(check('signed at', Math.abs(ageSeconds) <= 300 ? 'pass' : 'info',
    `${new Date(createdAt * 1000).toISOString()} (${ageSeconds}s ago)`));

  return {
    verdict: 'signed',
    headline: 'My Signet signed correctly',
    checks,
    matchedLaunch: matched,
  };
}

export const VERIFY_BUILD = 'signet-test-harness verify v1';
