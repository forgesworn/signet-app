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
 * Renders an Upload button only when an `onUpload` callback is wired; otherwise
 * only paste-URL is supported (no Blossom).
 */

import type React from 'react';
import { safeImageOrLinkUrl } from '../lib/public-profile-publish';
import { Icon } from './Icon';

export interface ImageRowProps {
  url: string;
  isSignetHosted: boolean;
  showPreview: boolean;
  uploading: boolean;
  hostname: string;
  onUpload?: (e: React.ChangeEvent<HTMLInputElement>) => void;
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
  onUpload,
  onPasteUrl,
  onShowPreview,
  onRemove,
  disabled,
  aspect = 'square',
}: ImageRowProps) {
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
      <div className="slot-image-row">
        {thumb}
        <div className="slot-image-actions">
          {onUpload && (
            <label className="btn btn-ghost btn-sm" style={{ cursor: disabled || uploading ? 'not-allowed' : 'pointer' }}>
              {uploading ? 'Uploading…' : url ? 'Change…' : 'Upload…'}
              <input type="file" accept="image/*" style={{ display: 'none' }} onChange={onUpload} disabled={disabled || uploading} />
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
