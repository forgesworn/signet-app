import { useState, useEffect, useCallback } from 'react';
import type { Contact } from '../types';
import * as db from '../lib/db';

export function useContacts(ownerPubkey: string | undefined, encryptionKey?: string | null) {
  const [members, setMembers] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    if (!ownerPubkey) { setMembers([]); setLoading(false); return; }
    const all = await db.getContacts(ownerPubkey, encryptionKey || undefined);
    setMembers(all.sort((a, b) => b.verifiedAt - a.verifiedAt));
    setLoading(false);
  }, [ownerPubkey, encryptionKey]);

  useEffect(() => { reload(); }, [reload]);

  const addMember = useCallback(async (member: Contact) => {
    await db.saveContact(member, encryptionKey || undefined);
    await reload();
  }, [reload, encryptionKey]);

  const removeMember = useCallback(async (pubkey: string) => {
    await db.deleteContact(pubkey);
    await reload();
  }, [reload]);

  const getContactGroup = useCallback((groupId: string): Contact[] => {
    return members.filter(m => m.groupId === groupId);
  }, [members]);

  const setDefaultContact = useCallback(async (pubkey: string) => {
    const target = members.find(m => m.pubkey === pubkey);
    if (!target?.groupId) return;
    const group = members.filter(m => m.groupId === target.groupId);
    for (const m of group) {
      await db.saveContact(
        { ...m, isDefaultForGroup: m.pubkey === pubkey },
        encryptionKey || undefined,
      );
    }
    await reload();
  }, [members, encryptionKey, reload]);

  return { members, loading, addMember, removeMember, reload, getContactGroup, setDefaultContact };
}
