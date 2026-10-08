import { sigilPaths } from '../lib/handshake-sigil';
import { HANDSHAKE_COPY } from '../lib/contacts-v2-copy';
export function JigsawSigil({ digest, half = 'whole' }: { digest: string; half?: 'left' | 'right' | 'whole' }) {
  return <svg role="img" aria-label={HANDSHAKE_COPY.sigil} viewBox={half === 'whole' ? '0 0 256 256' : `${half === 'left' ? 0 : 128} 0 128 256`}
    className={`jigsaw-sigil jigsaw-sigil-${half}`} preserveAspectRatio="none">
    <rect x="0" y="0" width="256" height="256" fill="#101724" />
    {sigilPaths(digest).map((path, i) => <path key={i} d={path.d} stroke={path.colour} strokeWidth={path.width} fill="none" />)}
  </svg>;
}
