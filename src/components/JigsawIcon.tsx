export function JigsawIcon({ state = 'apart', size = 26 }: { state?: 'apart' | 'closing' | 'joined'; size?: number }) {
  const gap = state === 'joined' ? 0 : state === 'closing' ? 1 : 3;
  return <svg width={size} height={size} viewBox="-3 0 38 32" fill="none" aria-hidden="true">
    <g className={state === 'closing' ? 'jigsaw-closing' : undefined}>
      <path transform={`translate(${-gap} 0)`} d="M16 2 A14 14 0 0 0 16 30 L16 21 C9 24 9 14 16 17 L16 11 C23 14 23 4 16 7 Z" fill="currentColor" />
      <path transform={`translate(${gap} 0)`} d="M16 2 A14 14 0 0 1 16 30 L16 21 C9 24 9 14 16 17 L16 11 C23 14 23 4 16 7 Z" fill="currentColor" opacity=".7" />
    </g>
  </svg>;
}
