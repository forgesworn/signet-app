import type { DependantIdentity, ExtraPersonaTombstone } from '../types';

function personaNumber(path: string, name: string): number | null {
  const prefix = `${path}-persona-`;
  if (!name.startsWith(prefix)) return null;
  const suffix = name.slice(prefix.length);
  if (!/^(0|[1-9]\d*)$/.test(suffix)) return null;
  const number = Number(suffix);
  if (!Number.isSafeInteger(number)) throw new Error('Dependant persona number is out of range');
  return number;
}

/** Deleted names remain reserved, including after sync and recovery. */
export function nextDependantPersonaName(dep: DependantIdentity): string {
  let highest = -1;
  for (const entry of [...(dep.extraPersonas ?? []), ...(dep.extraPersonaTombstones ?? [])]) {
    const number = personaNumber(dep.derivationPath, entry.derivationName);
    if (number !== null) highest = Math.max(highest, number);
  }
  if (highest >= Number.MAX_SAFE_INTEGER) throw new Error('Dependant persona numbers exhausted');
  return `${dep.derivationPath}-persona-${highest + 1}`;
}

/** Allowlist metadata only; never put persona keys or labels in tombstones. */
export function dependantPersonaTombstones(path: string, input: unknown): ExtraPersonaTombstone[] {
  const byName = new Map<string, ExtraPersonaTombstone>();
  if (!Array.isArray(input)) return [];
  for (const item of input) {
    if (!item || typeof item !== 'object' || typeof item.derivationName !== 'string'
      || typeof item.removedAt !== 'number' || !Number.isSafeInteger(item.removedAt) || item.removedAt < 0) continue;
    // Malformed remote metadata must not abort restoration of the dependant.
    try { if (personaNumber(path, item.derivationName) === null) continue; }
    catch { continue; }
    const previous = byName.get(item.derivationName);
    if (!previous || item.removedAt > previous.removedAt) {
      byName.set(item.derivationName, { derivationName: item.derivationName, removedAt: item.removedAt });
    }
  }
  return [...byName.values()].sort((a, b) => a.derivationName < b.derivationName ? -1 : 1);
}

/** Deletion wins over a stale device's live copy. */
export function applyDependantPersonaTombstones(dep: DependantIdentity): DependantIdentity {
  if (!dep.extraPersonaTombstones?.length) return dep;
  const removed = new Set(dep.extraPersonaTombstones.map(t => t.derivationName));
  const extras = (dep.extraPersonas ?? []).filter(ep => !removed.has(ep.derivationName));
  return {
    ...dep,
    extraPersonas: extras,
    primaryKeypair: dep.primaryKeypair !== 'persona' && dep.primaryKeypair !== 'natural-person'
      && !extras.some(ep => ep.publicKey === dep.primaryKeypair) ? 'persona' : dep.primaryKeypair,
  };
}
