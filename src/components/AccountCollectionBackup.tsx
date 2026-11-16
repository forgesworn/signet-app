import {useState} from 'react';
import {readAccountCollectionFile, saveAccountCollectionFile} from '../lib/wrapped-backup-file';
import type {CollectionInspection} from '../lib/wrapped-account-collection';
import {sha256} from '@noble/hashes/sha2.js';
import {bytesToHex} from '@noble/hashes/utils.js';

export interface AccountCollectionBackupProps {
  accounts: {publicKey: string; name: string}[];
  existingNpubs: string[];
  onCreate: (publicKeys: string[]) => Promise<Uint8Array>;
  onInspect: (file: Uint8Array) => Promise<CollectionInspection>;
  onRestore: (file: Uint8Array, npubs: string[], expectedHash: string) => Promise<void>;
}
export function AccountCollectionBackup({accounts, existingNpubs, onCreate, onInspect, onRestore}: AccountCollectionBackupProps) {
  const [exportKeys, setExportKeys] = useState<string[]>([]);
  const [file, setFile] = useState<Uint8Array | null>(null);
  const [inventory, setInventory] = useState<CollectionInspection | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [expectedExport, setExpectedExport] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const toggle = (values: string[], value: string) => values.includes(value) ? values.filter(v => v !== value) : [...values, value];
  async function run(work: () => Promise<void>) {
    setBusy(true); setError(''); setNote('');
    try { await work(); } catch (e) { setError(e instanceof Error ? e.message : 'The backup operation failed.'); }
    finally { setBusy(false); }
  }
  async function download() {
    const keys = exportKeys.filter(k => accounts.some(a => a.publicKey === k));
    if (!keys.length) return;
    const bytes = await onCreate(keys);
    if (!await saveAccountCollectionFile(bytes)) return;
    setExpectedExport(bytesToHex(sha256(bytes)));
    setNote(`Downloaded a collection of ${keys.length} accounts. Choose the saved collection below to check it. Keep it separately from your Signet recovery words.`);
  }
  async function choose(picked: File) {
    setFile(null); setInventory(null); setSelected([]);
    setFile(await readAccountCollectionFile(picked));
  }
  async function inspect() {
    if (!file) return;
    const checked = await onInspect(file);
    setInventory(checked);
    setSelected(checked.accounts.filter(a => !existingNpubs.includes(a.npub)).map(a => a.npub));
    if (expectedExport) {
      if (expectedExport !== checked.sha256) throw new Error('This is a different snapshot from the collection just downloaded. Keep and check the new file too.');
      setExpectedExport('');
      setNote(`Saved collection checked: ${checked.accounts.length} accounts. Keep a second copy and your recovery words.`);
    }
  }
  async function restore() {
    if (!file || !inventory || !selected.length) return;
    const count = selected.length;
    await onRestore(file, selected, inventory.sha256);
    setFile(null); setInventory(null); setSelected([]);
    setNote(`Restored ${count} ${count === 1 ? 'account' : 'accounts'} with their original npubs. Keep the collection and your Signet recovery words.`);
  }
  return <section className="card section" aria-label="Account collection backup">
    <div className="section-title">Back up several accounts · Preview</div>
    <p>Save up to 100 imported accounts in one encrypted file. Your Signet recovery words and the file are both needed to restore them. Keep your separate key backups during this preview.</p>
    {!!accounts.length && <fieldset disabled={busy}>
      <legend>Accounts to back up</legend>
      {accounts.map(a => <label key={a.publicKey} style={{display: 'block'}}>
        <input type="checkbox" checked={exportKeys.includes(a.publicKey)} onChange={() => setExportKeys(toggle(exportKeys, a.publicKey))} /> {a.name}
      </label>)}
      <button type="button" className="btn btn-secondary" onClick={() => setExportKeys(accounts.map(a => a.publicKey))}>Select all imported accounts</button>
      <button type="button" className="btn btn-secondary" disabled={!exportKeys.length || exportKeys.length > 100} onClick={() => void run(download)}>Download account collection</button>
    </fieldset>}
    <p>The 65 KB file can be kept offline. Wildbloom can store it as an already encrypted file; keep its private storage receipt separately. Direct Bothy Keep storage is still awaiting integration.</p>
    <label style={{display: 'block'}}>Account collection file
      <input type="file" accept=".nstc,.fswnenc,application/octet-stream,application/vnd.forgesworn.encrypted" disabled={busy} onChange={e => {
        const picked = e.target.files?.[0]; e.target.value = '';
        if (picked) void run(() => choose(picked));
      }} />
    </label>
    <button type="button" className="btn btn-secondary" disabled={busy || !file} onClick={() => void run(inspect)}>Open collection</button>
    {inventory && <fieldset disabled={busy}>
      <legend>Accounts in this snapshot</legend>
      <p>Created {new Date(inventory.createdAt).toLocaleString()}. {inventory.accounts.length} accounts. This file does not prove that a newer snapshot exists elsewhere.</p>
      {inventory.accounts.map(a => <label key={a.npub} style={{display: 'block', overflowWrap: 'anywhere', marginBottom: 12}}>
        <input type="checkbox" aria-label={`Restore ${a.name}`} disabled={existingNpubs.includes(a.npub)} checked={selected.includes(a.npub)} onChange={() => setSelected(toggle(selected, a.npub))} />
        {' '}{a.name}{existingNpubs.includes(a.npub) ? ' · already here' : ''}<br /><span>{a.npub}</span>
      </label>)}
      <button type="button" className="btn btn-primary" disabled={!selected.length} onClick={() => void run(restore)}>Restore {selected.length} selected {selected.length === 1 ? 'account' : 'accounts'}</button>
    </fieldset>}
    {error && <p role="alert">{error}</p>}
    {note && <p role="status">{note}</p>}
  </section>;
}
