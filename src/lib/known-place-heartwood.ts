import type { DeviceClientSlot } from './heartwood-mgmt-types';

/** One line of what the device lets a paired app do, from the slot the device reports. */
export function heartwoodPolicySummary(slot: DeviceClientSlot): string {
  const how = slot.escalate ? 'Asks on your phone'
    : slot.autoApprove && slot.signingApproved ? 'Signs automatically'
    : 'Asks on the device';
  const kinds = slot.allowedKinds.length;
  return kinds > 0 ? `${how} · ${kinds} kind${kinds === 1 ? '' : 's'}` : how;
}

export interface HeartwoodAppEntryData {
  fingerprint: string;
  label: string;
  boundIdentity: string;
  policySummary: string;
}

/**
 * The apps paired straight to the device that serve this identity. A slot
 * bound to no identity serves any, so it appears on every card.
 */
export function heartwoodEntriesFor(
  slots: readonly DeviceClientSlot[],
  pubkey: string,
  nameOf: (pubkey: string) => string | undefined,
): HeartwoodAppEntryData[] {
  const mine = pubkey.toLowerCase();
  return slots
    .filter(s => s.boundIdentity === null || s.boundIdentity.toLowerCase() === mine)
    .map(s => ({
      fingerprint: s.secretFingerprint,
      label: s.label || `App ${s.slotIndex + 1}`,
      boundIdentity: s.boundIdentity ? nameOf(s.boundIdentity.toLowerCase()) ?? 'Another identity' : 'Any identity',
      policySummary: heartwoodPolicySummary(s),
    }));
}
