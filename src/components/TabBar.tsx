// src/components/TabBar.tsx
import { type CSSProperties } from 'react';
import { type TabDef, type TabId, BAR_HEIGHT } from '../lib/app-nav';
import { Z } from '../lib/z-index';
import { Icon } from './Icon';

interface Props {
  tabs: TabDef[];
  activeTab: TabId | null;
  onTab: (tab: TabDef) => void;
}

export function TabBar({ tabs, activeTab, onTab }: Props) {
  const container: CSSProperties = {
    display: 'flex', borderTop: '1px solid var(--border)', background: 'var(--bg-card)',
    position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: Z.header,
    paddingBottom: 'env(safe-area-inset-bottom)', height: `calc(${BAR_HEIGHT}px + env(safe-area-inset-bottom))`,
  };

  // data-theme="dark" forces dark tokens so the persistent bottom nav matches the
  // always-dark carousel home shell, instead of following the OS/global theme (which
  // made it render white on a light-mode desktop while the carousel stayed dark).
  return (
    <nav aria-label="Primary" data-theme="dark" style={container}>
      {tabs.map(t => {
        const active = t.id === activeTab;
        const item: CSSProperties = {
          flex: 1,
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          gap: 2, padding: '8px 0 6px',
          background: 'none',
          border: 'none', borderRadius: 0, cursor: 'pointer',
          color: active ? 'var(--accent)' : 'var(--text-secondary)', font: 'inherit',
        };
        return (
          <button key={t.id} type="button" onClick={() => onTab(t)}
            aria-current={active ? 'page' : undefined} style={item}>
            <Icon name={t.icon} size={20} />
            <span style={{ fontSize: 11 }}>{t.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
