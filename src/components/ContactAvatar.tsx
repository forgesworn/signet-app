import { initialFromName, colourFromPubkey } from '../lib/avatar';

/** A contact's avatar: the resolved image when present, else an initials +
 *  deterministic-gradient fallback so every contact has a visual. */
export function ContactAvatar({ url, name, pubkey, size }: {
  url: string | null;
  name: string;
  pubkey: string;
  size: number;
}) {
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
