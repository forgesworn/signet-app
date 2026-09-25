import type { AutonomyStage } from '../types';

export const AUTONOMY_STAGE_INFO: Record<AutonomyStage, { label: string; description: string }> = {
  'full-control': { label: 'Full control', description: 'You sign everything for them' },
  'request-approve': { label: 'Request / approve', description: 'They request, you approve each time' },
  'autonomous-alerts': { label: 'Autonomous with alerts', description: 'They sign freely, you get notified' },
  'autonomous-logging': { label: 'Autonomous with logging', description: 'They sign freely, audit log only' },
  'full-autonomy': { label: 'Full autonomy', description: 'No restrictions' },
};
