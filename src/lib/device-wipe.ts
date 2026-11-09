/**
 * What "Remove MySignet from this phone" actually costs, worked out up front
 * so the confirm card can say it plainly.
 *
 * Pure: the caller passes in what App already knows. Nothing here reads
 * storage or touches a relay.
 *
 * - `phoneOnly`   key material that exists nowhere else, so it is gone for good
 *                 unless the user saved it.
 * - `recoverable` things that can be brought back afterwards (re-pair, re-import).
 * - `takedown`    what the OPT-IN relay takedown would act on. The counts mirror
 *                 `handleDeleteIdentity` in App.tsx: a slot counts only when its
 *                 `tryRetract` would really fire (published profile, plus a way
 *                 to sign for it), and the whole takedown is skipped on a direct
 *                 child's phone.
 */
import type { DependantIdentity, ExtraPersona, SignetIdentity } from '../types';
import { sanitizeDisplayName } from './text-sanitize';

export interface WipeItem {
  id: string;
  label: string;
}

export interface DeviceWipeInventory {
  phoneOnly: WipeItem[];
  recoverable: WipeItem[];
  takedown: { profiles: number; appGrants: number };
}

export interface DeviceWipeInput {
  identity: SignetIdentity | null;
  dependants: readonly DependantIdentity[];
  signingMode?: 'local' | 'bunker' | 'nip07' | 'paired-child';
  /** An imported Heartwood operator credential is held on this phone. */
  hasOperatorKey: boolean;
  /** ACTIVE (not revoked) contacts-v2 app grants. */
  activeGrantCount: number;
  /** A child's phone paired straight to the Heartwood: the takedown never runs. */
  childDirect: boolean;
  /**
   * A Heartwood router can sign for slots that hold no local key, so the
   * takedown can still retract their profiles. Defaults to false.
   */
  hasBunkerRouter?: boolean;
}

const NAME_CAP = 40;

function safeName(raw: string | undefined, fallback: string): string {
  const cleaned = sanitizeDisplayName(raw ?? '', NAME_CAP);
  return cleaned || fallback;
}

function isImportedExtra(ep: ExtraPersona): boolean {
  // Same rule as personas-sync.ts toWire: never had a tree derivation.
  return !!ep.imported || !ep.derivationName;
}

/** Imported WITH key material (not the view-only kind, which holds no key). */
function isImportedWithKeys(dep: DependantIdentity): boolean {
  const path = dep.derivationPath ?? '';
  return path.startsWith('imported-') && !path.startsWith('imported-view-');
}

function dependantHoldsKey(dep: DependantIdentity): boolean {
  return (
    !!dep.naturalPerson?.privateKey ||
    !!dep.persona?.privateKey ||
    (dep.extraPersonas ?? []).some((ep) => !!ep.privateKey)
  );
}

export function buildDeviceWipeInventory(input: DeviceWipeInput): DeviceWipeInventory {
  const { identity, dependants, signingMode, hasOperatorKey, activeGrantCount, childDirect } = input;
  const phoneOnly: WipeItem[] = [];
  const recoverable: WipeItem[] = [];
  const phoneHoldsKeys = signingMode !== 'bunker' && signingMode !== 'paired-child' && signingMode !== 'nip07';

  if (identity && phoneHoldsKeys) {
    if (identity.mnemonic !== '') {
      phoneOnly.push({ id: 'recovery-words', label: 'Your recovery words' });
    } else {
      const holdsKey =
        !!identity.naturalPerson?.privateKey ||
        !!identity.persona?.privateKey;
      if (holdsKey) {
        phoneOnly.push({ id: 'identity-nsec', label: "Your Signet's key (imported nsec)" });
      }
    }
  }

  if (identity) {
    for (const ep of identity.extraPersonas ?? []) {
      if (!isImportedExtra(ep) || !ep.privateKey) continue;
      phoneOnly.push({
        id: `persona:${ep.publicKey}`,
        label: `"${safeName(ep.displayName, 'Unnamed')}" persona (imported nsec)`,
      });
    }
  }

  for (const dep of dependants) {
    if (!isImportedWithKeys(dep) || !dependantHoldsKey(dep)) continue;
    phoneOnly.push({
      id: `dependant:${dep.id ?? dep.persona?.publicKey ?? dep.derivationPath}`,
      label: `"${safeName(dep.displayName, 'Unnamed')}" (imported dependant)`,
    });
  }

  if (signingMode === 'bunker') {
    recoverable.push({
      id: 'heartwood-keys',
      label: 'Your Heartwood keys — pair again (press the button on the device)',
    });
  }
  if (hasOperatorKey) {
    recoverable.push({
      id: 'heartwood-operator',
      label: 'Heartwood operator key — import again from Sapwood',
    });
  }
  if (signingMode === 'paired-child') {
    recoverable.push({
      id: 'child-pairing',
      label: "This phone's pairing — pair again with your guardian",
    });
  }
  if (signingMode === 'nip07') {
    recoverable.push({
      id: 'extension-keys',
      label: 'Your key stays in your browser extension — connect it again',
    });
  }

  let profiles = 0;
  let appGrants = 0;
  if (identity && !childDirect) {
    const hasRouter = !!input.hasBunkerRouter;
    const counts = (slot: { privateKey?: string; publicProfile?: { enabled?: boolean; lastEventId?: string } } | undefined): number => {
      const pp = slot?.publicProfile;
      if (!pp?.enabled || !pp.lastEventId) return 0;
      return slot?.privateKey || hasRouter ? 1 : 0;
    };
    profiles += counts(identity.naturalPerson) + counts(identity.persona) + counts(identity.professionalPersona);
    for (const ep of identity.extraPersonas ?? []) profiles += counts(ep);
    for (const dep of dependants) {
      profiles += counts(dep.naturalPerson) + counts(dep.persona);
      for (const ep of dep.extraPersonas ?? []) profiles += counts(ep);
    }
    appGrants = Math.max(0, Math.floor(activeGrantCount));
  }

  return { phoneOnly, recoverable, takedown: { profiles, appGrants } };
}

/** "2 public profiles will be blanked · 1 connected app loses access" */
export function describeTakedown(t: { profiles: number; appGrants: number }): string {
  const parts: string[] = [];
  if (t.profiles > 0) {
    parts.push(t.profiles === 1 ? '1 public profile will be blanked' : `${t.profiles} public profiles will be blanked`);
  }
  if (t.appGrants > 0) {
    parts.push(t.appGrants === 1 ? '1 connected app loses access' : `${t.appGrants} connected apps lose access`);
  }
  return parts.join(' · ');
}

export const EMPTY_DEVICE_WIPE_INVENTORY: DeviceWipeInventory = {
  phoneOnly: [],
  recoverable: [],
  takedown: { profiles: 0, appGrants: 0 },
};
