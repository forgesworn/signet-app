/**
 * Every user-facing contacts v2 string, in one place.
 *
 * Kept as a module rather than scattered JSX so the spec section 12 copy rules
 * (the Persona / Real identity naming, never the three retired onboarding
 * words, and British rather than American spelling) are enforced by one
 * test, and so a dependant surface and a guardian surface cannot drift into
 * describing the same fact two ways. The banned words and spellings
 * themselves are not repeated here — the test file is the single source for
 * the list, so this comment can never defeat its own guard.
 *
 * **Sanitisation contract:** Every function that interpolates a caller-supplied
 * name (`displayName`, `dependantName`, `contactName`, `guardianName`, or
 * directory labels) strips control characters and bidi/invisible Unicode via
 * `sanitizeDisplayName(name, 100)` before splicing into copy. This prevents
 * control-char injection and bidi-override attacks in rendered text.
 */
import type {
  ContactIdentityProvenance, ContactTier, ContactCeilingTier, ContactTierSource,
  ContactType, ContactVerification, EffectiveContact,
} from '../types';
import { sanitizeDisplayName } from './text-sanitize';
import type { Capability } from '@forgesworn/signet-contacts/wire';

export const KEYLESS_MARKER = 'No key verified';
export const KEYLESS_EXPLAINER =
  'Nostr discovery and app filtering need a verified key. You can add one later.';
export const GUARDIAN_BLOCK_LOCK_COPY = 'A guardian applied this block';
export const OTHER_GUARDIAN_BLOCK_LOCK_COPY = 'Another guardian applied this block';
/**
 * M7: a guardian can be locked out of Unblock by a block a DEPENDANT applied
 * themselves (spec §7.9 — a dependant may always Block as a safety action).
 * That is a different fact from another guardian's block, so it gets its own
 * copy rather than reusing `OTHER_GUARDIAN_BLOCK_LOCK_COPY`, which would
 * misname the author.
 */
export const DEPENDANT_BLOCK_LOCK_COPY = 'They applied this block themselves';
export const BLOCK_BOUNDARY_COPY =
  'Blocking works inside Signet. It cannot stop someone posting on Nostr or reaching you through an unrelated identity or app.';

/**
 * R6: the contacts v2 rail refuses to publish a log past `MAX_CHECKPOINT_OPS`.
 * Says what stopped and what did not, and never implies local data was lost —
 * the log is intact on this device, it is the copy to the relay that stopped.
 */
export const CONTACTS_BACKUP_TOO_LARGE_COPY =
  'Your contact list has grown too large to back up to your relay. Nothing is lost on this device, but recent changes are not reaching your other devices.';

/**
 * R6 (Task 6 review ruling): `useContactsV2Sync` reports `backupState:
 * 'stalled'` when the relay's checkpoint exists but could not be read (R2
 * forbids compacting over it) AND this device's own outbox has grown past
 * one publish envelope, so there is no leg left that could possibly succeed.
 * Distinct from `CONTACTS_BACKUP_TOO_LARGE_COPY` — the log itself still fits
 * the rail, it is this particular relay round trip that is stuck.
 */
export const CONTACTS_BACKUP_STALLED_COPY =
  'Could not read the contact backup on your relay; local changes are not backed up until it is readable.';

/** Strip control characters and bidi overrides from caller-supplied names. */
function safeName(raw: string): string {
  return sanitizeDisplayName(raw, 100);
}

const TIER_LABELS: Record<ContactCeilingTier, string> = {
  kin: 'Kin',
  kith: 'Kith',
  ken: 'Ken',
  none: 'No tier',
};

export function tierChipLabel(tier: ContactCeilingTier): string {
  return TIER_LABELS[tier];
}

export function tierProvenanceSuffix(
  source: ContactTierSource,
  guardianName: string | null,
): string | null {
  if (source === 'direct') return null;
  if (source === 'guardian-vouched') return `via ${guardianName ? safeName(guardianName) : 'guardian'}`;
  return 'guardian-limited';
}

export function effectiveTierLine(
  c: Pick<EffectiveContact, 'effectiveTier' | 'tierSource'>,
  guardianName: string | null,
): string {
  const label = tierChipLabel(c.effectiveTier);
  if (c.tierSource === 'direct') return label;
  if (c.tierSource === 'guardian-vouched') return `${label} via ${guardianName ? safeName(guardianName) : 'guardian'}`;
  return `${guardianName ? safeName(guardianName) : 'Guardian'} limited this to ${label}`;
}

export function blockedLine(
  c: Pick<EffectiveContact, 'blocked' | 'blockedBy' | 'displayName'>,
  actorPubkey: string,
  guardianName: string | null,
): string | null {
  if (!c.blocked) return null;
  const actor = actorPubkey.toLowerCase();
  const byActor = c.blockedBy.some(pk => pk.toLowerCase() === actor);
  const byOther = c.blockedBy.some(pk => pk.toLowerCase() !== actor);
  const safe = safeName(c.displayName);
  const other = guardianName ? safeName(guardianName) : 'Guardian';
  if (byActor && byOther) return `Blocked by you and by ${guardianName ? safeName(guardianName) : 'a guardian'}`;
  if (byActor) return 'Blocked by you';
  return `${other} blocked ${safe}`;
}

export function independenceGateCopy(dependantName: string): string {
  return `Contact transfer isn't available yet. Independence will be enabled once contacts can move with ${safeName(dependantName)}.`;
}

export function removalChoiceCopy(dependantName: string): { deleteLine: string; archiveLine: string } {
  const safe = safeName(dependantName);
  return {
    deleteLine: `Delete contacts — ${safe}'s contacts are tombstoned on this device and app access to them is revoked; copies already on a relay or inside an app cannot be guaranteed erased.`,
    archiveLine: `Archive contacts — ${safe}'s contacts stop syncing and stop being editable, but stay as an encrypted read-only snapshot you can restore or delete later.`,
  };
}

/** PersonaAdvanced's remove-dependant card, while the family contacts log is still loading. */
export const REMOVE_DEPENDANT_CONTACTS_LOADING_COPY = 'Loading their contacts…';

/**
 * The family contacts log could not be read (a `reload()` that errored, or
 * came back without the directory a caller needed) at a moment that must
 * fail closed — the independence ceremony's confirm-time gate re-check and
 * the remove-dependant contacts-choice plan. Never treat a read failure as
 * "nothing to strand".
 */
export const CONTACTS_LOG_UNAVAILABLE_COPY = "Couldn't read their contacts. Please try again.";

export function defaultChildCeilingCopy(dependantName: string): string {
  return `Contacts ${safeName(dependantName)} adds themselves are capped at this tier until you vouch for them.`;
}

/** GuardianSettings' "Contacts your child adds start as" card title. */
export const DEFAULT_CHILD_CEILING_SECTION_TITLE = 'Contacts your child adds start as';

/**
 * R-CEILING-DISPLAY: the family manager's ceiling `<select>` always shows and
 * edits the ACTING guardian's own ceiling, never another guardian's. When a
 * co-guardian holds a stricter one, this names the tier that actually binds —
 * never presented as editable here.
 */
export function coGuardianCeilingHintCopy(tier: ContactCeilingTier): string {
  return `A co-guardian's stricter cap of ${tierChipLabel(tier)} still applies.`;
}

export function describeDirectories(labels: string[]): string {
  if (labels.length === 0) return 'nobody';
  const safe = labels.map(safeName);
  if (safe.length === 1) return safe[0];
  return `${safe.slice(0, -1).join(', ')} and ${safe[safe.length - 1]}`;
}

export function shareConfirmCopy(contactName: string, directoryLabels: string[]): string {
  const safe = safeName(contactName);
  return `Add ${safe} to ${describeDirectories(directoryLabels)} as Ken. Only the fields selected below are copied. Shared checks and tier are attributed to you, not treated as their own.`;
}

export function vouchConfirmCopy(
  contactName: string,
  tier: ContactTier,
  directoryLabels: string[],
): string {
  const safe = safeName(contactName);
  return `Vouch for ${safe} as ${tierChipLabel(tier)} for ${describeDirectories(directoryLabels)}. Each keeps their own record, and you can revoke the vouch later.`;
}

// ---- Contact detail page (src/pages/ContactDetail.tsx) --------------------

export const CONTACT_TYPE_LABELS: Record<ContactType, string> = {
  person: 'Person',
  organisation: 'Organisation',
};

export const IDENTITY_VERIFICATION_LABELS: Record<ContactVerification, string> = {
  unverified: 'Not verified',
  mutual: 'Mutually verified',
  proven: 'Proven',
};

/** How an identity arrived on the record — spec §7.8's provenance tag, in plain English. */
export const IDENTITY_PROVENANCE_LABELS: Record<ContactIdentityProvenance, string> = {
  direct: 'Added directly',
  'guardian-share': 'Shared by a guardian',
  'app-proposal': 'Suggested by an app',
  'legacy-import': 'Imported from your previous contacts',
  'key-link': 'Linked from a key rotation',
};

export const IDENTITIES_SECTION_TITLE = 'Nostr identities';
export const METHODS_SECTION_TITLE = 'Contact methods';
export const ROLES_SECTION_TITLE = 'Roles';
export const TIER_SECTION_TITLE = 'Your classification';
export const NOTE_SECTION_TITLE = 'Private note';
export const BLOCK_SECTION_TITLE = 'Blocking';

export const NAME_FIELD_LABEL = 'Name';
export const METHOD_KIND_FIELD_LABEL = 'Kind';
export const METHOD_LABEL_FIELD_LABEL = 'Label';
export const METHOD_VALUE_FIELD_LABEL = 'Value';
export const ADD_A_ROLE_LABEL = 'Add a role';
export const BLOCK_REASON_FIELD_LABEL = 'Reason (optional)';

export const SAVE_LABEL = 'Save';
export const ADD_METHOD_LABEL = 'Add method';
export const ADD_LABEL = 'Add';
export const SAVE_NOTE_LABEL = 'Save note';
export const UNBLOCK_LABEL = 'Unblock';
export const BLOCK_LABEL = 'Block';
export const CANCEL_LABEL = 'Cancel';
export const REMOVE_CONTACT_LABEL = 'Remove contact';
export const REMOVE_LABEL = 'Remove';
export const KEY_CONTROL_LABEL = 'Key control';

export const METHOD_PRIVACY_HINT =
  'Kept private on this device. Shared only through an explicit grant.';
export const ROLE_HINT =
  'A role describes the relationship. It never changes the tier or grants access.';
export const TIER_HINT =
  'Kin is your close circle, Kith an acquaintance, Ken someone you recognise one way.';
export const NO_ROLES_YET = 'No roles yet.';

/**
 * Generic fallback shown when a `contactsV2` mutator rejects (an invalid
 * operation, or the directory/actor scope isn't ready) — never the raw
 * `Error.message`, which is a developer-diagnostic string
 * (`"contacts: cannot rename — contacts scope not ready"`), not something to
 * put in front of a user.
 */
export const CONTACT_ACTION_FAILED_COPY = "That change didn't save. Try again.";

export function removeRoleAriaLabel(role: string): string {
  return `Remove role ${safeName(role)}`;
}

export function blockConfirmLabel(contactName: string): string {
  return `${BLOCK_LABEL} ${safeName(contactName)}`;
}

export function removeContactConfirmCopy(contactName: string): string {
  return `Remove ${safeName(contactName)} from your contacts? Their record is tombstoned on this device.`;
}

// ---- Field validators (src/lib/contacts-v2-detail.ts, src/lib/contacts-v2-new-contact.ts) ----

/** M11/P3: the field-level validator strings, moved out of the pure lib
 *  modules so they follow the same copy-module rule as everything else. */
export const METHOD_VALUE_REQUIRED_COPY = 'Enter a value.';
export const METHOD_EMAIL_INVALID_COPY = 'Enter an email address in the format name@domain.com.';
/** P1: the validator is https-only, and this says so — never http://. */
export const METHOD_WEBSITE_INVALID_COPY = 'Enter a web address starting with https://.';
export const NEW_CONTACT_NAME_REQUIRED_COPY = 'Enter a name.';

// ---- New contact page (src/pages/ContactNew.tsx) ---------------------------

export const TYPE_SECTION_TITLE = 'Type';
export const TIER_PICKER_SECTION_TITLE = 'Tier';
export const PHONE_OPTIONAL_LABEL = 'Phone (optional)';
export const EMAIL_OPTIONAL_LABEL = 'Email (optional)';
export const SAVE_CONTACT_LABEL = 'Save contact';
export const SAVING_LABEL = 'Saving…';

/** Preserves the exact wording shipped in Task 9 — moved here, not reworded. */
export const CONTACT_SAVE_FAILED_COPY = 'Could not save this contact.';

export function addingToContactsCopy(subjectName: string): string {
  return `Adding to ${safeName(subjectName)}'s contacts.`;
}

// ---- Contacts rolodex (src/pages/ContactsRolodex.tsx) ----------------------

export const ROLODEX_LOADING_COPY = 'Loading…';
export const ROLODEX_NO_MATCHES_TITLE = 'No matches';
export const ROLODEX_EMPTY_TITLE = 'No contacts yet';
export const ROLODEX_EMPTY_TEXT = 'Add someone to see them here.';
export const NEW_CONTACT_LABEL = 'New contact';
export const RECOGNISE_PUBLIC_KEY_LABEL = 'Recognise a public key';
export const SEARCH_CONTACTS_LABEL = 'Search contacts';

/** I5: the "Sam's contacts" heading interpolates a dependant display name — sanitised. */
export function rolodexHeadingCopy(subjectName: string): string {
  return `${safeName(subjectName)}'s contacts`;
}

// ---- Dependant settings (src/pages/PersonaAdvanced.tsx) --------------------

export const DEPENDANT_CONTACTS_SECTION_TITLE = 'Their contacts';
export const DELETE_CONTACTS_LABEL = 'Delete contacts';
export const ARCHIVE_CONTACTS_LABEL = 'Archive contacts';

// ---- Family contacts manager (src/pages/FamilyContacts.tsx, src/pages/FamilyList.tsx) ----

/** The label for the guardian's own directory in the family manager and App.tsx wiring. */
export const OWNER_DIRECTORY_LABEL = 'You';

export const FAMILY_CONTACTS_PAGE_TITLE = 'Family contacts';
export const MANAGE_FAMILY_CONTACTS_LABEL = 'Manage contacts across the family';
export const FAMILY_CONTACTS_LOADING_COPY = 'Loading…';
export const FAMILY_CONTACTS_DIRECTORIES_TITLE = 'Directories';
export const FAMILY_CONTACTS_DIRECTORIES_HINT =
  'Each person keeps their own record. Adding somebody here creates a new relationship, and copies no verification, notes or access.';
export const FAMILY_CONTACTS_EMPTY_TITLE = 'No contacts across the family yet';
export const FAMILY_CONTACTS_EMPTY_TEXT = 'Contacts you or a dependant add will show here, side by side.';
/**
 * Fix round 1 / I3: shown for BOTH a rejected `applyOps` batch and a failed
 * `useFamilyContactsV2` load — the raw message behind either (a validator
 * rejection, an IDB or decrypt failure) is a dev-diagnostic string, never
 * something to put on screen.
 */
export const FAMILY_CONTACTS_APPLY_FAILED_COPY = 'Could not apply that change.';
export const BACK_LABEL = 'Back';
export const CONFIRM_LABEL = 'Confirm';
export const SHARE_WITH_DEPENDANTS_LABEL = 'Share with my dependants';
export const NO_CEILING_LABEL = 'No ceiling';

export function directoryCoverageCopy(present: number, total: number): string {
  return `${present} of ${total} directories`;
}

/** "Vouch as Kin for…" / "Vouch as Kith for…" bulk-action button labels. */
export function vouchForLabel(tier: ContactTier): string {
  return `Vouch as ${tierChipLabel(tier)} for…`;
}

/** The bulk panel's own section title, once a bulk action is open. */
export function bulkSectionTitle(bulk: { kind: 'share' } | { kind: 'vouch'; tier: ContactTier }): string {
  return bulk.kind === 'share' ? 'Share with' : `Vouch as ${tierChipLabel(bulk.tier)} for`;
}

export function ceilingFieldLabel(directoryLabel: string): string {
  return `Ceiling for ${safeName(directoryLabel)}`;
}

export function roleFieldLabel(directoryLabel: string): string {
  return `Role for ${safeName(directoryLabel)}`;
}

// ---- Contacts v2 app grants (src/pages/ContactsGrantApprove.tsx) ----------

/**
 * Contacts v2 app grants (Phase E).
 *
 * Keyed by capability id so the approval screen, the connected-apps list and
 * any later surface all say the same thing about the same permission.
 *
 * Only name and public keys are included by default. Each additional field
 * needs its own requested, explicitly approved capability. Private links are
 * never part of a projection, including a blocked-contacts list.
 *
 * R-28(d): `propose:add-ken` says the app ADDS the contact. It used to read
 * "Ask you to add…", which described a queue and a prompt that do not exist —
 * an accepted batch is applied the moment it validates. A consent line has to
 * describe what actually happens, and what happens is bounded elsewhere
 * (dedupe by pubkey, a per-directory ceiling, Ken is recognised-only with no
 * access), not by an owner decision at the time.
 */
export const CONTACTS_GRANT_CAPABILITY_COPY: Record<Capability, string> = {
  'signet.contacts.invites:create': 'Make contact invites for this identity. Accept the first request to a single-use invite automatically for five minutes; you can switch this off.',
  'signet.contacts.invites:receive': 'Send contact requests from this identity when you connect through the app. This does not share your contact list.',
  'signet.contacts.read:directory':
    'See contact names and public keys only.',
  'signet.contacts.read:method:phone':
    'Also see phone numbers you marked as shareable.',
  'signet.contacts.read:method:email':
    'Also see email addresses you marked as shareable.',
  'signet.contacts.read:method:website':
    'Also see websites you marked as shareable.',
  'signet.contacts.read:method:postal-address':
    'Also see postal addresses you marked as shareable.',
  'signet.contacts.read:method:other':
    'Also see other contact methods you marked as shareable.',
  'signet.contacts.read:tier':
    'Also see Kin, Kith and Ken labels and whether a guardian set or limited them.',
  'signet.contacts.read:check-records':
    'Also see how and when you checked shared keys. Private sources and evidence stay private.',
  'signet.contacts.read:checks':
    'Also see verification status for the keys and contact methods you share.',
  'signet.contacts.read:roles':
    'See the role labels you give contacts, such as mum, coach or colleague.',
  'signet.contacts.blocks.read':
    'See who you have blocked, including their keys, so it can hide them for you.',
  'signet.contacts.propose:add-ken':
    'Add contacts to your Ken list — recognised only, with no access. Links to an existing contact under another identity need your confirmation.',
  'signet.contacts.propose:rename-app-label':
    'Rename a contact inside this app only — your own list is unchanged.',
};

/** The honesty line. Revocation stops the next update; it cannot reach into
 *  another device and delete what is already there, and with a seven-day
 *  window the app may keep using what it has for that long (S5). */
export const CONTACTS_GRANT_HONESTY =
  'You can disconnect this app at any time. That stops future updates — it cannot take back '
  + 'anything the app has already downloaded, and the app may keep using its copy until its '
  + 'freshness window runs out, which can be up to seven days.';

export const CONTACTS_GRANT_RECONNECT_COPY =
  'A sharing permission has changed. Reconnect this app to choose which fields it can read.';

export const CONTACTS_GRANT_FRESHNESS_LABEL = 'How fresh must its copy be?';

/**
 * R-26: this device is already at its limit of connected apps, so one or more
 * apps connected on ANOTHER device could not be added here.
 *
 * Said out loud rather than left silent: from the owner's seat an app that
 * quietly never arrives is indistinguishable from one that was never
 * connected, and the remedy (disconnect something here first) is only obvious
 * once the cause is named. It does not claim anything was lost — the other
 * device still holds the grant, and it still works there.
 */
export function GRANTS_SKIPPED_REMOTE_COPY(count: number): string {
  const apps = count === 1 ? '1 app' : `${count} apps`;
  const it = count === 1 ? 'it' : 'them';
  return `${apps} you connected on another device could not be added here — this device is already at its limit `
    + `of connected apps. Disconnect one here to make room for ${it}.`;
}

/** R-5: what the owner is told about the last publish for a grant. */
export const CONTACTS_GRANT_PUBLISH_STATE: Record<'ok' | 'truncated' | 'failed', string> = {
  ok: 'Up to date.',
  truncated: 'Your list was too big to send in full — this app has the most recently updated part of it.',
  failed: 'The last update did not reach your relay. It will try again.',
};

// ---- Contacts v2 connected-apps list and grant wiring (src/App.tsx) -------

/**
 * Task 22 surfaces. App.tsx is outside the vocabulary guard's glob but bound
 * by the same copy rule, so every string it renders for a contacts v2 grant —
 * including the message of every error it throws at the approval screen, which
 * `ContactsGrantApprove` shows verbatim — comes from here.
 */
export const CONTACTS_GRANTS_LIST_TITLE = 'Apps connected to your contacts';
export const CONTACTS_GRANTS_LIST_EMPTY = 'No apps are connected to your contacts.';
export const CONTACTS_GRANT_DISCONNECT_LABEL = 'Disconnect';
export const CONTACTS_GRANT_FORGET_LABEL = 'Forget';

/** Which contact list a grant reads. The label is the directory's own
 *  (`familyDirectoryRefs`), never a literal minted at the call site. */
export function contactsGrantDirectoryLine(directoryLabel: string): string {
  return `Contact list: ${safeName(directoryLabel)}`;
}

/** A revoked grant stays listed as ended, with when it ended. `when` is a
 *  locale-formatted date from the call site — the sentence around it is here. */
export function contactsGrantEndedLine(when: string): string {
  return `Disconnected ${safeName(when)}.`;
}

export function contactsGrantDisconnectConfirm(appName: string): string {
  return `Disconnect ${safeName(appName)}? Future updates stop straight away. What it has already downloaded cannot be taken back.`;
}

/**
 * R-13: the cap counts ACTIVE grants, so the remedy really is "disconnect one",
 * not "wait" — and a revoked row sitting in the list is not what is in the way.
 */
export const CONTACTS_GRANT_AT_CAP_COPY =
  'This device is already at its limit of apps connected to your contacts. Disconnect one before connecting another.';

export const CONTACTS_GRANT_DIRECTORY_UNAVAILABLE_COPY =
  'That contact list is not available on this device.';

export const CONTACTS_GRANT_NOT_READY_COPY =
  'This device is not ready to connect an app to your contacts yet. Unlock it and try again.';

/** Every failure past the grant being saved deletes the half-made grant again,
 *  so "nothing was shared" is a statement of fact, not reassurance. */
export const CONTACTS_GRANT_CONNECT_FAILED_COPY =
  'Could not connect that app. Nothing was shared — please try again.';

export const CONTACTS_GRANT_DISCONNECT_FAILED_COPY =
  'Could not disconnect that app. Please try again.';

export const CONTACTS_GRANT_FORGET_FAILED_COPY =
  'Could not remove that record. Please try again.';

/**
 * The grants rail's own too-large state, beside the contacts one. Distinct
 * from `CONTACTS_BACKUP_TOO_LARGE_COPY`: it is the list of connected apps that
 * stopped reaching the relay, not the contact log, and nothing local is lost.
 */
export const GRANTS_BACKUP_TOO_LARGE_COPY =
  'The list of apps connected to your contacts has grown too large to back up to your relay. Nothing is lost on this device, but it is not reaching your other devices.';

/** The approval page's own title (fix round 1 / M6). */
export const CONTACTS_GRANT_APPROVE_TITLE = 'Connect an app';

/**
 * M2: the tick-list came back empty, or carrying something the app never
 * asked for. Neither is a state the screen can produce on its own, so this is
 * a refusal the owner should be able to act on rather than a silent trim.
 */
export const CONTACTS_GRANT_CAPABILITIES_INVALID_COPY =
  'Those permissions do not match what the app asked for. Scan the code again.';

/**
 * M3: the app IS connected — the ack reached it — but this device's first
 * copy of the list did not reach the relay. Never worded as a failed
 * connection: the grant stands, and the next change retries.
 */
export const CONTACTS_GRANT_FIRST_UPDATE_FAILED_COPY =
  'That app is connected, but the first copy of your list did not reach your relay. It will try again with your next change.';

/**
 * M7: a paired-child install has no contacts v2 grant surface (R-8), so a
 * pairing code scanned there fails closed — WITH a reason, because a scan
 * that silently does nothing reads as a broken camera.
 */
export const CONTACTS_GRANT_PAIRED_CHILD_COPY =
  'Apps are connected to contacts from the guardian device, not this one. Ask them to scan this code.';

/** B/M5: the dismiss action on that banner. App.tsx is outside the vocabulary
 *  guard's glob but bound by the same rule, so the word lives here. */
export const CONTACTS_GRANT_DISMISS_LABEL = 'Dismiss';

/**
 * Pre-merge minor: the web verification scanner recognises a pairing code but
 * cannot act on one — approval belongs on the home screen's scanner, which has
 * the identity and the directory roster behind it. Saying which screen is the
 * whole point: the scanner used to fall through its own `switch` with NO case
 * and no `default`, so a pairing code read as a working scan that did nothing.
 */
export const CONTACTS_GRANT_WRONG_SCANNER_COPY =
  'That is an app pairing code. Scan it from the home screen to connect the app to your contacts.';
