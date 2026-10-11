import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { SEAM_GAP_DP } from '../lib/handshake-seam-gap';
import { SIGIL_HEIGHT, SIGIL_OVERHANG, SIGIL_SEAM, SIGIL_WIDTH, sigilAnimator, sigilPaths } from '../lib/handshake-sigil';
import { HANDSHAKE_COPY } from '../lib/contacts-v2-copy';

/** Kept here for the callers and tests that import it from the component. */
export { SEAM_GAP_DP };

/** The phones go top to top. Each shows one half at full width, with the seam
 * at its own top edge: the top half is turned half a turn, because that phone
 * faces the other way. On the halves the lines drift and flex slowly in time
 * with the clock, so the two phones move together across the seam. */
export function JigsawSigil({ digest, half = 'whole', gapDp = SEAM_GAP_DP }: { digest: string; half?: 'top' | 'bottom' | 'whole'; gapDp?: number }) {
  const lines = useRef<Array<SVGPathElement | null>>([]);
  const svg = useRef<SVGSVGElement | null>(null);
  // The hidden strip in sigil units, from this screen's real width (CSS px are dp on Android).
  const [gap, setGap] = useState(0);
  useLayoutEffect(() => {
    const el = svg.current;
    if (half === 'whole' || !el) return;
    const measure = () => { const width = el.getBoundingClientRect().width; setGap(width > 0 ? (gapDp * SIGIL_WIDTH) / width : 0); };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [half, gapDp]);
  useEffect(() => {
    if (half === 'whole') return;
    // Each phone shows only its own half, so the seam is all the two compare:
    // it keeps moving under reduced motion too, or a pair would look broken.
    const pathsAt = sigilAnimator(digest, { seamOnly: !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches });
    let frame = 0;
    const draw = () => {
      pathsAt(Date.now()).forEach((d, i) => lines.current[i]?.setAttribute('d', d));
      frame = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, [digest, half]);
  const shift = Math.min(gap, SIGIL_OVERHANG);
  const viewBox = half === 'whole' ? `0 0 ${SIGIL_WIDTH} ${SIGIL_HEIGHT}`
    : `0 ${(half === 'top' ? -shift : SIGIL_SEAM + shift).toFixed(2)} ${SIGIL_WIDTH} ${SIGIL_SEAM}`;
  return <svg ref={svg} role="img" aria-label={HANDSHAKE_COPY.sigil} viewBox={viewBox} className={`jigsaw-sigil jigsaw-sigil-${half}`}>
    <rect x="0" y={-SIGIL_OVERHANG} width={SIGIL_WIDTH} height={SIGIL_HEIGHT + 2 * SIGIL_OVERHANG} fill="#101724" />
    {sigilPaths(digest).map((path, i) => <path key={i} ref={el => { lines.current[i] = el; }} d={path.d} stroke={path.colour}
      strokeWidth={path.width} fill="none" />)}
  </svg>;
}
