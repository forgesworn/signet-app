import type { KeypairToken } from '../types';
import { shortNpub } from '../lib/signet';

/**
 * Single source of truth for the "What will be shared" content unit.
 *
 * Used by all sign-in approval surfaces — ApprovalOverlay (carousel
 * bottom sheet) and ApproveAuth (both viewport modes — mobile full
 * picker and desktop full picker). Each surface differs in chrome (container,
 * spacing, fonts) but the rows below are the same everywhere — same
 * labels, same row order, same conditional logic.
 *
 * Adding a new row here is a one-edit change. Re-implementing this list
 * inline in any caller silently forks the share preview across surfaces
 * Don't.
 */

interface Props {
  /** Pubkey of the picked identity (hex). Rendered as npub. */
  pubkey: string | null;
  /** Display name of the picked identity. */
  selectedDisplayName: string | null;
  /** Token type of the picked identity — drives row labelling. */
  selectedToken: KeypairToken | null;
  /** Age range when this is a login+verify request. */
  ageRange: string | null;
  /**
   * Current opt-in state for sharing the persona handle. Ignored when the
   * selected token is `natural-person` — NP always shares its name.
   */
  shareHandle: boolean;
  /**
   * When provided, the persona-handle row renders as a checkbox. Omit for
   * read-only mode (overlay surface — user must use Choose identity to
   * change opt-in).
   */
  onShareHandleChange?: (next: boolean) => void;
  /** Tighter spacing/font for narrow containers like the bottom-sheet overlay. */
  compact?: boolean;
}

const SUCCESS_COLOR = 'var(--success)';
const SUCCESS_BG = 'var(--success-light)';
const SUCCESS_DARK = 'var(--success)';
const DANGER_COLOR = 'var(--danger)';
const DANGER_BG = 'var(--danger-light)';
const DANGER_DARK = 'var(--danger)';

export function SharePreview({
  pubkey,
  selectedDisplayName,
  selectedToken,
  ageRange,
  shareHandle,
  onShareHandleChange,
  compact,
}: Props) {
  const npubDisplay = pubkey ? shortNpub(pubkey) : null;
  const isNp = selectedToken === 'natural-person';
  const isPersona = selectedToken === 'persona' || selectedToken === 'extra-persona';
  const handleValue = selectedDisplayName ?? '(not set)';
  const interactive = !!onShareHandleChange;

  const rowFontSize = compact ? '0.85rem' : '0.9rem';
  const valueFontSize = compact ? '0.78rem' : '0.85rem';
  const monoFontSize = compact ? '0.7rem' : '0.75rem';
  const badgeSize = compact ? 16 : 20;
  const gap = compact ? 8 : 10;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap }}>
      {/* Pubkey — always shared, always shown as npub */}
      {pubkey && (
        <Row
          shared
          label="Your public key"
          value={npubDisplay}
          valueMono
          fontSize={rowFontSize}
          valueFontSize={monoFontSize}
          badgeSize={badgeSize}
        />
      )}

      {/* Age range when login+verify */}
      {ageRange !== null && (
        <Row
          shared
          label={`Your age range (${ageRange})`}
          fontSize={rowFontSize}
          badgeSize={badgeSize}
        />
      )}

      {/* Identity-specific row — flips between persona handle and real name */}
      {isNp && (
        <Row
          shared
          label="Your real name"
          value={selectedDisplayName ?? null}
          fontSize={rowFontSize}
          valueFontSize={valueFontSize}
          badgeSize={badgeSize}
        />
      )}

      {isPersona && interactive && (
        <label
          style={{
            display: 'flex', alignItems: 'center', gap: 12,
            fontSize: rowFontSize, cursor: 'pointer',
          }}
        >
          <input
            type="checkbox"
            checked={shareHandle}
            onChange={e => onShareHandleChange!(e.target.checked)}
            style={{ width: badgeSize - 2, height: badgeSize - 2, flexShrink: 0, accentColor: 'var(--accent)' }}
            aria-label="Share persona handle"
          />
          <span style={{ color: shareHandle ? 'var(--text-primary)' : 'var(--text-muted)' }}>
            Your persona handle
          </span>
          <span
            style={{
              fontStyle: selectedDisplayName ? 'normal' : 'italic',
              opacity: selectedDisplayName ? 0.85 : 0.5,
              fontSize: valueFontSize,
              marginLeft: 'auto',
            }}
          >
            {handleValue}
          </span>
        </label>
      )}

      {isPersona && !interactive && (
        <Row
          shared
          label="Your persona handle"
          value={handleValue}
          valueItalicWhenEmpty={!selectedDisplayName}
          fontSize={rowFontSize}
          valueFontSize={valueFontSize}
          badgeSize={badgeSize}
        />
      )}

      {/* Not-shared rows */}
      {!isNp && (
        <Row
          shared={false}
          label="Your real name"
          fontSize={rowFontSize}
          badgeSize={badgeSize}
        />
      )}

      {ageRange === null && (
        <Row
          shared={false}
          label="Your age or documents"
          fontSize={rowFontSize}
          badgeSize={badgeSize}
        />
      )}

      {/* Read-only handle hint — overlay only. Tells the user how to change
          their mind (since the row above is read-only). */}
      {isPersona && !interactive && (
        <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 2 }}>
          To sign in without sharing your handle, choose a different identity.
        </div>
      )}
    </div>
  );
}

interface RowProps {
  shared: boolean;
  label: string;
  value?: string | null;
  valueMono?: boolean;
  valueItalicWhenEmpty?: boolean;
  fontSize: string;
  valueFontSize?: string;
  badgeSize: number;
}

function Row({ shared, label, value, valueMono, valueItalicWhenEmpty, fontSize, valueFontSize, badgeSize }: RowProps) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize }}>
      <span
        aria-label={shared ? 'will be shared' : 'will not be shared'}
        style={{
          flexShrink: 0,
          width: badgeSize,
          height: badgeSize,
          borderRadius: '50%',
          background: shared ? SUCCESS_BG : DANGER_BG,
          border: `1px solid ${shared ? SUCCESS_COLOR : DANGER_COLOR}`,
          color: shared ? SUCCESS_DARK : DANGER_DARK,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '0.7rem',
          fontWeight: 700,
        }}
      >
        {shared ? '✓' : '✗'}
      </span>
      <span style={{ color: shared ? 'var(--text-primary)' : 'var(--text-muted)' }}>
        {label}
      </span>
      {value && (
        <span
          style={{
            fontFamily: valueMono ? 'var(--font-mono)' : undefined,
            fontStyle: valueItalicWhenEmpty ? 'italic' : 'normal',
            fontSize: valueFontSize,
            opacity: 0.7,
            marginLeft: 'auto',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            minWidth: 0,
          }}
        >
          {value}
        </span>
      )}
    </div>
  );
}
