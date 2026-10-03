// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { IdentityCard } from './IdentityCard';
import { initialFromName } from '../lib/avatar';

// Minimal owner row for the inline name-editor tests: an unnamed persona.
const unnamedOwnerRow = {
  type: 'owner',
  identity: {
    displayName: '',
    publicKey: 'bb'.repeat(32),
    keypairType: 'persona',
  },
} as never;
const unnamedResolved = {
  displayName: 'Persona',   // fallback applied
  displayNameIsSet: false,
  publicKey: 'bb'.repeat(32),
  type: 'Persona',
  isDependant: false,
};

// Construct a minimal valid `row` that the component accepts.
// Adjust shape to match the actual `IdentityRow` type from carousel-utils.
function dependantRow(overrides: Partial<any> = {}) {
  return {
    type: 'dependant',
    dependant: {
      id: 'dep-1',
      guardianPubkey: '0'.repeat(64),
      displayName: 'Lily',
      naturalPerson: { publicKey: '0'.repeat(64), privateKey: '0'.repeat(64), displayName: 'Lily' },
      persona: { publicKey: '1'.repeat(64), privateKey: '1'.repeat(64), displayName: 'Lily' },
      derivationPath: 'dependant-0',
      createdAt: Date.now(),
      autonomyStage: 'guardian-managed',
      primaryKeypair: 'natural-person',
      ...overrides,
    },
  } as any;
}

function resolvedLily() {
  return {
    displayName: 'Lily',
    displayNameIsSet: true,
    publicKey: '0'.repeat(64),
    type: 'Dependant',
    isDependant: true,
    dependantId: 'dep-1',
  };
}

describe('IdentityCard — image / avatar', () => {
  it('renders the initial when no photoHash is set', () => {
    render(<IdentityCard row={dependantRow({ displayName: 'Lily' })} resolved={resolvedLily()} badge={null} childMode={false} />);
    expect(screen.getByText(initialFromName('Lily'))).toBeDefined();
  });

  it('renders an img element when photoUrl is provided', () => {
    render(
      <IdentityCard
        row={dependantRow({ displayName: 'Lily' })}
        resolved={resolvedLily()}
        badge={null}
        childMode={false}
        photoUrl="https://example.com/lily.jpg"
      />
    );
    const img = screen.getByAltText("Lily's image") as HTMLImageElement;
    expect(img).toBeDefined();
    expect(img.src).toContain('lily.jpg');
  });
});

// Minimal props for Pro pill tests using an owner row.
const baseOwnerRow = {
  type: 'owner',
  identity: {
    displayName: 'Alice',
    publicKey: 'aa'.repeat(32),
    keypairType: 'natural-person',
  },
} as never;
const baseResolved = {
  displayName: 'Alice',
  displayNameIsSet: true,
  publicKey: 'aa'.repeat(32),
  type: 'Owner',
  isDependant: false,
};
const baseBadge = { tier: 3, score: 120, vouchCount: 5 };

describe('IdentityCard — Pro pill', () => {
  it('renders Pro pill when proAnchorActive is true', () => {
    render(
      <IdentityCard
        row={baseOwnerRow}
        resolved={baseResolved}
        badge={baseBadge}
        childMode={false}
        proAnchorActive={true}
        onProPillTap={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: /Pro — tap to open Professional Dashboard/i })).toBeDefined();
  });

  it('does not render Pro pill when proAnchorActive is false', () => {
    render(
      <IdentityCard
        row={baseOwnerRow}
        resolved={baseResolved}
        badge={baseBadge}
        childMode={false}
        proAnchorActive={false}
      />
    );
    expect(screen.queryByRole('button', { name: /Pro/i })).toBeNull();
  });

  it('calls onProPillTap when Pro pill is tapped', () => {
    const onProPillTap = vi.fn();
    render(
      <IdentityCard
        row={baseOwnerRow}
        resolved={baseResolved}
        badge={baseBadge}
        childMode={false}
        proAnchorActive={true}
        onProPillTap={onProPillTap}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /Pro — tap to open Professional Dashboard/i }));
    expect(onProPillTap).toHaveBeenCalledOnce();
  });
});

describe('IdentityCard — dependant pairing status', () => {
  it('shows "No phone paired — swipe › to settings" when unpaired', () => {
    render(<IdentityCard row={dependantRow()} resolved={resolvedLily()} badge={null} childMode={false} pairingStatus={{ paired: false }} />);
    expect(screen.getByText(/No phone paired — swipe . to settings/)).toBeDefined();
  });

  it('shows "Paired" when paired (no timestamp)', () => {
    render(<IdentityCard row={dependantRow()} resolved={resolvedLily()} badge={null} childMode={false} pairingStatus={{ paired: true }} />);
    expect(screen.getByText(/Paired/)).toBeDefined();
  });

  it('shows nothing pairing-related when pairingStatus is null/undefined', () => {
    render(<IdentityCard row={dependantRow()} resolved={resolvedLily()} badge={null} childMode={false} />);
    expect(screen.queryByText(/Paired/)).toBeNull();
    expect(screen.queryByText(/No phone paired/)).toBeNull();
  });
});

describe('IdentityCard — inline name editor', () => {
  it('shows the inline input for any unnamed persona with onRenameActive', () => {
    const { container } = render(
      <IdentityCard
        row={unnamedOwnerRow}
        resolved={unnamedResolved}
        badge={null}
        childMode={false}
        onRenameActive={vi.fn()}
      />,
    );
    const input = screen.getByPlaceholderText('Add your name / handle') as HTMLInputElement;
    expect(input).toBeDefined();
    // The card-name div must NOT exist (replaced by the input)
    expect(container.querySelector('.card-name')).toBeNull();
  });

  it('calls onRenameActive with the typed name on blur', () => {
    const onRenameActive = vi.fn();
    render(
      <IdentityCard
        row={unnamedOwnerRow}
        resolved={unnamedResolved}
        badge={null}
        childMode={false}
        onRenameActive={onRenameActive}
      />,
    );
    const input = screen.getByPlaceholderText('Add your name / handle') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'DarkWolf99' } });
    fireEvent.blur(input);
    expect(onRenameActive).toHaveBeenCalledWith('DarkWolf99');
  });

  it('calls onRenameActive on Enter key', () => {
    const onRenameActive = vi.fn();
    render(
      <IdentityCard
        row={unnamedOwnerRow}
        resolved={unnamedResolved}
        badge={null}
        childMode={false}
        onRenameActive={onRenameActive}
      />,
    );
    const input = screen.getByPlaceholderText('Add your name / handle') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'SilverFox' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onRenameActive).toHaveBeenCalledWith('SilverFox');
  });

  it('does NOT call onRenameActive when the input is blank', () => {
    const onRenameActive = vi.fn();
    render(
      <IdentityCard
        row={unnamedOwnerRow}
        resolved={unnamedResolved}
        badge={null}
        childMode={false}
        onRenameActive={onRenameActive}
      />,
    );
    const input = screen.getByPlaceholderText('Add your name / handle') as HTMLInputElement;
    fireEvent.blur(input); // blur with empty value
    expect(onRenameActive).not.toHaveBeenCalled();
  });

  it('shows the regular card-name text when name is set (displayNameIsSet true)', () => {
    render(
      <IdentityCard
        row={baseOwnerRow}
        resolved={baseResolved}
        badge={null}
        childMode={false}
        onRenameActive={vi.fn()}
      />,
    );
    // displayNameIsSet = true → card-name text, no input
    expect(screen.queryByPlaceholderText('Add your name / handle')).toBeNull();
    expect(screen.getByText('Alice')).toBeDefined();
  });

  it('shows the regular card-name text when no onRenameActive is supplied', () => {
    const { container } = render(
      <IdentityCard
        row={unnamedOwnerRow}
        resolved={unnamedResolved}
        badge={null}
        childMode={false}
      />,
    );
    expect(screen.queryByPlaceholderText('Add your name / handle')).toBeNull();
    // The fallback 'Persona' is rendered as the card-name div (not an input)
    const cardName = container.querySelector('.card-name');
    expect(cardName?.textContent).toBe('Persona');
  });
});

describe('IdentityCard — public kind-0 picture', () => {
  const pubResolved = (pictureUrl?: string) => ({ ...baseResolved, displayName: 'Alice', pictureUrl });
  const renderCard = (pictureUrl?: string, extra: Record<string, unknown> = {}) =>
    render(
      <IdentityCard
        row={baseOwnerRow}
        resolved={pubResolved(pictureUrl)}
        badge={null}
        childMode={false}
        {...extra}
      />,
    );

  it('shows a valid https pictureUrl with no-referrer when there is no in-app avatar', () => {
    renderCard('https://example.com/alice.jpg');
    const img = screen.getByAltText("Alice's image") as HTMLImageElement;
    expect(img.src).toBe('https://example.com/alice.jpg');
    expect(img.getAttribute('referrerpolicy')).toBe('no-referrer');
  });

  it.each(['javascript:alert(1)', 'http://example.com/a.jpg', 'data:image/png;base64,AAAA'])(
    'ignores unsafe pictureUrl %s and shows the initial',
    (url) => {
      renderCard(url);
      expect(screen.queryByAltText("Alice's image")).toBeNull();
      expect(screen.getByText(initialFromName('Alice'))).toBeDefined();
    },
  );

  it('falls back to the initial when the picture fails to load', () => {
    renderCard('https://example.com/alice.jpg');
    fireEvent.error(screen.getByAltText("Alice's image"));
    expect(screen.queryByAltText("Alice's image")).toBeNull();
    expect(screen.getByText(initialFromName('Alice'))).toBeDefined();
  });

  it('retries when the pictureUrl changes after a failure', () => {
    const { rerender } = renderCard('https://example.com/a.jpg');
    fireEvent.error(screen.getByAltText("Alice's image"));
    rerender(
      <IdentityCard row={baseOwnerRow} resolved={pubResolved('https://example.com/b.jpg')} badge={null} childMode={false} />,
    );
    expect((screen.getByAltText("Alice's image") as HTMLImageElement).src).toBe('https://example.com/b.jpg');
  });

  it('lets the photoUrl prop win over the public picture', () => {
    renderCard('https://example.com/alice.jpg', { photoUrl: 'https://example.com/override.jpg' });
    expect((screen.getByAltText("Alice's image") as HTMLImageElement).src).toBe('https://example.com/override.jpg');
  });

  it('blurs the public picture with the identity area when blurIdentityNames is on', () => {
    renderCard('https://example.com/alice.jpg', { blurIdentityNames: true });
    const blurred = screen.getByLabelText('Tap to reveal identity');
    expect(blurred.style.filter).toContain('blur');
    expect(within(blurred).getByAltText("Alice's image")).toBeDefined();
  });
});
