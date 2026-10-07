import type { ContactCardChoice, ContactCardInfo } from '../lib/contact-card-share';
import {
  CARD_CHIPS_LABEL, CARD_NAME_CHIP_LABEL, CARD_PHOTO_CHIP_LABEL, CARD_PHOTO_UNAVAILABLE_COPY,
} from '../lib/contacts-v2-copy';

/**
 * "They'll see:" — what goes in the card of a contact request or acceptance.
 * Ticking only changes local state; the upload and publish that make a photo
 * shareable happen when the caller presses Send or Accept.
 */
export function ShareCardChips({ info, value, onChange, disabled }: {
  info: ContactCardInfo;
  value: ContactCardChoice;
  onChange(next: ContactCardChoice): void;
  disabled?: boolean;
}) {
  return <fieldset style={{ border: 0, padding: 0, margin: '12px 0' }}>
    <legend>{CARD_CHIPS_LABEL}</legend>
    <label style={{ marginRight: 16 }}>
      <input type="checkbox" checked={value.name && !!info.name} disabled={disabled || !info.name}
        onChange={e => onChange({ ...value, name: e.target.checked })} /> {CARD_NAME_CHIP_LABEL}
    </label>
    <label>
      <input type="checkbox" checked={value.photo && info.hasPhoto} disabled={disabled || !info.hasPhoto}
        onChange={e => onChange({ ...value, photo: e.target.checked })} /> {CARD_PHOTO_CHIP_LABEL}
    </label>
    {!info.hasPhoto && <p role="note">{CARD_PHOTO_UNAVAILABLE_COPY}</p>}
  </fieldset>;
}
