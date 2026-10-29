// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ScannerSettingsProvider, usePublishScannerSettings, useScannerSettings } from './ScannerSettingsContext';

function Publisher({ idleMs, autoStart }: { idleMs: number; autoStart: boolean }) {
  usePublishScannerSettings(idleMs, autoStart);
  return null;
}
function Reader() {
  const s = useScannerSettings();
  return <div data-testid="out">{s.idleMs}:{String(s.autoStart)}</div>;
}

describe('ScannerSettingsContext', () => {
  it('defaults to 20 s and auto-start on without a provider', () => {
    render(<Reader />);
    expect(screen.getByTestId('out')).toHaveTextContent('20000:true');
  });

  it('readers see what the publisher pushes, and updates', () => {
    const { rerender } = render(
      <ScannerSettingsProvider><Publisher idleMs={10_000} autoStart={false} /><Reader /></ScannerSettingsProvider>,
    );
    expect(screen.getByTestId('out')).toHaveTextContent('10000:false');
    rerender(
      <ScannerSettingsProvider><Publisher idleMs={60_000} autoStart /><Reader /></ScannerSettingsProvider>,
    );
    expect(screen.getByTestId('out')).toHaveTextContent('60000:true');
  });
});
