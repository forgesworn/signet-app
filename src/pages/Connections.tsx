import { useState } from 'react';
import type { ConnectedClient } from '../types';
import { shortNpub } from '../lib/signet';
import { Icon } from '../components/Icon';

interface Props {
  /** Bunker (NIP-46) clients paired with this device. A client with
   *  `allowAlways` can sign/decrypt WITHOUT a prompt, so it must be listed and
   *  revocable here — this is the surface the ConnectedClient docstring promises. */
  connectedClients?: ConnectedClient[];
  /** End a bunker client's grant — deletes the ConnectedClient row so its silent
   *  sign/decrypt access stops (the next request prompts again). */
  onDisconnectClient?: (clientPubkey: string) => void;
  /** Apps on this phone that reached the signer by NIP-55 and were remembered. One with
   *  `allowAlways` signs without a prompt, so it is listed and revocable here like a bunker client. */
  phoneApps?: PhoneApp[];
  /** Forget a phone app's decision, allow or deny; its next request asks again. */
  onForgetPhoneApp?: (packageName: string) => void;
  onBack: () => void;
}

function formatDate(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** A remembered NIP-55 decision for one app on this phone. */
export interface PhoneApp {
  packageName: string;
  /** The app's name as the phone shows it; null when only the package is known. */
  label: string | null;
  pubkey: string;
  allowAlways: boolean;
  denyAlways: boolean;
  grantedAt: number;
}

export function Connections({ connectedClients, onDisconnectClient, phoneApps, onForgetPhoneApp, onBack }: Props) {
  const [confirmingClient, setConfirmingClient] = useState<string | null>(null);

  const clients = connectedClients ?? [];
  const apps = phoneApps ?? [];
  const [confirmingApp, setConfirmingApp] = useState<string | null>(null);

  const whereYoureKnown = (
    <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 16 }}>
      Sites and apps this identity has signed in to are on the card's Where you're known column.
    </p>
  );

  if (clients.length === 0 && apps.length === 0) {
    return (
      <div className="fade-in" role="main">
        <div className="empty-state">
          <div className="empty-state-icon"><Icon name="link" size={36} /></div>
          <h3 className="empty-state-title">No connected apps</h3>
          <p className="empty-state-text">
            Sites and apps this identity has signed in to are on the card's Where you're known column. An app paired over a bunker connection, or one on this phone that uses MySignet as its signer, appears here.
          </p>
          <button className="btn btn-secondary" onClick={onBack}>
            Back to Settings
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fade-in connections" role="main">
      {whereYoureKnown}

      {clients.length > 0 && (
        <>
          <div className="section">
            <h3 style={{ fontSize: '0.95rem', marginBottom: 6 }}>Paired over Nostr Connect</h3>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 16 }}>
              Apps paired over a bunker (NIP-46) connection. One marked <strong>Always allowed</strong> can sign and decrypt for you <strong>without a prompt</strong> — disconnect it to stop that access. The next request from it will ask you again.
            </p>
          </div>
          <div className="card card-flush">
            {clients.map((client, i) => {
              const isConfirming = confirmingClient === client.clientPubkey;
              return (
                <div
                  key={client.clientPubkey}
                  style={{ padding: '14px 16px', borderBottom: i < clients.length - 1 ? '1px solid var(--border)' : 'none' }}
                >
                  <div className="connections-row">
                    <div className="connections-details">
                      <div style={{ fontWeight: 600, fontSize: '0.95rem', marginBottom: 2, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        {(client.appName || 'Unnamed app').slice(0, 100)}
                        {client.allowAlways && (
                          <span
                            title="This app can sign and decrypt without a prompt"
                            style={{ fontSize: '0.65rem', fontWeight: 600, padding: '2px 6px', borderRadius: 4, background: 'var(--danger)', color: '#fff' }}
                          >
                            ALWAYS ALLOWED
                          </span>
                        )}
                      </div>
                      {client.appUrl && (
                        <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {client.appUrl.slice(0, 200)}
                        </div>
                      )}
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                        {shortNpub(client.clientPubkey)}
                      </div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                        Last active {formatDate(client.lastSeenAt)}
                      </div>
                    </div>
                    {onDisconnectClient && (!isConfirming ? (
                      <button
                        className="btn btn-ghost"
                        onClick={() => setConfirmingClient(client.clientPubkey)}
                        style={{ color: 'var(--danger)', fontSize: '0.8rem', padding: '6px 12px', flexShrink: 0 }}
                      >
                        Disconnect
                      </button>
                    ) : (
                      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                        <button
                          className="btn btn-ghost"
                          onClick={() => { onDisconnectClient(client.clientPubkey); setConfirmingClient(null); }}
                          style={{ color: '#fff', background: 'var(--danger)', fontSize: '0.8rem', padding: '6px 12px' }}
                        >
                          Confirm
                        </button>
                        <button
                          className="btn btn-ghost"
                          onClick={() => setConfirmingClient(null)}
                          style={{ fontSize: '0.8rem', padding: '6px 12px' }}
                        >
                          Cancel
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {apps.length > 0 && (
        <>
          <div className="section" style={{ marginTop: clients.length > 0 ? 24 : 0 }}>
            <h3 style={{ fontSize: '0.95rem', marginBottom: 6 }}>Apps on this phone</h3>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 16 }}>
              Apps that use MySignet as their signer on this phone. One marked <strong>Always allowed</strong> signs for you <strong>without a prompt</strong> while MySignet is unlocked — forget it to stop that. The next request from it will ask you again.
            </p>
          </div>
          <div className="card card-flush">
            {apps.map((app, i) => {
              const isConfirming = confirmingApp === app.packageName;
              return (
                <div
                  key={app.packageName}
                  style={{ padding: '14px 16px', borderBottom: i < apps.length - 1 ? '1px solid var(--border)' : 'none' }}
                >
                  <div className="connections-row">
                    <div className="connections-details">
                      <div style={{ fontWeight: 600, fontSize: '0.95rem', marginBottom: 2, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        {(app.label || app.packageName).slice(0, 100)}
                        {app.allowAlways && (
                          <span
                            title="This app can sign without a prompt"
                            style={{ fontSize: '0.65rem', fontWeight: 600, padding: '2px 6px', borderRadius: 4, background: 'var(--danger)', color: '#fff' }}
                          >
                            ALWAYS ALLOWED
                          </span>
                        )}
                        {app.denyAlways && (
                          <span
                            title="This app is refused without a prompt"
                            style={{ fontSize: '0.65rem', fontWeight: 600, padding: '2px 6px', borderRadius: 4, background: 'var(--border)', color: 'var(--text-secondary)' }}
                          >
                            ALWAYS REFUSED
                          </span>
                        )}
                      </div>
                      {app.label && (
                        <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {app.packageName.slice(0, 200)}
                        </div>
                      )}
                      {!app.denyAlways && (
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                          As {shortNpub(app.pubkey)}
                        </div>
                      )}
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                        Decided {formatDate(app.grantedAt)}
                      </div>
                    </div>
                    {onForgetPhoneApp && (!isConfirming ? (
                      <button
                        className="btn btn-ghost"
                        onClick={() => setConfirmingApp(app.packageName)}
                        style={{ color: 'var(--danger)', fontSize: '0.8rem', padding: '6px 12px', flexShrink: 0 }}
                      >
                        Forget
                      </button>
                    ) : (
                      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                        <button
                          className="btn btn-ghost"
                          onClick={() => { onForgetPhoneApp(app.packageName); setConfirmingApp(null); }}
                          style={{ color: '#fff', background: 'var(--danger)', fontSize: '0.8rem', padding: '6px 12px' }}
                        >
                          Confirm
                        </button>
                        <button
                          className="btn btn-ghost"
                          onClick={() => setConfirmingApp(null)}
                          style={{ fontSize: '0.8rem', padding: '6px 12px' }}
                        >
                          Cancel
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
