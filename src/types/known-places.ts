/**
 * Known places — the facts this phone remembers about where an identity has
 * been used (a signed-in site, a paired NIP-46 app, a NIP-55 caller on this
 * phone). Rows are display metadata only: they are never a trust input. Whether
 * something signs automatically is read live from its source of truth
 * (`ConnectedClient.askToSign`, the NIP-55 grant), not stored here.
 */

export type KnownPlaceKind = 'sign-in' | 'nip46' | 'nip55';

export type KnownPlaceChannel =
  | 'phone-app'
  | 'browser'
  | 'other-device'
  | 'nip46'
  | 'nip55'
  | 'unknown';

export type KnownPlaceSigner =
  | 'local'
  | 'heartwood'
  | 'remote-signer'
  | 'extension'
  | 'unknown';

export interface KnownPlace {
  /** `${placeKey}:${pubkey}` */
  id: string;
  /** Lowercase hex pubkey of the identity this place knows. */
  pubkey: string;
  /** Web origin, `pkg:<package>`, or `nc:<clientPubkey>`. */
  placeKey: string;
  kind: KnownPlaceKind;
  /** Consumer-declared name, sanitised, at most 64 chars. */
  name: string;
  /** User-chosen alias, at most 64 chars. */
  alias?: string;
  origin?: string;
  nativePackage?: string;
  channel: KnownPlaceChannel;
  signer: KnownPlaceSigner;
  /** Unix seconds. */
  firstAt: number;
  /** Unix seconds. */
  lastAt: number;
  uses: number;
  shared: { handle?: boolean; picture?: boolean };
  pinned?: boolean;
}

/** What a writer supplies; the store fills `id`, `firstAt`, `lastAt`, `uses`. */
export type KnownPlaceInput = Omit<KnownPlace, 'id' | 'firstAt' | 'lastAt' | 'uses' | 'alias' | 'pinned'> & {
  alias?: string;
};
