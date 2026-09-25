import { describe, it, expect } from 'vitest';
import { resolveDependantIdFromRow, resolveDependantIdFromRowAlways, resolveSettingsViewer } from './carousel-routing';
import type { CarouselRow, DependantIdentity } from '../types';
import { shouldShowPairingStatus } from './carousel-routing';

const dep = { id: 'dep-1' } as DependantIdentity;

describe('resolveDependantIdFromRow', () => {
  it('returns the dep id for a dependant row in owner-mode', () => {
    const row: CarouselRow = { type: 'dependant', dependant: dep };
    expect(resolveDependantIdFromRow(row, false)).toBe('dep-1');
  });

  it('returns the dep id for a dependant-persona row in owner-mode', () => {
    const row: CarouselRow = { type: 'dependant-persona', dependant: dep };
    expect(resolveDependantIdFromRow(row, false)).toBe('dep-1');
  });

  it('returns the dep id for a dependant-extra-persona row in owner-mode', () => {
    const row: CarouselRow = { type: 'dependant-extra-persona', dependant: dep, personaIndex: 0 };
    expect(resolveDependantIdFromRow(row, false)).toBe('dep-1');
  });

  it('returns null in child-mode (activeDependantId already set elsewhere)', () => {
    const row: CarouselRow = { type: 'dependant', dependant: dep };
    expect(resolveDependantIdFromRow(row, true)).toBeNull();
  });

  it('returns null for the owner natural-person row', () => {
    const row: CarouselRow = { type: 'natural-person', identity: {} as any };
    expect(resolveDependantIdFromRow(row, false)).toBeNull();
  });

  it('returns null for the owner persona row', () => {
    const row: CarouselRow = { type: 'persona', identity: {} as any };
    expect(resolveDependantIdFromRow(row, false)).toBeNull();
  });

  it('returns null for an undefined row', () => {
    expect(resolveDependantIdFromRow(undefined, false)).toBeNull();
  });

  it('returns null for the owner extra-persona row', () => {
    const row: CarouselRow = { type: 'extra-persona', identity: {} as any, personaIndex: 1 };
    expect(resolveDependantIdFromRow(row, false)).toBeNull();
  });

  it('returns null for the add row', () => {
    const row: CarouselRow = { type: 'add' };
    expect(resolveDependantIdFromRow(row, false)).toBeNull();
  });
});

describe('resolveDependantIdFromRowAlways', () => {
  it('returns the dep id for a dependant row regardless of childMode', () => {
    const row: CarouselRow = { type: 'dependant', dependant: dep };
    // Both modes return the dep id — that's the whole point.
    expect(resolveDependantIdFromRowAlways(row)).toBe('dep-1');
  });

  it('returns the dep id for a dependant-persona row regardless of childMode', () => {
    const row: CarouselRow = { type: 'dependant-persona', dependant: dep };
    expect(resolveDependantIdFromRowAlways(row)).toBe('dep-1');
  });

  it('returns the dep id for a dependant-extra-persona row regardless of childMode', () => {
    const row: CarouselRow = { type: 'dependant-extra-persona', dependant: dep, personaIndex: 0 };
    expect(resolveDependantIdFromRowAlways(row)).toBe('dep-1');
  });

  it('returns null for the owner natural-person row', () => {
    const row: CarouselRow = { type: 'natural-person', identity: {} as any };
    expect(resolveDependantIdFromRowAlways(row)).toBeNull();
  });

  it('returns null for the owner persona row', () => {
    const row: CarouselRow = { type: 'persona', identity: {} as any };
    expect(resolveDependantIdFromRowAlways(row)).toBeNull();
  });

  it('returns null for the owner extra-persona row', () => {
    const row: CarouselRow = { type: 'extra-persona', identity: {} as any, personaIndex: 1 };
    expect(resolveDependantIdFromRowAlways(row)).toBeNull();
  });

  it('returns null for the add row', () => {
    const row: CarouselRow = { type: 'add' };
    expect(resolveDependantIdFromRowAlways(row)).toBeNull();
  });

  it('returns null for an undefined row', () => {
    expect(resolveDependantIdFromRowAlways(undefined)).toBeNull();
  });
});

describe('resolveSettingsViewer', () => {
  it("returns 'child' on a paired-child install regardless of childMode", () => {
    expect(resolveSettingsViewer('paired-child', false)).toBe('child');
    expect(resolveSettingsViewer('paired-child', true)).toBe('child');
  });

  it("returns 'child' when childMode is true on a non-paired-child install", () => {
    expect(resolveSettingsViewer('local', true)).toBe('child');
    expect(resolveSettingsViewer('bunker', true)).toBe('child');
    expect(resolveSettingsViewer('nip07', true)).toBe('child');
  });

  it("returns 'guardian' in owner-mode on a non-paired-child install", () => {
    expect(resolveSettingsViewer('local', false)).toBe('guardian');
    expect(resolveSettingsViewer('bunker', false)).toBe('guardian');
    expect(resolveSettingsViewer('nip07', false)).toBe('guardian');
  });

  it("treats undefined signingMode as guardian-on-local-device", () => {
    expect(resolveSettingsViewer(undefined, false)).toBe('guardian');
    expect(resolveSettingsViewer(undefined, true)).toBe('child');
  });
});

describe('shouldShowPairingStatus', () => {
  it('is true for owner-mode-on-dep-row on a non-paired-child install', () => {
    expect(shouldShowPairingStatus('dependant', false, 'local')).toBe(true);
    expect(shouldShowPairingStatus('dependant', false, 'bunker')).toBe(true);
    expect(shouldShowPairingStatus('dependant', false, 'nip07')).toBe(true);
    expect(shouldShowPairingStatus('dependant', false, undefined)).toBe(true);
  });

  it('is false in child-mode (acted-as on guardian phone)', () => {
    expect(shouldShowPairingStatus('dependant', true, 'local')).toBe(false);
  });

  it('is false on a paired-child install regardless of childMode', () => {
    expect(shouldShowPairingStatus('dependant', false, 'paired-child')).toBe(false);
    expect(shouldShowPairingStatus('dependant', true, 'paired-child')).toBe(false);
  });

  it('is false on non-dependant row types', () => {
    expect(shouldShowPairingStatus('natural-person', false, 'local')).toBe(false);
    expect(shouldShowPairingStatus('persona', false, 'local')).toBe(false);
    expect(shouldShowPairingStatus('extra-persona', false, 'local')).toBe(false);
    expect(shouldShowPairingStatus('dependant-persona', false, 'local')).toBe(false);
    expect(shouldShowPairingStatus('dependant-extra-persona', false, 'local')).toBe(false);
    expect(shouldShowPairingStatus('add', false, 'local')).toBe(false);
  });
});
