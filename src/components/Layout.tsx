import type { ReactNode } from 'react';
import { GuardianBanner } from './GuardianBanner';
import { Z } from '../lib/z-index';

interface Props {
  title?: string;
  showBack?: boolean;
  onBack?: () => void;
  /** When true, the header bar uses the guardian colour (amber) */
  guardianMode?: boolean;
  /** Dependant name for the guardian banner */
  guardianDependantName?: string;
  /**
   * True when in true child-mode (PIN-gated exit, strict-mirror view). False
   * when guardian is just managing a dep-scoped page (e.g. opened "Phone &
   * Pairing" from carousel col-2). Banner copy differs.
   */
  guardianActingAs?: boolean;
  /** Exit guardian mode */
  onExitGuardianMode?: () => void;
  /** Open the dependant hand-off picker (only meaningful if >1 dependant). */
  onOpenHandoffPicker?: () => void;
  children: ReactNode;
}

export function Layout({ title, showBack, onBack, guardianMode, guardianDependantName, guardianActingAs, onExitGuardianMode, onOpenHandoffPicker, children }: Props) {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* Header tint pairs with the banner colour: amber for true child-mode
       (acting-as), accent blue for guardian-managing-dep, neutral otherwise. */}
      <header className="layout-header" style={{
        borderBottom: guardianMode
          ? (guardianActingAs ? '2px solid var(--guardian)' : '2px solid var(--accent)')
          : '1px solid var(--border)',
        background: guardianMode
          ? (guardianActingAs ? 'var(--guardian-light)' : 'var(--accent-light)')
          : 'var(--bg-card)',
        zIndex: Z.header,
      }}>
        {showBack && (
          <button type="button" className="layout-back" onClick={onBack} aria-label="Go back">
            &#8249;
          </button>
        )}
        <h2 className="layout-title" style={{ marginLeft: showBack ? 0 : 4 }}>{title || 'MySignet'}</h2>
      </header>
      {guardianMode && guardianDependantName && onExitGuardianMode && (
        <GuardianBanner
          dependantName={guardianDependantName}
          onSwitchBack={onExitGuardianMode}
          onOpenSwitcher={onOpenHandoffPicker}
          actingAs={!!guardianActingAs}
        />
      )}
      <main className="page" style={{ flex: 1 }}>
        {children}
      </main>
    </div>
  );
}
