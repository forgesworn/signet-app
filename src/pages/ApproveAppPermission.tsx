/**
 * Approval page for `?action=app-permission` (an app asks to show other
 * players that this key plays its game). Modelled on ApproveAddDependant.
 *
 * Three shapes: an adult signing as their own persona, a child phone paired
 * straight to the Heartwood (the guardian decides, this page waits), and a
 * plain refusal. All wording is My Signet's; the app contributes only its
 * sanitised name, and its reason, shown in its own frame (M7).
 */
import { useMemo, useState } from 'react';
import type { AppPermissionRequest } from '../lib/app-permission';
import type { AppPermissionRoute } from '../lib/app-permission-flow';
import { APP_PERMISSION_COPY as COPY } from '../lib/app-permission-copy';
import { friendlyApprovalError } from '../lib/signer-error-copy';
import { PairedChildApprovalWaiting } from '../components/PairedChildApprovalWaiting';
import { NaturalPersonConfirmSection } from '../components/NaturalPersonConfirmSection';

interface Props {
  request: AppPermissionRequest;
  route: AppPermissionRoute;
  /** The display name of the key the permission is for. */
  personaName: string;
  /** Resolves when the answer is on its way; a throw is shown here and the page stays. */
  onApprove: (opts: { realIdentityConfirmed: boolean }) => Promise<void>;
  /** Cancel, Close and the back chevron: the app is told it was declined. */
  onCancel: () => void;
  /**
   * M5: the key is the activated real-name identity and the
   * `requireNpConfirmation` guardrail is on: Allow waits for the same
   * two-step confirmation a sign-in asks for.
   */
  confirmRealIdentity?: boolean;
}

function hostOf(origin: string): string {
  try { return new URL(origin).host || origin.slice(0, 64); } catch { return origin.slice(0, 64); }
}

/** A date in the reader's own format; the template's `valid_until` is unix seconds. */
export function formatPermissionDate(unixS: number): string {
  return new Date(unixS * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

export function shortKey(hex: string): string {
  return `${hex.slice(0, 8)}…${hex.slice(-4)}`;
}

export function ApproveAppPermission({ request, route, personaName, onApprove, onCancel, confirmRealIdentity = false }: Props) {
  const [working, setWorking] = useState(false);
  const [realIdentityConfirmed, setRealIdentityConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const host = useMemo(() => hostOf(request.origin), [request.origin]);
  const persona = personaName.slice(0, 64) || 'you';
  const app = request.name.slice(0, 64);
  const until = formatPermissionDate(request.details.validUntil);

  if (route.mode === 'refused') {
    return (
      <div className="fade-in" role="main">
        <div className="section" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <h2 style={{ margin: 0 }}>{app}</h2>
          <p role="alert" style={{ margin: 0, color: 'var(--text-secondary)' }}>{COPY.refusals[route.reason]}</p>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{COPY.from(host)}</div>
          <button className="btn btn-primary" onClick={onCancel}>{COPY.close}</button>
        </div>
      </div>
    );
  }

  const child = route.mode === 'child-direct';
  const needsConfirm = !child && confirmRealIdentity && !realIdentityConfirmed;
  const approve = async () => {
    if (working || needsConfirm) return;
    setWorking(true);
    setError(null);
    try {
      await onApprove({ realIdentityConfirmed: !child && confirmRealIdentity && realIdentityConfirmed });
    } catch (e) {
      setWorking(false);
      setError(friendlyApprovalError(e));
    }
  };

  return (
    <div className="fade-in" role="main">
      <div className="section" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <h2 style={{ margin: 0, lineHeight: 1.3 }}>
          {child ? COPY.headingChild(app) : COPY.headingAdult(app, persona)}
        </h2>
        <div>
          <div style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', marginBottom: 4 }}>
            {COPY.appSaysLabel}
          </div>
          {/* M7: the app's own words, framed apart from My Signet's. */}
          <div data-testid="app-permission-reason" style={{ padding: 8, borderRadius: 8, background: 'var(--bg-secondary)', border: '1px solid var(--border)',
            color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {request.reason}
          </div>
        </div>
        <div>
          <div style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', marginBottom: 4 }}>
            {COPY.allowsTitle}
          </div>
          <p data-testid="app-permission-allows" style={{ margin: 0, fontSize: '0.9rem' }}>
            {child ? COPY.allowsChild(app, persona, until) : COPY.allowsAdult(app, persona, until)}
          </p>
        </div>
        <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
          <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{COPY.from(host)}</div>
          <details>
            <summary>{COPY.details}</summary>
            <div>{COPY.appId}: {request.details.appId}</div>
            <div>{COPY.installKey}: {shortKey(request.details.installKey)}</div>
            <div>{COPY.validUntil}: {until}</div>
          </details>
        </div>
        {!child && (
          <NaturalPersonConfirmSection
            display={persona}
            requireConfirm={confirmRealIdentity}
            confirmed={realIdentityConfirmed}
            onConfirm={() => setRealIdentityConfirmed(true)}
            onUndo={() => setRealIdentityConfirmed(false)}
            copy={COPY.realIdentityConfirm}
          />
        )}
        {error && <div role="alert" style={{ color: 'var(--danger)', fontSize: '0.9rem', fontWeight: 600 }}>{error}</div>}
        {child && working ? (
          <PairedChildApprovalWaiting onCancel={onCancel} direct />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <button className="btn btn-primary" disabled={working || needsConfirm} aria-busy={working || undefined} onClick={() => { void approve(); }}>
              {working ? COPY.working : child ? (error ? COPY.tryAgain : COPY.askGuardian) : COPY.allow}
            </button>
            <button className="btn btn-ghost" disabled={working} onClick={onCancel}>{COPY.cancel}</button>
          </div>
        )}
      </div>
    </div>
  );
}
