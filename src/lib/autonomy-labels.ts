import type { AutonomyStage } from '../types';

/**
 * The five autonomy levels, named by what the CHILD can do. The guardian
 * keeps full control at every level, so no label may read as the child's
 * control. One list: the child's own permissions page reads these too.
 * Stored stage ids never change.
 */
export const AUTONOMY_STAGE_INFO: Record<AutonomyStage, { label: string; description: string }> = {
  'full-control': { label: 'Asks every time', description: 'Every request from them comes to you' },
  'request-approve': { label: 'Asks until you say Always', description: 'They ask you; you can say Always for a site or app you trust' },
  'autonomous-alerts': { label: 'Free, you’re alerted', description: 'They sign freely and you get an alert' },
  'autonomous-logging': { label: 'Free, logged', description: 'They sign freely; it’s logged for you' },
  'full-autonomy': { label: 'Fully independent', description: 'No limits' },
};

/** Shown under the level choices: the parent can always step back in. */
export const AUTONOMY_PICKER_NOTE = 'You can change this, take back an “Always” or unpair at any level.';
