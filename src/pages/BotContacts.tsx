import { useEffect, useMemo, useState } from 'react';
import type { SignetIdentity } from '../types';
import type { BotRecord } from '../lib/bot-registry';
import { useContactsV2 } from '../hooks/useContactsV2';
import { contactBelongsToList } from '../lib/contacts-v2-membership';
import { resolveActorRights, ownBlocks } from '../lib/contacts-v2-rights';
import { detailSections } from '../lib/contacts-v2-detail';
import { ContactNew } from './ContactNew';
import { ContactDetail } from './ContactDetail';
import { ContactsRolodex } from './ContactsRolodex';
const context = { activeGuardianPubkeys: [], defaultChildCeiling: 'ken' as const, directoryIsDependant: false };
const legacy = { hasSharedSecret: false, hasKenEntry: false };
/** The bot directory is separate even when a contact shares a public key with
 * someone in the human owner's contacts. There is no global All route here. */
export function BotContacts({ bot, identity, encryptionKey, deviceId, relayUrl, version, onChanged, onBack }: {
  bot: BotRecord; identity: SignetIdentity; encryptionKey: string; deviceId: string; relayUrl: string;
  version: number; onChanged(): void; onBack(): void;
}) {
  const actor = useMemo(() => ({ actorPubkey: identity.naturalPerson.publicKey, actorRole: 'owner' as const, actorDeviceId: deviceId }),
    [identity.naturalPerson.publicKey, deviceId]);
  const contacts = useContactsV2({ directoryId: 'bots', ownerIdentityPubkey: bot.publicKey, encryptionKey,
    actor, context, onMutated: onChanged });
  const [view, setView] = useState<'list' | 'new' | 'detail'>('list'), [selected, setSelected] = useState('');
  useEffect(() => { void contacts.reload(); }, [version, contacts.reload]);
  const visible = contacts.effective.filter(contact => contactBelongsToList(contact, bot.publicKey));
  const found = visible.find(contact => contact.contactId === selected && contact.lifecycle !== 'removed');
  const contact = found ? { ...found, checks: found.checks?.filter(check => check.ownerIdentityPubkey === bot.publicKey) } : undefined;
  const label = `${bot.label} · Bot`;
  return <div>
    <button className="btn btn-ghost" onClick={() => view === 'list' ? onBack() : setView('list')}>{view === 'list' ? 'Back to bots' : 'Back to bot contacts'}</button>
    <h2>{label} contacts</h2>
    {view === 'new' ? <ContactNew subjectName={label} onCreate={async (value, methods) => {
      const id = await contacts.addContact({ ...value, ownerIdentityPubkey: bot.publicKey });
      for (const method of methods) await contacts.addContactMethod(id, method);
    }} onDone={() => setView('list')} /> : view === 'detail' && contact ? <ContactDetail key={contact.contactId}
      contact={contact} identity={identity} actorPubkey={actor.actorPubkey} guardianName={null}
      rights={resolveActorRights(contact, actor)} sections={detailSections(contact, resolveActorRights(contact, actor), legacy)} legacy={legacy}
      checkOwnerIdentityPubkey={bot.publicKey}
      onRecordOrigin={origin => contacts.recordOrigin(contact.contactId, origin)} onRemoveOrigin={id => contacts.removeOrigin(contact.contactId, id)}
      onUpdateCheck={check => contacts.updateCheck(contact.contactId, check)}
      onRecordCheck={check => contacts.recordCheck(contact.contactId, check)} onRemoveCheck={id => contacts.removeCheck(contact.contactId, id)}
      onRename={name => contacts.renameContact(contact.contactId, name)} onSetTier={tier => contacts.setTier(contact.contactId, tier)}
      onAddRole={roles => contacts.setRoles(contact.contactId, roles)} onRemoveRole={roles => contacts.setRoles(contact.contactId, roles)}
      onAddMethod={async method => { await contacts.addContactMethod(contact.contactId, method); }}
      onRemoveItem={id => contacts.removeItem(contact.contactId, id)} onSetNote={note => contacts.setNote(contact.contactId, note)}
      onBlock={reason => contacts.block(contact.contactId, { scope: { kind: 'contact' }, reason })} onUnblock={async () => {
        for (const block of ownBlocks(contact, actor.actorPubkey)) await contacts.unblock(contact.contactId, block.operationId);
      }} onRemove={async () => { await contacts.removeContact(contact.contactId); setView('list'); }} onOpenKenDetail={() => {}} />
      : <ContactsRolodex contacts={visible} loading={contacts.loading} actorPubkey={actor.actorPubkey} guardianName={null}
        subjectName={label} relayUrl={relayUrl} encryptionKey={encryptionKey} onSelectContact={id => { setSelected(id); setView('detail'); }}
        onNewContact={() => setView('new')} />}
  </div>;
}
