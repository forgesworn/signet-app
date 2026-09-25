import { describe, it, expect } from 'vitest';
import {
  parseDependantStatusPayload,
  extractEndpointPubkey,
} from './dependant-status-sync';

describe('parseDependantStatusPayload', () => {
  it('accepts a minimal valid payload', () => {
    const raw = JSON.stringify({ v: 1, stage: 'request-approve', updatedAt: 12345 });
    const p = parseDependantStatusPayload(raw);
    expect(p).toEqual({ v: 1, stage: 'request-approve', updatedAt: 12345 });
  });

  it('accepts a payload with an optional guardianName', () => {
    const raw = JSON.stringify({ v: 1, stage: 'full-control', updatedAt: 1, guardianName: 'Mum' });
    expect(parseDependantStatusPayload(raw)?.guardianName).toBe('Mum');
  });

  it('strips control / bidi characters from guardianName', () => {
    const raw = JSON.stringify({ v: 1, stage: 'full-control', updatedAt: 1, guardianName: 'Mu\u0000m\u202eevil' });
    expect(parseDependantStatusPayload(raw)?.guardianName).toBe('Mumevil');
  });

  it('caps guardianName at 64 chars', () => {
    const raw = JSON.stringify({ v: 1, stage: 'full-control', updatedAt: 1, guardianName: 'x'.repeat(200) });
    expect(parseDependantStatusPayload(raw)?.guardianName?.length).toBe(64);
  });

  it('rejects a payload with a non-matching schema version', () => {
    const raw = JSON.stringify({ v: 2, stage: 'full-control', updatedAt: 1 });
    expect(parseDependantStatusPayload(raw)).toBeNull();
  });

  it('rejects unknown stage tokens (forward-compat dormant default)', () => {
    const raw = JSON.stringify({ v: 1, stage: 'unknown-future-stage', updatedAt: 1 });
    expect(parseDependantStatusPayload(raw)).toBeNull();
  });

  it('rejects a non-positive updatedAt', () => {
    expect(parseDependantStatusPayload(JSON.stringify({ v: 1, stage: 'full-control', updatedAt: 0 }))).toBeNull();
    expect(parseDependantStatusPayload(JSON.stringify({ v: 1, stage: 'full-control', updatedAt: -1 }))).toBeNull();
  });

  it('rejects malformed JSON', () => {
    expect(parseDependantStatusPayload('not json')).toBeNull();
  });

  it('rejects non-object top-level values', () => {
    expect(parseDependantStatusPayload('"string"')).toBeNull();
    expect(parseDependantStatusPayload('42')).toBeNull();
    expect(parseDependantStatusPayload('null')).toBeNull();
  });

  it('accepts every known stage', () => {
    const stages = ['full-control', 'request-approve', 'autonomous-alerts', 'autonomous-logging', 'full-autonomy'];
    for (const stage of stages) {
      const raw = JSON.stringify({ v: 1, stage, updatedAt: 1 });
      expect(parseDependantStatusPayload(raw)?.stage).toBe(stage);
    }
  });

  it('drops an empty guardianName after stripping', () => {
    const raw = JSON.stringify({ v: 1, stage: 'full-control', updatedAt: 1, guardianName: '\u0000\u202e' });
    expect(parseDependantStatusPayload(raw)?.guardianName).toBeUndefined();
  });
});

describe('extractEndpointPubkey', () => {
  const PK = 'a'.repeat(64);

  it('extracts the authority component of a bunker:// URI', () => {
    expect(extractEndpointPubkey(`bunker://${PK}?relay=wss://x&secret=12345678`)).toBe(PK);
  });

  it('lowercases uppercase hex', () => {
    expect(extractEndpointPubkey(`bunker://${PK.toUpperCase()}?relay=wss://x&secret=12345678`)).toBe(PK);
  });

  it('accepts BUNKER:// case-insensitively', () => {
    expect(extractEndpointPubkey(`BUNKER://${PK}?relay=wss://x`)).toBe(PK);
  });

  it('returns null for non-bunker schemes', () => {
    expect(extractEndpointPubkey(`https://${PK}?relay=x`)).toBeNull();
    expect(extractEndpointPubkey('nostrconnect://' + PK + '?relay=x')).toBeNull();
  });

  it('returns null when the authority is not 64-char hex', () => {
    expect(extractEndpointPubkey('bunker://not-hex?relay=x')).toBeNull();
    expect(extractEndpointPubkey(`bunker://${PK.slice(0, 32)}?relay=x`)).toBeNull();
  });

  it('returns null when there is no query separator', () => {
    expect(extractEndpointPubkey(`bunker://${PK}`)).toBeNull();
  });

  it('returns null for a non-string input', () => {
    expect(extractEndpointPubkey(null as unknown as string)).toBeNull();
  });
});
