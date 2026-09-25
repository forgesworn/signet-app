import { useState } from 'react';
import type { PendingNip55 } from '../hooks/useNip55Server';
import { npubOf } from '../lib/nip55';

/** One of the person's own keys, as the picker shows it. */
export interface Nip55Identity {
  pubkey: string;
  label: string;
}

interface Props {
  approval: PendingNip55;
  identities: Nip55Identity[];
  onApproveOnce: (handle: number, pubkey: string) => void;
  onApproveAlways: (handle: number, pubkey: string) => void;
  onDeny: (handle: number) => void;
  onDenyAlways: (handle: number) => void;
}

/** Both ends of the npub: the start a person knows from their profile, the end that tells two apart. */
function shortNpubish(pubkey: string): string {
  try {
    const npub = npubOf(pubkey);
    return `${npub.slice(0, 13)}…${npub.slice(-6)}`;
  } catch {
    return `${pubkey.slice(0, 8)}…${pubkey.slice(-6)}`;
  }
}

/** A package name, with the obviously hostile characters kept out of the DOM text. */
function safePackage(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 80) || 'an app';
}

/** The app's own name, as the phone shows it, trimmed to one line; null when there is none worth showing. */
function safeLabel(label: string | null | undefined): string | null {
  const clean = (label ?? '').replace(/[\p{C}]/gu, '').trim().slice(0, 40);
  return clean || null;
}

/**
 * The approval screen for a request from another app on this phone.
 * Same shape as the NIP-46 one so a person learns one screen; the extra is
 * the key picker, because `get_public_key` is the moment the person decides
 * which of their keys that app gets.
 */
export function Nip55ApprovalModal({ approval, identities, onApproveOnce, onApproveAlways, onDeny, onDenyAlways }: Props) {
  const [chosen, setChosen] = useState<string | null>(approval.pubkey ?? identities[0]?.pubkey ?? null);
  const app = safeLabel(approval.callerLabel) ?? safePackage(approval.callerPackage);
  const canChoose = approval.method === 'get_public_key' && identities.length > 1;
  // The identities can land a render after the modal does (the keys are
  // decrypted just after unlock), so the default follows them rather than
  // being fixed at mount.
  const key = chosen ?? approval.pubkey ?? identities[0]?.pubkey ?? null;

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="nip55-approval-title"
      style={{ position: 'fixed', inset: 0, zIndex: 10000, background: 'var(--scrim)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', padding: 16 }}>
      <div className="card" style={{ width: '100%', maxWidth: 480, background: 'var(--bg-card)', borderRadius: 'var(--radius-lg)', padding: 20, display: 'flex', flexDirection: 'column', gap: 12, boxShadow: 'var(--shadow-lg)' }}>
        <div>
          <div style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', marginBottom: 4 }}>
            App on this phone
          </div>
          <h2 id="nip55-approval-title" style={{ margin: 0, fontSize: '1.2rem', lineHeight: 1.3 }}>
            <strong>{app}</strong> wants to {approval.description}.
          </h2>
        </div>

        <div className="card" style={{ background: 'var(--bg-card-alt)', border: '1px solid var(--border)', padding: 12, borderRadius: 'var(--radius-sm)', fontSize: '0.85rem' }}>
          {approval.template && (
            <div style={{ marginBottom: 6 }}>
              <span style={{ color: 'var(--text-muted)' }}>Event kind: </span>
              <span style={{ fontFamily: 'var(--font-mono)' }}>{approval.template.kind}</span>
            </div>
          )}
          {approval.peer && (
            <div style={{ marginBottom: 6 }}>
              <span style={{ color: 'var(--text-muted)' }}>With: </span>
              <span style={{ fontFamily: 'var(--font-mono)' }}>{shortNpubish(approval.peer)}</span>
            </div>
          )}
          {approval.permissions.length > 0 && (
            <div style={{ marginBottom: 6 }}>
              <span style={{ color: 'var(--text-muted)' }}>It says it will ask for: </span>
              <span>{approval.permissions.join(', ')}</span>
            </div>
          )}
          {canChoose ? (
            <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
              <legend style={{ color: 'var(--text-muted)', marginBottom: 4 }}>Which of your keys:</legend>
              {identities.map(id => (
                <label key={id.pubkey} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0' }}>
                  <input type="radio" name="nip55-identity" value={id.pubkey} checked={key === id.pubkey} onChange={() => setChosen(id.pubkey)} />
                  <span>{id.label}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>{shortNpubish(id.pubkey)}</span>
                </label>
              ))}
            </fieldset>
          ) : key ? (
            <div>
              <span style={{ color: 'var(--text-muted)' }}>As: </span>
              <span>{identities.find(i => i.pubkey === key)?.label ?? 'your key'}</span>{' '}
              <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>{shortNpubish(key)}</span>
            </div>
          ) : null}
        </div>

        {!approval.existing && (
          <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', padding: '4px 2px' }}>
            First time this app has asked. Only approve if you started this.
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
          {approval.existing ? (
            <>
              <button className="btn btn-primary" disabled={!key} onClick={() => key && onApproveAlways(approval.handle, key)}>Allow always for {app.slice(0, 30)}</button>
              <button className="btn btn-secondary" disabled={!key} onClick={() => key && onApproveOnce(approval.handle, key)}>Allow once</button>
            </>
          ) : (
            <>
              <button className="btn btn-primary" disabled={!key} onClick={() => key && onApproveOnce(approval.handle, key)}>Allow once</button>
              <button className="btn btn-secondary" disabled={!key} onClick={() => key && onApproveAlways(approval.handle, key)}>Allow always for {app.slice(0, 30)}</button>
            </>
          )}
          <button className="btn btn-ghost" onClick={() => onDeny(approval.handle)}>Deny</button>
          <button className="btn btn-ghost" style={{ fontSize: '0.8rem' }} onClick={() => onDenyAlways(approval.handle)}>Always deny this app</button>
        </div>
      </div>
    </div>
  );
}
