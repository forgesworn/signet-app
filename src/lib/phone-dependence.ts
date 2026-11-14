/**
 * What, if anything, needs this phone to stay signed in to My Signet. Pure.
 *
 * Drives the Always-on swipe-away alert (native service) and the line under the
 * Always on button. Only things that reach the keys THROUGH this phone count: a
 * child's phone served by it, a Nostr Connect app served by it, a phone app that
 * signs without asking. An app on a Heartwood bunker link talks to the Heartwood
 * directly and never appears here.
 *
 * Apps count only while recently used, so one the person stopped using (or moved
 * to a Heartwood link) drops out on its own, and naming them makes a stale one
 * visible.
 */
import type { DependantIdentity } from '../types';
import type { Nip55Grants } from './nip55';

export const PHONE_APP_RECENT_SECONDS = 30 * 24 * 3600;

export interface PhoneDependenceInput {
  /** `'child'` = any paired-child install. */
  install: 'owner' | 'child';
  nowS: number;
  /** `lastSeenAt` is Unix seconds. */
  connectedClients: { clientPubkey: string; appName: string; lastSeenAt: number }[];
  /** Heartwood hand-offs: these apps talk to the Heartwood directly. Compared lowercase. */
  handedOffClientPubkeys: readonly string[];
  /** Grant times are Unix milliseconds. */
  nip55Grants: Nip55Grants;
  dependants: Pick<DependantIdentity, 'displayName' | 'childDevice' | 'bunkerEndpoint' | 'appBunkerEndpoint'>[];
}

export interface PhoneDependence {
  needed: boolean;
  names: string[];
  title: string;
  text: string;
  /** One line for the Bunker tab, under Always on. Empty when there is nothing to say. */
  bunkerLine: string;
}

const TITLE = 'Signet stopped signing';

/** `A` / `A and B` / `A, B and C` / `A, B and N more`. */
function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} more`;
}

export function phoneDependence(i: PhoneDependenceInput): PhoneDependence {
  if (i.install === 'child') {
    return {
      needed: true,
      names: [],
      title: TITLE,
      text: "Your apps and games can't reach Signet until you open and unlock it.",
      bunkerLine: '',
    };
  }

  const names: string[] = [];

  for (const dep of i.dependants) {
    const direct = dep.childDevice?.mode === 'heartwood-direct';
    const paired = !!dep.bunkerEndpoint?.authorizedClientPubkey || (dep.appBunkerEndpoint?.pairings?.length ?? 0) > 0;
    if (direct || paired) names.push(dep.displayName);
  }

  const handedOff = new Set(i.handedOffClientPubkeys.map(k => k.toLowerCase()));
  const apps: { name: string; usedS: number }[] = [];
  for (const c of i.connectedClients) {
    if (handedOff.has(c.clientPubkey.toLowerCase())) continue;
    if (i.nowS - c.lastSeenAt > PHONE_APP_RECENT_SECONDS) continue;
    apps.push({ name: c.appName.trim() || 'Unnamed app', usedS: c.lastSeenAt });
  }
  for (const [pkg, g] of Object.entries(i.nip55Grants)) {
    if (g.allowAlways !== true || g.denyAlways === true) continue;
    // Grant times are milliseconds.
    const usedS = (g.lastUsedAt ?? g.grantedAt) / 1000;
    if (i.nowS - usedS > PHONE_APP_RECENT_SECONDS) continue;
    apps.push({ name: g.label?.trim() || pkg, usedS });
  }
  apps.sort((a, b) => b.usedS - a.usedS);
  for (const a of apps) names.push(a.name);

  const seen = new Set<string>();
  const unique = names.filter(n => {
    const k = n.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  if (unique.length === 0) {
    return { needed: false, names: [], title: '', text: '', bunkerLine: 'Nothing needs this phone to stay open right now.' };
  }
  const list = listNames(unique);
  return {
    needed: true,
    names: unique,
    title: TITLE,
    text: `${list} can't reach Signet until you open and unlock it.`,
    bunkerLine: `Needed by ${list}.`,
  };
}
