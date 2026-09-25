import { defaultShareFields, type ContactShareFields } from './contact-share-fields';
/** Selected-field copies between independent vaults. Checks and tier travel
 * as the sender's attributed context, never as the recipient's own evidence. */
import type {
  AddContactValue, AddIdentityValue, AddMethodValue, SharedContactContext, ContactTier, EffectiveContact, VouchValue,
} from '../types';
import { shareConfirmCopy, vouchConfirmCopy } from './contacts-v2-copy';
import { normaliseRole } from './contacts-v2-detail';

export interface DirectoryTarget {
  directoryId: string;
  ownerIdentityPubkey?: string;
  label: string;
  /** The target's existing record for this contact, when it already has one. */
  contactId: string | null;
  /** Per-target role label, used by vouch only. */
  role?: string;
}

/** Public keys only: private evidence and key-link metadata never travel. */
function shareableIdentities(source: EffectiveContact, fields = defaultShareFields(source, true)): Omit<AddIdentityValue, 'itemId'>[] {
  return source.identities.filter(i => fields.identities.includes(i.itemId)).map(i => ({
    pubkey: i.pubkey,
    provenance: 'guardian-share' as const,
    verification: 'unverified' as const,
  }));
}

function shareableAdd(source: EffectiveContact, fields = defaultShareFields(source, true)): AddContactValue {
  return { type: fields.type ? source.type : 'person', displayName: fields.name ? source.displayName : 'Shared contact', ...(fields.roles ? { roles: source.roles } : {}), tier: 'ken', lifecycle: 'active' };
}

export interface ShareStep {
  directoryId: string;
  contactId: string | null;
  add?: AddContactValue;
  identities: Omit<AddIdentityValue, 'itemId'>[];
  methods?: Omit<AddMethodValue, 'itemId'>[];
  note?: string;
  context?: Omit<SharedContactContext, 'receivedAt'>;
  ownerIdentityPubkey?: string;
}

export interface SharePlan {
  steps: ShareStep[];
  confirmText: string;
}

export function planShare(input: { source: EffectiveContact; targets: DirectoryTarget[]; fields?: ContactShareFields; guardianPubkey?: string }): SharePlan {
  const fields = input.fields ?? defaultShareFields(input.source, true);
  const identities = shareableIdentities(input.source, fields);
  const steps = input.targets.map<ShareStep>(t => ({
    directoryId: t.directoryId,
    contactId: t.contactId,
    ...(t.contactId ? {} : { add: { ...shareableAdd(input.source, fields), ...(t.ownerIdentityPubkey ? { ownerIdentityPubkey: t.ownerIdentityPubkey } : {}) } }),
    identities,
    ownerIdentityPubkey: t.ownerIdentityPubkey,
    methods: input.source.contactMethods.filter(m => fields.methods.includes(m.itemId)).map(m => ({
      kind: m.kind, value: m.value, ...(m.label ? { label: m.label } : {}), verification: 'unverified', sharingPolicy: 'private',
    })),
    ...(fields.notes && input.source.notes ? { note: input.source.notes } : {}),
    ...(input.guardianPubkey ? { context: {
      guardianPubkey: input.guardianPubkey,
      ...(fields.tier ? { tier: input.source.tier } : {}),
      ...(fields.blocked ? { blocked: input.source.blocked } : {}),
      ...(fields.checks && input.source.checks?.length ? { checkRecords: input.source.checks.filter(c => identities.some(i => i.pubkey === c.identityPubkey))
        .map(c => ({ pubkey: c.identityPubkey, method: c.method, checkedAt: c.checkedAt })) } : {}),
      ...(fields.checks ? { checks: input.source.identities.filter(i => fields.identities.includes(i.itemId)).map(i => ({
        pubkey: i.pubkey, verification: i.verification, ...(i.direct ? { verifiedAt: i.direct.verifiedAt } : {}),
      })) } : {}),
    } } : {}),
  }));
  return {
    steps,
    confirmText: shareConfirmCopy(input.source.displayName, input.targets.map(t => t.label)),
  };
}

export interface VouchStep {
  kind: 'vouch' | 'own-directory';
  directoryId: string;
  contactId: string | null;
  add?: AddContactValue;
  identities: Omit<AddIdentityValue, 'itemId'>[];
  methods?: Omit<AddMethodValue, 'itemId'>[];
  note?: string;
  context?: Omit<SharedContactContext, 'receivedAt'>;
  ownerIdentityPubkey?: string;
  vouch?: VouchValue;
  ownTier?: ContactTier;
  roles?: string[];
}

export interface VouchPlan {
  steps: VouchStep[];
  confirmText: string;
}

export function planVouch(input: {
  source: EffectiveContact;
  guardianPubkey: string;
  ownerDirectoryId: string;
  tier: ContactTier;
  targets: DirectoryTarget[];
  fields?: ContactShareFields;
}): VouchPlan {
  const shared = planShare({ source: input.source, targets: input.targets, fields: input.fields, guardianPubkey: input.guardianPubkey });

  const steps = input.targets.map<VouchStep>((t, index) => {
    const role = t.role ? normaliseRole(t.role) : '';
    if (t.directoryId === input.ownerDirectoryId) {
      return {
        kind: 'own-directory',
        ...shared.steps[index],
        ownTier: input.tier,
        ...(role ? { roles: [role] } : {}),
      };
    }
    return {
      kind: 'vouch',
      ...shared.steps[index],
      vouch: {
        guardianPubkey: input.guardianPubkey,
        tier: input.tier,
        ...(role ? { role } : {}),
      },
    };
  });

  return {
    steps,
    confirmText: vouchConfirmCopy(input.source.displayName, input.tier, input.targets.map(t => t.label)),
  };
}
