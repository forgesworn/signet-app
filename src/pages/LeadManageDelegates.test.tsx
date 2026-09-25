import { shortNpub } from '../lib/signet';
// @vitest-environment jsdom
/**
 * LeadManageDelegates — component tests for delegate manager state machine.
 * Phase 5, Task 9.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LeadManageDelegates } from './LeadManageDelegates';
import type { AnchorContext, RosterMember } from '../lib/professional/role-anchor';
import type { SigningBackend } from '../lib/signing-backend';

const DELEGATE_D = 'd'.repeat(64);

function makeAnchorCtx(): AnchorContext {
  return {
    registry: 'GIAS',
    identifier: '100000',
    professionKind: 'school',
    entityName: 'Springfield School',
    canonicalDomain: 'springfield-school.example',
    jurisdiction: 'england',
    leadPubkey: 'a'.repeat(64),
  };
}

function makeBackend(): SigningBackend {
  return {
    activePublicKeyHex: 'a'.repeat(64),
    signEvent: vi.fn().mockResolvedValue({
      id: 'test-id',
      sig: 'a'.repeat(128),
      kind: 30202,
      created_at: 1000,
      tags: [],
      content: '',
      pubkey: 'a'.repeat(64),
    }),
    nip44Encrypt: vi.fn(),
  } as unknown as SigningBackend;
}

const BASE_MEMBERS: RosterMember[] = [{ pubkey: 'm'.repeat(64), role: 'form-tutor' }];

describe('LeadManageDelegates', () => {
  it('renders existing delegates in a list', () => {
    render(
      <LeadManageDelegates
        currentDelegates={[DELEGATE_D]}
        currentMembers={BASE_MEMBERS}
        anchorCtx={makeAnchorCtx()}
        proBackend={makeBackend()}
        onComplete={vi.fn()}
        onBack={vi.fn()}
        requestAuth={vi.fn().mockResolvedValue(null)}
        requestFreshAuth={vi.fn().mockResolvedValue(null)}
      />
    );
    // The address uses npub in the normal workflow
    expect(screen.getByText(shortNpub(DELEGATE_D))).toBeDefined();
  });

  it('shows an empty state when no delegates exist', () => {
    render(
      <LeadManageDelegates
        currentDelegates={[]}
        currentMembers={BASE_MEMBERS}
        anchorCtx={makeAnchorCtx()}
        proBackend={makeBackend()}
        onComplete={vi.fn()}
        onBack={vi.fn()}
        requestAuth={vi.fn().mockResolvedValue(null)}
        requestFreshAuth={vi.fn().mockResolvedValue(null)}
      />
    );
    expect(screen.getByText(/No delegates yet/)).toBeDefined();
  });

  it('shows the npub input for adding a new delegate', () => {
    render(
      <LeadManageDelegates
        currentDelegates={[]}
        currentMembers={BASE_MEMBERS}
        anchorCtx={makeAnchorCtx()}
        proBackend={makeBackend()}
        onComplete={vi.fn()}
        onBack={vi.fn()}
        requestAuth={vi.fn().mockResolvedValue(null)}
        requestFreshAuth={vi.fn().mockResolvedValue(null)}
      />
    );
    expect(screen.getByPlaceholderText(/npub/)).toBeDefined();
  });
});
