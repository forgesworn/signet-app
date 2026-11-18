// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChildModeBanner, Carousel } from './Carousel';
import { CarouselArrowProvider } from './CarouselArrowContext';
import { childModeBannerAction } from '../lib/child-mode-sign-in';

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

  it('saved child mode while locked offers Unlock (PIN), which asks for the unlock prompt', () => {
    const onUnlock = vi.fn();
    render(<ChildModeBanner name="Ada" blur={false} onUnlock={onUnlock} />);
    expect(screen.getByText('Ada')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Exit (PIN)' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Unlock (PIN)' }));
    expect(onUnlock).toHaveBeenCalledTimes(1);
  });

  it('with neither exit nor unlock it names the child and shows no button', () => {
    render(<ChildModeBanner name="Ada" blur={false} />);
    expect(screen.getByText('Ada')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('the carousel shows it for saved child mode too, with Exit only when live or the saved read failed', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const carousel = readFileSync(join(here, 'Carousel.tsx'), 'utf8');
    expect(carousel).toMatch(/\{\(props\.childMode \|\| props\.childModeSaved\) && \(\s*<ChildModeBanner/);
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

describe('saved child mode, locked cold start (no ring): the guardian can always get in', () => {
  function renderCarousel(over: Record<string, unknown>) {
    const onUnlockSavedChildMode = vi.fn();
    const onExitChildMode = vi.fn();
    render(
      <CarouselArrowProvider>
        <Carousel
          row={0} col={0} rows={[]}
          activeIdentity={{ displayName: '', displayNameIsSet: false, publicKey: '', type: '', isDependant: false }}
          animating={false} onCommit={vi.fn()} onAnimatingChange={vi.fn()} onNavigateDeepPage={vi.fn()}
          onEnterChildMode={vi.fn()} onExitChildMode={onExitChildMode} onAddPersona={vi.fn()}
          onQRScanned={vi.fn()} renderInviteCard={vi.fn()} renderContactsCard={vi.fn()} renderKnownPlacesCard={vi.fn()}
          onHandshake={vi.fn()} onUnlockSavedChildMode={onUnlockSavedChildMode}
          childMode={false} childDependant={null} stableChildId="kid" childModeName="Ada" childModeSaved
          {...over}
        />
      </CarouselArrowProvider>,
    );
    return { onUnlockSavedChildMode, onExitChildMode };
  }

  it('saved and locked: an Unlock (PIN) button that calls the unlock prompt, and no Exit', () => {
    const { onUnlockSavedChildMode, onExitChildMode } = renderCarousel({ childModeSavedExitable: false });
    expect(screen.queryByRole('button', { name: 'Exit (PIN)' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Unlock (PIN)' }));
    expect(onUnlockSavedChildMode).toHaveBeenCalledTimes(1);
    expect(onExitChildMode).not.toHaveBeenCalled();
  });

  it('saved and exitable (read failed, or unlocked without the restore): Exit (PIN), not Unlock', () => {
    const { onExitChildMode } = renderCarousel({ childModeSavedExitable: true });
    expect(screen.queryByRole('button', { name: 'Unlock (PIN)' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Exit (PIN)' }));
    expect(onExitChildMode).toHaveBeenCalledTimes(1);
  });
});

describe('childModeBannerAction: whenever the banner shows, it offers a way forward', () => {
  it.each([true, false])('live=%s', (live) => {
    for (const saved of [true, false]) for (const exitable of [true, false]) {
      const action = childModeBannerAction({ live, saved, savedExitable: exitable });
      if (!live && !saved) expect(action).toBe('none');
      else expect(action === 'exit' || action === 'unlock').toBe(true);
    }
  });
  it('live always exits; saved + locked unlocks; saved + exitable exits', () => {
    expect(childModeBannerAction({ live: true, saved: false, savedExitable: false })).toBe('exit');
    expect(childModeBannerAction({ live: false, saved: true, savedExitable: false })).toBe('unlock');
    expect(childModeBannerAction({ live: false, saved: true, savedExitable: true })).toBe('exit');
  });
});

describe('App wiring: saved + locked reaches the PIN prompt', () => {
  it('passes the unlock prompt to the carousel', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const app = readFileSync(join(here, '..', 'App.tsx'), 'utf8');
    expect(app).toMatch(/onUnlockSavedChildMode=\{[^}]*requestAuth\(\{ purpose: 'unlock-app' \}\)/);
  });
});
