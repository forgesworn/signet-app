/**
 * Pro-surface friction gate registry.
 *
 * Each operation is declared with its friction tier (1 or 2) and whether it
 * requires a double-confirm. Callers use `runProGate` to execute the gated
 * operation; tests use `getProGate` / `getProGateConfig` to verify contracts.
 *
 * Pro-gates also carry an `AuthPurpose` so the prompt that fires for the
 * gate carries semantic context (firm name, action, etc.) — see
 * `src/lib/auth-purposes.ts` and the 2026-05-03 auth-purpose-system holodeck.
 */

import type { AuthPurpose, PurposeContext } from '../auth-purposes';

export type ProOperation =
  | 'checkMyJson'
  | 'signRosterEvent'
  | 'signAct'
  | 'editCanonicalWebsite'
  | 'listInDirectory'
  | 'delistFromDirectory'
  | 'rotateLeadPubkey'
  | 'revokeSubRole'
  | 'removeRoleAnchor'
  | 'addStaffMember'
  | 'manageDelegates';

export interface ProGateConfig {
  tier: 1 | 2;
  requireDoubleConfirm: boolean;
  /**
   * Auth purpose used when this gate fires a PIN/biometric prompt.
   * Default for Tier 1 ops with no specific purpose: 'unlock-app' (legacy
   * behaviour). Tier 2 ops should declare a purpose to give the user real
   * context about the elevated action.
   */
  purpose?: AuthPurpose;
}

const GATE_CONFIGS: Record<ProOperation, ProGateConfig> = {
  // Tier 1 — PIN or biometric
  checkMyJson:          { tier: 1, requireDoubleConfirm: false },
  signRosterEvent:      { tier: 1, requireDoubleConfirm: false },
  signAct:              { tier: 1, requireDoubleConfirm: false },
  editCanonicalWebsite: { tier: 1, requireDoubleConfirm: false },
  listInDirectory:      { tier: 1, requireDoubleConfirm: false },
  delistFromDirectory:  { tier: 1, requireDoubleConfirm: false },
  // Tier 2 — fresh PIN + double-confirm
  rotateLeadPubkey:     { tier: 2, requireDoubleConfirm: true,  purpose: 'mutate-professional-roster' },
  revokeSubRole:        { tier: 2, requireDoubleConfirm: true,  purpose: 'mutate-professional-roster' },
  removeRoleAnchor:     { tier: 2, requireDoubleConfirm: true,  purpose: 'mutate-professional-roster' },
  addStaffMember:       { tier: 2, requireDoubleConfirm: true,  purpose: 'mutate-professional-roster' },
  manageDelegates:      { tier: 2, requireDoubleConfirm: true,  purpose: 'mutate-professional-roster' },
};

export function getProGateConfig(op: ProOperation): ProGateConfig {
  return GATE_CONFIGS[op];
}

export interface GateCallbacks {
  requestAuth: (ctx?: PurposeContext) => Promise<string | null>;
  requestFreshAuth: (ctx?: PurposeContext) => Promise<string | null>;
  payload: unknown;
  /**
   * Optional purpose context to surface in the prompt when the gate's
   * purpose calls for it. Caller assembles it from in-scope state
   * (firmName, recipientShort, etc.). Ignored if the gate has no purpose.
   */
  purposeContext?: PurposeContext;
}

/**
 * Returns a gate function for the given operation.
 * The gate calls the appropriate auth tier and returns the key.
 * Throws 'auth-cancelled' if the user cancels.
 */
export function getProGate(
  op: ProOperation,
): (callbacks: GateCallbacks) => Promise<string> {
  const config = GATE_CONFIGS[op];
  return async ({ requestAuth, requestFreshAuth, purposeContext }: GateCallbacks) => {
    const key = config.tier === 2
      ? await requestFreshAuth(purposeContext)
      : await requestAuth(purposeContext);
    if (!key) throw new Error('auth-cancelled');
    return key;
  };
}

/**
 * Execute a gated Pro operation.
 *
 * @param op — the operation name
 * @param callbacks — auth callbacks from App.tsx
 * @param action — the async action to perform; receives the encryption key
 */
export async function runProGate<T>(
  op: ProOperation,
  callbacks: GateCallbacks,
  action: (key: string) => Promise<T>,
): Promise<T> {
  const gate = getProGate(op);
  const key = await gate(callbacks);
  return action(key);
}
