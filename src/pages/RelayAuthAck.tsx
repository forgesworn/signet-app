/**
 * Relay Auth Acknowledgement Screen
 *
 * Shown after a relay-mode "Sign in with Signet" response has been published
 * (or failed to publish). The user stays in the Signet app and closes manually
 * once they have switched back to their other device.
 *
 * Success: "✓ Signed in to {site name}" — terminal Close button.
 * Denied:  "✗ Declined {site name}"    — terminal Close button.
 * Failure: "Couldn't deliver response to {relay host}" — Retry + Cancel.
 *
 * Retry holds an in-flight pending state — the button disables and the
 * label flips to "Retrying…" while the underlying re-publish is in
 * flight (up to ~10s — see `publishToRelay`'s NIP-20 OK-frame wait in
 * `relay-publish.ts`). Without this gate an impatient user can stack
 * multiple parallel re-publishes; the relay deduplicates by event id
 * so the end state is correct, but the cancel-button-vs-retry-spinner
 * race is bad UX.
 */

import { useCallback, useState } from 'react';
import { isNativeApp, SignetNative } from '../lib/native';

interface SuccessProps {
  state: 'approved' | 'denied';
  siteName: string;
  onClose: () => void;
  /**
   * Optional same-origin post-approval URL. When present (and `state` is
   * `'approved'`), the ack renders an "Open <hostname>" primary CTA that
   * navigates here on tap. Validated by `parseSignInRequest` upstream —
   * any cross-origin / invalid `post=` is stripped before reaching us.
   *
   * No auto-redirect, no countdown — the navigation is gated entirely
   * on the user's tap. See the internal couch-gaming
   * spec for the design rationale.
   */
  postUrl?: string;
}

interface FailureProps {
  state: 'failed';
  relayHost: string;
  /**
   * Re-publish the same already-signed event to the same relay. Returns
   * the publish result so the component can flip out of pending state
   * even when the parent doesn't immediately replace this view (e.g. a
   * second failure keeps us on `failed`).
   */
  onRetry: () => void | Promise<unknown>;
  onCancel: () => void;
}

type Props = SuccessProps | FailureProps;

function isFailure(p: Props): p is FailureProps {
  return p.state === 'failed';
}

export function RelayAuthAck(props: Props) {
  const isFail = isFailure(props);
  const [retrying, setRetrying] = useState(false);

  const onRetry = isFail ? props.onRetry : undefined;
  const handleRetry = useCallback(async () => {
    if (!onRetry) return;
    if (retrying) return;
    setRetrying(true);
    try {
      await Promise.resolve(onRetry());
    } finally {
      // The parent typically replaces this view on success (transitions
      // to `approved`) so this `setRetrying(false)` is a no-op. On a
      // second failure the parent re-mounts us with a fresh `retry`
      // closure but the same `failed` status — without resetting we'd
      // stay disabled forever. Safe to call unconditionally.
      setRetrying(false);
    }
  }, [onRetry, retrying]);

  if (isFail) {
    return (
      <div className="fade-in" role="main">
        <div className="section">
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              marginBottom: 16,
            }}
          >
            <span
              style={{
                flexShrink: 0,
                width: 40,
                height: 40,
                borderRadius: '50%',
                background: 'var(--warning-light)',
                border: '1px solid var(--warning)',
                color: 'var(--warning)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '1.2rem',
                fontWeight: 700,
              }}
              aria-hidden="true"
            >
              !
            </span>
            <h2 style={{ margin: 0 }}>Delivery failed</h2>
          </div>

          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: 24 }}>
            Couldn&apos;t deliver response to{' '}
            <strong>{props.relayHost.slice(0, 128)}</strong>. Try again?
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <button
              className="btn btn-primary"
              onClick={handleRetry}
              disabled={retrying}
              aria-busy={retrying || undefined}
            >
              {retrying ? 'Retrying…' : 'Retry'}
            </button>
            <button
              className="btn btn-ghost"
              onClick={props.onCancel}
              disabled={retrying}
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

  const approved = props.state === 'approved';

  return (
    <div className="fade-in" role="main">
      <div className="section">
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            marginBottom: 16,
          }}
        >
          <span
            style={{
              flexShrink: 0,
              width: 40,
              height: 40,
              borderRadius: '50%',
              background: approved ? 'var(--success-light)' : 'var(--danger-light)',
              border: `1px solid ${approved ? 'var(--success)' : 'var(--danger)'}`,
              color: approved ? 'var(--success)' : 'var(--danger)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '1.2rem',
              fontWeight: 700,
            }}
            aria-hidden="true"
          >
            {approved ? '\u2713' : '\u2717'}
          </span>
          <h2 style={{ margin: 0 }}>
            {approved ? 'Signed in' : 'Declined'}
          </h2>
        </div>

        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: 24 }}>
          {approved
            ? props.postUrl
              ? <>You have signed in to <strong>{props.siteName.slice(0, 64)}</strong>.</>
              : <>You have signed in to <strong>{props.siteName.slice(0, 64)}</strong>. Return to the app or page where you started to continue.</>
            : <>You declined to sign in to <strong>{props.siteName.slice(0, 64)}</strong>.</>
          }
        </p>

        {approved && isNativeApp() && (
          <button className="btn btn-primary" style={{ width: '100%', marginBottom: 12 }}
            onClick={() => { void SignetNative.returnToPreviousApp(); }}>
            Return to {props.siteName.slice(0, 64)}
          </button>
        )}

        {approved && props.postUrl
          ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <button
                className="btn btn-primary"
                onClick={() => { window.location.href = props.postUrl!; }}
              >
                Open {truncateHostname(props.postUrl)} →
              </button>
              <button className="btn btn-ghost" onClick={props.onClose}>
                Close
              </button>
            </div>
          )
          : (
            <button className="btn btn-primary" onClick={props.onClose}>
              Close
            </button>
          )
        }
      </div>
    </div>
  );
}

/**
 * Render the hostname of an already-validated post URL, truncated to fit a
 * narrow viewport. The URL has been parsed and same-origin-checked by
 * `parseSignInRequest` upstream, so `new URL()` cannot throw here — but
 * we defend in depth and fall back to the raw string if it somehow does.
 */
function truncateHostname(rawUrl: string): string {
  let host: string;
  try {
    host = new URL(rawUrl).hostname;
  } catch {
    host = rawUrl.slice(0, 32);
  }
  return host.length > 32 ? host.slice(0, 31) + '…' : host;
}
