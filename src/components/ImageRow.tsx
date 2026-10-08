/**
 * ImageRow — shared picture/banner row for kind-0 profile editors.
 *
 * Reused by:
 *   - src/pages/EditPublicProfile.tsx          (long-form editor)
 *   - src/components/SlotProfileFields.tsx     (inline persona-card editor)
 *
 * Handles three sources of imagery:
 *   1. Blossom-hosted (signet-uploaded) — `isSignetHosted = true`, preview always shown.
 *   2. Pasted external URL — gated behind a "Show preview" click per §6.6.4
 *      privacy invariant (don't auto-leak IP to a third-party host).
 *   3. Empty — shows a placeholder.
 *
 * Renders an Upload button only when an `onPick` callback is wired; otherwise
 * only paste-URL is supported (no Blossom). A square picture goes through the
 * header gate and the crop screen first (`usePicturePick`), so `onPick` gets the
 * file AND the chosen square; a wide banner is passed straight through.
 */

import { safeImageOrLinkUrl } from '../lib/public-profile-publish';
import type { PictureCrop } from '../lib/picture-crop';
import { usePicturePick } from '../hooks/usePicturePick';
import { Icon } from './Icon';

export interface ImageRowProps {
  url: string;
  isSignetHosted: boolean;
  showPreview: boolean;
  uploading: boolean;
  hostname: string;
  /** A picked file; `crop` is the square chosen on the crop screen (square pictures only, never banners). */
  onPick?: (file: File, crop?: PictureCrop) => void | Promise<void>;
  /** A picked file the gate refused (copy to show), so the host can use its own error style. */
  onPickError?: (message: string) => void;
  onPasteUrl: (value: string) => void;
  onShowPreview: () => void;
  onRemove: () => void;
  disabled: boolean;
  aspect?: 'square' | 'wide';
}

export function ImageRow({
  url,
  isSignetHosted,
  showPreview,
  uploading,
  hostname,
  onPick,
  onPickError,
  onPasteUrl,
  onShowPreview,
  onRemove,
  disabled,
  aspect = 'square',
}: ImageRowProps) {
  const picker = usePicturePick({
    crop: aspect !== 'wide',
    onPicked: (file, crop) => onPick?.(file, crop),
    onError: message => onPickError?.(message),
  });
  const isAllowedScheme = url ? safeImageOrLinkUrl(url) !== null : true;
  const renderInline = !!url && isAllowedScheme && (isSignetHosted || showPreview);

  // D8 — thumbnail sits LEFT of the controls (48px square / 96x36 banner), so
  // the Upload/Remove pair and the paste-URL field stack neatly on the right
  // instead of floating centred under a big preview box.
  const thumb = (
    <div className={`slot-image-thumb${aspect === 'wide' ? ' slot-image-thumb--wide' : ''}`}>
      {renderInline ? (
        // referrerpolicy strips Referer header so external servers don't see
        // which Signet user is viewing.
        // eslint-disable-next-line jsx-a11y/img-redundant-alt
        <img src={url} alt="Profile picture preview" referrerPolicy="no-referrer" />
      ) : url && !isAllowedScheme ? (
        <span style={{ color: 'var(--danger)' }}>bad URL</span>
      ) : (
        '—'
      )}
    </div>
  );

  return (
    <div className="slot-image-block">
      {picker.cropScreen}
      <div className="slot-image-row">
        {thumb}
        <div className="slot-image-actions">
          {onPick && (
            <label className="btn btn-ghost btn-sm" style={{ cursor: disabled || uploading ? 'not-allowed' : 'pointer' }}>
              {uploading ? 'Uploading…' : url ? 'Change…' : 'Upload…'}
              <input type="file" accept="image/*" style={{ display: 'none' }} onChange={picker.onInputChange} disabled={disabled || uploading} />
            </label>
          )}
          {url && (
            <button className="btn btn-ghost btn-sm" onClick={onRemove} disabled={disabled || uploading} style={{ color: 'var(--text-muted)' }}>Remove</button>
          )}
        </div>
      </div>
      {/* The URL field spans the whole group so it lines up with every other
          input in the form, rather than starting at whatever x the thumbnail
          happens to end at (48px picture vs 96px banner). */}
      <input
        className="input input-sm"
        placeholder="or paste URL"
        value={url}
        onChange={e => onPasteUrl(e.target.value)}
        disabled={disabled || uploading}
      />
      {url && !showPreview && !isSignetHosted && isAllowedScheme && (
        <div className="slot-image-warning">
          <Icon name="alertTriangle" size={14} className="icon-inline" />This URL points to <strong>{hostname}</strong>. Showing the preview will let that server see your IP address. Once you publish, anyone viewing your profile will hit that server too — that's how Nostr profile pictures work.
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <button className="btn btn-ghost btn-sm" onClick={onShowPreview} disabled={disabled}>Show preview</button>
          </div>
        </div>
      )}
    </div>
  );
}
