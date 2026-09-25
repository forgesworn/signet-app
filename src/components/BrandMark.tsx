import type { JSX } from 'react';
import emblemOnLight from '../assets/brand/mysignet-emblem.svg';
import emblemOnDark from '../assets/brand/mysignet-emblem-reversed.svg';
import horizontalOnLight from '../assets/brand/mysignet-logo-horizontal.svg';
import horizontalOnDark from '../assets/brand/mysignet-logo-horizontal-reversed.svg';
import stackedOnLight from '../assets/brand/mysignet-logo-stacked.svg';
import stackedOnDark from '../assets/brand/mysignet-logo-stacked-reversed.svg';
import wordmarkOnLight from '../assets/brand/mysignet-wordmark.svg';
import wordmarkOnDark from '../assets/brand/mysignet-wordmark-reversed.svg';

export interface BrandMarkProps {
  /** Which lockup to render. Default 'emblem' (mark only, no wordmark). 'wordmark' is
   *  the lockup's own wordmark paths alone, for layouts that set emblem and name apart. */
  variant?: 'emblem' | 'horizontal' | 'stacked' | 'wordmark';
  /** Rendered HEIGHT in px — width follows the SVG's native aspect ratio. Default 40. */
  size?: number;
  /**
   * 'on-light' forces the navy-stroke mark (for a light surface); 'on-dark'
   * forces the ivory-stroke reversed mark (for a dark surface, e.g. the
   * carousel's forced dark subtree). 'auto' (default) renders both and lets
   * CSS pick the right one for whatever theme context this mounts inside —
   * needed because a mount point can be inside a forced-dark subtree even
   * while the app-level theme is light, and a plain prop can't see that.
   */
  tone?: 'auto' | 'on-light' | 'on-dark';
  /** true → purely decorative (alt="", aria-hidden). Default false → alt="MySignet". */
  decorative?: boolean;
  className?: string;
}

const SOURCES: Record<NonNullable<BrandMarkProps['variant']>, { light: string; dark: string }> = {
  emblem: { light: emblemOnLight, dark: emblemOnDark },
  horizontal: { light: horizontalOnLight, dark: horizontalOnDark },
  stacked: { light: stackedOnLight, dark: stackedOnDark },
  wordmark: { light: wordmarkOnLight, dark: wordmarkOnDark },
};

export function BrandMark({
  variant = 'emblem',
  size = 40,
  tone = 'auto',
  decorative = false,
  className,
}: BrandMarkProps): JSX.Element {
  const { light, dark } = SOURCES[variant];
  const a11yProps = decorative
    ? { alt: '', 'aria-hidden': true as const }
    : { alt: 'MySignet' };

  if (tone === 'on-light') {
    return <img src={light} height={size} width="auto" className={className} {...a11yProps} />;
  }
  if (tone === 'on-dark') {
    return <img src={dark} height={size} width="auto" className={className} {...a11yProps} />;
  }

  // tone === 'auto': render both, CSS (global.css) hides the wrong one for
  // whatever theme context this mounts inside.
  const wrapperClassName = className ? `brand-mark-auto ${className}` : 'brand-mark-auto';
  return (
    <span className={wrapperClassName} style={{ height: size }}>
      <img src={light} height={size} width="auto" className="brand-on-light" {...a11yProps} />
      <img src={dark} height={size} width="auto" className="brand-on-dark" {...a11yProps} />
    </span>
  );
}
