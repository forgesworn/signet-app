import { useEffect, useState } from 'react';
import { nip19 } from 'nostr-tools';

/** Public identity display. Copy always uses the complete npub. */
export function NpubRow({ pubkey }: { pubkey: string }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    setCopied(false);
    setCopyError(false);
    setExpanded(false);
  }, [pubkey]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  if (!/^[0-9a-f]{64}$/.test(pubkey)) return null;
  const npub = nip19.npubEncode(pubkey);

  async function copy() {
    setCopyError(false);
    try {
      await navigator.clipboard.writeText(npub);
      setCopied(true);
    } catch {
      setCopied(false);
      setExpanded(true);
      setCopyError(true);
    }
  }

  return (
    <div className="slot-npub-row" style={{ minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span title={npub} style={{ fontFamily: 'var(--font-mono)', fontSize: '1rem', overflowWrap: 'anywhere', userSelect: 'text' }}>
          {expanded ? npub : `${npub.slice(0, 12)}…${npub.slice(-6)}`}
        </span>
        <button type="button" className="btn btn-ghost btn-sm" style={{ width: 'auto' }} onClick={copy}>
          {copied ? 'Copied!' : 'Copy npub'}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" style={{ width: 'auto' }} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Shorten' : 'Show full npub'}
        </button>
      </div>
      {copyError && <p role="status">Couldn’t copy. Select the full npub above to copy it manually.</p>}
    </div>
  );
}
