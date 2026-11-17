// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChildModeBanner } from './Carousel';

describe('child mode always has a way out', () => {
  it('names the child and exits through the PIN', () => {
    const onExit = vi.fn();
    render(<ChildModeBanner name="Ada" blur={false} onExit={onExit} />);
    expect(screen.getByText('Ada')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Exit (PIN)' }));
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('still shows the exit without a name', () => {
    render(<ChildModeBanner name="" blur={false} onExit={() => {}} />);
    expect(screen.getByText('a child')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Exit (PIN)' })).toBeTruthy();
  });

  it('the carousel shows it whenever child mode is on, not only with the full record', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const carousel = readFileSync(join(here, 'Carousel.tsx'), 'utf8');
    expect(carousel).toMatch(/\{props\.childMode && \(\s*<ChildModeBanner/);
    const app = readFileSync(join(here, '..', 'App.tsx'), 'utf8');
    expect(app).toContain('childModeName={signInChildDependant?.displayName}');
  });
});
