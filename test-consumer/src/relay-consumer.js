// Relay-mode consumer for the Signet Test Harness.
//
// The redirect flow hands the answer back in the URL. The cross-device flow
// does not: Signet gift-wraps the response (NIP-59) to a session key the
// consumer minted, and publishes it to the relay the consumer named. The
// consumer has to stay subscribed, unwrap three layers, and verify what it
// finds. That is the path Fathom and Skative use, and it is the one this
// module reproduces.
//
// Layers, outermost first:
//   kind 1059 wrap   — ephemeral author, ["p", sessionPubkey], NIP-44 content
//   kind 13   seal   — authored by the SIGNER, NIP-44 content
//   kind 29999 rumor — ["session", requestId], ["status", "approved"],
//                      content = JSON AuthResponse { authEvent, … }
//   kind 21236 auth  — the same signed challenge event the redirect flow returns

import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { nip44 } from 'nostr-tools';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { eventIdFor } from './verify.js';

const WRAP_KIND = 1059;
const SEAL_KIND = 13;
const RESPONSE_KIND = 29999;
const AUTH_KIND = 21236;

/** A fresh session identity for one sign-in attempt. */
export function newSession() {
  const secretKey = generateSecretKey();
  return {
    secretKey,
    secretKeyHex: bytesToHex(secretKey),
    publicKey: getPublicKey(secretKey),
  };
}

/**
 * Rebuild a session from its stored secret.
 *
 * On a phone the browser may discard the tab while you approve in the signer
 * app. Without the session key the response cannot be decrypted at all, so
 * the harness saves it and resumes rather than making you start over. This is
 * throwaway per-attempt key material in a dev harness — it authenticates
 * nothing and signs nothing.
 */
export function sessionFromSecret(secretKeyHex) {
  const secretKey = hexToBytes(secretKeyHex);
  return { secretKey, secretKeyHex, publicKey: getPublicKey(secretKey) };
}

function decrypt(sessionSecret, senderPubkey, ciphertext) {
  const conversationKey = nip44.getConversationKey(sessionSecret, senderPubkey);
  return nip44.decrypt(ciphertext, conversationKey);
}

function check(name, status, detail) {
  return { name, status, detail };
}

/**
 * Unwrap and verify a kind-1059 event addressed to this session.
 *
 * @param wrap     the event as it came off the relay
 * @param session  from newSession()
 * @param expected { challenge, origin } this attempt asked for
 * @returns { verdict, headline, checks, response? }
 */
export function verifyWrappedResponse(wrap, session, expected) {
  const checks = [];

  if (!wrap || wrap.kind !== WRAP_KIND) {
    return { verdict: 'failed', headline: `Expected a kind-${WRAP_KIND} gift wrap, got kind ${wrap && wrap.kind}`, checks };
  }
  if (!verifyEvent(wrap)) {
    return { verdict: 'failed', headline: 'The gift wrap is not correctly signed', checks };
  }
  checks.push(check('gift wrap', 'pass', `kind ${WRAP_KIND} addressed to this session, signature valid`));

  // Layer 1 → the seal.
  let seal;
  try {
    seal = JSON.parse(decrypt(session.secretKey, wrap.pubkey, wrap.content));
  } catch (e) {
    return { verdict: 'failed', headline: 'The gift wrap did not decrypt to this session key', checks: [...checks, check('wrap decrypts', 'fail', e.message)] };
  }
  if (!seal || seal.kind !== SEAL_KIND) {
    return { verdict: 'failed', headline: `Inside the wrap was kind ${seal && seal.kind}, expected the kind-${SEAL_KIND} seal`, checks };
  }
  if (!verifyEvent(seal)) {
    return { verdict: 'failed', headline: 'The seal is not correctly signed', checks: [...checks, check('seal', 'fail', 'signature invalid')] };
  }
  checks.push(check('seal', 'pass', `kind ${SEAL_KIND} from ${seal.pubkey.slice(0, 16)}…, signature valid`));

  // Layer 2 → the rumor.
  let rumor;
  try {
    rumor = JSON.parse(decrypt(session.secretKey, seal.pubkey, seal.content));
  } catch (e) {
    return { verdict: 'failed', headline: 'The seal did not decrypt', checks: [...checks, check('seal decrypts', 'fail', e.message)] };
  }
  if (!rumor || rumor.kind !== RESPONSE_KIND) {
    return { verdict: 'failed', headline: `Inside the seal was kind ${rumor && rumor.kind}, expected the kind-${RESPONSE_KIND} response`, checks };
  }
  if (rumor.pubkey !== seal.pubkey) {
    return {
      verdict: 'failed',
      headline: 'The response and the seal name different authors',
      checks: [...checks, check('same author', 'fail', `rumor ${rumor.pubkey.slice(0, 16)}… vs seal ${seal.pubkey.slice(0, 16)}…`)],
    };
  }
  checks.push(check('response', 'pass', `kind ${RESPONSE_KIND}, same author as the seal`));

  const status = (rumor.tags || []).find((t) => t[0] === 'status')?.[1];
  const session_ = (rumor.tags || []).find((t) => t[0] === 'session')?.[1];
  if (status && status !== 'approved') {
    return { verdict: 'denied', headline: `Signet answered status=${status}`, checks: [...checks, check('status', 'info', status)] };
  }
  if (expected?.challenge && session_ && session_ !== expected.challenge) {
    return {
      verdict: 'failed',
      headline: 'The response is for a different sign-in attempt',
      checks: [...checks, check('session tag', 'fail', `${session_.slice(0, 16)}… is not our request id`)],
    };
  }
  checks.push(check('session tag', 'pass', 'the response names this attempt'));

  // Layer 3 → the AuthResponse payload and the signed challenge inside it.
  let response;
  try {
    response = JSON.parse(rumor.content);
  } catch (e) {
    return { verdict: 'failed', headline: 'The response payload is not JSON', checks: [...checks, check('payload', 'fail', e.message)] };
  }
  const authEvent = response && response.authEvent;
  if (!authEvent || authEvent.kind !== AUTH_KIND) {
    return { verdict: 'failed', headline: `The response carried no kind-${AUTH_KIND} auth event`, checks };
  }
  if (!verifyEvent(authEvent)) {
    return { verdict: 'failed', headline: 'The signed challenge does not verify', checks: [...checks, check('signature verifies', 'fail', 'BIP-340 verification failed')] };
  }
  if (eventIdFor(authEvent) !== authEvent.id) {
    return { verdict: 'failed', headline: 'The auth event id does not match its own contents', checks: [...checks, check('event id', 'fail', 'recomputed id differs')] };
  }
  checks.push(check('signature verifies', 'pass', 'BIP-340 Schnorr signature is valid over the auth event'));

  const tag = (name) => (authEvent.tags || []).find((t) => t[0] === name)?.[1];
  if (expected?.challenge) {
    if (tag('challenge') !== expected.challenge) {
      return {
        verdict: 'failed',
        headline: 'The signature is valid but it is not over the challenge we sent',
        checks: [...checks, check('bound to our challenge', 'fail', `signed ${String(tag('challenge')).slice(0, 16)}…, we sent ${expected.challenge.slice(0, 16)}…`)],
      };
    }
    checks.push(check('bound to our challenge', 'pass', 'the signed event carries exactly the challenge we sent'));
  }
  if (expected?.origin) {
    if (tag('origin') !== expected.origin) {
      return {
        verdict: 'failed',
        headline: 'The signature is bound to a different origin',
        checks: [...checks, check('bound to our origin', 'fail', `signed ${String(tag('origin')).slice(0, 60)}`)],
      };
    }
    checks.push(check('bound to our origin', 'pass', expected.origin));
  }
  if (authEvent.pubkey !== seal.pubkey) {
    checks.push(check('signer', 'info', 'the auth event and the seal use different keys of the same identity'));
  }

  return {
    verdict: 'signed',
    headline: 'My Signet signed correctly and delivered it over the relay',
    checks,
    response,
    signerPubkey: authEvent.pubkey,
  };
}

/**
 * One-shot: ask the relay for everything ever addressed to this session, with
 * no `since` window at all.
 *
 * This is the difference between "Signet never published" and "we were asleep
 * when it did" — the two look identical to a live subscription that missed
 * the event, and only one of them is Signet's fault.
 */
export function fetchAll(relayUrl, session, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const events = [];
    let socket;
    const finish = () => {
      clearTimeout(timer);
      try { socket && socket.close(); } catch { /* already gone */ }
      resolve(events);
    };
    const timer = setTimeout(finish, timeoutMs);
    try { socket = new WebSocket(relayUrl); } catch { return finish(); }
    const subId = 'signet-harness-catchup-' + Math.random().toString(36).slice(2, 8);
    socket.onopen = () => socket.send(JSON.stringify(['REQ', subId, {
      kinds: [WRAP_KIND], '#p': [session.publicKey], limit: 20,
    }]));
    socket.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg[0] === 'EVENT' && msg[1] === subId) events.push(msg[2]);
      else if (msg[0] === 'EOSE' || msg[0] === 'CLOSED') finish();
    };
    socket.onerror = finish;
    socket.onclose = () => resolve(events);
  });
}

/**
 * Subscribe to one relay for gift wraps addressed to this session.
 *
 * Deliberately a bare WebSocket rather than a pool: the point is to see
 * exactly what the relay says, including an auth-required refusal, which a
 * pool would swallow as "no events".
 */
export function listen(relayUrl, session, handlers, sinceSeconds) {
  const socket = new WebSocket(relayUrl);
  const subId = 'signet-harness-' + Math.random().toString(36).slice(2, 10);
  let closed = false;
  // Gift wraps are stored events, so a re-subscription replays anything that
  // arrived while this page was backgrounded — which on a phone is most of
  // the time, since approving means switching to another app.
  const since = sinceSeconds ?? Math.floor(Date.now() / 1000) - 60;

  socket.onopen = () => {
    handlers.onStatus?.('connected', `subscribed on ${relayUrl}`);
    socket.send(JSON.stringify(['REQ', subId, {
      kinds: [WRAP_KIND],
      '#p': [session.publicKey],
      since,
    }]));
  };
  socket.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    const [type, ...rest] = msg;
    if (type === 'EVENT') handlers.onEvent?.(rest[1]);
    else if (type === 'EOSE') handlers.onStatus?.('listening', 'relay is live, waiting for the response');
    else if (type === 'CLOSED') handlers.onStatus?.('refused', String(rest[1] || 'the relay closed the subscription'));
    else if (type === 'NOTICE') handlers.onStatus?.('notice', String(rest[0] || ''));
  };
  socket.onerror = () => handlers.onStatus?.('error', `could not reach ${relayUrl}`);
  socket.onclose = () => { if (!closed) handlers.onStatus?.('disconnected', 'the relay connection closed'); };

  return () => {
    closed = true;
    try { socket.send(JSON.stringify(['CLOSE', subId])); } catch { /* already gone */ }
    try { socket.close(); } catch { /* already gone */ }
  };
}
