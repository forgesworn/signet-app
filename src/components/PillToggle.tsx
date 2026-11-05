/** Small pill toggle used by the settings pages' on/off rows. */
export function PillToggle({ enabled, onToggle, onLabel, offLabel }: {
  enabled: boolean;
  onToggle: (next: boolean) => void;
  /** Accessible name while ON (what a tap will do). */
  onLabel: string;
  /** Accessible name while OFF. */
  offLabel: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onToggle(!enabled)}
      aria-pressed={enabled}
      style={{
        width: 48,
        height: 28,
        borderRadius: 14,
        background: enabled ? 'var(--accent)' : 'var(--border)',
        border: 'none',
        cursor: 'pointer',
        position: 'relative',
        transition: 'background 0.2s',
        flexShrink: 0,
        marginTop: 2,
      }}
      aria-label={enabled ? onLabel : offLabel}
    >
      <span
        style={{
          position: 'absolute',
          top: 3,
          left: enabled ? 23 : 3,
          width: 22,
          height: 22,
          borderRadius: '50%',
          background: 'var(--bg-card)',
          transition: 'left 0.2s',
          display: 'block',
        }}
      />
    </button>
  );
}
