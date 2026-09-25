/**
 * Operator-key import flow — the pure state machine behind
 * `HeartwoodOperatorImport.tsx` and `useHeartwoodOperator.importLink /
 * importPhrase` (family-bunker §11.1.4/9, C3 design §5).
 *
 * Two entry carriers, one credential out:
 *   - a Sapwood handoff link (`#/import?op=…` plain or `#/import?eop=…`
 *     PIN-protected) — `resolveImportInput`;
 *   - the operator recovery phrase typed by hand, plus the device address
 *     and relay(s) the link would otherwise have carried —
 *     `resolvePhraseInput`. This deliberately re-enters through
 *     `parseHeartwoodImportLink` (a synthetic `#/import?…` string) so the
 *     device-address / relay validation is byte-identical to the link path.
 *
 * No storage, no relay, no React — the hooks persist and start the client.
 */

import {
  buildOperatorCredential,
  decryptOperatorLink,
  operatorFromPhrase,
  parseHeartwoodImportLink,
  HEARTWOOD_OPERATOR_PIN_MIN,
  type HeartwoodOperatorCredential,
} from './heartwood-operator';

export type ImportResolution =
  /** A PIN-protected (`eop=`) link with no PIN supplied yet — ask for one. */
  | { kind: 'needs-pin' }
  | { kind: 'credential'; cred: HeartwoodOperatorCredential }
  | { kind: 'error'; message: string };

/** True when the text parses as a Sapwood handoff link (cheap QR/paste prefilter). */
export function isHeartwoodImportLinkText(text: string): boolean {
  return parseHeartwoodImportLink(text) !== null;
}

/**
 * Turn pasted link text (+ optional PIN) into a credential, a PIN request,
 * or an error message safe to render. `nowSeconds` is injected for tests.
 */
export function resolveImportInput(
  text: string,
  pin?: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): ImportResolution {
  const link = parseHeartwoodImportLink(text);
  if (!link) return { kind: 'error', message: 'That isn’t a Heartwood handoff link. Paste the “Manage from your phone” link from Sapwood.' };
  let skHex: string;
  if (link.op) {
    skHex = link.op;
  } else if (link.eop) {
    const p = (pin ?? '').trim();
    if (!p) return { kind: 'needs-pin' };
    if (p.length < HEARTWOOD_OPERATOR_PIN_MIN) {
      return { kind: 'error', message: `PIN must be at least ${HEARTWOOD_OPERATOR_PIN_MIN} characters.` };
    }
    try {
      skHex = decryptOperatorLink(link.eop, p);
    } catch {
      return { kind: 'error', message: 'Wrong PIN — the link could not be unlocked.' };
    }
  } else {
    return { kind: 'error', message: 'The link carries no operator secret.' };
  }
  try {
    return { kind: 'credential', cred: buildOperatorCredential(link, skHex, nowSeconds) };
  } catch (e) {
    return { kind: 'error', message: e instanceof Error ? e.message : 'Could not read the link.' };
  }
}

/**
 * Phrase fallback: recovery words + device address (npub or hex) + relay
 * URL(s), one per line or comma-separated. Relays are filtered through the
 * same `wss://` safety rule as a link. Returns a credential or an error.
 */
export function resolvePhraseInput(
  words: string,
  deviceInput: string,
  relaysText: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Exclude<ImportResolution, { kind: 'needs-pin' }> {
  let skHex: string;
  try {
    skHex = operatorFromPhrase(words);
  } catch (e) {
    return { kind: 'error', message: e instanceof Error ? e.message : 'Not a valid recovery phrase' };
  }
  const relays = relaysText
    .split(/[\s,]+/)
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
  const synthetic = `#/import?op=${skHex}&dev=${encodeURIComponent(deviceInput.trim())}&relays=${encodeURIComponent(relays.join(','))}`;
  const link = parseHeartwoodImportLink(synthetic);
  if (!link || !link.op) return { kind: 'error', message: 'Could not read the recovery phrase.' };
  if (!link.deviceHex) return { kind: 'error', message: 'Device address must be an npub or 64-hex pubkey.' };
  if (!link.relays || link.relays.length === 0) return { kind: 'error', message: 'Enter at least one wss:// relay the device listens on.' };
  try {
    return { kind: 'credential', cred: buildOperatorCredential(link, skHex, nowSeconds) };
  } catch (e) {
    return { kind: 'error', message: e instanceof Error ? e.message : 'Could not build the credential.' };
  }
}

/** Short device label for settings rows: first 8 hex of the master pubkey. */
export function shortDeviceLabel(deviceHex: string): string {
  return `${deviceHex.slice(0, 8)}…`;
}
