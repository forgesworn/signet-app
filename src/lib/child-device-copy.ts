/**
 * User-facing copy for the child-direct Heartwood pairing (spec §4, §9.4).
 * British English. Every string the guardian or child sees for this feature
 * lives here, not inline in pages or hooks.
 */

export const CHILD_DEVICE_COPY = {
  title: (name: string) => `Pair ${name}'s phone`,
  checking: 'Checking your Heartwood…',
  blocked: {
    'no-operator-key': {
      heading: 'Your operator key is needed',
      body: 'To pair a phone straight to your Heartwood, this phone needs your Heartwood operator key. Import it from Sapwood first.',
      action: 'Import operator key',
    },
    'device-unsupported': {
      heading: 'Your Heartwood needs an update',
      body: 'Your Heartwood firmware cannot pair a phone this way yet. Update it in Sapwood, then come back here.',
    },
    'slots-full': {
      heading: 'Your Heartwood is full',
      body: 'Every client slot on your Heartwood is in use. Remove one in Sapwood, then try again. In use:',
    },
    'no-persona': {
      heading: 'No persona to pair',
      body: (name: string) => `${name} has no active persona for this phone to sign as. Add or switch to a persona first.`,
    },
    offline: {
      heading: 'Cannot reach your Heartwood',
      body: 'Your Heartwood did not answer. Check it is switched on and online, then try again.',
    },
  },
  offerIntro: (name: string) =>
    `Open My Signet on ${name}'s phone, choose "I'm pairing to my guardian", and scan this code.`,
  offerExpires: (mmss: string) => `This code expires in ${mmss}`,
  offerNoSecret: 'The code holds no key. It works once, for ten minutes.',
  confirmHeading: 'Check the words match',
  confirmBody: (name: string) =>
    `${name}'s phone is showing four words. Only carry on if they are exactly the same as these.`,
  confirmMatch: 'They match',
  confirmNoMatch: "They don't match",
  minting: 'Setting up the Heartwood slot…',
  pairedHeading: 'Paired',
  pairedBody: (name: string) =>
    `${name}'s phone now signs through your Heartwood. On their phone, follow the steps to approve each persona — press ALLOW AS on the Heartwood when it asks.`,
  pairedOldSlotWarning: 'The previous phone could not be removed from your Heartwood. Remove it in Sapwood.',
  abortedMismatch: 'Pairing stopped. The words did not match, so nothing was set up. The code has been cancelled — start again with a new one.',
  abortedTwoRequests: 'Pairing stopped. Two different phones answered this code, so nothing was set up. The code has been cancelled — start again with a new one.',
  expired: 'This code has expired. Nothing was set up.',
  newCode: 'New code',
  cancel: 'Cancel',
  done: 'Done',
  back: 'Back',
  unpair: 'Unpair this phone',
  unpairConfirm: (name: string) =>
    `Unpairing removes ${name}'s phone from your Heartwood at once. It will stop signing until you pair it again.`,
  unpairNow: 'Unpair now',
  unpairing: 'Unpairing…',
  unpaired: (name: string) => `${name}'s phone is no longer paired.`,
  pairedAlready: (name: string) => `${name}'s phone is paired to your Heartwood.`,
  pairAgain: 'Pair a different phone',
  errors: {
    mint: 'Your Heartwood could not set up the slot. Nothing was paired — try again.',
    mintUnconfirmed: 'Your Heartwood may have set up a slot we could not check. Open Sapwood and remove any "signet:child-device" slot you do not recognise.',
    verify: 'The Heartwood slot did not match what was asked for, so it was removed. Try again.',
    save: 'The slot was set up but could not be saved on this phone, so it was removed. Try again.',
    badRelay: 'A relay address is not valid. Check your relay settings.',
    unpair: 'Could not reach your Heartwood to unpair. Try again.',
    noDependant: 'Dependant not found.',
    stale: 'That pairing request is too old to use, so nothing was set up. Start again with a new code.',
    clientReused: 'That phone offered a connection your Heartwood already knows, so nothing was set up. Start again — the phone will use a new one.',
    generic: 'Something went wrong. Try again.',
  },
} as const;

/** Child-phone side of the child-direct pairing (spec §4 steps 2, 5, 6). */
export const CHILD_SIDE_COPY = {
  pasteHint: 'It starts with bunker:// or signet-child:.',
  confirmHeading: "You're about to pair as",
  confirmGuardian: (guardian: string) => `Your guardian: ${guardian}`,
  confirmBody: "This phone will sign through your family's Heartwood. Your guardian decides what it can do.",
  confirmGo: "That's me",
  pairing: 'Contacting your guardian…',
  checkHeading: 'Check these words match your guardian\'s phone',
  checkBody: 'Your guardian will see four words. Tell them yours. They only carry on if every word is the same.',
  waiting: 'Waiting for your guardian…',
  cancel: 'Cancel',
  /** A28: a failed run never retries the same code. */
  scanNew: 'Scan a new code',
  errors: {
    timeout: "Your guardian's phone did not answer in time. Nothing was set up — ask them for a new code.",
    publish: 'Could not reach the relay. Check your internet connection and try again.',
    signer: 'Your Heartwood did not connect as the right identity, so nothing was set up. Ask your guardian for a new code.',
    refused: {
      'check-mismatch': 'Your guardian said the words did not match, so nothing was set up. Ask them for a new code.',
      'two-requests': 'Another phone also answered this code, so nothing was set up. Ask your guardian for a new code.',
      'mint-failed': 'Your Heartwood could not set up a slot for this phone. Ask your guardian to try again.',
      'verify-failed': 'Your Heartwood slot did not check out, so it was removed. Ask your guardian to try again.',
      'save-failed': "Your guardian's phone could not save the pairing. Ask them to try again.",
      stale: 'Your guardian answered too late for this request, so nothing was set up. Ask them for a new code.',
      'client-reused': 'Your guardian\'s phone saw a connection it had used before, so nothing was set up. Try again — this phone will use a new one.',
      other: 'Your guardian stopped the pairing. Ask them for a new code.',
    } as Record<string, string>,
    wrongAccount: 'This code is for a different account. Ask your guardian to generate a new code for you specifically.',
    invalid: "That doesn't look like a valid pairing code. Check you have the whole thing.",
    expired: 'This code has expired. Ask your guardian for a new one.',
    generic: 'Pairing did not finish. Nothing was set up — try again.',
  },
  /** §9.4: the guardian unpaired this phone (notice or the Heartwood refusing it). */
  unpaired: 'Your guardian has unpaired this phone',
  pairAgain: 'Pair again',
  /** A45: the local app-connection keys will not decrypt; nothing was replaced. */
  transportKeysUnreadable: 'Your app connections could not be read on this phone, so apps cannot connect right now. Lock and unlock to try again.',
  /** A41: `?action=add-dependant` on a child's phone. */
  addDependantRefused: "This phone belongs to a child's account, so it cannot add someone to a family. Ask your guardian to do it on their phone.",
  /** A42: guardian-managed acts refused on a child's phone. */
  guardianManages: 'Your guardian looks after this for you, on their phone.',
  /** A40: nostrconnect:// on a direct child. */
  connectNotServed: 'This identity cannot connect apps on this phone right now. Check your Heartwood is connected, then try again.',
  approvals: {
    heading: 'Approve your identities on the Heartwood',
    body: 'For each identity, your guardian presses ALLOW AS on the Heartwood once.',
    approved: 'Approved',
    waiting: 'Waiting for the Heartwood',
    failed: 'Not approved yet',
    retry: 'Try again',
  },
} as const;

/** Guardian side of a child's fresh request (spec §7). */
export const CHILD_ASK_COPY = {
  eyebrow: 'Asking you',
  heading: (child: string, what: string) => `${child} wants to sign a ${what}`,
  headingCrypto: (child: string) => `${child} wants to read or send a private message`,
  as: (persona: string) => `As ${persona}`,
  on: (target: string) => `On ${target}`,
  /** A36: the child-supplied name, shown only under the re-derived target. */
  labelNote: (label: string) => `Their phone calls it “${label}”`,
  hidden: (n: number) => `Part of this request is hidden (${n} characters)`,
  hiddenTags: 'Some of this request’s details are hidden',
  allowOnce: 'Allow once',
  /** A36: names the scope, the re-derived target and the persona — "Always allow sign-in to school.org for Sky". */
  allowAlways: (scopePhrase: string, target: string, persona: string) => `Always allow ${scopePhrase} ${target} for ${persona}`,
  scopePhrase: {
    'sign-in': 'sign-in to',
    'venue-entry': 'venue entry at',
    'post-public': 'public posts on',
    'dm-private': 'private messages with',
    'upload-photo': 'photo uploads to',
    'react-zap-reply': 'reactions and replies on',
    'pair-device': 'device pairing with',
    'mutate-identity': 'profile changes on',
  } as Record<string, string>,
  kindPhrase: (kind: number) => `kind ${kind} requests on`,
  appMySignet: 'My Signet',
  appHex: (short: string) => `app ${short}`,
  anywhere: 'anywhere',
  /** A34: the answer is chosen but has not reached the child's phone. */
  unsentNote: (choice: string) => `You chose “${choice}”, but it has not reached their phone yet.`,
  sendAgain: (choice: string) => `Send again: ${choice}`,
  choiceName: { once: 'Allow once', always: 'Always allow', deny: 'Deny' } as Record<string, string>,
  /** A37 */
  later: 'Later',
  moreWaiting: (n: number) => (n === 1 ? '1 more waiting' : `${n} more waiting`),
  deny: 'Deny',
  alwaysDeny: 'Always deny this',
  sending: 'Sending…',
  sent: {
    once: 'Allowed once',
    always: 'Allowed from now on',
    deny: 'Denied',
  },
  reasons: {
    'device-unreachable': 'Your Heartwood could not be reached, so the request was denied. Check it is on and online.',
    'ceiling-full': 'Your Heartwood cannot hold another kind of request for this phone, so it was denied. Remove an older rule first.',
    paused: 'This phone is paused, so the request was denied.',
    expired: 'This request had already run out of time.',
    'publish-failed': 'Your answer has not reached their phone yet. Send it again.',
    'save-failed': 'Could not save your answer on this phone, so nothing was sent. Try again.',
    'always-unavailable': 'At this stage every request is asked for, so “Always” is not offered.',
    'already-decided': 'This request has already been answered.',
    'not-found': 'This request is no longer waiting.',
    locked: 'Unlock to answer.',
  } as Record<string, string>,
  notificationTitle: (child: string) => `${child} needs an approval`,
} as const;

/** The child's phone while its gate waits on the guardian (spec §7, §8). */
export const CHILD_WAITING_COPY = {
  title: 'Asking your guardian…',
  body: 'Your guardian gets this request on their phone. This page waits for their answer.',
  longTitle: 'Still waiting for your guardian…',
  longBody: 'They may not have seen it yet. The request stays open for 10 minutes.',
} as const;

/** Guardian's merged activity timeline for a child's own phone (spec §9.2, §9.3). */
export const CHILD_ACTIVITY_COPY = {
  outcome: {
    signed: 'Signed',
    approved: 'Allowed by you',
    denied: 'Denied',
    asked: 'Asked you',
    blocked: 'Blocked',
    expired: 'Not answered in time',
  } as Record<string, string>,
  as: (persona: string) => `As ${persona}`,
  onHeartwood: 'On the Heartwood',
  crypto: 'Read or sent a private message',
  mismatch: (name: string) => `Signed on the Heartwood but not reported by ${name}'s phone`,
  /** A48: a Heartwood record the guardian's own phone made, acting as the child. */
  signedByYou: 'Signed by you',
  empty: (name: string) => `What ${name}'s phone signs, and what it asks you, will appear here.`,
} as const;

/** Permissions page for a child's own phone (spec §9.3, §9.4). Guardian manages; the child sees it read-only. */
export const CHILD_PERMISSIONS_COPY = {
  title: (name: string) => `${name}'s permissions`,
  titleChild: 'What your guardian allows',
  entry: 'Permissions',
  entryBody: (name: string) => `What ${name}'s phone may sign, the apps on it, and how to stop them.`,
  childEntryBody: 'See what your guardian allows this phone to do.',
  childEntryButton: 'See permissions',
  pairedStatus: (name: string) => `${name}'s phone is paired to your Heartwood.`,
  notPaired: (name: string) => `${name}'s phone is not paired.`,
  unpairedChild: 'Your guardian has unpaired this phone.',
  noRulesYet: 'Waiting for your guardian’s rules. Until they arrive, everything is asked for.',
  stage: 'Stage',
  stageName: {
    'full-control': 'Full control — every request is asked for',
    'request-approve': 'Asks for approval',
    'autonomous-alerts': 'Independent, with alerts',
    'autonomous-logging': 'Independent, logged',
    'full-autonomy': 'Fully independent',
  } as Record<string, string>,
  changeStage: 'Change stage',
  rulesHeading: 'Rules',
  allPersonas: (name: string) => `All of ${name}'s identities`,
  noRules: 'No rules yet. Anything outside the stage is asked for.',
  allow: 'Always allow',
  deny: 'Always deny',
  lastUsed: (when: string) => `Last used ${when}`,
  neverUsed: 'Not used yet',
  revoke: 'Revoke',
  revoking: 'Revoking…',
  ceilingHeading: 'Allowed types on the Heartwood',
  ceilingBody: 'The Heartwood refuses any other type, whatever the phone asks. Which sites and apps may use each type is decided on the phone.',
  ceilingLocked: 'Nothing — this phone is paused.',
  everyType: 'Every type',
  relaySignIn: 'Relay sign-in',
  otherType: (n: number) => `Other type (${n})`,
  scopeName: {
    'sign-in': 'Sign-in',
    'venue-entry': 'Venue entry',
    'post-public': 'Public posts',
    'react-zap-reply': 'Reactions and replies',
    'dm-private': 'Private messages',
    'upload-photo': 'Photo uploads',
    'mutate-identity': 'Profile changes',
    'pair-device': 'Device pairing',
  } as Record<string, string>,
  personasHeading: 'Identities on the phone',
  removePersona: (name: string) => `Remove from ${name}'s phone`,
  removePersonaConfirm: (persona: string, name: string) =>
    `${persona} will stop signing on ${name}'s phone at once. Pair it again to bring it back.`,
  removeNow: 'Remove now',
  removing: 'Removing…',
  removed: (name: string) => `Removed from ${name}'s phone`,
  removeFailed: 'Could not reach your Heartwood to remove it. Try again.',
  appsHeading: (name: string) => `Apps on ${name}'s phone`,
  appsHeadingChild: 'Apps on this phone',
  noApps: 'No apps have connected yet.',
  appKind: { nip46: 'App', nip55: 'Android app', site: 'Website' } as Record<string, string>,
  as: (persona: string) => `As ${persona}`,
  block: 'Block',
  blocking: 'Blocking…',
  blocked: 'Blocked',
  blockFailed: 'Could not block this app. Try again.',
  revokeFailed: 'Could not revoke this rule. Try again.',
  asksHeading: 'Past requests',
  noAsks: 'No requests yet.',
  verdict: { once: 'Allowed once', always: 'Always allowed', deny: 'Denied' } as Record<string, string>,
  notSent: 'Not sent yet',
  unpairHeading: 'Unpair phone',
  cancel: 'Cancel',
} as const;
