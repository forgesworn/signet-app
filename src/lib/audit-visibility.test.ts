import { describe, it, expect } from 'vitest';
import {
  defaultVisibilityByStage,
  resolveAuditVisibility,
} from './audit-visibility';

/**
 * Exhaustive matrix for the audit-visibility rule (v2).
 *
 * 5 autonomy stages × 4 override states (`undefined`, `'default'`,
 * `'force-visible'`, `'force-hidden'`) = 20 explicit cases. We keep
 * each case spelled out rather than driving a programmatic loop —
 * this is policy code and a regression here would silently flip the
 * audit surface on or off for an entire user category. Per-case
 * assertions catch a one-line edit that would skate past a matrix
 * loop's "all 20 still pass somehow" coverage signal.
 */

describe('defaultVisibilityByStage', () => {
  it('hides at full-control', () => {
    expect(defaultVisibilityByStage('full-control')).toBe(false);
  });

  it('hides at request-approve', () => {
    expect(defaultVisibilityByStage('request-approve')).toBe(false);
  });

  it('shows at autonomous-alerts', () => {
    expect(defaultVisibilityByStage('autonomous-alerts')).toBe(true);
  });

  it('shows at autonomous-logging', () => {
    expect(defaultVisibilityByStage('autonomous-logging')).toBe(true);
  });

  it('shows at full-autonomy', () => {
    expect(defaultVisibilityByStage('full-autonomy')).toBe(true);
  });
});

describe('resolveAuditVisibility — full-control', () => {
  it('hides when override is undefined (stage default)', () => {
    expect(resolveAuditVisibility('full-control', undefined)).toBe(false);
  });

  it('hides when override is "default" (stage default)', () => {
    expect(resolveAuditVisibility('full-control', 'default')).toBe(false);
  });

  it('shows when override forces visible', () => {
    expect(resolveAuditVisibility('full-control', 'force-visible')).toBe(true);
  });

  it('hides when override forces hidden', () => {
    expect(resolveAuditVisibility('full-control', 'force-hidden')).toBe(false);
  });
});

describe('resolveAuditVisibility — request-approve', () => {
  it('hides when override is undefined (stage default)', () => {
    expect(resolveAuditVisibility('request-approve', undefined)).toBe(false);
  });

  it('hides when override is "default" (stage default)', () => {
    expect(resolveAuditVisibility('request-approve', 'default')).toBe(false);
  });

  it('shows when override forces visible (mature teen unlock)', () => {
    expect(resolveAuditVisibility('request-approve', 'force-visible')).toBe(true);
  });

  it('hides when override forces hidden', () => {
    expect(resolveAuditVisibility('request-approve', 'force-hidden')).toBe(false);
  });
});

describe('resolveAuditVisibility — autonomous-alerts', () => {
  it('shows when override is undefined (stage default)', () => {
    expect(resolveAuditVisibility('autonomous-alerts', undefined)).toBe(true);
  });

  it('shows when override is "default" (stage default)', () => {
    expect(resolveAuditVisibility('autonomous-alerts', 'default')).toBe(true);
  });

  it('shows when override forces visible (redundant but not contradictory)', () => {
    expect(resolveAuditVisibility('autonomous-alerts', 'force-visible')).toBe(true);
  });

  it('hides when override forces hidden (special-needs lockout)', () => {
    expect(resolveAuditVisibility('autonomous-alerts', 'force-hidden')).toBe(false);
  });
});

describe('resolveAuditVisibility — autonomous-logging', () => {
  it('shows when override is undefined (stage default)', () => {
    expect(resolveAuditVisibility('autonomous-logging', undefined)).toBe(true);
  });

  it('shows when override is "default" (stage default)', () => {
    expect(resolveAuditVisibility('autonomous-logging', 'default')).toBe(true);
  });

  it('shows when override forces visible', () => {
    expect(resolveAuditVisibility('autonomous-logging', 'force-visible')).toBe(true);
  });

  it('hides when override forces hidden', () => {
    expect(resolveAuditVisibility('autonomous-logging', 'force-hidden')).toBe(false);
  });
});

describe('resolveAuditVisibility — full-autonomy', () => {
  it('shows when override is undefined (stage default)', () => {
    expect(resolveAuditVisibility('full-autonomy', undefined)).toBe(true);
  });

  it('shows when override is "default" (stage default)', () => {
    expect(resolveAuditVisibility('full-autonomy', 'default')).toBe(true);
  });

  it('shows when override forces visible (redundant but not contradictory)', () => {
    expect(resolveAuditVisibility('full-autonomy', 'force-visible')).toBe(true);
  });

  it('hides when override forces hidden (special-needs adult dep)', () => {
    expect(resolveAuditVisibility('full-autonomy', 'force-hidden')).toBe(false);
  });
});
