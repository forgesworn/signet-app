import { useState } from 'react';
import {saveWrappedBackupFile} from '../lib/wrapped-backup-file';

async function readRecord(file: File): Promise<string> {
  if (file.size > 1024) throw new Error('Backup file is too large.');
  const record = (await file.text()).trim();
  if (record.length !== 181 || !record.startsWith('nstw1:')) throw new Error('Invalid backup file.');
  return record;
}

/** Explicit owner file export and read-back; never sets an automatic backup flag. */
export function WrappedKeyExport({onCreate, onVerify}: {
  onCreate: () => Promise<string | null>;
  onVerify: (record: string) => Promise<string | null>;
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  async function download() {
    setBusy(true); setError(''); setNote('');
    try {
      const record = await onCreate();
      if (!record) return;
      if (!await saveWrappedBackupFile(record)) return;
      setNote('Choose the saved file below to check it. Keep the file and your Signet recovery words.');
    } catch { setError('Could not create the encrypted backup. Unlock your Signet and try again.'); }
    finally { setBusy(false); }
  }
  async function verify(file: File) {
    setBusy(true); setError(''); setNote('');
    try {
      const npub = await onVerify(await readRecord(file));
      if (npub) setNote(`File checked for ${npub}. Keep a second copy of this file; your Signet words alone cannot restore this account.`);
    } catch { setError('This file could not be verified for this account and Signet.'); }
    finally { setBusy(false); }
  }
  return <div className="card section">
    <div className="section-title">Encrypted account backup · Preview</div>
    <p>Your Signet recovery words and this file can restore this imported account together. Keep its separate backup while this feature is in preview.</p>
    <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void download()}>Download encrypted backup</button>
    <label style={{display: 'block', marginTop: 12}}>Check saved backup file
      <input type="file" accept=".nstw,text/plain" disabled={busy} onChange={e => {
        const file = e.target.files?.[0]; e.target.value = '';
        if (file) void verify(file);
      }} />
    </label>
    {error && <p role="alert">{error}</p>}
    {note && <p role="status" style={{overflowWrap: 'anywhere'}}>{note}</p>}
  </div>;
}

/** Inspect, display the exact public account, then confirm persistence separately. */
export function WrappedKeyRestore({onInspect, onRestore}: {
  onInspect: (record: string) => Promise<string | null>;
  onRestore: (record: string, name: string, expectedNpub: string) => Promise<
    {added: true; pubkey: string} | {added: false; collision: string; collisionDisplayName?: string}
  >;
}) {
  const [record, setRecord] = useState('');
  const [npub, setNpub] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  async function select(file: File) {
    setRecord(''); setNpub(''); setError(''); setNote(''); setBusy(true);
    try { setRecord(await readRecord(file)); }
    catch { setError('Choose a valid .nstw encrypted backup file, no larger than 1 KB.'); }
    finally { setBusy(false); }
  }
  async function inspect() {
    setBusy(true); setError('');
    try { setNpub(await onInspect(record) ?? ''); }
    catch { setError('This file could not be opened with this Signet.'); }
    finally { setBusy(false); }
  }
  async function restore() {
    setBusy(true); setError('');
    try {
      const result = await onRestore(record, name.trim(), npub);
      if (!result.added) { setError(`That account is already here${result.collisionDisplayName ? ` as ${result.collisionDisplayName}` : ''}.`); return; }
      setNote(`Restored ${name.trim()}. Keep its encrypted file and your Signet recovery words.`);
      setRecord(''); setNpub(''); setName('');
    } catch { setError('The account could not be restored. Unlock your Signet and try again.'); }
    finally { setBusy(false); }
  }
  return <div className="card section">
    <div className="section-title">Restore encrypted account · Preview</div>
    <p>Use an account backup file made with this Signet’s recovery words. The account keeps its original npub.</p>
    <label style={{display: 'block'}}>Encrypted backup file
      <input type="file" accept=".nstw,text/plain" disabled={busy} onChange={e => {
        const file = e.target.files?.[0]; e.target.value = '';
        if (file) void select(file);
      }} />
    </label>
    <label style={{display: 'block', marginTop: 12}}>Restored account name
      <input className="input" maxLength={100} value={name} disabled={busy} onChange={e => setName(e.target.value)} />
    </label>
    {!npub ? <button type="button" className="btn btn-secondary" disabled={busy || !record} onClick={() => void inspect()}>Check backup file</button> : <>
      <p>Account to restore:</p><p style={{overflowWrap: 'anywhere'}}>{npub}</p>
      <button type="button" className="btn btn-primary" disabled={busy || !name.trim()} onClick={() => void restore()}>Restore this account</button>
    </>}
    {error && <p role="alert">{error}</p>}
    {note && <p role="status">{note}</p>}
  </div>;
}
