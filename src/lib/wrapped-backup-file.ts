import {isNativeApp, SignetNative} from './native';

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
