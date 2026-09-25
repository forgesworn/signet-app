import { useMemo, useState } from 'react';
import { useApprovalPickerChoice, WAITING_FOR_SIGNER_COPY } from '../hooks/useApprovalPickerChoice';
import type { NostrConnectRequest } from '../lib/nip46';
import type { SignetIdentity, DependantIdentity } from '../types';
import type { KeypairOption } from '../lib/keypair-policy';
import { resolvePolicy, shouldOverrideIncomingDefault } from '../lib/keypair-policy';
import { shortNpub } from '../lib/signet';
import { computeAge } from '../lib/date-utils';
import { KeypairBadge } from '../components/KeypairBadge';
import type { AuthSelection } from './ApproveAuth';
import { buildGuardianKeypairOptions, buildDependantKeypairOptions } from '../lib/auth-selection';

interface Props {
  request: NostrConnectRequest;
  identity: SignetIdentity;
  /** Whether the guardian has selectable signing identities. */
  canSwitchGuardianPersona: boolean;
  availableGuardianPubkeys?: readonly string[];
  /** Dependants available for signing (only when local backends exist). */
  dependants?: Array<Pick<DependantIdentity, 'id' | 'displayName' | 'dateOfBirth' | 'naturalPerson' | 'persona' | 'extraPersonas' | 'primaryKeypair' | 'naturalPersonActive'>>;
  /** Initial signing selection (e.g. the carousel's active row when the request arrived). */
  defaultSelection?: AuthSelection;
  /** NP-ceiling guardrail — extra confirmation before signing with natural-person. */
  requireNpConfirmation: boolean;
  /** User's default-to-persona setting (no consumer hint applies here). */
  preferPersonaForSignIns?: boolean;
  /** Pinned preferred persona pubkey for the default selection. */
  preferredPersonaPubkey?: string;
  /**
   * Parent resolves the selection to a SigningBackend and performs
   * sendConnectResponse. Should reject on network/send failure so the
   * component can surface the retry state.
   */
  onApprove: (selection: AuthSelection) => Promise<void>;
  onDeny: () => void;
  /** The user's explicit pick for THIS request, held by App (survives a lock remount). */
  userChoice?: { selection: AuthSelection | null };
  onUserChoice?: (selection: AuthSelection | null) => void;
  /** Listed guardian slots whose route to the paired signer is not back yet. */
  waitingGuardianPubkeys?: readonly string[];
}

export function ApproveConnect({
  request,
  identity,
  canSwitchGuardianPersona,
  availableGuardianPubkeys,
  dependants,
  defaultSelection,
  requireNpConfirmation,
  preferPersonaForSignIns,
  preferredPersonaPubkey,
  onApprove,
  onDeny,
  userChoice,
  onUserChoice,
  waitingGuardianPubkeys,
}: Props) {
  // Shared builder — same ring order and dormant-NP exclusion as ApproveAuth,
  // then bound to the keys this signing route can actually reach.
  const guardianOptions: KeypairOption[] = useMemo(
    () => buildGuardianKeypairOptions(identity)
      .filter(option => !availableGuardianPubkeys || availableGuardianPubkeys.includes(option.pubkey)),
    [identity, availableGuardianPubkeys],
  );

  // `nostrconnect://` has no consumer hint — pass null and lean entirely
  // on the user-defaults (preferPersonaForSignIns) to pick an initial row.
  const guardianPolicy = useMemo(
    () => resolvePolicy({
      options: guardianOptions,
      consumerHint: null,
      appGuardrails: { requireNpConfirmation },
      userDefaults: { preferPersonaForSignIns, preferredPersonaPubkey },
    }),
    [guardianOptions, requireNpConfirmation, preferPersonaForSignIns, preferredPersonaPubkey],
  );

  // True when the guardian half of the picker renders nothing at all: either
  // the policy ranked no option, or the locked-primary branch has no matching
  // option (primary is the natural person and it is still dormant).
  const guardianPickerEmpty = canSwitchGuardianPersona
    ? guardianPolicy.ranked.length === 0
    : !guardianOptions.some(o => o.key === identity.primaryKeypair);

  const dependantOptionsById = useMemo(() => {
    const map = new Map<string, KeypairOption[]>();
    for (const dep of dependants ?? []) {
      const opts = buildDependantKeypairOptions(dep);
      const policy = resolvePolicy({
        options: opts,
        consumerHint: null,
        appGuardrails: { requireNpConfirmation },
        userDefaults: { preferPersonaForSignIns, preferredPersonaPubkey },
      });
      map.set(dep.id, policy.ranked);
    }
    return map;
  }, [dependants, requireNpConfirmation, preferPersonaForSignIns, preferredPersonaPubkey]);

  const hasAnyDependantOption = useMemo(
    () => Array.from(dependantOptionsById.values()).some(arr => arr.length > 0),
    [dependantOptionsById],
  );

  const resolvedDefault = useMemo<AuthSelection | null>(() => {
    if (defaultSelection) {
      if (defaultSelection.source === 'guardian'
          && guardianPolicy.ranked.some(o => o.key === defaultSelection.keypairType)) {
        // Same incidental-NP-default override as ApproveAuth — let the
        // persona preference win over the carousel's NP row. No
        // consumer hint exists on the nostrconnect path, so this only ever
        // turns on when the resolver promoted a persona.
        if (shouldOverrideIncomingDefault({
          incomingSource: 'guardian',
          incomingKey: defaultSelection.keypairType,
          resolverDefaultKey: guardianPolicy.defaultKey,
          hasConsumerHint: false,
        })) {
          return { source: 'guardian', keypairType: guardianPolicy.defaultKey! };
        }
        return defaultSelection;
      }
      if (defaultSelection.source === 'dependant') {
        const depOpts = dependantOptionsById.get(defaultSelection.dependantId);
        if (depOpts?.some(o => o.key === defaultSelection.keypairType)) return defaultSelection;
      }
    }
    if (guardianPolicy.defaultKey) {
      return { source: 'guardian', keypairType: guardianPolicy.defaultKey };
    }
    for (const dep of dependants ?? []) {
      const opts = dependantOptionsById.get(dep.id);
      if (opts && opts.length > 0) {
        return { source: 'dependant', dependantId: dep.id, keypairType: opts[0].key };
      }
    }
    return null;
  }, [defaultSelection, guardianPolicy, dependantOptionsById, dependants]);

  const {
    selection,
    setSelection,
    selectionWaiting,
    isWaitingPubkey,
    missingChosenOption,
    missingChosenCopy,
  } = useApprovalPickerChoice<AuthSelection>({
    identity,
    resolvedDefault,
    offeredGuardianKeys: guardianPolicy.ranked.map(o => o.key),
    guardianOptions,
    resolvePubkey: (sel) => {
      if (sel?.source !== 'guardian') return null;
      if (sel.keypairType === 'natural-person') return identity.naturalPerson.publicKey;
      return buildGuardianKeypairOptions(identity).find(o => o.key === sel.keypairType)?.pubkey ?? null;
    },
    userChoice,
    onUserChoice,
    waitingGuardianPubkeys,
  });
  const [showNpConfirm, setShowNpConfirm] = useState(false);
  const [status, setStatus] = useState<'pending' | 'sending' | 'sent' | 'error'>('pending');
  const [error, setError] = useState<string | null>(null);

  const isGuardianSelected = (keypairType: string) =>
    selection?.source === 'guardian' && selection.keypairType === keypairType;
  const isDependantSelected = (depId: string, keypairType: string) =>
    selection?.source === 'dependant' && selection.dependantId === depId && selection.keypairType === keypairType;

  const npBlocked = requireNpConfirmation
    && selection?.source === 'guardian'
    && selection.keypairType === 'natural-person'
    && !showNpConfirm;

  async function handleApprove() {
    if (!selection || status === 'sending' || selectionWaiting) return;
    setStatus('sending');
    setError(null);
    try {
      await onApprove(selection);
      setStatus('sent');
    } catch (e) {
      setStatus('error');
      setError(e instanceof Error ? e.message : 'Failed to connect — please try again');
    }
  }

  return (
    <div className="fade-in" role="main">
      <div className="section">
        <h2 style={{ marginBottom: 8 }}>Connection Request</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: 20 }}>
          <strong>{request.appName.slice(0, 100)}</strong> wants to connect to your Signet.
        </p>
      </div>

      <div className="card section">
        <div className="section-title">Connection details</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: '0.9rem' }}>
            <span style={{ color: 'var(--text-muted)' }}>App: </span>
            <span style={{ fontWeight: 600 }}>{request.appName.slice(0, 100)}</span>
          </div>
          {request.appUrl && (
            <div style={{ fontSize: '0.9rem' }}>
              <span style={{ color: 'var(--text-muted)' }}>URL: </span>
              <span style={{ wordBreak: 'break-all' }}>{request.appUrl?.slice(0, 100)}</span>
            </div>
          )}
          <div style={{ fontSize: '0.85rem' }}>
            <span style={{ color: 'var(--text-muted)' }}>Relay: </span>
            <span style={{ wordBreak: 'break-all', color: 'var(--text-secondary)' }}>{request.relayUrl.slice(0, 100)}</span>
          </div>
        </div>
      </div>

      {/* Identity picker */}
      <div className="card section">
        <div className="section-title">Connect as</div>

        {canSwitchGuardianPersona ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {guardianPolicy.ranked.map(({ key, token, label, pubkey }) => (
              <button
                key={key}
                className={`btn ${isGuardianSelected(key) ? 'btn-tile-selected' : 'btn-secondary'}`}
                onClick={() => { setSelection({ source: 'guardian', keypairType: key }); setShowNpConfirm(false); }}
                disabled={status === 'sending'}
                style={{ padding: '10px 14px', textAlign: 'left', justifyContent: 'flex-start' }}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontWeight: 600 }}>{label.slice(0, 100)}</span>
                    <KeypairBadge token={token} />
                  </div>
                  <div style={{ fontSize: '0.75rem', fontWeight: 400, opacity: 0.7, fontFamily: 'var(--font-mono)' }}>
                    {shortNpub(pubkey)}
                  </div>
                  {isWaitingPubkey(pubkey) && (
                    <div style={{ fontSize: '0.75rem', fontWeight: 400, opacity: 0.8 }}>
                      {WAITING_FOR_SIGNER_COPY}
                    </div>
                  )}
                </div>
              </button>
            ))}
            {missingChosenOption && (
              <button
                key={`missing-${missingChosenOption.key}`}
                className="btn btn-primary"
                disabled
                style={{ padding: '10px 14px', textAlign: 'left', justifyContent: 'flex-start' }}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontWeight: 600 }}>{missingChosenOption.label.slice(0, 100)}</span>
                    <KeypairBadge token={missingChosenOption.token} />
                  </div>
                  <div style={{ fontSize: '0.75rem', fontWeight: 400, opacity: 0.8 }}>
                    {missingChosenCopy}
                  </div>
                </div>
              </button>
            )}
          </div>
        ) : (
          (() => {
            const current = guardianOptions.find(o => o.key === identity.primaryKeypair);
            if (!current) return null;
            return (
              <button
                className="btn btn-primary"
                disabled
                style={{ padding: '10px 14px', textAlign: 'left', justifyContent: 'flex-start', cursor: 'default' }}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontWeight: 600 }}>{current.label.slice(0, 100)}</span>
                    <KeypairBadge token={current.token} />
                  </div>
                  <div style={{ fontSize: '0.75rem', fontWeight: 400, opacity: 0.7, fontFamily: 'var(--font-mono)' }}>
                    {shortNpub(current.pubkey)}
                  </div>
                </div>
              </button>
            );
          })()
        )}

        {/* A dormant real identity is excluded from the picker (spec §6), so an
            identity with no persona yet can leave the list empty. Say why. */}
        {guardianPickerEmpty && (
          <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', margin: 0 }}>
            You have no persona set up to connect with yet. Add one, or set up your real
            identity, from Settings &rsaquo; Personas.
          </p>
        )}

        {dependants && dependants.length > 0 && hasAnyDependantOption && (
          <>
            <div style={{
              fontSize: 11,
              fontWeight: 600,
              color: 'var(--text-muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              padding: '12px 0 6px',
              borderTop: '1px solid var(--border)',
              marginTop: 10,
            }}>
              Dependants
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {dependants.map((dep) => {
                const depAllowed = dependantOptionsById.get(dep.id) ?? [];
                if (depAllowed.length === 0) return null;
                const age = dep.dateOfBirth ? computeAge(dep.dateOfBirth) : null;
                return (
                  <div key={dep.id}>
                    <div style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-muted)', padding: '6px 0 2px' }}>
                      {dep.displayName.slice(0, 100)}
                      {age !== null && <span style={{ fontSize: '0.7rem', fontWeight: 400, opacity: 0.7, marginLeft: 6 }}>age {age}</span>}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {depAllowed.map(({ key, token, label, pubkey }) => {
                        const isActive = isDependantSelected(dep.id, key);
                        return (
                          <button
                            key={key}
                            className={`btn ${isActive ? 'btn-tile-selected' : 'btn-secondary'}`}
                            onClick={() => { setSelection({ source: 'dependant', dependantId: dep.id, keypairType: key }); setShowNpConfirm(false); }}
                            disabled={status === 'sending'}
                            style={{
                              padding: '8px 14px',
                              textAlign: 'left',
                              justifyContent: 'flex-start',
                              borderColor: isActive ? undefined : 'var(--guardian, var(--border))',
                            }}
                          >
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <span style={{ fontWeight: 600 }}>{label.slice(0, 100)}</span>
                                <KeypairBadge token={token} />
                              </div>
                              <div style={{ fontSize: '0.75rem', fontWeight: 400, opacity: 0.7, fontFamily: 'var(--font-mono)' }}>
                                {shortNpub(pubkey)}
                              </div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      {/* NP-ceiling confirmation — only when NP is selected and the guardrail is on. */}
      {selection?.source === 'guardian' && selection.keypairType === 'natural-person' && requireNpConfirmation && (
        <div
          className="card section"
          style={{
            background: showNpConfirm ? 'var(--success-light)' : 'var(--warning-light)',
            borderColor: showNpConfirm ? 'var(--success)' : 'var(--warning)',
          }}
        >
          {!showNpConfirm ? (
            <>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>
                Connecting with your real-name identity
              </div>
              <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 10 }}>
                <strong>{(identity.naturalPerson.displayName || 'Real identity').slice(0, 100)}</strong> is your natural-person keypair. Most apps don't need it — a persona is usually enough.
              </p>
              <button className="btn btn-secondary" onClick={() => setShowNpConfirm(true)} style={{ width: '100%' }}>
                Yes, connect with my real-name identity
              </button>
            </>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <span style={{ color: 'var(--success)', fontSize: '0.85rem' }}>
                Real-name connection confirmed.
              </span>
              <button className="btn btn-ghost" onClick={() => setShowNpConfirm(false)} style={{ fontSize: '0.8rem', padding: '4px 8px' }}>
                Undo
              </button>
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="card section" style={{ background: 'var(--danger-light)', borderColor: 'var(--danger)' }}>
          <p style={{ fontSize: '0.85rem', color: 'var(--danger)', marginBottom: 0 }}>
            {error}
          </p>
        </div>
      )}

      {(status === 'pending' || status === 'error') && (
        <div className="section" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <button
            className="btn btn-primary"
            disabled={!selection || npBlocked || selectionWaiting}
            onClick={handleApprove}
          >
            {status === 'error' ? 'Try again' : 'Approve'}
          </button>
          <button className="btn btn-ghost" onClick={onDeny}>
            Deny
          </button>
        </div>
      )}

      {status === 'sending' && (
        <div className="section" style={{ textAlign: 'center' }}>
          <p style={{ color: 'var(--text-secondary)' }}>Sending...</p>
        </div>
      )}

      {status === 'sent' && (
        <div className="section" style={{ textAlign: 'center' }}>
          <p style={{ color: 'var(--success)', fontWeight: 600 }}>Connected!</p>
        </div>
      )}
    </div>
  );
}
