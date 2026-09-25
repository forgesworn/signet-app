/**
 * The single constructor for a locally authored contacts v2 operation.
 *
 * One user action produces exactly ONE operation — that is what keeps the log
 * mergeable and the Lamport clock meaningful. The builder does not validate or
 * repair `value`: `validateOperation` in the reducer is the one gate, so a
 * caller cannot accidentally get a second, weaker opinion here.
 *
 * Pure: the caller supplies the id, the clock and the timestamp.
 */

import type { ContactAction, ContactOperation } from '../types';
import type { ContactActorRole } from '../types';

export interface MutationActor {
  actorPubkey: string;
  actorRole: ContactActorRole;
  actorDeviceId: string;
}

export function buildOperation(params: {
  directoryId: string;
  contactId: string;
  action: ContactAction;
  value: unknown;
  clock: number;
  actor: MutationActor;
  now: number;
  operationId: string;
  itemId?: string;
  targetOperationId?: string;
}): ContactOperation {
  return {
    operationId: params.operationId,
    directoryId: params.directoryId,
    contactId: params.contactId,
    ...(params.itemId ? { itemId: params.itemId } : {}),
    actorPubkey: params.actor.actorPubkey,
    actorRole: params.actor.actorRole,
    actorDeviceId: params.actor.actorDeviceId,
    logicalClock: params.clock,
    action: params.action,
    ...(params.targetOperationId ? { targetOperationId: params.targetOperationId } : {}),
    value: params.value,
    createdAt: params.now,
  };
}
