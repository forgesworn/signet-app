import {isNativeApp, SignetNative} from './native';
import {bytesToBase64} from '@forgesworn/stash';
import {COLLECTION_BYTES, isAccountCollection} from './wrapped-account-collection';

/** Binary FSWNENC2 on disk; the text prefix exists only across the native bridge. */
export async function saveAccountCollectionFile(bytes: Uint8Array): Promise<boolean> {
  if (!isAccountCollection(bytes)) throw new Error('Invalid account collection file.');
  if (isNativeApp()) {
    const record = 'nstc1:' + bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return (await SignetNative.saveWrappedBackup({record})).saved;
  }
  const owned = new Uint8Array(bytes);
  const url = URL.createObjectURL(new Blob([owned], {type: 'application/octet-stream'}));
  try {
    const link = document.createElement('a');
    link.href = url; link.download = 'signet-accounts.nstc'; document.body.appendChild(link);
    try { link.click(); } finally { link.remove(); }
  } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
  return true;
}

export async function readAccountCollectionFile(file: File): Promise<Uint8Array> {
  if (file.size !== COLLECTION_BYTES) throw new Error('Choose a Signet account collection.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!isAccountCollection(bytes)) throw new Error('Invalid account collection file.');
  return bytes;
}

/** Save only the bounded encrypted envelope; cancellation never claims a saved file. */
export async function saveWrappedBackupFile(record: string): Promise<boolean> {
  if (record.length !== 181 || !/^nstw1:[A-Za-z0-9_-]{175}$/.test(record)) throw new Error('Invalid encrypted backup file.');
  if (isNativeApp()) return (await SignetNative.saveWrappedBackup({record})).saved;
  const url = URL.createObjectURL(new Blob([record], {type: 'text/plain'}));
  try {
    const link = document.createElement('a');
    link.href = url; link.download = 'imported-account.nstw';
    document.body.appendChild(link);
    try { link.click(); } finally { link.remove(); }
  } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
  // The browser does not confirm persistence: the UI still requires file read-back.
  return true;
}
