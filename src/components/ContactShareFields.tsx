import type { ContactRecord } from '../types';
import type { ContactShareFields as Fields } from '../lib/contact-share-fields';
import { METHOD_KIND_LABELS } from '../lib/contacts-v2-detail';

export function ContactShareFields({ contact, value, onChange }: {
  contact: ContactRecord; value: Fields; onChange: (value: Fields) => void;
}) {
  const toggle = (kind: 'identities' | 'methods', id: string, checked: boolean) =>
    onChange({ ...value, [kind]: checked ? [...value[kind], id] : value[kind].filter(i => i !== id) });
  return <fieldset style={{ border: 0, padding: 0 }}>
    <legend>Fields to share</legend>
    <label className="row"><input type="checkbox" checked={value.name} onChange={e => onChange({ ...value, name: e.target.checked })} /> Name: {contact.displayName}</label>
    {contact.identities.map(i => <label className="row" key={i.itemId}>
      <input type="checkbox" checked={value.identities.includes(i.itemId)} onChange={e => toggle('identities', i.itemId, e.target.checked)} />
      Public key: {i.pubkey.slice(0, 12)}…
    </label>)}
    {contact.contactMethods.map(m => <label className="row" key={m.itemId}>
      <input type="checkbox" checked={value.methods.includes(m.itemId)} onChange={e => toggle('methods', m.itemId, e.target.checked)} />
      {METHOD_KIND_LABELS[m.kind]}: {m.value}
    </label>)}
    {(['tier', 'roles', 'notes', 'type', 'checks', 'blocked'] as const).map(key => <label className="row" key={key}>
      <input type="checkbox" checked={value[key]} onChange={e => onChange({ ...value, [key]: e.target.checked })} />
      {{ tier: 'Tier', roles: 'Roles', notes: 'Notes', type: 'Person or organisation', checks: 'Check summaries and dates', blocked: 'Block status' }[key]}
    </label>)}
  </fieldset>;
}
