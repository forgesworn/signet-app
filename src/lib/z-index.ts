/** Centralised z-index scale. Use these constants instead of magic numbers. */
export const Z = {
  /** Carousel navigation dots (subordinate to header) */
  carouselDot: 20,
  /** Carousel child-mode banner */
  carouselBanner: 30,
  /** Carousel approval overlay (in-flow, not a modal) */
  carouselOverlay: 40,
  header: 50,
  nav: 100,
  dropdown: 200,
  modal: 1000,
  overlay: 2000,
  /** Slide-over sheet panels (e.g. the Bunker panel) — above the overlay backdrop tier, below the focused approval modal. */
  panel: 2500,
  /** Auth/unlock modals and focused approval modals — highest interactive level before debug. */
  auth: 3000,
  debug: 9999,
} as const;
