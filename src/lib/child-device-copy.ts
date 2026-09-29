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
  hidden: (n: number) => `Part of this request is hidden (${n} characters)`,
  hiddenTags: 'Some of this request’s details are hidden',
  allowOnce: 'Allow once',
  allowAlways: (target: string, persona: string) => `Always allow ${target} for ${persona}`,
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
    'publish-failed': 'Could not reach the relay to answer. Try again.',
    'always-unavailable': 'At this stage every request is asked for, so “Always” is not offered.',
    'already-decided': 'This request has already been answered.',
    'not-found': 'This request is no longer waiting.',
    locked: 'Unlock to answer.',
  } as Record<string, string>,
  notificationTitle: (child: string) => `${child} needs an approval`,
} as const;
