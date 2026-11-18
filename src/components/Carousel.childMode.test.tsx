// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Carousel } from './Carousel';
import { CarouselArrowProvider } from './CarouselArrowContext';
import { resolveActiveIdentity } from '../lib/carousel-utils';
import type { CarouselColumn, CarouselRow } from '../types';

/**
 * Child mode: the guardian's phone is in the dependant's hands. The carousel
 * offers the child's own cards their allowed controls and a row that is not the
 * child's no action at all (the guardian's ring can show for a moment around a lock).
 */
const dependant = {
  id: 'kid', guardianPubkey: 'g'.repeat(64), displayName: 'Kid',
  naturalPerson: { publicKey: '0'.repeat(64), privateKey: '', displayName: 'Kid' },
  persona: { publicKey: '1'.repeat(64), privateKey: '', displayName: 'Kidpad' },
  derivationPath: 'dependant-0', createdAt: 0, autonomyStage: 'full-control', primaryKeypair: 'natural-person',
};
const childPersona = { type: 'dependant-persona', dependant } as unknown as CarouselRow;
const guardianPersona = {
  type: 'persona',
  identity: {
    id: 'g', naturalPerson: { publicKey: 'a'.repeat(64), displayName: '' },
    persona: { publicKey: 'b'.repeat(64), displayName: 'Guardian persona' }, primaryKeypair: 'persona',
  },
} as unknown as CarouselRow;

function setup(row: CarouselRow, col: CarouselColumn, over: Record<string, unknown> = {}) {
  const spies = {
    renderInviteCard: vi.fn((_r: CarouselRow, _x: unknown, plain: () => React.ReactNode) => <div data-testid="invite-card">{plain()}</div>),
    renderContactsCard: vi.fn(() => <div data-testid="contacts-card" />),
    renderKnownPlacesCard: vi.fn(() => <div data-testid="places-card" />),
    onHandshake: vi.fn(),
    onQRScanned: vi.fn(),
  };
  render(
    <CarouselArrowProvider>
      <Carousel
        row={0} col={col} rows={[row]} activeIdentity={resolveActiveIdentity(row)} animating={false}
        onCommit={vi.fn()} onAnimatingChange={vi.fn()} onNavigateDeepPage={vi.fn()}
        onEnterChildMode={vi.fn()} onExitChildMode={vi.fn()} onAddPersona={vi.fn()}
        childMode childDependant={dependant as never} stableChildId="kid"
        {...spies} {...over}
      />
    </CarouselArrowProvider>,
  );
  return spies;
}

afterEach(cleanup);

describe('Carousel in child mode: the child\'s own persona card', () => {
  it('col 0 keeps Scan, Handshake, My QR and the backdrop control', () => {
    setup(childPersona, 0);
    expect(screen.getByLabelText('Scan a QR code')).toBeDefined();
    expect(screen.getByLabelText('Show my QR code')).toBeDefined();
    expect(screen.getByLabelText('Customise card backdrop')).toBeDefined();
    expect(screen.getByText(/handshake/i)).toBeDefined();
  });

  it('col 1 is the plain QR, never the standing-invite card', () => {
    const { renderInviteCard } = setup(childPersona, 1);
    expect(renderInviteCard).not.toHaveBeenCalled();
    expect(screen.queryByTestId('invite-card')).toBeNull();
  });
});

describe('Carousel in child mode: a row that is not the child\'s', () => {
  it('col 0 offers no controls and no places or contacts shortcuts', () => {
    setup(guardianPersona, 0, { contactsCountFor: () => 3, knownPlacesFor: () => [] });
    expect(screen.queryByLabelText('Scan a QR code')).toBeNull();
    expect(screen.queryByLabelText('Show my QR code')).toBeNull();
    expect(screen.queryByLabelText('Customise card backdrop')).toBeNull();
    expect(screen.queryByText(/handshake/i)).toBeNull();
    expect(screen.queryByLabelText(/Open this identity's contacts/)).toBeNull();
  });

  it('col 0 offers no Pro pill on it', () => {
    const naturalPerson = { type: 'natural-person', identity: (guardianPersona as unknown as { identity: unknown }).identity } as unknown as CarouselRow;
    setup(naturalPerson, 0, { proAnchorActive: true, onProPillTap: vi.fn() });
    expect(screen.queryByLabelText(/Professional Dashboard/)).toBeNull();
  });

  it.each([1, 2, 3, 4, 5] as const)('col %i renders nothing for it', col => {
    const spies = setup(guardianPersona, col);
    expect(spies.renderInviteCard).not.toHaveBeenCalled();
    expect(spies.renderContactsCard).not.toHaveBeenCalled();
    expect(spies.renderKnownPlacesCard).not.toHaveBeenCalled();
    expect(document.querySelector('.camera-view, .settings-view, .qr-card')).toBeNull();
  });

  it('a sibling\'s row is foreign too', () => {
    const sibling = { type: 'dependant-persona', dependant: { ...dependant, id: 'sib' } } as unknown as CarouselRow;
    setup(sibling, 0);
    expect(screen.queryByLabelText('Scan a QR code')).toBeNull();
  });
});

describe('Carousel outside child mode', () => {
  it('still offers the owner card its controls and the invite card', () => {
    const spies = setup(guardianPersona, 1, { childMode: false, childDependant: null, stableChildId: null });
    expect(spies.renderInviteCard).toHaveBeenCalled();
  });
});
