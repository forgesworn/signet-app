import { useRef, useState, type ReactNode } from 'react';
import type { ContactIdentity, EffectiveContact } from '../types';
import { contactDisplayName } from '../lib/contacts-v2-name';
import { QRScanner } from './QRScanner';
import { useCamera } from '../hooks/useCamera';
import { shortNpub } from '../lib/signet';
import { shortNpub as shortNpubForNote } from '../lib/nostr-follows';
import { NOTE_MAX } from '../lib/contacts-v2-detail';
import {
  ConfirmMergeRefusedError, appendNoteLine, decideScan, npubReadoutGroups, planMatch, planMismatch, planTierMove, scannedKeyToHex,
  shouldOfferTierMove, type ConfirmStep, type MismatchChoice, type ScanDecision,
} from '../lib/contacts-v2-confirm';
import {
  CONFIRM_ALLOW_CAMERA_LABEL, CONFIRM_BACK_LABEL, CONFIRM_BUTTON_LABEL, CONFIRM_CANCEL_LABEL, CONFIRM_DID_NOT_MATCH_LABEL,
  CONFIRM_DONE_LABEL, CONFIRM_KEEP_BOTH_HINT, CONFIRM_KEEP_BOTH_LABEL, CONFIRM_KEEP_KEN_LABEL,
  CONFIRM_MATCHED_LABEL, CONFIRM_MISMATCH_EXPLAINER, CONFIRM_MYSIGNET_HINT, CONFIRM_MYSIGNET_LABEL,
  CONFIRM_OLD_NOT_THEIRS_HINT, CONFIRM_OLD_NOT_THEIRS_HINT_SCANNED, CONFIRM_OLD_NOT_THEIRS_LABEL,
  CONFIRM_READOUT_GROUPS_LABEL, CONFIRM_READOUT_HINT, CONFIRM_READOUT_LABEL, CONFIRM_READOUT_MISMATCH_EXPLAINER,
  CONFIRM_READOUT_TITLE, CONFIRM_SAVED_COPY, CONFIRM_SCAN_HINT, CONFIRM_SCAN_LABEL, CONFIRM_SCAN_PROMPT,
  CONFIRM_SCAN_TITLE, CONFIRM_SCAN_UNREADABLE_COPY, CONFIRM_USE_NEW_HINT, CONFIRM_USE_NEW_LABEL,
  CONTACT_ACTION_FAILED_COPY, confirmBelongsToOtherCopy, confirmIntroCopy, confirmMismatchTitleCopy,
  confirmOtherKeyOfThisCopy, confirmOwnKeyCopy, confirmReadoutPromptCopy, confirmTierPromptCopy,
  confirmedDoneCopy, tierChipLabel, confirmNotSureNoteLabel, confirmNotSureNoteLine,
  CONFIRM_NOT_SENT_COPY, CONFIRM_NOT_SURE_DONE_COPY, CONFIRM_NOT_SURE_HINT, CONFIRM_NOT_SURE_LABEL,
  CONFIRM_NOTE_TOO_LONG_COPY, CONFIRM_READOUT_RECOGNISE_HINT, CONFIRM_RECOGNISE_RULE, CONFIRM_SCAN_RECOGNISE_HINT,
} from '../lib/contacts-v2-copy';

interface Props {
  contact: EffectiveContact;
  /** The identity being confirmed — a snapshot, so the flow survives the old key being removed. */
  identity: ContactIdentity;
  /** Every contact in the same directory, deleted and archived ones included, so a key that belongs to someone else is named. */
  contacts: EffectiveContact[];
  /** Every contact id a key was ever added to (`keyHolderIds`), so a key since removed from someone is still caught. */
  keyHolderIds?: (pubkey: string) => string[];
  /** The user's own public keys. */
  ownPubkeys: string[];
  canSetTier: boolean;
  onApply: (steps: ConfirmStep[]) => Promise<void>;
  /** Replace the contact's note (the `note` operation). Absent where the actor cannot edit notes: "not sure" then offers no note. */
  onSetNote?: (note: string) => Promise<void>;
  /** Start the existing My Signet invite exchange. Absent where invites are not available. */
  onStartExchange?: () => void;
  onClose: () => void;
}

type Stage =
  | { name: 'choose' }
  | { name: 'scan' }
  | { name: 'readout' }
  | { name: 'tier' }
  | { name: 'mismatch'; scannedHex: string | null }
  | { name: 'not-sure'; scannedHex: string | null }
  | { name: 'notice'; decision: Exclude<ScanDecision, { kind: 'match' | 'mismatch' }> }
  | { name: 'done'; message: string };

/**
 * "Confirm it's them": check that a key really belongs to the person named.
 * The tier is a separate question and is only ever offered, never forced.
 */
export function ContactConfirm({ contact, identity, contacts, keyHolderIds, ownPubkeys, canSetTier, onApply, onSetNote, onStartExchange, onClose }: Props) {
  const shownName = contactDisplayName(contact);
  const [stage, setStage] = useState<Stage>({ name: 'choose' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [scanError, setScanError] = useState('');
  const [addNote, setAddNote] = useState(true);
  const handling = useRef(false);
  const { hasPermission, error: cameraError, requestPermission } = useCamera();

  async function apply(steps: ConfirmStep[], next: Stage) {
    setBusy(true);
    setError('');
    try {
      await onApply(steps);
      setStage(next);
    } catch (err) {
      // The queued write found the key would merge this contact with another
      // one and wrote nothing: say whose it is, exactly as an up-front catch would.
      if (err instanceof ConfirmMergeRefusedError) {
        setStage({ name: 'notice', decision: { kind: 'belongs-to-other', ...err.refusal } });
      } else {
        setError(CONTACT_ACTION_FAILED_COPY);
      }
    } finally {
      setBusy(false);
    }
  }

  function afterMatch(): Stage {
    return canSetTier && shouldOfferTierMove(contact) ? { name: 'tier' } : { name: 'done', message: confirmedDoneCopy(shownName) };
  }

  async function handleScan(data: string) {
    if (handling.current) return;
    const scannedHex = scannedKeyToHex(data);
    if (!scannedHex) { setScanError(CONFIRM_SCAN_UNREADABLE_COPY); return; }
    handling.current = true;
    setScanError('');
    try {
      const decision = decideScan({
        record: contact, identity, scannedHex, contacts, ownPubkeys, formerHolderIds: keyHolderIds?.(scannedHex),
      });
      if (decision.kind === 'match') {
        await apply(planMatch({ identity, method: 'in-person' }), afterMatch());
      } else if (decision.kind === 'mismatch') {
        setStage({ name: 'mismatch', scannedHex });
      } else {
        setStage({ name: 'notice', decision });
      }
    } finally {
      handling.current = false;
    }
  }

  const shell = (children: ReactNode) => (
    <div className="card section" role="group" aria-label={CONFIRM_BUTTON_LABEL}>{children}</div>
  );
  const alert = error ? <p role="alert" className="field-hint" style={{ color: 'var(--danger)' }}>{error}</p> : null;

  if (stage.name === 'choose') {
    return shell(
      <>
        <p className="field-hint">{CONFIRM_RECOGNISE_RULE}</p>
        <p className="field-hint">{confirmIntroCopy(shownName)}</p>
        <button className="btn btn-secondary" style={{ width: '100%' }} onClick={() => {
          setScanError(''); setStage({ name: 'scan' });
          if (hasPermission === null) void requestPermission();
        }}>{CONFIRM_SCAN_LABEL}</button>
        <p className="field-hint">{CONFIRM_SCAN_HINT}</p>
        <button className="btn btn-secondary" style={{ width: '100%' }} onClick={() => setStage({ name: 'readout' })}>{CONFIRM_READOUT_LABEL}</button>
        <p className="field-hint">{CONFIRM_READOUT_HINT}</p>
        {onStartExchange && <>
          <button className="btn btn-secondary" style={{ width: '100%' }} onClick={onStartExchange}>{CONFIRM_MYSIGNET_LABEL}</button>
          <p className="field-hint">{CONFIRM_MYSIGNET_HINT}</p>
        </>}
        <button className="btn btn-ghost" onClick={onClose}>{CONFIRM_CANCEL_LABEL}</button>
      </>,
    );
  }

  if (stage.name === 'scan') {
    return shell(
      <>
        <h3>{CONFIRM_SCAN_TITLE}</h3>
        <p className="field-hint">{CONFIRM_SCAN_PROMPT}</p>
        <p className="field-hint">{CONFIRM_SCAN_RECOGNISE_HINT}</p>
        {cameraError && <p role="alert" className="field-hint" style={{ color: 'var(--danger)' }}>{cameraError}</p>}
        {scanError && <p role="alert" className="field-hint" style={{ color: 'var(--danger)' }}>{scanError}</p>}
        {alert}
        <QRScanner onScan={data => void handleScan(data)} active={hasPermission === true && !busy} />
        {hasPermission === null && (
          <button className="btn btn-primary" onClick={() => void requestPermission()}>{CONFIRM_ALLOW_CAMERA_LABEL}</button>
        )}
        <button className="btn btn-ghost" onClick={() => { setScanError(''); setError(''); setStage({ name: 'choose' }); }}>{CONFIRM_BACK_LABEL}</button>
      </>,
    );
  }

  if (stage.name === 'readout') {
    const groups = npubReadoutGroups(identity.pubkey);
    return shell(
      <>
        <h3>{CONFIRM_READOUT_TITLE}</h3>
        <p className="field-hint">{confirmReadoutPromptCopy(shownName)}</p>
        <p className="field-hint">{CONFIRM_READOUT_RECOGNISE_HINT}</p>
        <p className="row-sub">{shortNpub(identity.pubkey)}</p>
        <p className="field-hint">{CONFIRM_READOUT_GROUPS_LABEL}</p>
        <p className="mono" aria-label={CONFIRM_READOUT_GROUPS_LABEL}
          style={{ fontSize: '1.9rem', fontWeight: 700, letterSpacing: '0.08em', display: 'flex', gap: 14, flexWrap: 'wrap', margin: '8px 0 16px' }}>
          {groups.map((g, i) => <span key={i} data-testid="readout-group">{g}</span>)}
        </p>
        {alert}
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-primary" style={{ flex: 1 }} disabled={busy}
            onClick={() => void apply(planMatch({ identity, method: 'words' }), afterMatch())}>{CONFIRM_MATCHED_LABEL}</button>
          <button className="btn btn-secondary" style={{ flex: 1 }} disabled={busy}
            onClick={() => { setError(''); setStage({ name: 'mismatch', scannedHex: null }); }}>{CONFIRM_DID_NOT_MATCH_LABEL}</button>
        </div>
        <button className="btn btn-ghost" onClick={() => { setError(''); setStage({ name: 'choose' }); }}>{CONFIRM_BACK_LABEL}</button>
      </>,
    );
  }

  if (stage.name === 'tier') {
    const name = shownName;
    const move = (tier: 'kith' | 'kin') => void apply(planTierMove(tier), { name: 'done', message: confirmedDoneCopy(name) });
    return shell(
      <>
        <p>{confirmTierPromptCopy(name)}</p>
        {alert}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-primary" disabled={busy} onClick={() => move('kith')}>{tierChipLabel('kith')}</button>
          <button className="btn btn-secondary" disabled={busy} onClick={() => move('kin')}>{tierChipLabel('kin')}</button>
          <button className="btn btn-ghost" disabled={busy} onClick={() => setStage({ name: 'done', message: confirmedDoneCopy(name) })}>{CONFIRM_KEEP_KEN_LABEL}</button>
        </div>
      </>,
    );
  }

  if (stage.name === 'mismatch') {
    const { scannedHex } = stage;
    const choose = (choice: MismatchChoice) => {
      if (choice === 'cancel') { setError(''); setStage({ name: 'choose' }); return; }
      if (choice === 'not-sure') { setError(''); setAddNote(true); setStage({ name: 'not-sure', scannedHex }); return; }
      void apply(planMismatch({ choice, old: identity, scannedHex }), { name: 'done', message: CONFIRM_SAVED_COPY });
    };
    return shell(
      <>
        <h3>{confirmMismatchTitleCopy(shownName)}</h3>
        <p className="field-hint">{scannedHex ? CONFIRM_MISMATCH_EXPLAINER : CONFIRM_READOUT_MISMATCH_EXPLAINER}</p>
        <p className="field-hint">{CONFIRM_NOT_SENT_COPY}</p>
        {alert}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {scannedHex && <>
            <button className="btn btn-primary" disabled={busy} onClick={() => choose('use-new')}>{CONFIRM_USE_NEW_LABEL}</button>
            <p className="field-hint">{CONFIRM_USE_NEW_HINT}</p>
            <button className="btn btn-secondary" disabled={busy} onClick={() => choose('keep-both')}>{CONFIRM_KEEP_BOTH_LABEL}</button>
            <p className="field-hint">{CONFIRM_KEEP_BOTH_HINT}</p>
          </>}
          <button className="btn btn-secondary" disabled={busy} onClick={() => choose('old-not-theirs')}>{CONFIRM_OLD_NOT_THEIRS_LABEL}</button>
          <p className="field-hint">{scannedHex ? CONFIRM_OLD_NOT_THEIRS_HINT_SCANNED : CONFIRM_OLD_NOT_THEIRS_HINT}</p>
          <button className="btn btn-secondary" disabled={busy} onClick={() => choose('not-sure')}>{CONFIRM_NOT_SURE_LABEL}</button>
          <p className="field-hint">{CONFIRM_NOT_SURE_HINT}</p>
          <button className="btn btn-ghost" disabled={busy} onClick={() => choose('cancel')}>{CONFIRM_CANCEL_LABEL}</button>
        </div>
      </>,
    );
  }

  if (stage.name === 'not-sure') {
    const { scannedHex } = stage;
    const finish = async () => {
      if (addNote && onSetNote) {
        const line = confirmNotSureNoteLine(scannedHex ? shortNpubForNote(scannedHex) : null, Date.now());
        const next = appendNoteLine(contact.notes, line, NOTE_MAX);
        if (next === null) { setError(CONFIRM_NOTE_TOO_LONG_COPY); return; }
        setBusy(true);
        setError('');
        try {
          await onSetNote(next);
        } catch {
          setError(CONTACT_ACTION_FAILED_COPY);
          return;
        } finally {
          setBusy(false);
        }
      }
      setStage({ name: 'done', message: CONFIRM_NOT_SURE_DONE_COPY });
    };
    return shell(
      <>
        <p role="status">{CONFIRM_NOT_SURE_DONE_COPY}</p>
        {onSetNote && (
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" checked={addNote} disabled={busy} onChange={e => { setAddNote(e.target.checked); setError(''); }} />
            <span>{confirmNotSureNoteLabel(shownName)}</span>
          </label>
        )}
        {alert}
        <button className="btn btn-primary" disabled={busy} onClick={() => void finish()}>{CONFIRM_DONE_LABEL}</button>
      </>,
    );
  }

  if (stage.name === 'notice') {
    const d = stage.decision;
    const text = d.kind === 'belongs-to-other' ? confirmBelongsToOtherCopy(d.displayName, d.state)
      : d.kind === 'own-key' ? confirmOwnKeyCopy(shownName)
        : confirmOtherKeyOfThisCopy(shownName);
    return shell(
      <>
        <p role="status">{text}</p>
        <button className="btn btn-secondary" onClick={() => setStage({ name: 'choose' })}>{CONFIRM_BACK_LABEL}</button>
      </>,
    );
  }

  return shell(
    <>
      <p role="status">{stage.message}</p>
      <button className="btn btn-secondary" onClick={onClose}>{CONFIRM_DONE_LABEL}</button>
    </>,
  );
}
