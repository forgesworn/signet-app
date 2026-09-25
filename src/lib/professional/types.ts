// Pro-surface shared types.
// Spec: the internal Pro-surface architecture design doc, §5.1–5.2

export type ProfessionKind =
  | 'school'
  | 'solicitor-firm'
  | 'gp-practice'
  // P2 — after P1 proves the architecture:
  | 'pharmacy'
  | 'dental-practice'
  | 'accountant-firm';

export type Jurisdiction =
  | 'england-wales'
  | 'england'
  | 'wales'
  | 'scotland-state'
  | 'scotland-private'
  | 'northern-ireland';

export type RegistryId =
  | 'GIAS'
  | 'GovScot-Schools'
  | 'GovScot-IndepSchools'
  | 'DENI'
  | 'SRA'
  | 'LSS'
  | 'LSNI'
  | 'CQC'
  | 'NHS-ODS'
  | 'HIS'
  | 'HIW'
  | 'RQIA'
  | 'GPhC'
  | 'GDC'
  | 'ICAEW'
  | 'ACCA'
  | 'ICAS'
  | 'AAT'
  | 'CIMA';

export type IdentifierKind =
  | 'URN'
  | 'SeedCode'
  | 'InstitutionRef'
  | 'SRA-FirmNumber'
  | 'CQC-ProviderID'
  | 'CQC-LocationID'
  | 'ODS-Code'
  | string;

/** Canonical record returned by any profession resolver. */
export interface RegulatedEntityRecord {
  professionKind: ProfessionKind;
  jurisdiction: Jurisdiction;
  registry: RegistryId;

  /** Native identifier from the registry. */
  identifier: string;
  identifierKind: IdentifierKind;

  name: string;
  status: 'Active' | 'Inactive' | 'Closed' | 'Suspended' | string;

  /**
   * Canonical website if the registry publishes one. Null for registries
   * (e.g. DENI) that publish no website field.
   */
  website: string | null;

  /**
   * For registries without a website field but with an email-domain or other
   * inferrable signal, the resolver computes a candidate the entity must
   * explicitly confirm during onboarding (e.g. NI schools: *.ni.sch.uk).
   */
  inferredCandidateWebsite: string | null;

  postcode: string;
  locality: string;
  tags: string[];

  /** ISO-8601 timestamp of when this record was fetched from the registry. */
  fetchedAt: string;
}

/** Per-profession resolver interface. Spec §5.2. */
export interface ProfessionResolver {
  /** Profession this resolver handles. */
  professionKind: ProfessionKind;

  /** Jurisdictions this resolver covers (a single resolver can cover multiple). */
  jurisdictions: Jurisdiction[];

  /**
   * Identifier-shape predicate: does this look like an identifier this resolver
   * handles? Used for sanity-check disambiguation in dispatch, never for blind
   * dispatch (onboarding always asks profession first).
   */
  matches(identifier: string): boolean;

  /**
   * Resolve identifier → record.
   * Returns null if the identifier is not found (not-found is not an error).
   * Throws on transient failure (network error, rate limit); caller should retry.
   */
  resolve(identifier: string): Promise<RegulatedEntityRecord | null>;
}

/**
 * What we persist in IndexedDB after a successful role-anchor "Check my JSON".
 * One record per user pubkey (leads) or per roster pubkey (sub-roles).
 */
export interface ProRoleAnchorRecord {
  /** The pubkey this record belongs to (natural-person hex pubkey). */
  pubkey: string;
  professionKind: ProfessionKind;
  jurisdiction: Jurisdiction;
  registry: RegistryId;
  identifier: string;
  identifierKind: IdentifierKind;
  entityName: string;
  canonicalDomain: string;
  /** The Nostr event ID of the kind-30201 event this device published. */
  anchorEventId: string;
  /** ISO-8601 — when the anchor was last successfully verified. */
  verifiedAt: string;
  /** Whether the entity is listed in the public Signet directory. */
  listedInDirectory: boolean;
}

/**
 * What we persist after fetching + validating a signet.json.
 * Keyed by canonicalDomain so repeated lookups hit the cache.
 */
export interface ProSignetJsonCacheRecord {
  /** Bare hostname (no trailing slash). */
  canonicalDomain: string;
  /** Raw parsed signet.json contents. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: Record<string, any>;
  /** ISO-8601 — when this was fetched. Cache TTL is 24h. */
  fetchedAt: string;
}
