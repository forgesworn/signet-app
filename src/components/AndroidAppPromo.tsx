// Dumb home card promoting the native Android APK. All show/snooze state lives
// in App.tsx via lib/android-promo; this renders + calls back. Styled to match
// the home nag cards (accent left-border, card section).
interface Props {
  onGetApp: () => void;
  onSnooze: () => void;
}

export function AndroidAppPromo({ onGetApp, onSnooze }: Props) {
  return (
    <div className="card section" style={{ borderLeft: '3px solid var(--accent)' }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>Get the Android app</div>
      <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 12 }}>
        Fingerprint unlock and always-on approvals, even with the screen off — no Google needed.
      </p>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn btn-primary" onClick={onGetApp} style={{ flex: 1 }}>Get the app</button>
        <button className="btn btn-ghost" onClick={onSnooze}>Not now</button>
      </div>
    </div>
  );
}
