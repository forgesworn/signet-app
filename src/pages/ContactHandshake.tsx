import { useEffect, useState } from 'react';
import type { ContactCardChoice, ContactCardInfo } from '../lib/contact-card-share';
import type { HandshakeHost } from '../hooks/useHandshake';
import { useHandshake } from '../hooks/useHandshake';
import { CONTACT_ACTION_FAILED_COPY, HANDSHAKE_COPY as COPY, handshakeWaiting } from '../lib/contacts-v2-copy';
import { loadHandshakeChoice, saveHandshakeChoice } from '../lib/handshake-defaults';
import { handshakeQR, readHandshakeQR } from '../lib/handshake-proof';
import { encodeContactInvite } from '@forgesworn/signet-contacts';
import { HandshakeCamera } from '../components/HandshakeCamera';
import { QRCode } from '../components/QRCode';
import { HandshakeQR } from '../components/HandshakeQR';
import { JigsawIcon } from '../components/JigsawIcon';
import { JigsawSigil } from '../components/JigsawSigil';
import { Icon } from '../components/Icon';
import { useScreenWakeLock } from '../hooks/useScreenWakeLock';
import { isNativeApp, SignetNative } from '../lib/native';
import { encodeNpub, hexToBytes } from '../lib/signet';

interface Props extends Omit<HandshakeHost, 'card'> {
  encryptionKey: string; info: ContactCardInfo; choose: boolean;
  buildCard(choice: ContactCardChoice): ReturnType<HandshakeHost['card']>;
  pairedChild?: boolean; onChildInvite(raw: string): void;
  onTier(contactId: string, tier: 'kith' | 'kin'): Promise<void>;
  onOpenContact(contactId: string): Promise<void>;
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
function ScanComplete({ camera = false }: { camera?: boolean }) {
  return <div className={`handshake-scan-complete${camera ? ' handshake-camera-complete' : ''}`}>
    <Icon name="checkCircle" size={64} />
    <span>{camera ? COPY.cameraDone : COPY.qrDone}</span>
  </div>;
}
function ChildHandshake(props: Props) {
  const [facing, setFacing] = useState<'user' | 'environment'>(HANDSHAKE_DEFAULT_CAMERA);
  return <div className="handshake-screen">
    <QRCode data={encodeNpub(hexToBytes(props.persona))} size={280} />
    <HandshakeCamera facing={facing} active onScan={raw => {
      const peer = readHandshakeQR(raw, Math.floor(Date.now() / 1000));
      if (peer && peer.invite.recipient !== props.persona) props.onChildInvite(encodeContactInvite(peer.invite));
    }} />
    <CameraChoice facing={facing} change={() => setFacing(f => f === 'user' ? 'environment' : 'user')} />
    <p role="status">{COPY.child}</p>
  </div>;
}
function RunningHandshake(props: Props & Pick<HandshakeHost, 'card'>) {
  const { view, scan, oneWay, confirm, withoutPhoto } = useHandshake(props);
  const [facing, setFacing] = useState<'user' | 'environment'>(HANDSHAKE_DEFAULT_CAMERA);
  const [tierBusy, setTierBusy] = useState(false);
  const [tierChosen, setTierChosen] = useState(false);
  const [tierFailed, setTierFailed] = useState(false);
  const [opening, setOpening] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);
  const active = view.phase === 'reading' || view.phase === 'waiting';
  const waiting = view.phase === 'waiting' && !!view.peer;
  const half = view.peer ? (props.persona < view.peer.recipient ? 'left' : 'right')
    : 'right'; // A one-way request's recipient is the right half; requester overrides below.
  // Both halves use canonical pubkey order, including the one-way path.
  return <div className="handshake-screen">
    {view.sigil && (view.phase === 'checking' || view.phase === 'sealed')
      ? <JigsawSigil digest={view.sigil} half={view.half ?? half} />
      : active && view.scansConfirmed ? <ScanComplete />
      : view.invite && active ? <HandshakeQR data={handshakeQR(view.invite)} /> : null}
    {active && <>
      {view.peer ? <ScanComplete camera /> : <>
        <HandshakeCamera facing={facing} active onScan={scan} />
        <CameraChoice facing={facing} change={() => setFacing(f => f === 'user' ? 'environment' : 'user')} />
      </>}
    </>}
    <div className="handshake-status" role="status">
      <JigsawIcon state={view.phase === 'sealed' ? 'joined' : waiting ? 'closing' : 'apart'} size={40} />
      <span>{active ? view.scansConfirmed ? COPY.finishing : view.peer ? handshakeWaiting(view.name) : COPY.scan
        : view.phase === 'sealed' ? COPY.sealed : view.phase === 'expired' ? COPY.expired : view.phase === 'failed' ? COPY.failed : COPY.compare}</span>
      {waiting && <span className="handshake-wait" aria-hidden="true"><i /><i /><i /></span>}
    </div>
    {active && view.nearby && <p className="field-hint">{view.nearby === 'linked' ? COPY.nearbyLinked : view.nearby === 'off' ? COPY.nearbyOff : COPY.nearbyDenied}</p>}
    {active && view.photoFailed && <div className="handshake-photo-failed">
      <p role="alert">{COPY.photoFailed}</p>
      <button className="btn btn-secondary" onClick={withoutPhoto}>{COPY.withoutPhoto}</button>
    </div>}
    {active && view.peer && !view.scansConfirmed && <p className="field-hint">{COPY.scanYours}</p>}
    {view.phase === 'waiting' && !view.scansConfirmed && <button className="btn btn-ghost" onClick={oneWay}>{COPY.oneWay}</button>}
    {view.phase === 'checking' && <button className="btn btn-primary" onClick={confirm}>{COPY.joins}</button>}
    {view.phase === 'sealed' && view.contactId && !tierChosen && <div className="handshake-tier">
      <p>{COPY.tier}</p>
      {(['kith', 'kin'] as const).map(tier => <button key={tier} className="btn btn-secondary" disabled={tierBusy} onClick={() => {
        setTierBusy(true); setTierFailed(false);
        void props.onTier(view.contactId!, tier).then(() => setTierChosen(true)).catch(() => setTierFailed(true)).finally(() => setTierBusy(false));
      }}>{COPY[tier]}</button>)}
      <button className="btn btn-ghost" onClick={() => setTierChosen(true)}>{COPY.keepTier}</button>
      {tierFailed && <p role="alert">{CONTACT_ACTION_FAILED_COPY}</p>}
    </div>}
    {view.phase === 'sealed' && view.contactId && <div className="handshake-open-contact">
      <button className="btn btn-primary" disabled={opening} onClick={() => {
        setOpening(true); setOpenFailed(false);
        void props.onOpenContact(view.contactId!).catch(() => setOpenFailed(true)).finally(() => setOpening(false));
      }}>{COPY.openContact}</button>
      {openFailed && <p role="alert">{CONTACT_ACTION_FAILED_COPY}</p>}
    </div>}
  </div>;
}
