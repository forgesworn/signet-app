// src/components/Icon.tsx
//
// MySignet line-icon set (2026-09 rebrand). Hand-drawn 24x24 stroke paths —
// no icon-library dependency. Brand guide §7: simple, geometric, consistent
// stroke weight, compatible with the emblem's clean curves; the set
// deliberately avoids fingerprints, CCTV, generic shields, crypto coins and
// padlocks as the default security metaphor — security reads as control /
// ownership / keys / provenance instead (hence `key` standing in for every
// former lock/bunker glyph, and `scan` instead of a literal fingerprint for
// the biometric-prompt icon).

import type { SVGProps } from 'react';

export type IconName =
  | 'home'
  | 'users'
  | 'user'
  | 'key'
  | 'settings'
  | 'checkCircle'
  | 'alertTriangle'
  | 'x'
  | 'smartphone'
  | 'idCard'
  | 'link'
  | 'puzzle'
  | 'clipboard'
  | 'globe'
  | 'landmark'
  | 'grid'
  | 'scan'
  | 'download';

const PATHS: Record<IconName, SVGProps<SVGSVGElement>['children']> = {
  home: (
    <>
      <path d="M4 11.5 12 4l8 7.5" />
      <path d="M6 10v9a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-9" />
      <path d="M10 20v-5h4v5" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <path d="M15.5 4.3a3.5 3.5 0 0 1 0 6.9" />
      <path d="M16 13.5a6.5 6.5 0 0 1 5.5 6.5" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </>
  ),
  key: (
    <>
      <circle cx="7.5" cy="16.5" r="4.2" />
      <path d="M10.8 13.2 20 4" />
      <path d="M17 7l2.3 2.3" />
      <path d="M14 10l2.3 2.3" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.5v3.2M12 18.3v3.2M4.2 4.2l2.3 2.3M17.5 17.5l2.3 2.3M2.5 12h3.2M18.3 12h3.2M4.2 19.8l2.3-2.3M17.5 6.5l2.3-2.3" />
    </>
  ),
  checkCircle: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12.3 10.7 15 16 9" />
    </>
  ),
  alertTriangle: (
    <>
      <path d="M12 3.3 2.4 20.3h19.2L12 3.3z" />
      <path d="M12 9.6v4.6" />
      <circle cx="12" cy="17.1" r="0.15" fill="currentColor" stroke="currentColor" />
    </>
  ),
  x: (
    <>
      <path d="M5 5l14 14" />
      <path d="M19 5 5 19" />
    </>
  ),
  smartphone: (
    <>
      <rect x="6.5" y="2.5" width="11" height="19" rx="2" />
      <path d="M10.7 18.3h2.6" />
    </>
  ),
  idCard: (
    <>
      <rect x="2.5" y="5" width="19" height="14" rx="2" />
      <circle cx="8.5" cy="11" r="2.1" />
      <path d="M5.3 16a3.3 3.3 0 0 1 6.4 0" />
      <path d="M14 9.5h5M14 13h5" />
    </>
  ),
  link: (
    <>
      <path d="M10 14a5 5 0 0 0 7.1 0l2-2a5 5 0 0 0-7.1-7.1l-1.2 1.2" />
      <path d="M14 10a5 5 0 0 0-7.1 0l-2 2a5 5 0 0 0 7.1 7.1l1.2-1.2" />
    </>
  ),
  puzzle: (
    <path d="M9 4h4a1 1 0 0 1 1 1v1.7a1.3 1.3 0 0 0 2 1.1 1.8 1.8 0 1 1 0 3.4 1.3 1.3 0 0 0-2 1.1V14a1 1 0 0 1-1 1h-1.7a1.3 1.3 0 0 0-1.1 2 1.8 1.8 0 1 1-3.4 0 1.3 1.3 0 0 0-1.1-2H4a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h1.7a1.3 1.3 0 0 0 1.1-2A1.8 1.8 0 1 1 10.2 5.7 1.3 1.3 0 0 0 9 4z" />
  ),
  clipboard: (
    <>
      <rect x="5" y="4.5" width="14" height="16" rx="2" />
      <rect x="9" y="2.3" width="6" height="3.2" rx="1" />
      <path d="M8.3 11h7.4M8.3 14.5h7.4M8.3 18h4.5" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3c-3 3-3 15 0 18" />
      <path d="M12 3c3 3 3 15 0 18" />
    </>
  ),
  landmark: (
    <>
      <path d="M3 10 12 4l9 6" />
      <path d="M4.5 10v10M9 10v10M15 10v10M19.5 10v10" />
      <path d="M3 21h18" />
    </>
  ),
  grid: (
    <>
      <circle cx="6.5" cy="6.5" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="12" cy="6.5" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="17.5" cy="6.5" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="6.5" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="17.5" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="6.5" cy="17.5" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="12" cy="17.5" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="17.5" cy="17.5" r="1.5" fill="currentColor" stroke="none" />
    </>
  ),
  scan: (
    <>
      <path d="M4 8.5V6.5a2 2 0 0 1 2-2h2" />
      <path d="M16 4.5h2a2 2 0 0 1 2 2v2" />
      <path d="M20 15.5v2a2 2 0 0 1-2 2h-2" />
      <path d="M8 19.5H6a2 2 0 0 1-2-2v-2" />
      <path d="M6.5 12h11" />
    </>
  ),
  download: (
    <>
      <path d="M12 3v12" />
      <path d="M7 10l5 5 5-5" />
      <path d="M4.5 19.5h15" />
    </>
  ),
};

export interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
  title?: string;
}

/**
 * A single MySignet line icon. Decorative by default (`aria-hidden`); pass
 * `title` to make it a meaningful image instead (`role="img"` + `<title>`,
 * announced by screen readers). Colour always comes from `currentColor`, so
 * it inherits text colour / theme tokens for free — no `fill`/`stroke` props
 * to wire up per call site.
 */
export function Icon({ name, size = 20, className, title }: IconProps) {
  const decorative = !title;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden={decorative ? 'true' : undefined}
      role={decorative ? undefined : 'img'}
    >
      {title ? <title>{title}</title> : null}
      {PATHS[name]}
    </svg>
  );
}
