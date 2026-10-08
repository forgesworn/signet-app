import { useState, type ChangeEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ContactPictureCrop } from '../components/ContactPictureCrop';
import {
  CROP_TITLE, OWN_PICTURE_REFUSED_COPY, OWN_PICTURE_UNREADABLE_COPY, PERSONA_CROP_HINT, PERSONA_PICTURE_TOO_LARGE_COPY,
} from '../lib/contacts-v2-copy';
import type { PictureCrop } from '../lib/picture-crop';
import { checkPickedPicture } from '../lib/picture-pick';

/**
 * The pick flow for a persona picture: file input change -> header gate ->
 * crop screen -> `onPicked(file, crop)`. A refused or unreadable file never
 * opens the crop screen; `onError` gets the copy for it. With `crop: false`
 * (banners) the file goes straight to `onPicked` with no crop, as before.
 *
 * Render `cropScreen` anywhere in the picker's output. It portals into the
 * app root (`.desk-frame-app`, else `document.body`): rendered in place it
 * would sit inside the carousel, whose `transform` makes `position: fixed`
 * resolve to the card instead of the screen (or the desktop phone frame).
 */
export function usePicturePick({ crop = true, onPicked, onError }: {
  crop?: boolean;
  onPicked: (file: File, crop?: PictureCrop) => void | Promise<void>;
  onError: (message: string) => void;
}): { onInputChange: (e: ChangeEvent<HTMLInputElement>) => void; cropScreen: ReactNode } {
  const [cropFile, setCropFile] = useState<File | null>(null);

  function onInputChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Reset so picking the same file twice still fires onChange.
    e.target.value = '';
    if (!file) return;
    if (!crop) { void onPicked(file); return; }
    void (async () => {
      const verdict = await checkPickedPicture(file);
      if (verdict === 'ok') setCropFile(file);
      else onError(verdict === 'too-large' ? PERSONA_PICTURE_TOO_LARGE_COPY : verdict === 'unreadable' ? OWN_PICTURE_UNREADABLE_COPY : OWN_PICTURE_REFUSED_COPY);
    })();
  }

  const cropScreen = cropFile ? createPortal(
    <ContactPictureCrop
      file={cropFile}
      title={CROP_TITLE}
      hint={PERSONA_CROP_HINT}
      onUse={picked => { const file = cropFile; setCropFile(null); void onPicked(file, picked); }}
      onCancel={() => setCropFile(null)}
    />,
    document.querySelector('.desk-frame-app') ?? document.body,
  ) : null;

  return { onInputChange, cropScreen };
}
