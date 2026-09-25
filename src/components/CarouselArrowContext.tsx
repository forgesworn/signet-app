// src/components/CarouselArrowContext.tsx
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { CarouselArrowState } from '../lib/carousel-arrows';

export interface CarouselArrowApi extends CarouselArrowState {
  left: () => void;
  right: () => void;
  up: () => void;
  down: () => void;
}

interface CarouselArrowContextValue {
  api: CarouselArrowApi | null;
  setApi: (api: CarouselArrowApi | null) => void;
}

const CarouselArrowContext = createContext<CarouselArrowContextValue | null>(null);

export function CarouselArrowProvider({ children }: { children: ReactNode }) {
  const [api, setApiState] = useState<CarouselArrowApi | null>(null);
  const setApi = useCallback((next: CarouselArrowApi | null) => setApiState(next), []);
  const value = useMemo(() => ({ api, setApi }), [api, setApi]);
  return <CarouselArrowContext.Provider value={value}>{children}</CarouselArrowContext.Provider>;
}

/** Consumer (DesktopFrame): the current carousel arrow API, or null when no
 *  carousel is mounted (non-home pages) → arrows are hidden. */
export function useCarouselArrows(): CarouselArrowApi | null {
  const ctx = useContext(CarouselArrowContext);
  return ctx?.api ?? null;
}

/** Producer (Carousel): returns a stable setter to register/unregister this
 *  carousel's arrow API. No-op if no provider is mounted. */
export function useRegisterCarouselArrows(): (api: CarouselArrowApi | null) => void {
  const ctx = useContext(CarouselArrowContext);
  return ctx?.setApi ?? (() => {});
}
