import { useState } from 'react';
import type { AuthorizedSite, SignetIdentity, OriginPolicy, ConnectedClient } from '../types';
import { shortNpub } from '../lib/signet';
import { tokenForKeypair } from '../lib/identity-label';
import { KeypairBadge } from '../components/KeypairBadge';
import { Icon } from '../components/Icon';

interface Props {
  sites: AuthorizedSite[];
  identity: SignetIdentity;
  /** Per-origin policies — read for pin status, written by pin/unpin actions. */
  originPolicies?: OriginPolicy[];
  /** Bunker (NIP-46) clients paired with this device. A client with
   *  `allowAlways` can sign/decrypt WITHOUT a prompt, so it must be listed and
   *  revocable here — this is the surface the ConnectedClient docstring promises. */
  connectedClients?: ConnectedClient[];
  onRevoke: (id: string) => void;
  /** End a bunker client's grant — deletes the ConnectedClient row so its silent
   *  sign/decrypt access stops (the next request prompts again). */
  onDisconnectClient?: (clientPubkey: string) => void;
  /** Apps on this phone that reached the signer by NIP-55 and were remembered. One with
   *  `allowAlways` signs without a prompt, so it is listed and revocable here like a bunker client. */
  phoneApps?: PhoneApp[];
  /** Forget a phone app's decision, allow or deny; its next request asks again. */
  onForgetPhoneApp?: (packageName: string) => void;
  onSetPinned?: (origin: string, pinned: boolean) => Promise<void> | void;
  onUpdateAlias?: (id: string, alias: string) => Promise<void> | void;
  onBack: () => void;
}

function formatDate(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function extractDomain(origin: string): string {
  try {
    return new URL(origin).hostname.slice(0, 64);
  } catch {
    return origin.slice(0, 64);
  }
}

function resolvePersonaName(site: AuthorizedSite, identity: SignetIdentity): string {
  if (site.keypairUsed === 'natural-person') {
    return identity.naturalPerson.displayName || 'Natural Person';
  }
  // Check if it matches the built-in persona
  if (site.pubkeyShared === identity.persona.publicKey) {
    return identity.persona.displayName || 'Persona';
  }
  // Check extra personas
  const extra = (identity.extraPersonas ?? []).find(p => p.publicKey === site.pubkeyShared);
  if (extra) return extra.displayName || 'Persona';
  return 'Persona';
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

export function Connections({ sites, identity, originPolicies, connectedClients, onRevoke, onDisconnectClient, phoneApps, onForgetPhoneApp, onSetPinned, onUpdateAlias, onBack }: Props) {
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [confirmingClient, setConfirmingClient] = useState<string | null>(null);
  const [editingAliasId, setEditingAliasId] = useState<string | null>(null);
  const [aliasDraft, setAliasDraft] = useState('');

  const clients = connectedClients ?? [];
  const apps = phoneApps ?? [];
  const [confirmingApp, setConfirmingApp] = useState<string | null>(null);

  // Build a quick lookup so the per-site card can show its pin state.
  const policyByOrigin = new Map<string, OriginPolicy>();
  for (const p of originPolicies ?? []) policyByOrigin.set(p.origin, p);

  if (sites.length === 0 && clients.length === 0 && apps.length === 0) {
    return (
      <div className="fade-in" role="main">
        <div className="empty-state">
          <div className="empty-state-icon"><Icon name="link" size={36} /></div>
          <h3 className="empty-state-title">No connected sites or apps</h3>
          <p className="empty-state-text">
            When you sign in to a website, or pair an app over a bunker connection, it will appear here.
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
      {sites.length > 0 && (
      <div className="section">
        <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 16 }}>
          Sites you've signed in to with your Signet identity. Revoking removes local authorization — the site will need to request access again.
        </p>
      </div>
      )}

      {sites.length > 0 && (
      <div className="card card-flush">
        {sites.map((site, i) => {
          const personaName = resolvePersonaName(site, identity);
          const isConfirming = confirmingId === site.id;
          const policy = (() => {
            try { return policyByOrigin.get(new URL(site.origin).origin); } catch { return undefined; }
          })();
          const isPinned = !!policy?.pinned;

          return (
            <div
              key={site.id}
              style={{
                padding: '14px 16px',
                borderBottom: i < sites.length - 1 ? '1px solid var(--border)' : 'none',
              }}
            >
              <div className="connections-row">
                <div className="connections-details">
                  <div style={{ fontWeight: 600, fontSize: '0.95rem', marginBottom: 2, display: 'flex', alignItems: 'center', gap: 6 }}>
                    {site.name.slice(0, 100)}
                    {isPinned && (
                      <span
                        title="Pinned — this site will always use the chosen identity, ignoring its own preference"
                        style={{
                          fontSize: '0.65rem',
                          fontWeight: 600,
                          padding: '2px 6px',
                          borderRadius: 4,
                          background: 'var(--accent)',
                          color: 'var(--on-accent)',
                        }}
                      >
                        PINNED
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: 4 }}>
                    {extractDomain(site.origin)}
                  </div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span>{personaName.slice(0, 100)}</span>
                    <KeypairBadge token={tokenForKeypair(site.keypairUsed)} />
                    <span style={{ fontFamily: 'var(--font-mono)' }}>{shortNpub(site.pubkeyShared)}</span>
                  </div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                    Last used {formatDate(site.lastUsedAt)}
                  </div>
                  {onUpdateAlias && (
                    <div style={{ marginTop: 6, fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                      {editingAliasId === site.id ? (
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                          <input
                            type="text"
                            value={aliasDraft}
                            onChange={e => setAliasDraft(e.target.value.slice(0, 64))}
                            maxLength={64}
                            autoFocus
                            placeholder="Known to this site as…"
                            style={{
                              flex: 1,
                              padding: '4px 8px',
                              borderRadius: 4,
                              border: '1px solid var(--border)',
                              background: 'var(--bg)',
                              color: 'var(--text-primary)',
                              fontSize: '0.8rem',
                            }}
                          />
                          <button
                            className="btn btn-ghost"
                            onClick={async () => {
                              await onUpdateAlias(site.id, aliasDraft);
                              setEditingAliasId(null);
                            }}
                            style={{ fontSize: '0.75rem', padding: '4px 8px' }}
                          >Save</button>
                          <button
                            className="btn btn-ghost"
                            onClick={() => setEditingAliasId(null)}
                            style={{ fontSize: '0.75rem', padding: '4px 8px' }}
                          >Cancel</button>
                        </div>
                      ) : (
                        <span>
                          {site.consumerDisplayName
                            ? <>Known to {extractDomain(site.origin)} as <strong>{site.consumerDisplayName.slice(0, 64)}</strong></>
                            : <em>No alias recorded</em>}
                          <button
                            className="btn btn-ghost"
                            onClick={() => {
                              setEditingAliasId(site.id);
                              setAliasDraft(site.consumerDisplayName ?? '');
                            }}
                            style={{ fontSize: '0.7rem', padding: '2px 8px', marginLeft: 8 }}
                          >
                            {site.consumerDisplayName ? 'Edit' : 'Add'}
                          </button>
                        </span>
                      )}
                    </div>
                  )}
                  {onSetPinned && (
                    <div style={{ marginTop: 8 }}>
                      <button
                        className="btn btn-ghost"
                        onClick={() => { void onSetPinned(site.origin, !isPinned); }}
                        style={{ fontSize: '0.75rem', padding: '4px 10px' }}
                      >
                        {isPinned ? 'Unpin identity' : 'Pin this identity'}
                      </button>
                    </div>
                  )}
                </div>
                {!isConfirming ? (
                  <button
                    className="btn btn-ghost"
                    onClick={() => setConfirmingId(site.id)}
                    style={{
                      color: 'var(--danger)',
                      fontSize: '0.8rem',
                      padding: '6px 12px',
                      flexShrink: 0,
                    }}
                  >
                    Revoke
                  </button>
                ) : (
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    <button
                      className="btn btn-ghost"
                      onClick={() => { onRevoke(site.id); setConfirmingId(null); }}
                      style={{
                        color: '#fff',
                        background: 'var(--danger)',
                        fontSize: '0.8rem',
                        padding: '6px 12px',
                      }}
                    >
                      Confirm
                    </button>
                    <button
                      className="btn btn-ghost"
                      onClick={() => setConfirmingId(null)}
                      style={{
                        fontSize: '0.8rem',
                        padding: '6px 12px',
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
      )}

      {clients.length > 0 && (
        <>
          <div className="section" style={{ marginTop: sites.length > 0 ? 24 : 0 }}>
            <h3 style={{ fontSize: '0.95rem', marginBottom: 6 }}>Connected apps</h3>
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
          <div className="section" style={{ marginTop: sites.length > 0 || clients.length > 0 ? 24 : 0 }}>
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
