/**
 * Approval page for the third-party-initiated add-dependant flow
 * (`?action=add-dependant&...`). Modelled on `ApproveAuth.tsx`.
 *
 * Surfaces the consumer app name + origin prominently, takes a
 * (pre-filled, editable) child name and DOB, and on approve mints
 * the dependant + signs a kind-21236 proof event tying the new
 * dependant to the consumer's challenge.
 */

import { useMemo, useState } from 'react';
import type { AddDependantRequest } from '../lib/url-auth';
import { computeAge } from '../lib/date-utils';

interface Props {
  request: AddDependantRequest;
  /**
   * Whether the auto-pair checkbox should be shown. True iff phone-bunker
   * infrastructure is available — i.e. we can
   * mint a one-shot pairing secret for the new dependant's
   * `appBunkerEndpoint` slot. App-side gating: this is `bunkerServerEnabled`
   * in App.tsx.
   */
  canAutoPair: boolean;
  onApprove: (params: {
    childName: string;
    dateOfBirth?: string;
    autoPair: boolean;
  }) => Promise<void> | void;
  onCancel: () => void;
}

function safeOrigin(origin: string): string {
  try {
    return new URL(origin).hostname || origin.slice(0, 64);
  } catch {
    return origin.slice(0, 64);
  }
}

export function ApproveAddDependant({ request, canAutoPair, onApprove, onCancel }: Props) {
  const [childName, setChildName] = useState<string>(request.childName ?? '');
  const [dateOfBirth, setDateOfBirth] = useState<string>('');
  const [autoPair, setAutoPair] = useState<boolean>(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nameError, setNameError] = useState('');
  const [dobError, setDobError] = useState('');

  const originDisplay = useMemo(() => safeOrigin(request.origin), [request.origin]);
  // request.name is already sanitised by parseAddDependantRequest, but cap defensively.
  const consumerName = request.name.slice(0, 64);

  const validate = (): boolean => {
    let valid = true;
    const trimmedName = childName.trim();
    if (!trimmedName) {
      setNameError('Please enter their name.');
      valid = false;
    } else {
      setNameError('');
    }

    if (dateOfBirth) {
      const dob = new Date(dateOfBirth);
      const now = new Date();
      if (isNaN(dob.getTime())) {
        setDobError('Please enter a valid date.');
        valid = false;
      } else if (dob >= now) {
        setDobError('Date of birth must be in the past.');
        valid = false;
      } else {
        const age = computeAge(dateOfBirth);
        if (age >= 18) {
          setDobError('This person is 18 or older. Dependant accounts are for under-18s only.');
          valid = false;
        } else {
          setDobError('');
        }
      }
    } else {
      setDobError('');
    }

    return valid;
  };

  const handleSubmit = async () => {
    if (submitting) return;
    if (!validate()) return;
    setSubmitting(true);
    setError(null);
    try {
      await onApprove({
        childName: childName.trim(),
        dateOfBirth: dateOfBirth || undefined,
        autoPair: canAutoPair && autoPair,
      });
    } catch (e) {
      setSubmitting(false);
      setError(e instanceof Error ? e.message : 'Could not add dependant — please try again');
    }
  };

  const headline = `${consumerName} wants to add a child to your Signet`;
  const bodyCopy = `You'll be the guardian. Their identity stays with you until they're ready to take it over.`;

  // Mobile layout
  return (
    <div className="fade-in" role="main">
      <div className="section">
        <h2 style={{ marginBottom: 8 }}>{headline}</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: 16, lineHeight: 1.5 }}>
          {bodyCopy}
        </p>
        <div
          className="card"
          style={{
            background: 'var(--bg-card-alt)',
            borderColor: 'var(--border)',
            marginBottom: 20,
          }}
        >
          <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            <div><strong>App:</strong> {consumerName}</div>
            <div style={{ marginTop: 4 }}><strong>Origin:</strong> {originDisplay}</div>
          </div>
        </div>
      </div>

      <div className="section">
        <div style={{ marginBottom: 16 }}>
          <label
            htmlFor="add-dep-name-m"
            style={{ display: 'block', fontWeight: 600, marginBottom: 6, fontSize: '0.9rem' }}
          >
            Their name
          </label>
          <input
            id="add-dep-name-m"
            className="input"
            type="text"
            placeholder="Enter their name"
            value={childName}
            onChange={e => setChildName(e.target.value.slice(0, 100))}
            maxLength={100}
            disabled={submitting}
            autoFocus
            autoComplete="off"
          />
          {nameError && (
            <p style={{ color: 'var(--danger)', fontSize: '0.85rem', marginTop: 4 }}>{nameError}</p>
          )}
        </div>

        <div style={{ marginBottom: 20 }}>
          <label
            htmlFor="add-dep-dob-m"
            style={{ display: 'block', fontWeight: 600, marginBottom: 6, fontSize: '0.9rem' }}
          >
            Date of birth <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: '0.8rem' }}>(optional)</span>
          </label>
          <input
            id="add-dep-dob-m"
            className="input"
            type="date"
            value={dateOfBirth}
            onChange={e => setDateOfBirth(e.target.value)}
            disabled={submitting}
          />
          {dobError && (
            <p style={{ color: 'var(--danger)', fontSize: '0.85rem', marginTop: 4 }}>{dobError}</p>
          )}
        </div>

        {canAutoPair && (
          <label
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 10,
              fontSize: '0.9rem',
              marginBottom: 20,
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={autoPair}
              onChange={e => setAutoPair(e.target.checked)}
              disabled={submitting}
              style={{ marginTop: 3 }}
            />
            <span>
              Auto-pair <strong>{consumerName}</strong> to this dependant.
              <span style={{ display: 'block', color: 'var(--text-secondary)', fontSize: '0.8rem', marginTop: 2 }}>
                Skips a separate pairing step.
              </span>
            </span>
          </label>
        )}

        {error && (
          <div
            className="card"
            style={{
              background: 'var(--danger-light)',
              borderColor: 'var(--danger)',
              marginBottom: 16,
            }}
          >
            <p style={{ fontSize: '0.85rem', color: 'var(--danger)', marginBottom: 0 }}>
              {error}
            </p>
          </div>
        )}

        <button className="btn btn-primary" onClick={handleSubmit} disabled={submitting}>
          {submitting ? 'Adding…' : 'Add dependant'}
        </button>
        <button
          className="btn btn-ghost"
          onClick={onCancel}
          disabled={submitting}
          style={{ marginTop: 8 }}
        >
          Cancel
        </button>
      </div>

      {/* Display unused props placeholder so this stays simple — DOB used via state above. */}
      {/* age preview kept inline if the user types a DOB */}
      {dateOfBirth && !dobError && (() => {
        try {
          const age = computeAge(dateOfBirth);
          return (
            <div className="section" style={{ marginTop: -8, fontSize: '0.8rem', color: 'var(--text-muted)' }}>
              Age: {age}
            </div>
          );
        } catch { return null; }
      })()}
    </div>
  );
}
