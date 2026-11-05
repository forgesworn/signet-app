// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { useEffect } from 'react';
import { IdentityCard } from './IdentityCard';
import { CarouselArrowProvider, useRegisterCarouselArrows, type CarouselArrowApi } from './CarouselArrowContext';
import { useSwipeGesture } from '../hooks/useSwipeGesture';

// A persona-first owner card, with the real swipe hook listening on `document`
// the way the Carousel does and a registered arrow API (so the role label is
// the switcher button and the Scan / My QR tiles are live).

const resolved = {
  displayName: 'Sky Hawk', displayNameIsSet: true, publicKey: 'b'.repeat(64), type: 'Persona', isDependant: false,
} as never;
const row = {
  type: 'persona',
  identity: {
    naturalPerson: { publicKey: 'a'.repeat(64), displayName: '' },
    persona: { publicKey: 'b'.repeat(64), displayName: 'Sky Hawk' },
    primaryKeypair: 'persona',
  },
} as never;

function arrowApi(over: Partial<CarouselArrowApi> = {}): CarouselArrowApi {
  return {
    left: vi.fn(), right: vi.fn(), up: vi.fn(), down: vi.fn(), jump: vi.fn(), openSwitcher: vi.fn(),
    rowIndex: 0, rowCount: 4, upDisabled: false, downDisabled: false, ...over,
  };
}

function Arrows({ api }: { api: CarouselArrowApi }) {
  const register = useRegisterCarouselArrows();
  useEffect(() => { register(api); return () => register(null); }, [register, api]);
  return null;
}

function Harness({ api, callbacks, cardProps }: {
  api: CarouselArrowApi;
  callbacks: { onSwipe: () => void; onSnapBack: () => void; onTap: () => void; onLongPressRelease: () => void };
  cardProps?: Record<string, unknown>;
}) {
  useSwipeGesture({ onDrag: () => {}, onLongPressEngage: () => {}, ...callbacks });
  return (
    <>
      <Arrows api={api} />
      <IdentityCard row={row} resolved={resolved} childMode={false} {...cardProps} />
    </>
  );
}

function setup(api = arrowApi(), cardProps?: Record<string, unknown>) {
  const callbacks = { onSwipe: vi.fn(), onSnapBack: vi.fn(), onTap: vi.fn(), onLongPressRelease: vi.fn() };
  const utils = render(
    <CarouselArrowProvider>
      <Harness api={api} callbacks={callbacks} cardProps={cardProps} />
    </CarouselArrowProvider>,
  );
  return { ...utils, ...callbacks, api };
}

const touch = (x: number, y: number) => ({ touches: [{ clientX: x, clientY: y }], changedTouches: [{ clientX: x, clientY: y }] });

describe('IdentityCard controls and the swipe gesture', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  const controls = ['Scan a QR code', 'Show my QR code', 'Customise card backdrop'] as const;

  for (const label of controls) {
    it(`a long-press drag that starts on "${label}" ends when the finger lifts`, () => {
      const { getByLabelText, onLongPressRelease, onSnapBack, onSwipe } = setup();
      const control = getByLabelText(label);

      fireEvent.touchStart(control, touch(100, 300));
      act(() => { vi.advanceTimersByTime(450); });
      fireEvent.touchMove(control, touch(100, 320));
      fireEvent.touchEnd(control, touch(100, 320));

      expect(onLongPressRelease).toHaveBeenCalledTimes(1);
      expect(onSnapBack.mock.calls.length + onSwipe.mock.calls.length).toBe(1);
    });
  }

  it('a long-press drag that starts on the role label ends when the finger lifts', () => {
    const { getByRole, onLongPressRelease } = setup();
    const label = getByRole('button', { name: /Switch identity/ });

    fireEvent.touchStart(label, touch(100, 300));
    act(() => { vi.advanceTimersByTime(450); });
    fireEvent.touchEnd(label, touch(100, 300));

    expect(onLongPressRelease).toHaveBeenCalledTimes(1);
  });

  it('a short tap on a control fires its own handler and not the card tap', () => {
    const { getByLabelText, api, onTap } = setup();
    const scan = getByLabelText('Scan a QR code');

    fireEvent.touchStart(scan, touch(100, 300));
    fireEvent.touchEnd(scan, touch(100, 300));
    fireEvent.click(scan);

    expect(api.jump).toHaveBeenCalledWith(4);
    expect(onTap).not.toHaveBeenCalled();
  });

  it('a short tap on the role label opens the switcher and not the card tap', () => {
    const { getByRole, api, onTap } = setup();
    const label = getByRole('button', { name: /Switch identity/ });

    fireEvent.touchStart(label, touch(100, 300));
    fireEvent.touchEnd(label, touch(100, 300));
    fireEvent.click(label);

    expect(api.openSwitcher).toHaveBeenCalledTimes(1);
    expect(onTap).not.toHaveBeenCalled();
  });
});

describe('IdentityCard position pill', () => {
  afterEach(cleanup);

  it('shows the card\'s own row, not the settled row the context reports', () => {
    // Mid-slide the context still says row 0; the incoming card is row 2.
    const { container } = setup(arrowApi({ rowIndex: 0, rowCount: 4 }), { rowIndex: 2 });
    expect(container.querySelector('.card-type-count')!.textContent).toBe('3/4');
  });

  it('falls back to the context row when no row is passed', () => {
    const { container } = setup(arrowApi({ rowIndex: 1, rowCount: 4 }));
    expect(container.querySelector('.card-type-count')!.textContent).toBe('2/4');
  });
});

describe('IdentityCard "Signed in as" caption under the blur preference', () => {
  afterEach(cleanup);

  it('blurs the persona name', () => {
    const { getByText } = setup(arrowApi(), { recentSignInLabel: 'Night Owl', blurIdentityNames: true });
    expect((getByText('Night Owl') as HTMLElement).style.filter).toContain('blur');
  });

  it('leaves it sharp otherwise', () => {
    const { getByText } = setup(arrowApi(), { recentSignInLabel: 'Night Owl' });
    expect((getByText('Night Owl') as HTMLElement).style.filter).toBe('');
  });
});
