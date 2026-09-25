import { routeQR, type AuthRequest } from './qr-router';
import { signAuthChallenge } from './signet';
import { giftWrap, publishToRelay } from './relay-publish';
import { buildAuthResponseEventTemplate } from 'signet-protocol';
import type { DecryptingSigningBackend } from './signing-backend';

/** A separate selection namespace: never a guardian extra-persona token. */
export interface BotAuthSelection { source: 'bot'; botPubkey: string }

export function parseBotAuthRequest(raw: string): AuthRequest {
  const action = routeQR(raw);
  if (action.type !== 'auth' || action.request.type !== 'signet-auth-request') {
    throw new Error('Use a sign-in QR for this bot. Credentials and app connections need their own approval.');
  }
  const request = action.request;
  if (!request.relay || !request.sessionPubkey || !Number.isFinite(request.timestamp)) {
    throw new Error('This bot sign-in needs an encrypted relay response.');
  }
  // Copy only the fields this consent authorises; no callback or extra fields.
  return { type: 'signet-auth-request', requestId: request.requestId, challenge: request.challenge,
    origin: request.origin, relay: request.relay, sessionPubkey: request.sessionPubkey, timestamp: request.timestamp };
}

/** One consent, one authentication proof. Does not mint a persistent grant. */
export async function approveBotAuth(options: {
  selection: BotAuthSelection; request: AuthRequest; isCurrent(): boolean;
  signer(selection: BotAuthSelection): Promise<DecryptingSigningBackend>;
}): Promise<void> {
  const selection = { ...options.selection };
  const request = parseBotAuthRequest(JSON.stringify(options.request));
  const current = () => {
    if (!options.isCurrent()) throw new Error('Bot sign-in session changed');
    if (Math.abs(Date.now() / 1000 - request.timestamp) > 300) throw new Error('Sign-in request expired. Scan a fresh QR.');
  };
  current();
  if (selection.source !== 'bot' || !/^[0-9a-f]{64}$/.test(selection.botPubkey)) throw new Error('Select a bot');
  const backend = await options.signer(selection);
  try {
    current();
    if (backend.activePublicKeyHex !== selection.botPubkey) throw new Error('Wrong bot signer');
    const { authEvent } = await signAuthChallenge(backend, request.challenge, request.origin);
    current();
    if (authEvent.pubkey !== selection.botPubkey) throw new Error('Wrong bot signature');
    const response = { type: 'signet-auth-response' as const, requestId: request.requestId, authEvent };
    const wrapped = await giftWrap(buildAuthResponseEventTemplate(response, selection.botPubkey), request.sessionPubkey!, backend);
    current();
    const delivered = await publishToRelay(wrapped, request.relay!);
    current();
    if (!delivered) throw new Error('The app relay did not confirm delivery. You can try again.');
  } finally { backend.destroy(); }
}
