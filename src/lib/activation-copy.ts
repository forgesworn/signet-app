import type { ActivationTarget } from '../types/routing';

/**
 * One paragraph of the explanation card. A plain string renders as-is; the
 * object form renders `emphasis` inside `<strong>` where it occurs in `text`.
 *
 * The emphasis exists because the load-bearing word in the owner copy is
 * "not" — "It is **not** used for ordinary sign-ins" — and a reader skimming
 * three near-identical paragraphs can otherwise read it as its own opposite.
 */
export type ActivationExplanationLine = string | { text: string; emphasis: string };

export interface ActivationCopy {
  explanationTitle: string;
  explanationBody: ActivationExplanationLine[];
  nameLabel: string;
  namePlaceholder: string;
  confirmHeading: string;
  confirmBody: string;
  confirmHelper: string;
  confirmLabel: string;
}

/**
 * Per-target copy for the real-identity activation ceremony (spec §7.1, §7.6,
 * §12). Pure so the wording is pinned by a test rather than by a screenshot.
 *
 * The dependant branch says out loud what the ceremony does NOT do: it derives
 * no key and does not change which slot the child signs as. Both were already
 * true for the owner, but for a guardian acting on a child's behalf the
 * reassurance is the point.
 */
export function resolveActivationCopy(target: ActivationTarget): ActivationCopy {
  if (target.kind === 'owner') {
    return {
      explanationTitle: 'What your real identity is',
      explanationBody: [
        'It carries your legal name. It is what a professional verifies, what your family is built on, and what a venue reads at the door.',
        {
          text: 'It is not used for ordinary sign-ins. A site only ever sees it if you pick it yourself and confirm.',
          emphasis: 'not',
        },
        'It is a separate key from your personas. Sites you have signed into with a persona cannot link the two.',
      ],
      nameLabel: 'Your legal name',
      namePlaceholder: 'Your legal name',
      confirmHeading: 'Type your name to confirm',
      confirmBody: 'This is the one identity that carries your legal name. Take a second to type it.',
      confirmHelper: 'From now on this name is what verifiers, venues and your family see.',
      confirmLabel: 'Activate my real identity',
    };
  }
  const who = target.dependantName;
  return {
    explanationTitle: `${who}'s real identity`,
    explanationBody: [
      `${who} signs as their persona. Their real identity carries their legal name — it is what a professional verifies and what a venue reads at the door.`,
      {
        text: 'It is not used for ordinary sign-ins. A site only sees it if it is picked and confirmed.',
        emphasis: 'not',
      },
      `Their keys do not change and neither does the identity they sign as by default. This only gives the real-name slot a name.`,
    ],
    nameLabel: `${who}'s legal name`,
    namePlaceholder: 'Their legal name',
    confirmHeading: 'Type their name to confirm',
    confirmBody: `This is the one identity that carries ${who}'s legal name. Take a second to type it.`,
    confirmHelper: 'From now on this name is what verifiers and venues see for them.',
    confirmLabel: 'Activate their real identity',
  };
}

/** Flatten a line to plain text — for tests, and any surface that cannot render markup. */
export function activationLineText(line: ActivationExplanationLine): string {
  return typeof line === 'string' ? line : line.text;
}
