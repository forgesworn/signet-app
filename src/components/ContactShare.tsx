import { useState } from 'react';
import type { ContactRecord } from '../types';
import { ContactShareFields } from './ContactShareFields';
import { contactVCard, defaultShareFields } from '../lib/contact-share-fields';

export function ContactShare({ contact }: { contact: ContactRecord }) {
  const [open, setOpen] = useState(false);
  const [fields, setFields] = useState(() => defaultShareFields(contact));
  return <div className="card section">
    <h2>Share contact</h2>
    {!open ? <button className="btn btn-secondary" onClick={() => { setFields(defaultShareFields(contact)); setOpen(true); }}>Choose fields to share</button>
      : <>
        <ContactShareFields contact={contact} value={fields} onChange={setFields} />
        <p className="field-hint">Share only what this person is happy for you to pass on. Private evidence and identity-list links are never included.</p>
        <a className="btn btn-primary" download="contact.vcf" href={`data:text/vcard;charset=utf-8,${encodeURIComponent(contactVCard(contact, fields))}`}>Download selected fields as vCard</a>
        <button className="btn btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
      </>}
  </div>;
}
