import { describe, it, expect } from 'vitest';
import { buildAuditEventTemplate, AUDIT_EVENT_KIND } from './audit';

const GUARDIAN = 'a'.repeat(64);
const DEPENDANT = 'b'.repeat(64);
const COUNTERPARTY = 'c'.repeat(64);

describe('buildAuditEventTemplate', () => {
  it('produces a kind-31000 event with an empty content field', () => {
    const template = buildAuditEventTemplate(
      { dependantPubkey: DEPENDANT, eventKind: 1, outcome: 'approved' },
      GUARDIAN,
    );
    expect(template.kind).toBe(AUDIT_EVENT_KIND);
    // OQ1 privacy invariant — content MUST be empty.
    expect(template.content).toBe('');
  });

  it('includes the fundamental OQ1 metadata tags and nothing else by default', () => {
    const template = buildAuditEventTemplate(
      { dependantPubkey: DEPENDANT, eventKind: 21236, outcome: 'approved' },
      GUARDIAN,
    );
    const keys = template.tags.map(t => t[0]);
    // `t`, `d`, `k`, `outcome` for every record; optional `p` + `origin`
    // are gated on presence.
    expect(keys).toEqual(['t', 'd', 'k', 'outcome']);
    expect(template.tags.find(t => t[0] === 't')?.[1]).toBe('audit');
    expect(template.tags.find(t => t[0] === 'k')?.[1]).toBe('21236');
    expect(template.tags.find(t => t[0] === 'outcome')?.[1]).toBe('approved');
  });

  it('appends `p` and `origin` tags when the scope has them', () => {
    const template = buildAuditEventTemplate(
      {
        dependantPubkey: DEPENDANT,
        eventKind: 1059,
        counterpartyPubkey: COUNTERPARTY,
        origin: 'https://roblox.com',
        outcome: 'auto-approved',
      },
      GUARDIAN,
    );
    expect(template.tags.find(t => t[0] === 'p')?.[1]).toBe(COUNTERPARTY);
    expect(template.tags.find(t => t[0] === 'origin')?.[1]).toBe('https://roblox.com');
  });

  it('lowercases counterparty pubkeys', () => {
    const template = buildAuditEventTemplate(
      {
        dependantPubkey: DEPENDANT,
        eventKind: 1,
        counterpartyPubkey: COUNTERPARTY.toUpperCase(),
        outcome: 'approved',
      },
      GUARDIAN,
    );
    expect(template.tags.find(t => t[0] === 'p')?.[1]).toBe(COUNTERPARTY);
  });

  it('uses the guardian pubkey (not the dependant) as the event pubkey', () => {
    // Audit events are published FROM the guardian (who is the signer in the
    // phone-as-family-bunker case), TO the guardian's own pubkey. The
    // dependant's key never appears as the event pubkey.
    const template = buildAuditEventTemplate(
      { dependantPubkey: DEPENDANT, eventKind: 1, outcome: 'approved' },
      GUARDIAN,
    );
    expect(template.pubkey).toBe(GUARDIAN);
  });

  it('rejects a non-hex guardianPubkey', () => {
    expect(() => buildAuditEventTemplate(
      { dependantPubkey: DEPENDANT, eventKind: 1, outcome: 'approved' },
      'not-hex',
    )).toThrow(/guardian/i);
  });

  it('rejects a non-hex dependantPubkey', () => {
    expect(() => buildAuditEventTemplate(
      { dependantPubkey: 'short', eventKind: 1, outcome: 'approved' },
      GUARDIAN,
    )).toThrow(/dependant/i);
  });

  it('rejects a non-hex counterpartyPubkey when supplied', () => {
    expect(() => buildAuditEventTemplate(
      {
        dependantPubkey: DEPENDANT,
        eventKind: 1,
        counterpartyPubkey: 'not-hex',
        outcome: 'approved',
      },
      GUARDIAN,
    )).toThrow(/counterparty/i);
  });

  it('rejects a non-integer eventKind', () => {
    expect(() => buildAuditEventTemplate(
      { dependantPubkey: DEPENDANT, eventKind: 1.5, outcome: 'approved' },
      GUARDIAN,
    )).toThrow(/kind/i);
    expect(() => buildAuditEventTemplate(
      { dependantPubkey: DEPENDANT, eventKind: -1, outcome: 'approved' },
      GUARDIAN,
    )).toThrow(/kind/i);
  });

  it('rejects a signing outcome without eventKind', () => {
    // Signing outcomes must have a kind — anything else is a caller bug.
    expect(() => buildAuditEventTemplate(
      { dependantPubkey: DEPENDANT, outcome: 'approved' },
      GUARDIAN,
    )).toThrow(/kind/i);
  });

  it('accepts ceremony-complete outcome without an eventKind and omits the k tag', () => {
    const template = buildAuditEventTemplate(
      { dependantPubkey: DEPENDANT, outcome: 'ceremony-complete' },
      GUARDIAN,
    );
    const keys = template.tags.map(t => t[0]);
    expect(keys).toEqual(['t', 'd', 'outcome']);
    expect(template.tags.find(t => t[0] === 'outcome')?.[1]).toBe('ceremony-complete');
  });

  it('never includes any tag that looks like content (body, payload, text)', () => {
    const template = buildAuditEventTemplate(
      {
        dependantPubkey: DEPENDANT,
        eventKind: 1059,
        counterpartyPubkey: COUNTERPARTY,
        origin: 'https://example.com',
        outcome: 'denied',
      },
      GUARDIAN,
    );
    const allowlist = new Set(['t', 'd', 'k', 'outcome', 'p', 'origin']);
    for (const [key] of template.tags) {
      expect(allowlist.has(key)).toBe(true);
    }
  });

  describe('clause-blocked outcome (Charter clause #1)', () => {
    it('emits clause + reason + schedule-source + next-allowed tags', () => {
      const template = buildAuditEventTemplate(
        {
          dependantPubkey: DEPENDANT,
          eventKind: 1,
          origin: 'https://roblox.com',
          outcome: 'clause-blocked',
          clauseType: 'schedule',
          clauseReason: 'outside-allowed-hours',
          scheduleSource: 'dep-default',
          scheduleIssuedAt: 1715000000,
          nextAllowedAt: 1715245200,
        },
        GUARDIAN,
      );
      expect(template.tags.find(t => t[0] === 'outcome')?.[1]).toBe('clause-blocked');
      expect(template.tags.find(t => t[0] === 'clause')?.[1]).toBe('schedule');
      expect(template.tags.find(t => t[0] === 'reason')?.[1]).toBe('outside-allowed-hours');
      expect(template.tags.find(t => t[0] === 'schedule-source')?.[1]).toBe('dep-default');
      expect(template.tags.find(t => t[0] === 'schedule-issued')?.[1]).toBe('1715000000');
      expect(template.tags.find(t => t[0] === 'next-allowed')?.[1]).toBe('1715245200');
    });

    it('emits paused reason for paused-clause refusals', () => {
      const template = buildAuditEventTemplate(
        {
          dependantPubkey: DEPENDANT,
          eventKind: 1,
          origin: 'https://roblox.com',
          outcome: 'clause-blocked',
          clauseType: 'schedule',
          clauseReason: 'paused',
          scheduleSource: 'dep-default',
          scheduleIssuedAt: 1715000000,
        },
        GUARDIAN,
      );
      expect(template.tags.find(t => t[0] === 'reason')?.[1]).toBe('paused');
    });

    it('rejects clause-blocked without a clauseType', () => {
      expect(() => buildAuditEventTemplate(
        {
          dependantPubkey: DEPENDANT,
          eventKind: 1,
          origin: 'https://roblox.com',
          outcome: 'clause-blocked',
          clauseReason: 'outside-allowed-hours',
        },
        GUARDIAN,
      )).toThrow(/clauseType/i);
    });

    it('rejects clause-blocked without a clauseReason', () => {
      expect(() => buildAuditEventTemplate(
        {
          dependantPubkey: DEPENDANT,
          eventKind: 1,
          origin: 'https://roblox.com',
          outcome: 'clause-blocked',
          clauseType: 'schedule',
        },
        GUARDIAN,
      )).toThrow(/clauseReason/i);
    });

    it('omits next-allowed tag when not provided', () => {
      const template = buildAuditEventTemplate(
        {
          dependantPubkey: DEPENDANT,
          eventKind: 1,
          origin: 'https://roblox.com',
          outcome: 'clause-blocked',
          clauseType: 'schedule',
          clauseReason: 'outside-allowed-hours',
          scheduleSource: 'per-origin',
          scheduleIssuedAt: 1715000000,
        },
        GUARDIAN,
      );
      expect(template.tags.find(t => t[0] === 'next-allowed')).toBeUndefined();
    });

    it('clause-blocked content stays empty (privacy contract preserved)', () => {
      const template = buildAuditEventTemplate(
        {
          dependantPubkey: DEPENDANT,
          eventKind: 1,
          origin: 'https://roblox.com',
          outcome: 'clause-blocked',
          clauseType: 'schedule',
          clauseReason: 'outside-allowed-hours',
          scheduleSource: 'intersection',
          scheduleIssuedAt: 1715000000,
        },
        GUARDIAN,
      );
      expect(template.content).toBe('');
    });
  });
});
