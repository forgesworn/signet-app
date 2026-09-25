import type { SignetIdentity } from '../types';
import { useVenueEntry } from '../hooks/useVenueEntry';
import { useScreenWakeLock } from '../hooks/useScreenWakeLock';
import type { SigningBackend } from '../lib/signing-backend';
import { QRCode } from '../components/QRCode';

interface Props {
  identity: SignetIdentity;
  backend: SigningBackend;
  onBack: () => void;
  onNavigatePhoto: () => void;
}

function CountdownArc({ seconds, total }: { seconds: number; total: number }) {
  const radius = 18;
  const circumference = 2 * Math.PI * radius;
  const progress = seconds / total;
  const offset = circumference * (1 - progress);

  return (
    <svg width="44" height="44" viewBox="0 0 44 44" aria-label={`${seconds} seconds until refresh`}>
      <circle
        cx="22" cy="22" r={radius}
        fill="none"
        stroke="rgba(14,42,71,0.14)"
        strokeWidth="3"
      />
      <circle
        cx="22" cy="22" r={radius}
        fill="none"
        stroke="#0E2A47"
        strokeWidth="3"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        strokeLinecap="round"
        transform="rotate(-90 22 22)"
        style={{ transition: 'stroke-dashoffset 1s linear' }}
      />
      <text
        x="22" y="22"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize="12"
        fontWeight="600"
        fill="#596979"
      >
        {seconds}
      </text>
    </svg>
  );
}

export function VenueEntry({ identity, backend, onBack, onNavigatePhoto }: Props) {
  useScreenWakeLock(true);

  const { qrData, secondsRemaining, generatedAt, error } = useVenueEntry(
    backend,
    identity.naturalPerson.publicKey,
    identity.photoHash,
    identity.blossomUrl,
    identity.photoKey,
  );

  const timeStr = generatedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const displayName = identity.naturalPerson.displayName || 'Venue Entry';
  const hasPhoto = !!identity.photoHash;

  return (
    <div
      className="fade-in"
      role="main"
      aria-label="Venue entry pass"
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#ffffff',
        color: '#1A1A2E',
        padding: '20px',
        position: 'relative',
      }}
    >
      {/* Top row — 40px circular back target consistent with .layout-back,
          a small eyebrow, and the display name. */}
      <button
        onClick={onBack}
        aria-label="Back to home"
        className="layout-back"
        style={{
          position: 'absolute',
          top: 16,
          left: 16,
          color: '#1A1A2E',
        }}
      >
        &#8249;
      </button>

      <div style={{ textAlign: 'center', marginBottom: 16 }}>
        <div style={{ fontSize: '0.72rem', fontWeight: 600, letterSpacing: '0.08em', color: '#9CA3AF', marginBottom: 4, textTransform: 'uppercase' }}>
          Venue entry
        </div>
        <div style={{ fontSize: 18, fontWeight: 600 }}>
          {displayName.slice(0, 100)}
        </div>
      </div>

      {/* QR Code */}
      <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'center' }}>
        {qrData && (
          <QRCode data={qrData} size={Math.min(window.innerWidth - 80, 400)} />
        )}
      </div>

      {error && (
        <div style={{ color: '#ef4444', textAlign: 'center', marginTop: 12, fontSize: 14 }}>
          {error}
        </div>
      )}

      {/* Generated at timestamp */}
      <div style={{ fontSize: 12, color: '#888', marginBottom: 12 }}>
        Generated at {timeStr}
      </div>

      {/* Countdown arc */}
      <CountdownArc seconds={secondsRemaining} total={30} />

      {/* D11 — e2e/venue-entry.spec.ts asserts this element is visible and
          reads its textContent as JSON, so it stays rendered (not collapsed
          behind <details>) but styled as a small, muted, captioned
          technical block instead of a naked wall of JSON. */}
      {qrData && (
        <div
          style={{
            marginTop: 16,
            maxWidth: 300,
            width: '100%',
            border: '1px solid #E5E7EB',
            borderRadius: 8,
            padding: '8px 12px',
            textAlign: 'center',
          }}
        >
          <div style={{ fontSize: '0.68rem', fontWeight: 600, color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
            Payload
          </div>
          <div
            data-testid="qr-payload"
            className="mono"
            style={{ color: '#9CA3AF', userSelect: 'all', fontSize: '0.68rem', maxHeight: 72, overflowY: 'auto', textAlign: 'left' }}
          >
            {qrData}
          </div>
        </div>
      )}

      {/* Photo hint */}
      {!hasPhoto && (
        <button
          onClick={onNavigatePhoto}
          style={{
            marginTop: 24,
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            color: 'var(--accent)',
            fontSize: 14,
            textDecoration: 'underline',
          }}
        >
          Add photo for visual matching
        </button>
      )}
    </div>
  );
}
