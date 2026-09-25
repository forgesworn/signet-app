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

export type AuthTier = 0 | 1 | 2;

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
  | 'manage-family-contacts';

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
      action: 'switch' | 'rename' | 'create';
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
  | { purpose: 'manage-family-contacts' };

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
      switch (ctx.action) {
        case 'switch': return 'Switch persona';
        case 'rename': return 'Rename persona';
        case 'create': return 'Add persona';
      }
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
