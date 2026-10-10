import { useEffect, useRef } from 'react';
import { SIGIL_HEIGHT, SIGIL_SEAM, SIGIL_WIDTH, sigilMotion, sigilOffset, sigilPaths } from '../lib/handshake-sigil';
import { HANDSHAKE_COPY } from '../lib/contacts-v2-copy';

/** The phones go top to top. Each shows one half at full width, with the seam
 * at its own top edge: the top half is turned half a turn, because that phone
 * faces the other way. On the halves the lines drift slowly in time with the
 * clock, so the two phones move together across the seam. */
export function JigsawSigil({ digest, half = 'whole' }: { digest: string; half?: 'top' | 'bottom' | 'whole' }) {
  const lines = useRef<Array<SVGPathElement | null>>([]);
  useEffect(() => {
    if (half === 'whole' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const motion = sigilMotion(digest);
    let frame = 0;
    const draw = () => {
      const now = Date.now();
      motion.forEach((m, i) => lines.current[i]?.setAttribute('transform', `translate(${sigilOffset(m, now).toFixed(2)} 0)`));
      frame = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, [digest, half]);
  const viewBox = half === 'whole' ? `0 0 ${SIGIL_WIDTH} ${SIGIL_HEIGHT}`
    : `0 ${half === 'top' ? 0 : SIGIL_SEAM} ${SIGIL_WIDTH} ${SIGIL_SEAM}`;
  return <svg role="img" aria-label={HANDSHAKE_COPY.sigil} viewBox={viewBox} className={`jigsaw-sigil jigsaw-sigil-${half}`}>
    <rect x="0" y="0" width={SIGIL_WIDTH} height={SIGIL_HEIGHT} fill="#101724" />
    {sigilPaths(digest).map((path, i) => <path key={i} ref={el => { lines.current[i] = el; }} d={path.d} stroke={path.colour}
      strokeWidth={path.width} fill="none" />)}
  </svg>;
}
