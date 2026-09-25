// src/components/AppShell.tsx
import type { ReactNode } from 'react';
import type { Page } from '../types';
import { TabBar } from './TabBar';
import { barTabsFor, isBarHiddenPage, activeTabForPage, BAR_HEIGHT, type TabDef } from '../lib/app-nav';

interface Props {
  page: Page;
  isDependantContext: boolean;
  onNavigate: (page: Page) => void;
  onBunker: () => void;
  bunkerPanelOpen?: boolean;
  children: ReactNode;
}

export function AppShell({ page, isDependantContext, onNavigate, onBunker, bunkerPanelOpen, children }: Props) {
  if (isBarHiddenPage(page)) return <>{children}</>;

  const tabs = barTabsFor({ isDependantContext });
  const activeTab = bunkerPanelOpen ? 'bunker' : activeTabForPage(page);

  const handleTab = (t: TabDef) => {
    if (t.id === 'bunker') { onBunker(); return; } // opens the Bunker panel
    if (t.page) onNavigate(t.page);
  };

  const bar = <TabBar tabs={tabs} activeTab={activeTab} onTab={handleTab} />;

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 1, minWidth: 0, paddingBottom: `calc(${BAR_HEIGHT}px + env(safe-area-inset-bottom))` }}>
        {children}
      </div>
      {bar}
    </div>
  );
}
