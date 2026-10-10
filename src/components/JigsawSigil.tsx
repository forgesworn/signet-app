import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { SIGIL_HEIGHT, SIGIL_OVERHANG, SIGIL_SEAM, SIGIL_WIDTH, sigilAnimator, sigilPaths } from '../lib/handshake-sigil';

/** Between the two screens, top to top, each phone hides a strip: its status
 * bar and top bezel. Assumed 80 dp each: measured, it is 40 to 50 dp of status
 * bar and 2 to 3 mm of bezel on the phones it was tried on, but by eye the
 * lines joined better with a wider allowance. Each half starts that far beyond
 * the seam, so the lines carry on across the gap and the eye joins them. */
export const SEAM_GAP_DP = 80;
import { HANDSHAKE_COPY } from '../lib/contacts-v2-copy';

/** The phones go top to top. Each shows one half at full width, with the seam
 * at its own top edge: the top half is turned half a turn, because that phone
 * faces the other way. On the halves the lines drift and flex slowly in time
 * with the clock, so the two phones move together across the seam. */
export function JigsawSigil({ digest, half = 'whole' }: { digest: string; half?: 'top' | 'bottom' | 'whole' }) {
  const lines = useRef<Array<SVGPathElement | null>>([]);
  const svg = useRef<SVGSVGElement | null>(null);
  // The hidden strip in sigil units, from this screen's real width (CSS px are dp on Android).
  const [gap, setGap] = useState(0);
  useLayoutEffect(() => {
    const el = svg.current;
    if (half === 'whole' || !el) return;
    const measure = () => { const width = el.getBoundingClientRect().width; setGap(width > 0 ? (SEAM_GAP_DP * SIGIL_WIDTH) / width : 0); };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [half]);
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
