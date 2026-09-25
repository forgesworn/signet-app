import { useState, useEffect, useCallback, useRef } from 'react';
import type { SigningBackend } from '../lib/signing-backend';
import { type UnsignedEvent, verifyEvent } from 'signet-protocol';
import { publishEvent, fetchEvents } from '../lib/relay-service';
import { decodeNpub, shortNpub } from '../lib/signet';
import { bytesToHex } from '@noble/hashes/utils.js';

interface RosterMember {
  pubkey: string;
  role: string;
  displayName: string;
}

interface Props {
  backend: SigningBackend;
  signerDisplayName?: string;
  onBack: () => void;
}

const MAX_DISPLAY_NAME = 100;
const MAX_ROLE = 50;
const MAX_ROSTER_MEMBERS = 100;

function isValidHexPubkey(s: string): boolean {
  return /^[0-9a-f]{64}$/i.test(s);
}

function parsePubkeyInput(input: string): string | null {
  const trimmed = input.trim();
  if (isValidHexPubkey(trimmed)) return trimmed.toLowerCase();
  // Try npub decode
  try {
    const decoded = decodeNpub(trimmed);
    const hex = bytesToHex(decoded);
    if (isValidHexPubkey(hex)) return hex.toLowerCase();
  } catch { /* not an npub */ }
  return null;
}

function stripControlChars(s: string): string {
  return s.replace(/[\x00-\x1f\x7f-\x9f\u200e\u200f\u202a-\u202e]/g, '');
}

export function Roster({ backend, signerDisplayName, onBack }: Props) {
  const [members, setMembers] = useState<RosterMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [publishing, setPublishing] = useState(false);
  const [published, setPublished] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  // Add form state
  const [adding, setAdding] = useState(false);
  const [newPubkey, setNewPubkey] = useState('');
  const [newRole, setNewRole] = useState('');
  const [newDisplayName, setNewDisplayName] = useState('');
  const [addError, setAddError] = useState<string | null>(null);

  // Edit state
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editRole, setEditRole] = useState('');
  const [editDisplayName, setEditDisplayName] = useState('');

  // Cleanup published flash timeout on unmount
  const publishedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (publishedTimerRef.current) clearTimeout(publishedTimerRef.current);
  }, []);

  // Fetch existing roster from relay (best-effort — page is usable without it)
  useEffect(() => {
    const load = async () => {
      try {
        const events = await fetchEvents([{
          kinds: [31920],
          authors: [backend.activePublicKeyHex],
          '#d': ['staff-roster'],
        }]);
        if (events.length > 0) {
          const latest = events.sort((a, b) => b.created_at - a.created_at)[0];
          if (!await verifyEvent(latest)) return; // reject forged events
          const parsed: RosterMember[] = [];
          for (const tag of latest.tags) {
            if (tag[0] === 'p' && tag[1] && isValidHexPubkey(tag[1])) {
              parsed.push({
                pubkey: tag[1].toLowerCase(),
                role: (tag[2] ?? '').slice(0, MAX_ROLE),
                displayName: stripControlChars((tag[3] ?? '').slice(0, MAX_DISPLAY_NAME)),
              });
            }
          }
          setMembers(parsed);
        }
      } catch {
        // Relay unreachable or no existing roster — not an error, just start fresh
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [backend.activePublicKeyHex]);

  // Role autocomplete suggestions
  const roleSuggestions = [...new Set(members.map(m => m.role).filter(Boolean))];

  const handleAdd = useCallback(() => {
    setAddError(null);
    if (members.length >= MAX_ROSTER_MEMBERS) {
      setAddError(`Roster cannot exceed ${MAX_ROSTER_MEMBERS} members`);
      return;
    }
    const pubkey = parsePubkeyInput(newPubkey);
    if (!pubkey) {
      setAddError('Enter a valid public address starting with npub1.');
      return;
    }
    if (members.some(m => m.pubkey === pubkey)) {
      setAddError('This pubkey is already in the roster');
      return;
    }
    const role = stripControlChars(newRole.trim()).slice(0, MAX_ROLE);
    const displayName = stripControlChars(newDisplayName.trim()).slice(0, MAX_DISPLAY_NAME);
    if (!displayName) {
      setAddError('Display name is required');
      return;
    }
    setMembers(prev => [...prev, { pubkey, role, displayName }]);
    setNewPubkey('');
    setNewRole('');
    setNewDisplayName('');
    setAdding(false);
    setDirty(true);
  }, [newPubkey, newRole, newDisplayName, members]);

  const handleRemove = useCallback((index: number) => {
    setMembers(prev => prev.filter((_, i) => i !== index));
    setDirty(true);
  }, []);

  const handleStartEdit = useCallback((index: number) => {
    setEditingIndex(index);
    setEditRole(members[index].role);
    setEditDisplayName(members[index].displayName);
  }, [members]);

  const handleSaveEdit = useCallback(() => {
    if (editingIndex === null) return;
    setMembers(prev => prev.map((m, i) =>
      i === editingIndex
        ? { ...m, role: stripControlChars(editRole.trim()).slice(0, MAX_ROLE), displayName: stripControlChars(editDisplayName.trim()).slice(0, MAX_DISPLAY_NAME) || m.displayName }
        : m,
    ));
    setEditingIndex(null);
    setDirty(true);
  }, [editingIndex, editRole, editDisplayName]);

  const publishingRef = useRef(false);
  const handlePublish = useCallback(async () => {
    if (publishingRef.current) return;
    publishingRef.current = true;
    setPublishing(true);
    setError(null);
    setPublished(false);
    try {
      const unsigned: UnsignedEvent = {
        pubkey: backend.activePublicKeyHex,
        kind: 31920,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['d', 'staff-roster'],
          ...members.map(m => ['p', m.pubkey, m.role, m.displayName]),
        ],
        content: '',
      };
      const signed = await backend.signEvent(unsigned);
      const result = await publishEvent(signed);
      if (!result.ok) {
        setError(`Relay rejected: ${result.message.slice(0, 200)}`);
      } else {
        setPublished(true);
        setDirty(false);
        publishedTimerRef.current = setTimeout(() => setPublished(false), 3000);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message.slice(0, 200) : 'Failed to publish');
    } finally {
      setPublishing(false);
      publishingRef.current = false;
    }
  }, [backend, members]);

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-secondary)' }}>
        Loading roster...
      </div>
    );
  }

  return (
    <div className="fade-in" role="main">
      <div className="section">
        <div className="card" style={{ background: 'var(--bg-input)', marginBottom: 12, padding: '10px 14px' }}>
          <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
            Signing as
          </div>
          <div style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--text-primary)' }}>
            {signerDisplayName || 'Unknown identity'}
          </div>
          <div style={{ fontSize: '0.75rem', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', marginTop: 2 }}>
            {shortNpub(backend.activePublicKeyHex)}
          </div>
        </div>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 16 }}>
          Manage a list of authorised pubkeys with roles. Publishing replaces any existing roster signed by this key.
        </p>
      </div>

      {/* Member list */}
      {members.length > 0 && (
        <div className="card card-flush" style={{ marginBottom: 16 }}>
          {members.map((member, i) => (
            <div
              key={member.pubkey}
              style={{
                padding: '12px 14px',
                borderBottom: i < members.length - 1 ? '1px solid var(--border)' : 'none',
              }}
            >
              {editingIndex === i ? (
                <div>
                  <div style={{ fontWeight: 600, fontSize: '0.9rem', marginBottom: 8 }}>
                    {member.displayName}
                    <span style={{ fontWeight: 400, fontSize: '0.75rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', marginLeft: 8 }}>
                      {shortNpub(member.pubkey)}
                    </span>
                  </div>
                  <input
                    className="input"
                    value={editRole}
                    onChange={e => setEditRole(e.target.value)}
                    placeholder="Role"
                    maxLength={MAX_ROLE}
                    list="role-suggestions"
                    style={{ marginBottom: 6 }}
                  />
                  <input
                    className="input"
                    value={editDisplayName}
                    onChange={e => setEditDisplayName(e.target.value)}
                    placeholder="Display name"
                    maxLength={MAX_DISPLAY_NAME}
                    style={{ marginBottom: 8 }}
                  />
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button className="btn btn-primary" onClick={handleSaveEdit} style={{ flex: 1 }}>Save</button>
                    <button className="btn btn-ghost" onClick={() => setEditingIndex(null)} style={{ flex: 1 }}>Cancel</button>
                  </div>
                </div>
              ) : (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: '0.9rem', marginBottom: 2 }}>
                      {member.displayName.slice(0, MAX_DISPLAY_NAME)}
                    </div>
                    <div style={{ fontSize: '0.75rem', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', marginBottom: 2 }}>
                      {shortNpub(member.pubkey)}
                    </div>
                    {member.role && (
                      <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                        {member.role}
                      </div>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                    <button className="btn btn-ghost" onClick={() => handleStartEdit(i)} style={{ padding: '4px 10px', fontSize: '0.8rem' }}>
                      Edit
                    </button>
                    <button className="btn btn-ghost" onClick={() => handleRemove(i)} style={{ padding: '4px 10px', fontSize: '0.8rem', color: 'var(--danger)' }}>
                      Remove
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {members.length === 0 && !adding && (
        <div className="card section" style={{ textAlign: 'center', padding: 24 }}>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: 12 }}>
            No roster members yet.
          </p>
        </div>
      )}

      {/* Add member form */}
      {adding ? (
        <div className="card section" style={{ padding: 16 }}>
          <div style={{ fontWeight: 600, fontSize: '0.9rem', marginBottom: 8 }}>Add member</div>
          <input
            className="input"
            value={newPubkey}
            onChange={e => { setNewPubkey(e.target.value); setAddError(null); }}
            placeholder="npub1…"
            maxLength={200}
            style={{ marginBottom: 6 }}
          />
          <input
            className="input"
            value={newRole}
            onChange={e => setNewRole(e.target.value)}
            placeholder="Role (e.g. admin, steward)"
            maxLength={MAX_ROLE}
            list="role-suggestions"
            style={{ marginBottom: 6 }}
          />
          <input
            className="input"
            value={newDisplayName}
            onChange={e => setNewDisplayName(e.target.value)}
            placeholder="Display name"
            maxLength={MAX_DISPLAY_NAME}
            style={{ marginBottom: 8 }}
          />
          {addError && (
            <p style={{ fontSize: '0.8rem', color: 'var(--danger)', marginBottom: 8 }}>{addError}</p>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-primary" onClick={handleAdd} style={{ flex: 1 }}>Add</button>
            <button className="btn btn-ghost" onClick={() => { setAdding(false); setAddError(null); }} style={{ flex: 1 }}>Cancel</button>
          </div>
        </div>
      ) : (
        <button className="btn btn-secondary" onClick={() => setAdding(true)} style={{ width: '100%', marginBottom: 16 }}>
          + Add member
        </button>
      )}

      {/* Role autocomplete datalist */}
      {roleSuggestions.length > 0 && (
        <datalist id="role-suggestions">
          {roleSuggestions.map(role => (
            <option key={role} value={role} />
          ))}
        </datalist>
      )}

      {/* Status */}
      {error && (
        <div style={{ color: 'var(--danger)', textAlign: 'center', fontSize: '0.85rem', marginBottom: 12 }}>
          {error}
        </div>
      )}
      {published && (
        <div style={{ color: 'var(--success)', textAlign: 'center', fontSize: '0.85rem', marginBottom: 12 }}>
          Roster published successfully
        </div>
      )}

      {/* Publish button */}
      <button
        className="btn btn-primary"
        onClick={handlePublish}
        disabled={publishing || members.length === 0}
        style={{ width: '100%', marginBottom: 8 }}
      >
        {publishing ? 'Publishing...' : dirty ? 'Publish roster' : 'Republish roster'}
      </button>

      <button className="btn btn-ghost" onClick={onBack} style={{ width: '100%' }}>
        Back to Settings
      </button>
    </div>
  );
}
