import { useEffect, useState } from 'react';
import type { ContactCardChoice, ContactCardInfo } from '../lib/contact-card-share';
import type { HandshakeHost } from '../hooks/useHandshake';
import { useHandshake } from '../hooks/useHandshake';
import { CONTACT_ACTION_FAILED_COPY, HANDSHAKE_COPY as COPY, handshakeWaiting } from '../lib/contacts-v2-copy';
import { loadHandshakeChoice, saveHandshakeChoice } from '../lib/handshake-defaults';
import { readHandshakeCode } from '../lib/handshake-proof';
import { encodeContactInvite } from '@forgesworn/signet-contacts';
import { HandshakeCamera } from '../components/HandshakeCamera';
import { QRCode } from '../components/QRCode';
import { HandshakeQR } from '../components/HandshakeQR';
import { JigsawIcon } from '../components/JigsawIcon';
import { JigsawSigil } from '../components/JigsawSigil';
import { Icon } from '../components/Icon';
import { useScreenWakeLock } from '../hooks/useScreenWakeLock';
import { isNativeApp, SignetNative } from '../lib/native';
import { encodeNpub, hexToBytes, shortNpub } from '../lib/signet';
import { ContactAvatar } from '../components/ContactAvatar';
import { useContactAvatar } from '../hooks/useContactAvatar';
import { useContactPicture } from '../hooks/useContactPicture';

interface Props extends Omit<HandshakeHost, 'card'> {
  encryptionKey: string; info: ContactCardInfo; choose: boolean;
  buildCard(choice: ContactCardChoice): ReturnType<HandshakeHost['card']>;
  pairedChild?: boolean; onChildInvite(raw: string): void;
  onOpenContact(contactId: string): Promise<void>;
  /** For the arrived contact's picture. */
  relayUrl: string; directoryId: string;
  /** The user blurs identities on screen: the arrival comes blurred, shown on a tap. */
  blurArrival?: boolean;
}
/** Who just arrived, so the new contact is felt to be on this phone: picture,
 * the name they shared and their key. Blurred until tapped when the user
 * blurs identities, for onlookers. */
function HandshakeArrival(props: { partner: string; name?: string; relayUrl: string; directoryId: string; contactId: string;
  encryptionKey: string; blur?: boolean }) {
  const [shown, setShown] = useState(!props.blur);
  const shared = useContactAvatar(props.partner, props.relayUrl, props.encryptionKey);
  const picture = useContactPicture({ encryptionKey: props.encryptionKey, pubkey: props.partner, directoryId: props.directoryId,
    contactId: props.contactId, sharedUrl: shared });
  const name = props.name?.trim();
  return <div className={`handshake-arrival${shown ? '' : ' is-hidden'}`}>
    <div className="handshake-arrival-body" aria-hidden={!shown}>
      <ContactAvatar url={picture.url} name={name || props.partner} pubkey={props.partner} size={64} />
      <div>
        <p className="handshake-arrival-name">{name || COPY.noName}</p>
        <p className="handshake-arrival-key mono">{shortNpub(props.partner)}</p>
      </div>
    </div>
    {!shown && <button type="button" className="btn btn-ghost handshake-arrival-reveal" onClick={() => setShown(true)}>{COPY.reveal}</button>}
    <p className="field-hint">{COPY.added}</p>
  </div>;
}
// S1 decides this value on the real screen. Rear is the working baseline.
export const HANDSHAKE_DEFAULT_CAMERA = 'environment' as const;
export function ContactHandshake(props: Props) {
  const [choice, setChoice] = useState<ContactCardChoice>();
  const [choosing, setChoosing] = useState(props.choose);
  const [saveDefault, setSaveDefault] = useState(false);
  const [failed, setFailed] = useState(false);
  useScreenWakeLock(true);
  useEffect(() => {
    if (!isNativeApp()) return;
    void SignetNative.handshakeAwake({ active: true }).catch(() => {});
    return () => { void SignetNative.handshakeAwake({ active: false }).catch(() => {}); };
  }, []);
  useEffect(() => {
    let cancelled = false;
    void loadHandshakeChoice(props.persona, props.encryptionKey, props.info).then(value => { if (!cancelled) setChoice(value); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [props.persona, props.encryptionKey]);
  if (failed) return <p role="alert">{COPY.failed}</p>;
  if (!choice) return <p role="status">{COPY.reading}</p>;
  if (choosing) return <div className="card section">
    <h2>{COPY.chooser}</h2>
    <label><input type="checkbox" checked={choice.name} disabled={!props.info.name} onChange={e => setChoice({ ...choice, name: e.target.checked })} /> {COPY.name}</label>
    <label><input type="checkbox" checked readOnly disabled /> {COPY.npub}</label>
    <p className="field-hint">{COPY.keyRequired}</p>
    <label><input type="checkbox" checked={choice.photo} disabled={!props.info.hasPhoto} onChange={e => setChoice({ ...choice, photo: e.target.checked })} /> {COPY.photo}</label>
    <label><input type="checkbox" checked={saveDefault} onChange={e => setSaveDefault(e.target.checked)} /> {COPY.saveDefault}</label>
    <button className="btn btn-primary" onClick={() => {
      void (async () => { if (saveDefault) await saveHandshakeChoice(props.persona, props.encryptionKey, choice); setChoosing(false); })().catch(() => setFailed(true));
    }}>{COPY.go}</button>
  </div>;
  return props.pairedChild ? <ChildHandshake {...props} />
    : <RunningHandshake {...props} card={opts => props.buildCard(opts?.withoutPhoto ? { ...choice, photo: false } : choice)} />;
}
function CameraChoice({ facing, change }: { facing: 'user' | 'environment'; change(): void }) {
  return <button className="btn btn-ghost btn-sm" aria-label={COPY.switchCamera} onClick={change}>{facing === 'user' ? COPY.front : COPY.rear}</button>;
}
function ScanComplete({ camera = false, tapped = false }: { camera?: boolean; tapped?: boolean }) {
  return <div className={`handshake-scan-complete${camera ? ' handshake-camera-complete' : ''}`}>
    <Icon name="checkCircle" size={64} />
    <span>{tapped ? camera ? COPY.tapDone : COPY.tapYoursDone : camera ? COPY.cameraDone : COPY.qrDone}</span>
  </div>;
}
function ChildHandshake(props: Props) {
  const [facing, setFacing] = useState<'user' | 'environment'>(HANDSHAKE_DEFAULT_CAMERA);
  const [note, setNote] = useState<string>();
  return <div className="handshake-screen">
    <QRCode data={encodeNpub(hexToBytes(props.persona))} size={280} />
    <HandshakeCamera facing={facing} active onScan={raw => {
      const code = readHandshakeCode(raw, Math.floor(Date.now() / 1000));
      // A handshake screen names no one, so a guardian request needs the
      // person's contact card instead.
      if (code?.kind === 'session') setNote(COPY.childCard);
      else if (code?.kind === 'outdated') setNote(COPY.outdated);
      else if (code?.kind === 'invite' && code.invite.recipient !== props.persona) props.onChildInvite(encodeContactInvite(code.invite));
    }} />
    <CameraChoice facing={facing} change={() => setFacing(f => f === 'user' ? 'environment' : 'user')} />
    <p role="status">{COPY.child}</p>
    {note && <p className="field-hint">{note}</p>}
  </div>;
}
function RunningHandshake(props: Props & Pick<HandshakeHost, 'card'>) {
  const { view, scan, oneWay, confirm, withoutPhoto } = useHandshake(props);
  const [facing, setFacing] = useState<'user' | 'environment'>(HANDSHAKE_DEFAULT_CAMERA);
  const [opening, setOpening] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);
  const active = view.phase === 'reading' || view.phase === 'waiting';
  const waiting = view.phase === 'waiting' && !!view.scanned;
  const tapped = view.via === 'tap';
  // Both halves use canonical pubkey order, set once the transcript exists.
  const half = view.half ?? 'bottom';
  return <div className="handshake-screen">
    {view.sigil && (view.phase === 'checking' || view.phase === 'sealed')
      ? <JigsawSigil digest={view.sigil} half={half} />
      : active && view.scansConfirmed ? <ScanComplete tapped={tapped} />
      : view.code && active ? <HandshakeQR data={view.code} /> : null}
    {active && <>
      {view.scanned ? <ScanComplete camera tapped={tapped} /> : <>
        <HandshakeCamera facing={facing} active onScan={scan} />
        <CameraChoice facing={facing} change={() => setFacing(f => f === 'user' ? 'environment' : 'user')} />
      </>}
    </>}
    <div className="handshake-status" role="status">
      <JigsawIcon state={view.phase === 'sealed' ? 'joined' : waiting ? 'closing' : 'apart'} size={40} />
      <span>{active ? view.scansConfirmed ? tapped ? COPY.tapFinishing : COPY.finishing : view.scanned ? handshakeWaiting(view.name, tapped) : view.tapAvailable ? COPY.scanOrTap : COPY.scan
        : view.phase === 'sealed' ? COPY.sealed : view.phase === 'expired' ? COPY.expired : view.phase === 'failed' ? COPY.failed : COPY.compare}</span>
      {waiting && <span className="handshake-wait" aria-hidden="true"><i /><i /><i /></span>}
    </div>
    {active && view.nearby && <p className="field-hint">{view.nearby === 'linked' ? COPY.nearbyLinked : view.nearby === 'off' ? COPY.nearbyOff : COPY.nearbyDenied}</p>}
    {active && view.photoFailed && <div className="handshake-photo-failed">
      <p role="alert">{COPY.photoFailed}</p>
      <button className="btn btn-secondary" onClick={withoutPhoto}>{COPY.withoutPhoto}</button>
    </div>}
    {active && view.outdated && <p role="alert">{COPY.outdated}</p>}
    {active && view.ambiguous && <p role="alert">{COPY.ambiguous}</p>}
    {/* A tap crossed both codes at once: there is nothing more to scan. */}
    {active && view.scanned && !view.scansConfirmed && !tapped && <p className="field-hint">{COPY.scanYours}</p>}
    {view.phase === 'waiting' && !view.scansConfirmed && <button className="btn btn-ghost" onClick={oneWay}>{COPY.oneWay}</button>}
    {view.phase === 'checking' && <button className="btn btn-primary" onClick={confirm}>{COPY.joins}</button>}
    {view.phase === 'sealed' && view.contactId && view.partner && <HandshakeArrival partner={view.partner} name={view.name}
      relayUrl={props.relayUrl} directoryId={props.directoryId} contactId={view.contactId} encryptionKey={props.encryptionKey}
      blur={props.blurArrival} />}
    {view.phase === 'sealed' && view.contactId && <div className="handshake-open-contact">
      <button className="btn btn-primary" disabled={opening} onClick={() => {
        setOpening(true); setOpenFailed(false);
        void props.onOpenContact(view.contactId!).catch(() => setOpenFailed(true)).finally(() => setOpening(false));
      }}>{COPY.openContact}</button>
      {openFailed && <p role="alert">{CONTACT_ACTION_FAILED_COPY}</p>}
    </div>}
  </div>;
}
