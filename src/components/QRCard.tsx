import type { ReactNode } from 'react';
import type { ResolvedIdentity } from '../lib/carousel-utils';
import { MiniIdBadge } from './MiniIdBadge';
import { QRCode } from './QRCode';
import { encodeNpub, hexToBytes, isValidHexKey } from '../lib/signet';

/** Optional slots a host can fill: a tab switch under the header, a footer row. */
export interface QRCardSlots { tabs?: ReactNode; footer?: ReactNode }

interface Props extends QRCardSlots {
  resolved: ResolvedIdentity;
  badge: { tier: number; score: number; vouchCount: number } | null;
}

/** The public-key card: the bare npub, which every Nostr app can read. No options. */
export function QRCard({ resolved, badge, tabs, footer }: Props) {
  const tier = badge?.tier ?? 1;
  const npub = isValidHexKey(resolved.publicKey)
    ? encodeNpub(hexToBytes(resolved.publicKey))
    : resolved.publicKey;
  const tierDisplay = resolved.isDependant ? 'Dependant' : `Tier ${tier}`;
  const isVerified = tier >= 2;

  return (
    <div className={`qr-view${tabs ? ' qr-tabbed' : ''}`}>
      <div>
        <MiniIdBadge resolved={resolved} />
      </div>
      {tabs}

      <div className="qr-box">
        <QRCode data={npub} size={230} />
      </div>

      <div className="qr-caption">Works in any Nostr app.</div>

      <div className="qr-tier-line">
        &#128737; {tierDisplay} &middot; {isVerified ? 'Verified' : 'Unverified'}
      </div>

      {footer && <div className="qr-footer">{footer}</div>}
    </div>
  );
}
