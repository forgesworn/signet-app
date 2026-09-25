/**
 * Professional gateway page.
 * Entry point from Profile → Professional row.
 *
 * - No anchor: explainer + "Set up Professional role" CTA.
 * - Has anchor: redirect to Professional Dashboard immediately.
 *
 * Spec: the internal Pro-surface architecture design doc, §4.1
 */

import { useEffect } from 'react';
import type { ProRoleAnchorRecord } from '../lib/professional/types';

interface Props {
  anchor: ProRoleAnchorRecord | null;
  isLoading: boolean;
  onSetupPro: () => void;
  onGoToDashboard: () => void;
  onGoToSubRoleDashboard?: () => void;
  hasPendingSelfCert?: boolean;
  onBack: () => void;
}

export function Professional({
  anchor,
  isLoading,
  onSetupPro,
  onGoToDashboard,
  onGoToSubRoleDashboard,
  hasPendingSelfCert,
}: Props) {
  useEffect(() => {
    if (!isLoading && anchor) {
      onGoToDashboard();
    }
  }, [anchor, isLoading, onGoToDashboard]);

  useEffect(() => {
    if (!isLoading && !anchor && hasPendingSelfCert && onGoToSubRoleDashboard) {
      onGoToSubRoleDashboard();
    }
  }, [anchor, isLoading, hasPendingSelfCert, onGoToSubRoleDashboard]);

  if (isLoading) {
    return (
      <div style={{ padding: 24, textAlign: 'center' }}>
        <p style={{ color: 'var(--text-secondary)' }}>Checking professional role…</p>
      </div>
    );
  }

  if (anchor) {
    // Will redirect via useEffect — render nothing while effect fires
    return null;
  }

  return (
    <div className="fade-in">
      <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: 1.6, marginBottom: 8 }}>
        Signet Professional lets you act in your professional capacity — as a head teacher, GP, or solicitor — with your role anchored to a regulator-listed organisation.
      </p>
      <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: 1.6, marginBottom: 8 }}>
        Once set up, you can sign rosters, issue credentials, and be verified by parents, patients, and clients — all within the existing Signet trust chain.
      </p>
      <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: 1.6, marginBottom: 24 }}>
        You'll need a Tier 3+ personal identity credential first, and access to your organisation's website to publish a short verification file.
      </p>

      <button
        className="btn btn-primary"
        onClick={onSetupPro}
        style={{ width: '100%' }}
      >
        Set up Professional role
      </button>
    </div>
  );
}
