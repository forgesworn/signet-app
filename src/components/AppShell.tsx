// src/components/AppShell.tsx
import type { ReactNode } from 'react';
import type { Page } from '../types';
import { TabBar } from './TabBar';
import { barTabsFor, isBarHiddenPage, activeTabForPage, BAR_HEIGHT, type TabDef, type BunkerTint } from '../lib/app-nav';

interface Props {
  page: Page;
  isDependantContext: boolean;
  /** A child's phone paired straight to the Heartwood: it is the child's bunker. */
  childBunker?: boolean;
  onNavigate: (page: Page) => void;
  onBunker: () => void;
  bunkerPanelOpen?: boolean;
  /** Serving state of the Bunker key: grey (off), amber (wanted), green (serving). */
  bunkerTint?: BunkerTint;
  children: ReactNode;
}

const TINT_COLOUR: Record<BunkerTint, string> = {
  off: 'var(--text-secondary)',
  wanted: 'var(--warning)',
  serving: 'var(--success)',
};

export function AppShell({ page, isDependantContext, childBunker, onNavigate, onBunker, bunkerPanelOpen, bunkerTint, children }: Props) {
  if (isBarHiddenPage(page)) return <>{children}</>;

  const tabs = barTabsFor({ isDependantContext, childBunker });
  const activeTab = bunkerPanelOpen ? 'bunker' : activeTabForPage(page);

  const handleTab = (t: TabDef) => {
    if (t.id === 'bunker') { onBunker(); return; } // opens the Bunker panel
    if (t.page) onNavigate(t.page);
  };

  const bar = <TabBar tabs={tabs} activeTab={activeTab} onTab={handleTab}
    tint={bunkerTint ? { bunker: TINT_COLOUR[bunkerTint] } : undefined} />;

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 1, minWidth: 0, paddingBottom: `calc(${BAR_HEIGHT}px + env(safe-area-inset-bottom))` }}>
        {children}
      </div>
      {bar}
    </div>
  );
}
