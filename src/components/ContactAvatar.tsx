import { initialFromName, colourFromPubkey } from '../lib/avatar';

/** Badge diameter as a share of the avatar's (spec: about 42%). */
export const BADGE_SHARE = 0.42;
/** The ring that separates the badge from the main picture. */
export const BADGE_RING_PX = 2;

/** A contact's avatar: the resolved image when present, else an initials +
 *  deterministic-gradient fallback so every contact has a visual. With
 *  `badgeUrl` (their picture, under the user's own) a round badge sits in the
 *  bottom-right corner, overlapping the edge, ringed in the card background. */
export function ContactAvatar({ url, name, pubkey, size, badgeUrl }: {
  url: string | null;
  name: string;
  pubkey: string;
  size: number;
  badgeUrl?: string | null;
}) {
  if (url && badgeUrl) {
    const badge = Math.round(size * BADGE_SHARE);
    // The badge centre sits on the circle's edge at 45 degrees (0.854 of the way across).
    const overhang = -Math.round(size * 0.06);
    return (
      <div style={{ position: 'relative', width: size, height: size }}>
        <img src={url} alt="" style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', display: 'block' }} />
        <img
          src={badgeUrl}
          alt=""
          data-testid="contact-avatar-badge"
          style={{
            position: 'absolute', right: overhang, bottom: overhang, width: badge, height: badge,
            boxSizing: 'border-box', borderRadius: '50%', objectFit: 'cover', display: 'block',
            border: `${BADGE_RING_PX}px solid var(--bg-card)`,
          }}
        />
      </div>
    );
  }
  if (url) {
    return <img src={url} alt="" style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', display: 'block' }} />;
  }
  return (
    <div
      aria-hidden
      style={{
        width: size, height: size, borderRadius: '50%', background: colourFromPubkey(pubkey),
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: '#fff', fontWeight: 600, fontSize: Math.round(size * 0.42), lineHeight: 1,
      }}
    >
      {initialFromName(name)}
    </div>
  );
}
