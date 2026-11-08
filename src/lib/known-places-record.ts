// Fire-and-forget writer for known-place rows. A place is a display fact:
// failing to record one must never block a sign-in, a pairing or a grant, so
// every error is swallowed here and the caller just gets a boolean.

import type { KnownPlaceInput, KnownPlaceChannel, KnownPlaceSigner } from '../types';
import { upsertKnownPlace } from './db';

export async function recordKnownPlace(input: KnownPlaceInput): Promise<boolean> {
  try {
    return (await upsertKnownPlace(input)) !== null;
  } catch {
    return false;
  }
}

export interface SignInKnownPlaceArgs {
  origin: string;
  pubkey: string;
  siteName: string;
  consumerDisplayName?: string;
  /** Package that launched the link; stored as a label only, never trusted. */
  nativePackage?: string | null;
  channel: KnownPlaceChannel;
  signer: KnownPlaceSigner;
  /** The persona handle string actually sent to the site, if any. */
  handleShared?: string | null;
  /** Whether a picture was sent to the site. */
  pictureShared: boolean;
}

/** The row a completed sign-in leaves behind. Pure, so both delivery paths share it. */
export function buildSignInKnownPlace(a: SignInKnownPlaceArgs): KnownPlaceInput {
  return {
    placeKey: a.origin,
    pubkey: a.pubkey,
    kind: 'sign-in',
    name: a.siteName,
    ...(a.consumerDisplayName ? { alias: a.consumerDisplayName } : {}),
    origin: a.origin,
    ...(a.nativePackage ? { nativePackage: a.nativePackage } : {}),
    channel: a.channel,
    signer: a.signer,
    shared: { handle: !!a.handleShared, picture: a.pictureShared },
  };
}
