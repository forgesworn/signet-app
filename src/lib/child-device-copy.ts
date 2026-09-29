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
    generic: 'Something went wrong. Try again.',
  },
} as const;
