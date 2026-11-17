import { describe, it, expect } from 'vitest';
import { AUTONOMY_STAGE_INFO } from './autonomy-labels';
import { CHILD_PERMISSIONS_COPY, CHILD_ASK_COPY } from './child-device-copy';

describe('autonomy level names', () => {
  it('names each level by what the child can do', () => {
    expect(Object.fromEntries(Object.entries(AUTONOMY_STAGE_INFO).map(([k, v]) => [k, v.label]))).toEqual({
      'full-control': 'Asks every time',
      'request-approve': 'Asks until you say Always',
      'autonomous-alerts': 'Free, you’re alerted',
      'autonomous-logging': 'Free, logged',
      'full-autonomy': 'Fully independent',
    });
  });

  it('gives each level its description', () => {
    expect(Object.fromEntries(Object.entries(AUTONOMY_STAGE_INFO).map(([k, v]) => [k, v.description]))).toEqual({
      'full-control': 'Every request from them comes to you',
      'request-approve': 'They ask you; you can say Always for a site or app you trust',
      'autonomous-alerts': 'They sign freely and you get an alert',
      'autonomous-logging': 'They sign freely; it’s logged for you',
      'full-autonomy': 'No limits',
    });
  });

  it('the child-device stage names equal the guardian labels, so the two lists cannot drift', () => {
    for (const [stage, info] of Object.entries(AUTONOMY_STAGE_INFO)) {
      expect(CHILD_PERMISSIONS_COPY.stageName[stage]).toBe(info.label);
    }
    expect(Object.keys(CHILD_PERMISSIONS_COPY.stageName).sort()).toEqual(Object.keys(AUTONOMY_STAGE_INFO).sort());
  });

  it('the "Always is missing" line uses the new names', () => {
    expect(CHILD_ASK_COPY.alwaysHiddenAsksEveryTime('Lily')).toBe(
      'Lily is on “Asks every time”. To offer “Always allow”, choose “Asks until you say Always” in Lily’s Autonomy Level.',
    );
  });
});
