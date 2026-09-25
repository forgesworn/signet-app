import type { ContactIdentityList } from '../lib/contacts-v2-identity-lists';
import { useEffect, useState } from 'react';
import type { EffectiveContact } from '../types';
import { ContactAvatar } from '../components/ContactAvatar';
import { ContactTierChip } from '../components/ContactTierChip';
import { Icon } from '../components/Icon';
import { useContactAvatar, seedContactAvatarPointer } from '../hooks/useContactAvatar';
import { fetchContactAvatarPointers } from '../lib/contact-avatar';
import {
  KEYLESS_MARKER, MANAGE_FAMILY_CONTACTS_LABEL, NEW_CONTACT_LABEL, RECOGNISE_PUBLIC_KEY_LABEL,
  ROLODEX_EMPTY_TEXT, ROLODEX_EMPTY_TITLE, ROLODEX_LOADING_COPY, ROLODEX_NO_MATCHES_TITLE,
  SEARCH_CONTACTS_LABEL, rolodexHeadingCopy,
} from '../lib/contacts-v2-copy';
import {
  arrangeContactsV2, CONTACT_FILTERS, filterLabel, isKeyless, primaryIdentityPubkey,
  type ContactsFilter,
} from '../lib/contacts-v2-list';

interface Props {
  initialSearch?: string;
  lists?: ContactIdentityList[];
  pendingLinks?: number;
  selectedList?: string;
  onSelectList?: (key: string) => void;
  /** The acting directory's effective contacts, straight from `useContactsV2`. */
  contacts: EffectiveContact[];
  loading: boolean;
  /** Current actor pubkey — decides "Blocked by you" wording downstream. */
  actorPubkey: string;
  /** Guardian display name for provenance copy, or null when unknown. */
  guardianName: string | null;
  /** Whose contacts these are when acting as a dependant; null for the owner. */
  subjectName: string | null;
  relayUrl: string;
  encryptionKey: string | null;
  onSelectContact: (contactId: string) => void;
  onNewContact: () => void;
  onInvites?: () => void;
  /** Recognise a public key (legacy ken flow) — unchanged in this phase. */
  onAddKen?: () => void;
  /** Guardian-only cross-family table. Absent unless the scope allows it. */
  onManageFamily?: () => void;
}

const COMPACT_THRESHOLD = 8;

function RowAvatar({ pubkey, name, relayUrl, encryptionKey }: {
  pubkey: string | null; name: string; relayUrl: string; encryptionKey: string | null;
}) {
  const url = useContactAvatar(pubkey ?? '', relayUrl, encryptionKey);
  return (
    <div style={{ flexShrink: 0 }}>
      <ContactAvatar url={pubkey ? url : null} name={name} pubkey={pubkey ?? name} size={32} />
    </div>
  );
}

function ContactRow({ contact, guardianName, relayUrl, encryptionKey, onTap }: {
  contact: EffectiveContact; guardianName: string | null;
  relayUrl: string; encryptionKey: string | null; onTap: () => void;
}) {
  const pubkey = primaryIdentityPubkey(contact);
  return (
    <button className="row row-button" onClick={onTap} aria-label={`Open ${contact.displayName}`}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }}>
        <RowAvatar pubkey={pubkey} name={contact.displayName} relayUrl={relayUrl} encryptionKey={encryptionKey} />
        <span className="row-main">
          <span className="row-label" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {contact.displayName}{contact.appIntroductions?.some(i => i.status === 'pending') ? ' · Link needs review' : ''}
          </span>
          {isKeyless(contact) && <span className="row-sub">{KEYLESS_MARKER}</span>}
        </span>
      </span>
      <span className="row-meta">
        <ContactTierChip
          tier={contact.effectiveTier}
          source={contact.tierSource}
          guardianName={guardianName}
          blocked={contact.blocked}
          compact
        />
      </span>
      <span className="row-chevron" aria-hidden="true">&rsaquo;</span>
    </button>
  );
}

export function ContactsRolodex({ initialSearch = '', pendingLinks = 0, lists, selectedList, onSelectList,
  contacts, loading, guardianName, subjectName, relayUrl, encryptionKey,
  onSelectContact, onNewContact, onAddKen, onManageFamily, onInvites,
}: Props) {
  const [filter, setFilter] = useState<ContactsFilter>('all');
  const [query, setQuery] = useState(initialSearch);
  const [inviteFilter, setInviteFilter] = useState('');
  useEffect(() => { setInviteFilter(''); }, [selectedList, subjectName]);
  const inviteNames = [...new Set(contacts.flatMap(contact => (contact.origins ?? []).filter(origin => !selectedList || selectedList === 'all' || origin.ownerIdentityPubkey === selectedList).map(origin => origin.inviteName).filter((name): name is string => !!name)))].sort();

  const displayed = arrangeContactsV2(contacts.filter(contact => !inviteFilter || contact.origins?.some(origin => origin.inviteName === inviteFilter && (!selectedList || selectedList === 'all' || origin.ownerIdentityPubkey === selectedList))), { filter, query });

  // Batch-fetch every visible contact's avatar pointer in ONE relay round-trip
  // and seed the module cache, so each row's useContactAvatar resolves from
  // cache instead of opening its own connection. Seeding null for misses too
  // prevents per-row refetch. `displayed` is recomputed each render, so the
  // effect depends on a stable joined-pubkey string, not the array identity.
  const pubkeyKey = displayed
    .map(primaryIdentityPubkey)
    .filter((pk): pk is string => !!pk)
    .join(',');
  useEffect(() => {
    const pubkeys = pubkeyKey ? pubkeyKey.split(',') : [];
    if (pubkeys.length === 0) return;
    let cancelled = false;
    void (async () => {
      const map = await fetchContactAvatarPointers(pubkeys, relayUrl);
      if (cancelled) return;
      for (const pk of pubkeys) seedContactAvatarPointer(pk, map.get(pk.toLowerCase()) ?? null);
    })();
    return () => { cancelled = true; };
  }, [pubkeyKey, relayUrl]);

  const compact = displayed.length > COMPACT_THRESHOLD;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div style={{ padding: '14px 16px 8px', flexShrink: 0 }}>
        {pendingLinks > 0 && <button className="btn btn-secondary btn-sm" onClick={() => onSelectList?.('all')}>
          Review app links ({pendingLinks}) — shown under All
        </button>}
        {lists && onSelectList && <label>Identity list
          <select className="input" aria-label="Identity list" value={selectedList} onChange={e => onSelectList(e.target.value)}>
            {lists.map(l => <option key={l.ownerIdentityPubkey} value={l.ownerIdentityPubkey}>{l.label}</option>)}
            <option value="all">All — including unassigned contacts</option>
          </select>
        </label>}
        {inviteNames.length > 0 && <label>Private invite
          <select className="input" aria-label="Private invite" value={inviteFilter} onChange={event => setInviteFilter(event.target.value)}>
            <option value="">All invites</option>{inviteNames.map(name => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>}
        {subjectName && (
          <p className="field-hint" style={{ marginBottom: 8 }}>{rolodexHeadingCopy(subjectName)}</p>
        )}
        <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
          {CONTACT_FILTERS.map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              aria-pressed={filter === f}
              style={{
                padding: '4px 12px', borderRadius: 20, border: '1px solid',
                borderColor: filter === f ? 'var(--accent)' : 'var(--border)',
                background: filter === f ? 'var(--accent)' : 'var(--bg-secondary)',
                color: filter === f ? 'var(--on-accent)' : 'var(--text-secondary)',
                fontSize: '0.8rem', fontWeight: filter === f ? 700 : 400, cursor: 'pointer',
              }}
            >
              {filterLabel(f)}
            </button>
          ))}
        </div>
        {onInvites && <button className="btn btn-secondary" onClick={onInvites}>Invites and requests</button>}
        <input
          type="search"
          className="input input-sm"
          placeholder={SEARCH_CONTACTS_LABEL}
          aria-label={SEARCH_CONTACTS_LABEL}
          value={query}
          onChange={e => setQuery(e.target.value)}
          maxLength={100}
        />
      </div>

      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: '0 16px 16px' }}>
        {loading ? (
          <div className="empty-state" style={{ height: '100%', justifyContent: 'center' }}>
            <p className="empty-state-text">{ROLODEX_LOADING_COPY}</p>
          </div>
        ) : displayed.length === 0 ? (
          <div className="empty-state" style={{ height: '100%', justifyContent: 'center' }}>
            <div className="empty-state-icon"><Icon name="users" size={36} /></div>
            <h3 className="empty-state-title">
              {query || filter !== 'all' ? ROLODEX_NO_MATCHES_TITLE : ROLODEX_EMPTY_TITLE}
            </h3>
            {!query && filter === 'all' && (
              <p className="empty-state-text">{ROLODEX_EMPTY_TEXT}</p>
            )}
            {!query && (
              <button className="btn btn-primary" onClick={onNewContact}>{NEW_CONTACT_LABEL}</button>
            )}
          </div>
        ) : (
          <div style={{ paddingBottom: compact ? 0 : 8 }}>
            {displayed.map(c => (
              <ContactRow
                key={c.contactId}
                contact={c}
                guardianName={guardianName}
                relayUrl={relayUrl}
                encryptionKey={encryptionKey}
                onTap={() => onSelectContact(c.contactId)}
              />
            ))}
          </div>
        )}
      </div>

      <div style={{ flexShrink: 0, padding: '0 16px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <button className="btn btn-secondary" onClick={onNewContact}>{NEW_CONTACT_LABEL}</button>
        {onAddKen && (
          <button className="btn btn-ghost" onClick={onAddKen}>{RECOGNISE_PUBLIC_KEY_LABEL}</button>
        )}
        {onManageFamily && (
          <button className="btn btn-ghost" onClick={onManageFamily}>
            {MANAGE_FAMILY_CONTACTS_LABEL}
          </button>
        )}
      </div>
    </div>
  );
}
