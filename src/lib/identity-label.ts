/**
 * Consistent identity-label rendering across picker / Connections /
 * Identity Settings. Every surface should show:
 *   - displayName as the primary label
 *   - a small type badge as secondary ("Real name" | "Persona" | "Extra persona")
 */

import type { KeypairToken } from '../types';

/** Human-readable badge for a keypair token. */
export function keypairTypeLabel(token: KeypairToken): string {
  switch (token) {
    case 'natural-person': return 'Real name';
    case 'persona': return 'Persona';
    case 'extra-persona': return 'Extra persona';
  }
}

/** Classify an internal keypair literal ('natural-person' | 'persona' | pubkey) into a token. */
export function tokenForKeypair(keypair: string): KeypairToken {
  if (keypair === 'natural-person') return 'natural-person';
  if (keypair === 'persona') return 'persona';
  return 'extra-persona';
}

/** Badge colour classes keyed by token — used by the picker + Connections. */
export function badgeColour(token: KeypairToken): { background: string; color: string } {
  switch (token) {
    case 'natural-person':
      return { background: 'var(--warning-light, #fff8e1)', color: 'var(--warning, #b45309)' };
    case 'persona':
      return { background: 'var(--success-light, #e8f5e9)', color: 'var(--success, #2e7d32)' };
    case 'extra-persona':
      return { background: 'var(--surface, rgba(0,0,0,0.06))', color: 'var(--text-secondary)' };
  }
}

/** First 1-2 uppercase letters of a display name, for avatar placeholders. */
export function getInitials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map(w => w[0]!)
    .join('')
    .slice(0, 2)
    .toUpperCase() || '\u00b7';
}
