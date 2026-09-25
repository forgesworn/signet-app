import { useEffect, useRef, useState } from 'react';

interface Props {
  /** Quiet caption above the value, e.g. "npub". Also names the copy button. */
  label: string;
  /** The copyable value. Rendered monospace. */
  value: string;
  /**
   * Truncate the value to one line with an ellipsis instead of wrapping.
   * Wrapping (the default) suits a full key on a dedicated page; truncation
   * suits a key sitting in a settings row.
   */
  truncate?: boolean;
  /** Override the button's resting label (defaults to "Copy"). */
  copyLabel?: string;
}

const COPIED_MS = 2000;

/**
 * A `.row` carrying one copyable public value (npub, hex pubkey, …).
 *
 * Public values only — there is no clipboard auto-clear here. The 60s wipe in
 * SecuritySettings is reserved for secrets (mnemonic, bunker URL).
 */
export function CopyRow({ label, value, truncate, copyLabel }: Props) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  function handleCopy() {
    // No console output on failure — an unavailable clipboard (insecure
    // context, denied permission) simply leaves the button in its resting
    // state; the value stays selectable on screen.
    navigator.clipboard?.writeText(value).then(() => {
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), COPIED_MS);
    }).catch(() => {});
  }

  return (
    <div className="row copy-row">
      <div className="row-main">
        <span className="row-sub">{label}</span>
        <span
          className={`mono copy-row-value${truncate ? ' copy-row-value--truncate' : ''}`}
          title={truncate ? value : undefined}
        >
          {value}
        </span>
      </div>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={handleCopy}
        aria-label={copied ? `${label} copied` : `Copy ${label}`}
      >
        {copied ? 'Copied ✓' : (copyLabel ?? 'Copy')}
      </button>
    </div>
  );
}
