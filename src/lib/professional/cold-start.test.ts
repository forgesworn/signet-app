// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  buildSelfCertCredentialEvent,
  computeLapseStatus,
  SELF_CERT_LAPSE_DAYS,
  SUB_ROLE_TOKENS,
} from './cold-start';
import type { SelfCertParams } from './cold-start';

const NOW_UNIX = 1_750_000_000; // 2025-ish fixed timestamp

describe('buildSelfCertCredentialEvent', () => {
  const params: SelfCertParams = {
    recipientPubkey: 'b'.repeat(64),
    credentialType: 'parent-of-pupil-8B',
    claimedFirm: '100000',
    claimedFirmKind: 'URN',
    claimedRole: 'form-tutor',
    pendingIssuedAt: NOW_UNIX,
  };

  it('includes self-cert: true tag', () => {
    const template = buildSelfCertCredentialEvent(params);
    const scTag = template.tags.find(t => t[0] === 'self-cert');
    expect(scTag?.[1]).toBe('true');
  });

  it('includes claimed-firm tag with correct value', () => {
    const template = buildSelfCertCredentialEvent(params);
    const tag = template.tags.find(t => t[0] === 'claimed-firm');
    expect(tag?.[1]).toBe('100000');
  });

  it('includes claimed-firm-kind tag', () => {
    const template = buildSelfCertCredentialEvent(params);
    const tag = template.tags.find(t => t[0] === 'claimed-firm-kind');
    expect(tag?.[1]).toBe('URN');
  });

  it('includes claimed-role tag', () => {
    const template = buildSelfCertCredentialEvent(params);
    const tag = template.tags.find(t => t[0] === 'claimed-role');
    expect(tag?.[1]).toBe('form-tutor');
  });

  it('includes pending-issued-at tag matching pendingIssuedAt param', () => {
    const template = buildSelfCertCredentialEvent(params);
    const tag = template.tags.find(t => t[0] === 'pending-issued-at');
    expect(tag?.[1]).toBe(String(NOW_UNIX));
  });

  it('sets kind to PRO_CREDENTIAL (29999)', () => {
    const template = buildSelfCertCredentialEvent(params);
    expect(template.kind).toBe(29999);
  });
});

describe('computeLapseStatus', () => {
  it('returns pending when < 30 days have elapsed', () => {
    const pendingIssuedAt = NOW_UNIX;
    const nowMs = (NOW_UNIX + 86400 * 10) * 1000; // 10 days later
    expect(computeLapseStatus(pendingIssuedAt, nowMs)).toBe('pending');
  });

  it('returns expired-pending exactly at 30 days', () => {
    const pendingIssuedAt = NOW_UNIX;
    const nowMs = (NOW_UNIX + 86400 * SELF_CERT_LAPSE_DAYS) * 1000;
    expect(computeLapseStatus(pendingIssuedAt, nowMs)).toBe('expired-pending');
  });

  it('returns expired-pending when > 30 days have elapsed', () => {
    const pendingIssuedAt = NOW_UNIX;
    const nowMs = (NOW_UNIX + 86400 * 31) * 1000;
    expect(computeLapseStatus(pendingIssuedAt, nowMs)).toBe('expired-pending');
  });

  it('returns expired-pending for 1 second over the boundary', () => {
    const pendingIssuedAt = NOW_UNIX;
    const nowMs = (NOW_UNIX + 86400 * SELF_CERT_LAPSE_DAYS + 1) * 1000;
    expect(computeLapseStatus(pendingIssuedAt, nowMs)).toBe('expired-pending');
  });
});

describe('SUB_ROLE_TOKENS — lead roles must not be present', () => {
  it('does not include head-teacher', () => {
    expect(SUB_ROLE_TOKENS).not.toContain('head-teacher');
  });
  it('does not include lead-gp', () => {
    expect(SUB_ROLE_TOKENS).not.toContain('lead-gp');
  });
  it('does not include senior-partner', () => {
    expect(SUB_ROLE_TOKENS).not.toContain('senior-partner');
  });
  it('includes form-tutor', () => {
    expect(SUB_ROLE_TOKENS).toContain('form-tutor');
  });
  it('includes practice-gp', () => {
    expect(SUB_ROLE_TOKENS).toContain('practice-gp');
  });
  it('includes associate', () => {
    expect(SUB_ROLE_TOKENS).toContain('associate');
  });
});
