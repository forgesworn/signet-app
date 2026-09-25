/**
 * Always-on-top build badge. Colour is a deterministic hash of __BUILD_TIME__,
 * so the same build always renders the same hue and a new build shifts it.
 * Used as a UAT visual signal — at-a-glance "is this the build I expected?".
 */
import { Z } from '../lib/z-index';
function hueFromString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

export function VersionBadge() {
  const hue = hueFromString(__BUILD_TIME__);
  const date = __BUILD_TIME__.slice(0, 10);
  const time = __BUILD_TIME__.slice(11, 16);
  return (
    <div
      title={`Built ${__BUILD_TIME__}\nCommit ${__GIT_SHA__}`}
      style={{
        position: 'fixed',
        top: 8,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: Z.debug,
        padding: '6px 14px',
        borderRadius: 6,
        background: `hsl(${hue}, 65%, 30%)`,
        color: '#fff',
        fontSize: 13,
        fontWeight: 600,
        lineHeight: 1.3,
        fontFamily: 'var(--font-mono)',
        pointerEvents: 'auto',
        userSelect: 'none',
        boxShadow: '0 2px 6px rgba(0,0,0,0.3)',
        whiteSpace: 'nowrap',
      }}
    >
      v{__APP_VERSION__} · {date} {time} · {__GIT_SHA__}
    </div>
  );
}
