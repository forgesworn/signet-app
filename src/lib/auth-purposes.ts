/**
 * Auth-purpose registry — typed contextualisation for PIN/biometric prompts.
 *
 * Background. Every prompt rendered by `AuthScreen` used to carry the same
 * generic "Unlock Signet" header regardless of why it fired, leading to a
 * real UX bug where guardian-approval-of-dependant-action looks identical
 * to app-unlock. This registry attaches a typed `PurposeContext` to each
 * `requestAuth` / `requestFreshAuth` call, so the screen can render
 * purpose-specific copy + visual treatment.
 *
 * Design contract: see the internal auth-purpose-system design review.
 *
 * Conventions (also documented in the holodeck doc):
 *   - Tier 0 = passive unlock (cached key OK; `requestAuth`)
 *   - Tier 1 = explicit action, cached key OK (`requestAuth`)
 *   - Tier 2 = elevated action, always re-prompt (`requestFreshAuth`)
 *   - Templates are pure: `(ctx) => string`, no side effects
 *   - Dynamic context (siteName, depName, …) is bolded in the rendered copy
 *     by AuthScreen; templates wrap such tokens in `**…**`
 *   - Voice: direct, second-person, no hedging — match existing app voice
 */

import type { Page } from '../types';

export type AuthTier = 0 | 1 | 2;

const PERSONA_ACTION_TITLES = {
  switch: 'Switch persona', rename: 'Rename persona', create: 'Add persona',
  import: 'Import Nostr account', hide: 'Hide persona', show: 'Show persona',
  'edit-profile': 'Update persona profile', 'set-avatar': 'Set persona picture',
  'remove-avatar': 'Remove persona picture', 'share-photo': 'Share contact picture',
  'stop-sharing-photo': 'Stop sharing contact picture', activate: 'Activate real identity',
} as const;

const DEPENDANT_ACTION_TITLES = {
  'pair-device': 'Pair a dependant’s device', 'pair-app': 'Pair a dependant’s app',
  'remove-app': 'Disconnect a dependant’s app', permissions: 'Change dependant permissions',
  'contact-policy': 'Change dependant contact policy', rename: 'Rename dependant',
} as const;

const FEATURE_TITLES = {
  contacts: 'View contacts', bots: 'Manage bots', family: 'Manage family',
  'venue-entry': 'Open venue entry', 'photo-capture': 'Add venue-entry photo',
  roster: 'Manage roster', carousel: 'Organise identity cards',
  heartwood: 'Move keys to Heartwood', 'contact-code': 'Check contact access code',
} as const;

const REQUEST_TITLES = {
  'sign-in': 'Review sign-in request', connection: 'Review app connection',
  verification: 'Review verification request', 'add-dependant': 'Review dependant request',
  'app-permission': 'Review app permissions', 'contact-access': 'Review contact access',
  companion: 'Review companion access', vouch: 'Vouch for someone',
} as const;

const BOT_ACTION_TITLES = {
  create: 'Create a bot', connect: 'Connect a bot to an app',
  ownership: 'Confirm bot ownership', revoke: 'Revoke bot ownership',
  publish: 'Publish bot ownership', 'reveal-key': 'Reveal bot recovery key',
} as const;

export type AuthPurpose =
  | 'unlock-app'
  | 'approve-sign-in'
  | 'mutate-persona'
  | 'change-autonomy-stage'
  | 'reveal-dep-backup'
  | 'issue-professional-credential-pending'
  | 'guardian-approve-dep-action'
  | 'exit-child-mode'
  | 'delete-my-signet'
  | 'mutate-persona-child-mode'
  | 'issue-professional-credential-confirmed'
  | 'mutate-professional-roster'
  | 'manage-family-contacts'
  | 'transfer-independence'
  | 'review-request'
  | 'access-feature'
  | 'manage-signing-session'
  | 'manage-dependant'
  | 'manage-bot'
  | 'manage-keep'
  | 'rotate-backup-key'
  | 'reveal-recovery-words'
  | 'change-biometric'
  | 'recheck-professional';

export type RosterAction =
  | 'add-staff'
  | 'add-delegate'
  | 'remove-delegate'
  | 'rotate-key'
  | 'revoke-role'
  | 'remove-role';

export type PurposeContext =
  | { purpose: 'unlock-app' }
  | { purpose: 'approve-sign-in'; siteName: string; identityName: string }
  | {
      purpose: 'mutate-persona';
      action: keyof typeof PERSONA_ACTION_TITLES;
      personaName?: string;
      depName?: string;
    }
  | { purpose: 'change-autonomy-stage'; depName: string; nextStage: string }
  | { purpose: 'reveal-dep-backup'; depName: string }
  | {
      purpose: 'issue-professional-credential-pending';
      firmName: string;
      recipientShort: string;
      credentialType: string;
    }
  | {
      purpose: 'guardian-approve-dep-action';
      depName: string;
      actionDescription: string;
      siteName?: string;
    }
  | { purpose: 'exit-child-mode'; depName: string }
  | { purpose: 'delete-my-signet' }
  | {
      purpose: 'mutate-persona-child-mode';
      depName: string;
      action: 'create' | 'switch';
    }
  | {
      purpose: 'issue-professional-credential-confirmed';
      firmName: string;
      recipientShort: string;
      credentialType: string;
    }
  | { purpose: 'mutate-professional-roster'; firmName: string; action: RosterAction }
  | { purpose: 'manage-family-contacts' }
  | { purpose: 'transfer-independence'; depName: string; phase: 'prepare' | 'complete' }
  | { purpose: 'review-request'; request: keyof typeof REQUEST_TITLES; siteName?: string }
  | { purpose: 'access-feature'; feature: keyof typeof FEATURE_TITLES }
  | { purpose: 'manage-signing-session'; minutes?: number }
  | { purpose: 'manage-dependant'; depName: string; action: keyof typeof DEPENDANT_ACTION_TITLES }
  | { purpose: 'manage-bot'; action: keyof typeof BOT_ACTION_TITLES; botName?: string; siteName?: string }
  /** `claim` (the default): make the Keep this persona's. `link` / `unlink`: add or take off an owner persona of a Keep. */
  | { purpose: 'manage-keep'; keepName: string; personaName: string; action?: 'claim' | 'link' | 'unlink' }
  | { purpose: 'rotate-backup-key' }
  | { purpose: 'reveal-recovery-words' }
  | { purpose: 'change-biometric'; enabled: boolean }
  | { purpose: 'recheck-professional'; firmName: string };

export type PurposeIcon =
  | 'lock'
  | 'shield'
  | 'shield-warn'
  | 'key-plus'
  | 'trash'
  | 'scroll'
  | 'people'
  | 'door';

export type PurposeAccent = 'neutral' | 'soft' | 'warning' | 'destructive';

export interface PurposeConfig {
  tier: AuthTier;
  icon: PurposeIcon;
  accent: PurposeAccent;
  /** Headline. Renders in place of "Unlock Signet". */
  title: (ctx: PurposeContext) => string;
  /**
   * Subtext. Renders in place of "Enter your 6-digit PIN to continue".
   * Wrap dynamic tokens in **bold** — AuthScreen renders `**…**` as bold
   * via a tiny inline parser (no markdown library).
   */
  description: (ctx: PurposeContext) => string;
}

/**
 * Type-narrowing helper: assert the context matches the purpose. Used inside
 * each template so the compiler knows the discriminant is correct.
 */
function as<P extends AuthPurpose>(
  ctx: PurposeContext,
  purpose: P,
): Extract<PurposeContext, { purpose: P }> {
  if (ctx.purpose !== purpose) {
    // Defensive — should never happen at runtime if PURPOSES is keyed correctly.
    throw new Error(`Purpose mismatch: expected ${purpose}, got ${ctx.purpose}`);
  }
  return ctx as Extract<PurposeContext, { purpose: P }>;
}

export const PURPOSES: Record<AuthPurpose, PurposeConfig> = {
  'review-request': {
    tier: 1, icon: 'shield', accent: 'soft',
    title: raw => REQUEST_TITLES[as(raw, 'review-request').request],
    description: raw => {
      const ctx = as(raw, 'review-request');
      return `Unlock to review ${ctx.siteName ? `the request from **${ctx.siteName}**` : 'this request'}. You can approve or decline it after unlocking.`;
    },
  },
  'access-feature': {
    tier: 1, icon: 'lock', accent: 'soft',
    title: raw => FEATURE_TITLES[as(raw, 'access-feature').feature],
    description: () => 'Unlock to continue. Your encrypted data stays private while Signet is locked.',
  },
  'manage-signing-session': {
    tier: 1, icon: 'shield', accent: 'soft',
    title: () => 'Keep Signet available for apps',
    description: raw => {
      const ctx = as(raw, 'manage-signing-session');
      return ctx.minutes === undefined
        ? 'Unlock to keep Signet available for connected apps until you turn it off. Your approval rules still apply.'
        : `Unlock to keep Signet available for connected apps for **${ctx.minutes} minutes**. Your approval rules still apply.`;
    },
  },
  'manage-dependant': {
    tier: 1, icon: 'people', accent: 'soft',
    title: raw => DEPENDANT_ACTION_TITLES[as(raw, 'manage-dependant').action],
    description: raw => {
      const ctx = as(raw, 'manage-dependant');
      const actions: Record<typeof ctx.action, string> = {
        'pair-device': 'Set up or change device pairing', 'pair-app': 'Set up app pairing',
        'remove-app': 'Disconnect an app', permissions: 'Change app or persona permissions',
        'contact-policy': 'Change who can be added as a contact', rename: 'Change the display name',
      };
      return `${actions[ctx.action]} for **${ctx.depName}**.`;
    },
  },
  'manage-bot': {
    tier: 2, icon: 'key-plus', accent: 'warning',
    title: raw => BOT_ACTION_TITLES[as(raw, 'manage-bot').action],
    description: raw => {
      const ctx = as(raw, 'manage-bot');
      const bot = ctx.botName ? `**${ctx.botName}**` : 'this bot';
      const actions: Record<typeof ctx.action, string> = {
        create: `Create ${bot} with its own signing key.`,
        connect: `Let ${bot} connect to ${ctx.siteName ? `**${ctx.siteName}**` : 'an app'} with the permissions you selected.`,
        ownership: `Sign an ownership claim for ${bot}.`, revoke: `Revoke your ownership claim for ${bot}.`,
        publish: `Publish your ownership claim for ${bot}.`,
        'reveal-key': `Show the recovery key for ${bot}. Anyone with this key can sign as the bot.`,
      };
      return `${actions[ctx.action]} Confirm with your PIN or biometrics.`;
    },
  },
  'manage-keep': {
    tier: 2, icon: 'key-plus', accent: 'warning',
    title: raw => {
      const action = as(raw, 'manage-keep').action;
      return action === 'link' ? 'Link a persona to this Keep' : action === 'unlink' ? 'Unlink a persona from this Keep' : 'Make this your Keep';
    },
    description: raw => {
      const ctx = as(raw, 'manage-keep');
      if (ctx.action === 'link') {
        return `**${ctx.personaName}** will be able to manage **${ctx.keepName}**, and the Keep will be able to tell it belongs to the same person as the personas already linked. Confirm with your PIN or biometrics.`;
      }
      if (ctx.action === 'unlink') {
        return `**${ctx.personaName}** will no longer be able to manage **${ctx.keepName}**, and its place in the game there will be revoked. Confirm with your PIN or biometrics.`;
      }
      return `**${ctx.keepName}** will belong to **${ctx.personaName}**, who will set up who can use it and which of your other personas can manage it. Confirm with your PIN or biometrics.`;
    },
  },
  'rotate-backup-key': {
    tier: 2, icon: 'shield-warn', accent: 'warning',
    title: () => 'Change private backup key',
    description: () => 'Re-encrypt your private relay backup with a new key. Confirm with your PIN or biometrics.',
  },
  'reveal-recovery-words': {
    tier: 2, icon: 'key-plus', accent: 'warning',
    title: () => 'Reveal your recovery words',
    description: () => 'Show the words that restore your whole Signet, including your personas and dependants. Anyone with these words can recover your identity.',
  },
  'change-biometric': {
    tier: 2, icon: 'shield-warn', accent: 'warning',
    title: raw => as(raw, 'change-biometric').enabled ? 'Enable biometric unlock' : 'Switch to PIN unlock',
    description: raw => as(raw, 'change-biometric').enabled
      ? 'Confirm your current unlock before setting up fingerprint or face unlock.'
      : 'Confirm your current unlock before replacing biometric unlock with your new PIN.',
  },
  'recheck-professional': {
    tier: 1, icon: 'scroll', accent: 'soft',
    title: () => 'Recheck professional registration',
    description: raw => `Check the current registry record for **${as(raw, 'recheck-professional').firmName}**.`,
  },
  'transfer-independence': {
    tier: 2,
    icon: 'key-plus',
    accent: 'warning',
    title: raw => as(raw, 'transfer-independence').phase === 'prepare' ? 'Prepare independent recovery words' : 'Confirm independence handover',
    description: raw => {
      const ctx = as(raw, 'transfer-independence');
      return ctx.phase === 'prepare'
        ? `Create new recovery words for **${ctx.depName}**. These belong to their new independent identity.`
        : `Transfer **${ctx.depName}**'s contacts to their independent identity and stop managing the old family copy. Confirm with your PIN.`;
    },
  },
  'unlock-app': {
    tier: 0,
    icon: 'lock',
    accent: 'neutral',
    title: () => 'Unlock Signet',
    description: () => 'Enter your 6-digit PIN to continue',
  },

  'approve-sign-in': {
    tier: 1,
    icon: 'shield',
    accent: 'soft',
    title: () => 'Approve sign-in',
    description: (raw) => {
      const ctx = as(raw, 'approve-sign-in');
      return `Sign in to **${ctx.siteName}** as **${ctx.identityName}**`;
    },
  },

  'mutate-persona': {
    tier: 1,
    icon: 'key-plus',
    accent: 'soft',
    title: (raw) => {
      const ctx = as(raw, 'mutate-persona');
      return PERSONA_ACTION_TITLES[ctx.action];
    },
    description: (raw) => {
      const ctx = as(raw, 'mutate-persona');
      const subject = ctx.depName ? `**${ctx.depName}**'s` : 'your';
      switch (ctx.action) {
        case 'switch':
          return ctx.personaName
            ? `Switch ${subject} active persona to **${ctx.personaName}**.`
            : `Switch ${subject} active persona.`;
        case 'rename':
          return ctx.personaName
            ? `Rename ${subject} persona to **${ctx.personaName}**.`
            : `Rename ${subject} persona.`;
        case 'create':
          return ctx.personaName
            ? `Add a new persona **${ctx.personaName}** to ${subject} identity.`
            : `Add a new persona to ${subject} identity.`;
        default: {
          const actions: Record<Exclude<typeof ctx.action, 'switch' | 'rename' | 'create'>, string> = {
            import: 'Import a Nostr account into', hide: 'Hide a persona from', show: 'Show a hidden persona in',
            'edit-profile': 'Update a persona profile for', 'set-avatar': 'Set a persona picture for',
            'remove-avatar': 'Remove a persona picture from', 'share-photo': 'Share a contact picture from',
            'stop-sharing-photo': 'Stop sharing a contact picture from', activate: 'Activate the real identity for',
          };
          return `${actions[ctx.action]} ${subject} identity${ctx.personaName ? ` (**${ctx.personaName}**)` : ''}.`;
        }
      }
    },
  },

  'change-autonomy-stage': {
    tier: 1,
    icon: 'shield',
    accent: 'soft',
    title: () => 'Change autonomy stage',
    description: (raw) => {
      const ctx = as(raw, 'change-autonomy-stage');
      return `Set **${ctx.depName}**'s autonomy stage to **${ctx.nextStage}**.`;
    },
  },

  'manage-family-contacts': {
    tier: 1,
    icon: 'people',
    accent: 'soft',
    title: () => 'Manage family contacts',
    description: () =>
      'Review and change contacts across your own directory and every dependant you manage.',
  },

  'reveal-dep-backup': {
    tier: 1,
    icon: 'shield',
    accent: 'soft',
    title: () => 'Reveal backup words',
    description: (raw) => {
      const ctx = as(raw, 'reveal-dep-backup');
      return `Show **${ctx.depName}**'s backup words. Anyone seeing these can recover this identity.`;
    },
  },

  'issue-professional-credential-pending': {
    tier: 1,
    icon: 'scroll',
    accent: 'soft',
    title: () => 'Issue credential',
    description: (raw) => {
      const ctx = as(raw, 'issue-professional-credential-pending');
      return `Issue a **${ctx.credentialType}** credential at **${ctx.firmName}** for **${ctx.recipientShort}**. This is a pending-path credential; the recipient can present it once your firm's roster confirms.`;
    },
  },

  'guardian-approve-dep-action': {
    tier: 2,
    icon: 'shield-warn',
    accent: 'warning',
    title: () => 'Approve as guardian',
    description: (raw) => {
      const ctx = as(raw, 'guardian-approve-dep-action');
      const where = ctx.siteName ? ` at **${ctx.siteName}**` : '';
      return `You're about to **${ctx.actionDescription}**${where} on behalf of **${ctx.depName}**. Confirm with your PIN.`;
    },
  },

  'exit-child-mode': {
    tier: 2,
    icon: 'door',
    accent: 'warning',
    title: () => 'Exit child mode',
    description: (raw) => {
      const ctx = as(raw, 'exit-child-mode');
      return `Leave **${ctx.depName}**'s session and return to your own identity.`;
    },
  },

  'delete-my-signet': {
    tier: 2,
    icon: 'trash',
    accent: 'destructive',
    title: () => 'Delete MySignet',
    description: () =>
      'This deletes all data from this device. There is no undo. Make sure you have a backup.',
  },

  'mutate-persona-child-mode': {
    tier: 2,
    icon: 'key-plus',
    accent: 'warning',
    title: (raw) => {
      const ctx = as(raw, 'mutate-persona-child-mode');
      return ctx.action === 'create' ? 'Add persona for child' : 'Switch child persona';
    },
    description: (raw) => {
      const ctx = as(raw, 'mutate-persona-child-mode');
      const verb = ctx.action === 'create' ? 'Add a new persona for' : 'Switch the active persona for';
      return `${verb} **${ctx.depName}**. PIN required to confirm you're the guardian, not the child.`;
    },
  },

  'issue-professional-credential-confirmed': {
    tier: 2,
    icon: 'scroll',
    accent: 'warning',
    title: () => 'Issue confirmed credential',
    description: (raw) => {
      const ctx = as(raw, 'issue-professional-credential-confirmed');
      return `Issue a confirmed **${ctx.credentialType}** credential at **${ctx.firmName}** for **${ctx.recipientShort}**. The recipient can present this immediately. Confirm with your PIN.`;
    },
  },

  'mutate-professional-roster': {
    tier: 2,
    icon: 'people',
    accent: 'warning',
    title: (raw) => {
      const ctx = as(raw, 'mutate-professional-roster');
      switch (ctx.action) {
        case 'add-staff': return 'Add staff member';
        case 'add-delegate': return 'Add delegate';
        case 'remove-delegate': return 'Remove delegate';
        case 'rotate-key': return 'Rotate lead key';
        case 'revoke-role': return 'Revoke role';
        case 'remove-role': return 'Remove professional role';
      }
    },
    description: (raw) => {
      const ctx = as(raw, 'mutate-professional-roster');
      const verb: Record<RosterAction, string> = {
        'add-staff': 'Add a staff member to the roster at',
        'add-delegate': 'Add a delegate to the roster at',
        'remove-delegate': 'Remove a delegate from the roster at',
        'rotate-key': 'Rotate the lead signing key for',
        'revoke-role': 'Revoke a sub-role at',
        'remove-role': 'Decommission your professional role at',
      };
      return `${verb[ctx.action]} **${ctx.firmName}**. Confirm with your PIN.`;
    },
  },
};

/** Default context — used when a call site doesn't supply one. */
export const DEFAULT_PURPOSE_CONTEXT: PurposeContext = { purpose: 'unlock-app' };

/** Context for a page's re-unlock gate. Unlocking a review page is not approval. */
export const PAGE_AUTH_CONTEXTS: Partial<Record<Page, PurposeContext>> = {
  'venue-entry': { purpose: 'access-feature', feature: 'venue-entry' },
  'photo-capture': { purpose: 'access-feature', feature: 'photo-capture' },
  'approve-auth': { purpose: 'review-request', request: 'sign-in' },
  'approve-verification': { purpose: 'review-request', request: 'verification' },
  'approve-connect': { purpose: 'review-request', request: 'connection' },
  'approve-add-dependant': { purpose: 'review-request', request: 'add-dependant' },
  'approve-app-permission': { purpose: 'review-request', request: 'app-permission' },
  'approve-companion-grant': { purpose: 'review-request', request: 'companion' },
  'vouch-someone': { purpose: 'review-request', request: 'vouch' },
  'add-dependant': { purpose: 'access-feature', feature: 'family' },
  'import-dependant': { purpose: 'access-feature', feature: 'family' },
  roster: { purpose: 'access-feature', feature: 'roster' },
  'manage-carousel': { purpose: 'access-feature', feature: 'carousel' },
  'migrate-heartwood': { purpose: 'access-feature', feature: 'heartwood' },
  'contacts-grant-approve': { purpose: 'review-request', request: 'contact-access' },
  'contacts-grant-code': { purpose: 'access-feature', feature: 'contact-code' },
};

/** Resolve `(ctx) => { tier, icon, accent, titleStr, descStr }` for AuthScreen. */
export function resolvePurpose(ctx: PurposeContext): {
  tier: AuthTier;
  icon: PurposeIcon;
  accent: PurposeAccent;
  title: string;
  description: string;
} {
  const cfg = PURPOSES[ctx.purpose];
  return {
    tier: cfg.tier,
    icon: cfg.icon,
    accent: cfg.accent,
    title: cfg.title(ctx),
    description: cfg.description(ctx),
  };
}
