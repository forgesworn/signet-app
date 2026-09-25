interface Props {
  dependantName: string;
  onSwitchBack: () => void;
  onOpenSwitcher?: () => void;
  /**
   * True when the guardian has entered child-mode via carousel swipe — strict
   * mirror of the kid's surface, PIN-gated exit. False when the guardian is
   * just deep-paged to a dep-scoped page (e.g. tapped Phone & Pairing from
   * carousel col-2) — they're still in guardian context. Copy differs so the
   * user doesn't read "Acting as" when they're not.
   */
  actingAs: boolean;
}

export function GuardianBanner({ dependantName, onSwitchBack, onOpenSwitcher, actingAs }: Props) {
  const label = actingAs ? `Acting as ${dependantName}` : `Managing ${dependantName}`;
  // Acting-as = amber alert (device handed over, strict mirror). Managing =
  // accent blue informational (still in guardian context, just scoped to
  // a dep). Distinct hue + text colour so users don't conflate the two.
  const bg = actingAs ? 'var(--guardian)' : 'var(--accent)';
  const textColor = actingAs ? 'var(--guardian-text)' : 'var(--on-accent)';
  return (
    <div
      style={{
        width: '100%',
        height: 36,
        background: bg,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative',
        flexShrink: 0,
      }}
    >
      {/* Banner label — tapping opens the switcher if available */}
      {onOpenSwitcher ? (
        <button
          onClick={onOpenSwitcher}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            fontSize: 14,
            fontWeight: 600,
            color: textColor,
            padding: '0 8px',
            WebkitTapHighlightColor: 'transparent',
            lineHeight: 1,
          }}
          aria-label={`${label} — open account switcher`}
        >
          {label}
        </button>
      ) : (
        <span
          style={{
            fontSize: 14,
            fontWeight: 600,
            color: textColor,
            padding: '0 8px',
            lineHeight: 1,
          }}
        >
          {label}
        </span>
      )}

      {/* Back to me link — right-aligned */}
      <button
        onClick={onSwitchBack}
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          fontSize: 14,
          fontWeight: 600,
          color: textColor,
          position: 'absolute',
          right: 12,
          top: '50%',
          transform: 'translateY(-50%)',
          padding: 0,
          WebkitTapHighlightColor: 'transparent',
          lineHeight: 1,
          whiteSpace: 'nowrap',
        }}
        aria-label="Switch back to your own identity"
      >
        Back to me →
      </button>
    </div>
  );
}
