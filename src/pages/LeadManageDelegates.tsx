import { shortNpub } from '../lib/signet';
/**
 * LeadManageDelegates — in-app delegate add/remove UI.
 *
 * Allows a lead to add or remove delegates from their kind-30202 roster event.
 * Delegates can sign roster updates on behalf of leads (spec §3.5.3).
 *
 * Flow:
 *   - View current delegates
 *   - Add: paste npub → Tier 2 PIN gate → double-confirm → sign + publish
 *   - Remove: click Remove → Tier 2 PIN gate → double-confirm → sign + publish
 *
 * Spec: 2026-04-25-pro-surface-architecture-design.md §3.5.3, §3.5.5
 * Phase 5, Task 9.
 */

import { useState } from 'react';
import { buildRosterEvent, buildRosterUpdate } from '../lib/professional/role-anchor';
import type { AnchorContext, RosterMember } from '../lib/professional/role-anchor';
import { runProGate } from '../lib/professional/pro-gates';
import type { SigningBackend } from '../lib/signing-backend';
import { publishEvent } from '../lib/relay-service';
import { nip19 } from 'nostr-tools';
import type { PurposeContext } from '../lib/auth-purposes';

interface Props {
  /** Current delegates (hex pubkeys). */
  currentDelegates: string[];
  /** Current roster members — preserved in full on every update. */
  currentMembers: RosterMember[];
  /** Anchor context for the lead's firm. */
  anchorCtx: AnchorContext;
  /** Pro persona signing backend. */
  proBackend: SigningBackend;
  /** Called after a successful add or remove (so the parent can re-fetch / navigate back). */
  onComplete: () => void;
  onBack: () => void;
  /** Standard auth callback — prompts unlock if needed. */
  requestAuth: (ctx?: PurposeContext) => Promise<string | null>;
  /** Fresh-auth callback — always re-prompts (Tier 2 gate requirement). */
  requestFreshAuth: (ctx?: PurposeContext) => Promise<string | null>;
}

type ConfirmAction =
  | { type: 'add'; delegateHex: string; delegateNpub: string }
  | { type: 'remove'; delegateHex: string };

/**
 * Decode an npub to a hex pubkey. Returns null if decoding fails.
 */
function decodeNpubToHex(npub: string): string | null {
  try {
    const decoded = nip19.decode(npub);
    if (decoded.type === 'npub') return decoded.data as string;
    return null;
  } catch {
    return null;
  }
}

export function LeadManageDelegates({
  currentDelegates,
  currentMembers,
  anchorCtx,
  proBackend,
  onComplete,
  requestAuth: _requestAuth,
  requestFreshAuth,
}: Props) {
  const [pendingAdd, setPendingAdd] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const [confirmWorking, setConfirmWorking] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  // ── Add flow ─────────────────────────────────────────────────────────────────

  async function handleAddClick() {
    setAddError(null);
    const trimmed = pendingAdd.trim();
    if (!trimmed.startsWith('npub1') || trimmed.length < 60) {
      setAddError('Please enter a valid npub (starts with npub1, at least 60 characters).');
      return;
    }
    const hex = decodeNpubToHex(trimmed);
    if (!hex) {
      setAddError('Could not decode that npub. Please check it and try again.');
      return;
    }
    if (currentDelegates.includes(hex)) {
      setAddError('That pubkey is already a delegate.');
      return;
    }

    // Tier 2 gate — fresh PIN / biometric, with purpose context so the
    // prompt explains the action and which firm it affects.
    try {
      await runProGate(
        'manageDelegates',
        {
          requestAuth: requestFreshAuth,
          requestFreshAuth,
          payload: null,
          purposeContext: {
            purpose: 'mutate-professional-roster',
            firmName: anchorCtx.entityName,
            action: 'add-delegate',
          },
        },
        async () => {
          setConfirmAction({ type: 'add', delegateHex: hex, delegateNpub: trimmed });
        },
      );
    } catch (e) {
      if (e instanceof Error && e.message === 'auth-cancelled') return;
      setAddError('Authentication failed. Please try again.');
    }
  }

  // ── Remove flow ───────────────────────────────────────────────────────────────

  async function handleRemoveClick(delegateHex: string) {
    // Tier 2 gate — fresh PIN / biometric, with purpose context.
    try {
      await runProGate(
        'manageDelegates',
        {
          requestAuth: requestFreshAuth,
          requestFreshAuth,
          payload: null,
          purposeContext: {
            purpose: 'mutate-professional-roster',
            firmName: anchorCtx.entityName,
            action: 'remove-delegate',
          },
        },
        async () => {
          setConfirmAction({ type: 'remove', delegateHex });
        },
      );
    } catch (e) {
      if (e instanceof Error && e.message === 'auth-cancelled') return;
    }
  }

  // ── Confirm: sign + publish ───────────────────────────────────────────────────

  async function handleConfirm() {
    if (!confirmAction) return;
    setConfirmWorking(true);
    setConfirmError(null);
    try {
      const updated =
        confirmAction.type === 'add'
          ? buildRosterUpdate({ currentMembers, currentDelegates, addDelegate: confirmAction.delegateHex })
          : buildRosterUpdate({ currentMembers, currentDelegates, removeDelegate: confirmAction.delegateHex });

      const template = buildRosterEvent(anchorCtx, updated.members, updated.delegates);
      const unsigned = { ...template, pubkey: proBackend.activePublicKeyHex };
      const signed = await proBackend.signEvent(unsigned);
      await publishEvent(signed as Parameters<typeof publishEvent>[0]);

      setConfirmAction(null);
      onComplete();
    } catch (e) {
      setConfirmError(e instanceof Error ? e.message : 'Something went wrong. Please try again.');
    } finally {
      setConfirmWorking(false);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div className="fade-in" style={{ padding: 24 }}>
      <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: 24, lineHeight: 1.5 }}>
        Delegates can sign roster updates on behalf of leads. They appear in the authority union (spec §3.5.3).
      </p>

      {/* Current delegates list */}
      <p style={{ fontWeight: 600, fontSize: '0.9rem', marginBottom: 10 }}>Current delegates</p>
      {currentDelegates.length === 0 ? (
        <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginBottom: 24 }}>
          No delegates yet. Add one below.
        </p>
      ) : (
        <div style={{ marginBottom: 24 }}>
          {currentDelegates.map(hex => {
            const isSelf = hex === proBackend.activePublicKeyHex;
            return (
              <div
                key={hex}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '10px 14px',
                  borderRadius: 8,
                  border: '1px solid var(--border)',
                  marginBottom: 6,
                }}
              >
                <span
                  style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem', color: 'var(--text-primary)' }}
                  title={nip19.npubEncode(hex)}
                >
                  {shortNpub(hex)}
                </span>
                <button
                  className="btn btn-ghost btn-sm"
                  style={{ fontSize: '0.8rem', padding: '4px 10px', color: 'var(--error)' }}
                  onClick={() => handleRemoveClick(hex)}
                >
                  {isSelf ? 'Leave this role' : 'Remove'}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Add delegate section */}
      <p style={{ fontWeight: 600, fontSize: '0.9rem', marginBottom: 8 }}>Add a delegate</p>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <input
          type="text"
          value={pendingAdd}
          onChange={e => { setPendingAdd(e.target.value); setAddError(null); }}
          placeholder="npub1…"
          style={{
            flex: 1,
            padding: '10px 12px',
            borderRadius: 8,
            border: '1px solid var(--border)',
            fontSize: '0.9rem',
          }}
          autoComplete="off"
          autoCapitalize="none"
          onKeyDown={e => { if (e.key === 'Enter') { void handleAddClick(); } }}
        />
        <button
          className="btn btn-secondary"
          onClick={() => { void handleAddClick(); }}
          disabled={!pendingAdd.trim()}
        >
          Add
        </button>
      </div>
      {addError && (
        <p style={{ color: 'var(--error)', fontSize: '0.85rem', marginBottom: 12 }}>{addError}</p>
      )}

      {/* Double-confirm dialog */}
      {confirmAction && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="manage-delegates-confirm-title"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'var(--scrim)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: 24,
          }}
        >
          <div style={{
            background: 'var(--bg-card)',
            borderRadius: 12,
            padding: 24,
            maxWidth: 360,
            width: '100%',
          }}>
            <h3 id="manage-delegates-confirm-title" style={{ marginBottom: 12 }}>
              {confirmAction.type === 'add' ? 'Confirm: add delegate' : 'Confirm: remove delegate'}
            </h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: 8, lineHeight: 1.6 }}>
              {confirmAction.type === 'add'
                ? 'Add this delegate? They will be able to sign roster updates on your behalf.'
                : 'Remove this delegate? They will no longer be able to sign roster updates.'}
            </p>
            <p style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '0.75rem',
              wordBreak: 'break-all',
              color: 'var(--text-muted)',
              marginBottom: 12,
            }}>
              {confirmAction.type === 'add'
                ? confirmAction.delegateNpub
                : confirmAction.delegateHex}
            </p>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 16, lineHeight: 1.5 }}>
              A new kind-30202 roster event will be signed and published.
            </p>

            {confirmError && (
              <p style={{ color: 'var(--error)', fontSize: '0.85rem', marginBottom: 12 }}>
                {confirmError}
              </p>
            )}

            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="btn btn-ghost"
                style={{ flex: 1 }}
                onClick={() => { setConfirmAction(null); setConfirmError(null); }}
                disabled={confirmWorking}
              >
                Cancel
              </button>
              <button
                className={confirmAction.type === 'remove' ? 'btn btn-danger' : 'btn btn-primary'}
                style={{ flex: 1 }}
                onClick={() => { void handleConfirm(); }}
                disabled={confirmWorking}
              >
                {confirmWorking
                  ? 'Signing…'
                  : confirmAction.type === 'add'
                    ? 'Yes, add delegate'
                    : 'Yes, remove delegate'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
