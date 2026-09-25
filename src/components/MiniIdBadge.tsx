import type { ResolvedIdentity } from '../lib/carousel-utils';

interface Props {
  resolved: ResolvedIdentity;
  variant?: 'dark' | 'light';
}

export function MiniIdBadge({ resolved, variant = 'dark' }: Props) {
  const initials = resolved.displayName
    .split(' ')
    .map(w => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className={`mini-id${variant === 'light' ? ' light' : ''}`}>
      <div className="mini-id-photo">
        {initials}
      </div>
      <div className="mini-id-name">{resolved.displayName}</div>
    </div>
  );
}
