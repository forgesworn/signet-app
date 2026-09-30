// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Layout } from './Layout';
import { PrivateVaultApprovalBanner } from './PrivateVaultApprovalBanner';

afterEach(cleanup);

describe('Layout sticky header', () => {
  it('keeps a solid colour under the guardian tint, which is translucent in the dark theme', () => {
    const { container } = render(<Layout title="Activity" guardianMode guardianDependantName="Kid" onExitGuardianMode={() => {}}>x</Layout>);
    const bg = (container.querySelector('header') as HTMLElement).style.background;
    expect(bg).toContain('var(--accent-light)');
    expect(bg).toContain('var(--bg-card)');
  });
  it('is the plain card colour outside guardian mode', () => {
    const { container } = render(<Layout title="Settings">x</Layout>);
    expect((container.querySelector('header') as HTMLElement).style.background).toBe('var(--bg-card)');
  });
});

describe('PrivateVaultApprovalBanner', () => {
  it('renders the copy and both actions, in a wrapping row', () => {
    const onApprove = vi.fn(); const onDismiss = vi.fn();
    const { container } = render(<PrivateVaultApprovalBanner onApprove={onApprove} onDismiss={onDismiss} />);
    expect(screen.getByText(/hasn't approved private backups yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Approve on Heartwood' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(container.firstElementChild?.className).toBe('vault-approval-banner');
  });
  it('the stylesheet lets the row wrap and gives the sentence the full width', () => {
    const css = readFileSync(resolve(__dirname, '../styles/global.css'), 'utf8');
    const rule = css.slice(css.indexOf('.vault-approval-banner {'), css.indexOf('}', css.indexOf('.vault-approval-banner {')));
    expect(rule).toContain('flex-wrap: wrap');
    expect(css).toMatch(/\.vault-approval-banner-text\s*\{[^}]*flex:\s*1 1 100%/);
  });
});
