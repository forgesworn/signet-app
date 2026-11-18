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

  it('with no exit (child mode only saved while locked) names the child and shows no button', () => {
    render(<ChildModeBanner name="Ada" blur={false} />);
    expect(screen.getByText('Ada')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('the carousel shows it for saved child mode too, with Exit only when live or the saved read failed', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const carousel = readFileSync(join(here, 'Carousel.tsx'), 'utf8');
    expect(carousel).toMatch(/\{\(props\.childMode \|\| props\.childModeSaved\) && \(\s*<ChildModeBanner/);
    expect(carousel).toContain('onExit={props.childMode || props.childModeSavedExitable ? props.onExitChildMode : undefined}');
    const app = readFileSync(join(here, '..', 'App.tsx'), 'utf8');
    expect(app).toContain('childModeSaved={!carousel.childMode && !!savedChildMode}');
    expect(app).toContain("isDependantContext={!!activeDependant || preferences.signingMode === 'paired-child' || childModeNow !== 'off'}");
    // childMode itself still drives only live child mode.
    expect(app).toContain('childMode={carousel.childMode}');
  });

  it('the carousel shows it whenever child mode is on, not only with the full record', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const carousel = readFileSync(join(here, 'Carousel.tsx'), 'utf8');
    expect(carousel).toMatch(/\{\(props\.childMode \|\| props\.childModeSaved\) && \(\s*<ChildModeBanner/);
    const app = readFileSync(join(here, '..', 'App.tsx'), 'utf8');
    expect(app).toContain('childModeName={signInChildDependant?.displayName}');
  });
});
