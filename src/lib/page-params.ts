/**
 * History-entry parameters (`useAppNavigation`'s `pageParam`). A page whose
 * content depends on more than the dependant scope — which slot an Advanced
 * page edits, whose real identity a ceremony activates, which persona a
 * handshake exchanges as — carries that target on its own history entry, so
 * back and forward show each entry with the target it was opened for and the
 * matching scope banner. A target held in App state instead is overwritten by
 * the next visit, and going back showed the newer target under the older
 * entry's banner ("Managing A" over B's slot, with B's Remove button).
 *
 * Parameters come back out of `history.state`, so they are read through
 * these guards rather than cast.
 */
import type { Page } from '../types';
import type { ActivateRealIdentityRoute, PersonaAdvancedRoute } from '../types/routing';
import type { SignetIdentity } from '../types/identity';
import type { DependantIdentity } from '../types/dependants';

/** The `contact-handshake` page's parameter: the persona exchanging, and its card. */
export interface HandshakeRoute {
  persona: string;
  choose: boolean;
  info: { name: string; hasPhoto: boolean };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function personaAdvancedRouteOf(param: unknown): PersonaAdvancedRoute | null {
  if (!isRecord(param) || typeof param.slotTarget !== 'string' || param.slotTarget === '') return null;
  if (param.depPubkey !== undefined && typeof param.depPubkey !== 'string') return null;
  return typeof param.depPubkey === 'string'
    ? { slotTarget: param.slotTarget, depPubkey: param.depPubkey }
    : { slotTarget: param.slotTarget };
}

export function activationRouteOf(param: unknown): ActivateRealIdentityRoute | null {
  if (!isRecord(param)) return null;
  if (param.returnTo !== null && typeof param.returnTo !== 'string') return null;
  if (param.dependantId !== undefined && typeof param.dependantId !== 'string') return null;
  const returnTo = param.returnTo as Page | null;
  return typeof param.dependantId === 'string' ? { returnTo, dependantId: param.dependantId } : { returnTo };
}

export function handshakeRouteOf(param: unknown): HandshakeRoute | null {
  if (!isRecord(param) || typeof param.persona !== 'string' || param.persona === '') return null;
  if (typeof param.choose !== 'boolean' || !isRecord(param.info)) return null;
  const { name, hasPhoto } = param.info;
  if (typeof name !== 'string' || typeof hasPhoto !== 'boolean') return null;
  return { persona: param.persona, choose: param.choose, info: { name, hasPhoto } };
}

/** Whether the slot an Advanced page was opened for still exists (mirrors PersonaAdvanced's resolvers). */
export function personaAdvancedTargetExists(
  route: PersonaAdvancedRoute,
  identity: SignetIdentity,
  dependants: readonly DependantIdentity[],
): boolean {
  const { slotTarget, depPubkey } = route;
  if (depPubkey !== undefined) {
    const dep = dependants.find(d => d.id === depPubkey);
    if (!dep) return false;
    if (slotTarget === 'natural-person' || slotTarget === 'persona') return true;
    return (dep.extraPersonas ?? []).some(p => p.publicKey === slotTarget);
  }
  if (slotTarget === 'natural-person' || slotTarget === 'persona') return true;
  if (slotTarget === 'professional-persona') return !!identity.professionalPersona;
  return (identity.extraPersonas ?? []).some(p => p.publicKey === slotTarget);
}

/**
 * `useAppNavigation`'s `isPageParamLive`: a popped entry whose page needs a
 * parameter it does not carry, or whose parameter names a slot or dependant
 * that is gone, goes home. With no identity loaded nothing can be judged, so
 * the entry stands and the page's own guards decide.
 */
export function isPageParamLive(
  page: Page,
  param: unknown,
  ctx: { identity: SignetIdentity | null; dependants: readonly DependantIdentity[] },
): boolean {
  if (page === 'persona-advanced') {
    const route = personaAdvancedRouteOf(param);
    if (!route) return false;
    return !ctx.identity || personaAdvancedTargetExists(route, ctx.identity, ctx.dependants);
  }
  if (page === 'activate-real-identity') {
    const route = activationRouteOf(param);
    if (!route?.dependantId) return true;
    return ctx.dependants.some(d => d.id === route.dependantId);
  }
  if (page === 'contact-handshake') return handshakeRouteOf(param) !== null;
  return true;
}
