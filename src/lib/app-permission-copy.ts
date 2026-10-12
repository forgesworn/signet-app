/**
 * Words for the phone that receives an app-permission request (the person
 * asked, or a child asking their guardian). The guardian's card is in
 * `CHILD_ASK_COPY.appPermission`. Nothing here is app-supplied text except
 * the sanitised name and reason the callers interpolate.
 */
import type { AppPermissionRefusalKind } from './app-permission-flow';

export const APP_PERMISSION_COPY = {
  layoutTitle: 'App permission',
  /** Adult: the key is theirs. */
  headingAdult: (app: string, persona: string) => `${app} asks to show other players it is ${persona}`,
  /** Child: the guardian decides. */
  headingChild: (app: string) => `${app} asks: let you play online with other players`,
  appSays: (reason: string) => `The app says: “${reason}”`,
  allowsTitle: 'What this allows',
  allowsAdult: (app: string, persona: string, until: string) =>
    `Until ${until}, ${app} on this phone can prove to the other players in a game that it is ${persona}, so they will know ${persona} plays ${app}. It cannot post, message anyone or act as ${persona} anywhere else. My Signet cannot control what the app does with this proof; ${app} says it shows it only to players in a game with ${persona}.`,
  allowsChild: (app: string, persona: string, until: string) =>
    `Until ${until}, ${app} on this phone can prove to the other players in a game that it is ${persona}, so they will know ${persona} plays ${app}. It cannot post, message anyone or act as ${persona} anywhere else. Your guardian decides, and My Signet cannot control what the app does with this proof.`,
  from: (host: string) => `From ${host}`,
  details: 'Details',
  appId: 'App id',
  installKey: 'Install key',
  validUntil: 'Valid until',
  allow: 'Allow',
  askGuardian: 'Ask my guardian',
  tryAgain: 'Try again',
  /** M5: the sign-in guardrail's confirmation, worded for a permission. */
  realIdentityConfirm: {
    confirmed: 'Real-name identity confirmed.',
    title: "You're about to give this permission as your real-name identity",
    usuallyEnough: "Most apps don't need it — a persona is usually enough.",
  },
  realIdentityUnconfirmed: 'Confirm your real-name identity first.',
  cancel: 'Cancel',
  close: 'Close',
  working: 'Working…',
  /** Result screen (reuses the sign-in acknowledgement). */
  ackApprovedTitle: 'Permission given',
  ackApproved: (app: string) => `You let ${app} show other players who you are. Return to the app or page where you started to continue.`,
  ackDeniedTitle: 'Declined',
  ackDenied: (app: string) => `You said no to ${app}.`,
  ackFailedNoun: 'this request',
  keyUnavailable: 'The key for this permission is not available right now. Unlock again or reconnect your signer, then try again.',
  noLongerPending: 'This request is no longer waiting.',
  /** I1: a local failure on a child phone; nothing was sent to the app. */
  guardianUnreachable: 'Couldn\'t reach your guardian. Try again.',
  /** I1: the guardian allowed it, but their phone could not update the Heartwood. */
  deviceUnreachable: 'Your guardian said yes, but their phone couldn\'t reach the Heartwood. Try again.',
  invalidLink: 'That app permission link was not valid, so nothing was asked.',
  /** M4: a second link while one request is open; the second app is sent nothing. */
  anotherOpen: 'Another app\'s request is already open.',
  refusals: {
    'legacy-paired-child': 'This phone cannot give an app permission yet. Ask your guardian to do it from their phone.',
    'dependant-on-guardian': 'That key belongs to a child you look after, whose phone is not paired straight to a Heartwood. App permissions for it cannot be given from here yet.',
    'child-mode': 'This phone is being used as a child right now. Switch back to your own account to give an app permission.',
    'persona-not-on-device': 'That key is not on this device, so this phone cannot give the permission.',
  } as Record<AppPermissionRefusalKind, string>,
} as const;
