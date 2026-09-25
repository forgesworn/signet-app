// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Keep parseNip05 real (pure, used for the stored-result domain display) —
// only checkNip05 is mocked, so the Check-button tests never touch the
// network and can assert exactly what it was called with.
vi.mock('../lib/nip05-check', async () => {
  const actual = await vi.importActual<typeof import('../lib/nip05-check')>('../lib/nip05-check');
  return { ...actual, checkNip05: vi.fn() };
});

import { SlotProfileFields } from './SlotProfileFields';
import { checkNip05 } from '../lib/nip05-check';
import type { PublicProfileConfig, PersonaPublicProfile } from '../types';

const mockCheckNip05 = vi.mocked(checkNip05);

const PUBKEY = 'a'.repeat(64);

function stubClipboard() {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
  return writeText;
}

function baseConfig(overrides: Partial<PublicProfileConfig> = {}): PublicProfileConfig {
  return {
    displayName: 'Alex',
    about: 'A line about Alex',
    pictureUrl: undefined,
    pictureBlossomHash: undefined,
    bannerUrl: undefined,
    bannerBlossomHash: undefined,
    nip05: 'alex@example.com',
    lud16: 'alex@walletofsatoshi.com',
    website: 'https://alex.example',
    ...overrides,
  };
}

describe('SlotProfileFields', () => {
  beforeEach(() => {
    mockCheckNip05.mockReset();
  });

  it('renders fields with seeded config values', () => {
    render(
      <SlotProfileFields
        pubkey={PUBKEY}
        config={baseConfig()}
        slotKind="natural-person"
        onSaveConfig={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    // About textarea seeded
    const about = screen.getByDisplayValue('A line about Alex');
    expect(about).toBeDefined();
    // NIP-05 input seeded (NP slot — visible inline by default)
    expect(screen.getByDisplayValue('alex@example.com')).toBeDefined();
    expect(screen.getByDisplayValue('alex@walletofsatoshi.com')).toBeDefined();
    expect(screen.getByDisplayValue('https://alex.example')).toBeDefined();
  });

  it('default-Persona variant hides NIP-05 / Lightning / Website until Show-all tapped', async () => {
    render(
      <SlotProfileFields
        pubkey={PUBKEY}
        config={baseConfig()}
        slotKind="persona"
        onSaveConfig={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    // Hidden initially — NIP-05 / lud16 / website seeded values should NOT be in the DOM.
    expect(screen.queryByDisplayValue('alex@example.com')).toBeNull();
    expect(screen.queryByDisplayValue('alex@walletofsatoshi.com')).toBeNull();
    expect(screen.queryByDisplayValue('https://alex.example')).toBeNull();

    // Toggle visible
    const toggle = screen.getByRole('button', { name: /show all fields/i });
    fireEvent.click(toggle);

    // Now the three fields are rendered
    expect(screen.getByDisplayValue('alex@example.com')).toBeDefined();
    expect(screen.getByDisplayValue('alex@walletofsatoshi.com')).toBeDefined();
    expect(screen.getByDisplayValue('https://alex.example')).toBeDefined();
  });

  it('renders Imported badge when imported=true', () => {
    render(
      <SlotProfileFields
        pubkey={PUBKEY}
        config={baseConfig()}
        slotKind="extra"
        imported
        onSaveConfig={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    expect(screen.getByText(/Imported — not in your seed phrase/i)).toBeDefined();
  });

  it('paired-child view disables inputs and renders read-only banner', () => {
    render(
      <SlotProfileFields
        pubkey={PUBKEY}
        config={baseConfig()}
        slotKind="dep-natural-person"
        pairedChildView
        onSaveConfig={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    expect(screen.getByText(/Your guardian set this up/i)).toBeDefined();
    // About textarea disabled
    const about = screen.getByDisplayValue('A line about Alex') as HTMLTextAreaElement;
    expect(about.disabled).toBe(true);
    // No Save button rendered
    expect(screen.queryByRole('button', { name: /^save$/i })).toBeNull();
  });

  it('Save triggers onSaveConfig with the latest form values', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <SlotProfileFields
        pubkey={PUBKEY}
        config={baseConfig()}
        slotKind="natural-person"
        onSaveConfig={onSave}
      />,
    );
    const about = screen.getByDisplayValue('A line about Alex') as HTMLTextAreaElement;
    fireEvent.change(about, { target: { value: 'Updated about line' } });

    const saveBtn = screen.getByRole('button', { name: /^save$/i });
    fireEvent.click(saveBtn);

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const passed = onSave.mock.calls[0][0] as PublicProfileConfig;
    expect(passed.about).toBe('Updated about line');
    // Other seeded fields preserved
    expect(passed.nip05).toBe('alex@example.com');
  });

  it('Save button stays disabled when form is pristine', () => {
    render(
      <SlotProfileFields
        pubkey={PUBKEY}
        config={baseConfig()}
        slotKind="natural-person"
        onSaveConfig={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    const saveBtn = screen.getByRole('button', { name: /^save$/i }) as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);
  });

  it('Republish prompt appears after Save when publishedState.enabled === true', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const onPublishNow = vi.fn().mockResolvedValue(undefined);
    const published: PersonaPublicProfile = {
      enabled: true,
      lastEventId: 'a'.repeat(64),
      lastPublishedAt: 1_700_000_000,
      lastPublishedRelay: 'wss://relay.example',
    };
    render(
      <SlotProfileFields
        pubkey={PUBKEY}
        config={baseConfig()}
        publishedState={published}
        slotKind="natural-person"
        onSaveConfig={onSave}
        onPublishNow={onPublishNow}
      />,
    );
    const about = screen.getByDisplayValue('A line about Alex') as HTMLTextAreaElement;
    fireEvent.change(about, { target: { value: 'Republish me' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    // Modal appears
    const yesBtn = await screen.findByRole('button', { name: /yes, republish/i });
    expect(yesBtn).toBeDefined();
    expect(screen.getByRole('button', { name: /save locally for now/i })).toBeDefined();

    fireEvent.click(yesBtn);
    await waitFor(() => expect(onPublishNow).toHaveBeenCalledTimes(1));
  });

  it('Republish prompt does NOT appear when publishedState.enabled is false', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const onPublishNow = vi.fn().mockResolvedValue(undefined);
    render(
      <SlotProfileFields
        pubkey={PUBKEY}
        config={baseConfig()}
        publishedState={{ enabled: false }}
        slotKind="natural-person"
        onSaveConfig={onSave}
        onPublishNow={onPublishNow}
      />,
    );
    const about = screen.getByDisplayValue('A line about Alex') as HTMLTextAreaElement;
    fireEvent.change(about, { target: { value: 'No republish for me' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    // No modal
    expect(screen.queryByRole('button', { name: /yes, republish/i })).toBeNull();
    expect(onPublishNow).not.toHaveBeenCalled();
  });

  it('Status line shows "Off" when publishedState undefined', () => {
    render(
      <SlotProfileFields
        pubkey={PUBKEY}
        config={baseConfig()}
        slotKind="natural-person"
        onSaveConfig={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    expect(screen.getByText(/Public Nostr profile:.*Off/)).toBeDefined();
  });

  it('Status line shows "On" with relay host when published', () => {
    render(
      <SlotProfileFields
        pubkey={PUBKEY}
        config={baseConfig()}
        publishedState={{
          enabled: true,
          lastEventId: 'a'.repeat(64),
          lastPublishedAt: 1_700_000_000,
          lastPublishedRelay: 'wss://relay.example.org',
        }}
        slotKind="natural-person"
        onSaveConfig={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    expect(screen.getByText(/Public Nostr profile:.*On/)).toBeDefined();
    expect(screen.getByText(/relay\.example\.org/)).toBeDefined();
  });
});

describe('SlotProfileFields — npub copy row', () => {
  beforeEach(() => {
    mockCheckNip05.mockReset();
  });

  // The row is the shared `NpubRow`: it renders the npub abbreviated with the
  // FULL value in `title` (and expandable via "Show full npub"), and copies
  // the complete npub from its "Copy npub" button.
  it('renders the abbreviated npub with the full npub as the title, and copies it', () => {
    const writeText = stubClipboard();
    render(
      <SlotProfileFields
        pubkey={PUBKEY}
        config={baseConfig()}
        slotKind="natural-person"
        onSaveConfig={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    // nip19.npubEncode('a'.repeat(64)) — pinned expected value.
    const fullNpub = 'npub1424242424242424242424242424242424242424242424242424qamrcaj';
    const npubSpan = screen.getByTitle(fullNpub);
    expect(npubSpan.textContent).toBe(`${fullNpub.slice(0, 12)}\u2026${fullNpub.slice(-6)}`);

    fireEvent.click(screen.getByRole('button', { name: /^show full npub$/i }));
    expect(screen.getByTitle(fullNpub).textContent).toBe(fullNpub);

    const copyBtn = screen.getByRole('button', { name: /^copy npub$/i });
    fireEvent.click(copyBtn);
    expect(writeText).toHaveBeenCalledWith(fullNpub);
  });

  it('flips the Copy button to its copied state after a tap', async () => {
    stubClipboard();
    render(
      <SlotProfileFields
        pubkey={PUBKEY}
        config={baseConfig()}
        slotKind="natural-person"
        onSaveConfig={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    const copyBtn = screen.getByRole('button', { name: /^copy npub$/i });
    fireEvent.click(copyBtn);
    await waitFor(() => expect(screen.getByRole('button', { name: /^copied!$/i })).toBeDefined());
  });

  it('renders in the paired-child read-only view too', () => {
    stubClipboard();
    render(
      <SlotProfileFields
        pubkey={PUBKEY}
        config={baseConfig()}
        slotKind="dep-natural-person"
        pairedChildView
        onSaveConfig={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    expect(screen.getByRole('button', { name: /^copy npub$/i })).toBeDefined();
  });

  it('renders nothing when the pubkey is not 64 lowercase hex chars', () => {
    render(
      <SlotProfileFields
        pubkey="not-a-valid-pubkey"
        config={baseConfig()}
        slotKind="natural-person"
        onSaveConfig={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    expect(screen.queryByRole('button', { name: /^copy npub$/i })).toBeNull();
  });

  it('renders nothing for uppercase-hex (must be lowercase) without throwing', () => {
    expect(() =>
      render(
        <SlotProfileFields
          pubkey={'A'.repeat(64)}
          config={baseConfig()}
          slotKind="natural-person"
          onSaveConfig={vi.fn().mockResolvedValue(undefined)}
        />,
      ),
    ).not.toThrow();
    expect(screen.queryByRole('button', { name: /^copy npub$/i })).toBeNull();
  });
});

describe('SlotProfileFields — NIP-05 check', () => {
  beforeEach(() => {
    mockCheckNip05.mockReset();
  });

  it('Check button is hidden when the parent wired no onNip05Checked', () => {
    render(
      <SlotProfileFields
        pubkey={PUBKEY}
        config={baseConfig()}
        slotKind="natural-person"
        onSaveConfig={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    expect(screen.queryByRole('button', { name: /^check$/i })).toBeNull();
  });

  it('Check button is disabled when the NIP-05 field is empty', () => {
    render(
      <SlotProfileFields
        pubkey={PUBKEY}
        config={baseConfig({ nip05: undefined })}
        slotKind="natural-person"
        onSaveConfig={vi.fn().mockResolvedValue(undefined)}
        onNip05Checked={vi.fn()}
      />,
    );
    const checkBtn = screen.getByRole('button', { name: /^check$/i }) as HTMLButtonElement;
    expect(checkBtn.disabled).toBe(true);
  });

  it('Check button is disabled when the field is dirty (edited but not saved) and shows "Save first"', () => {
    render(
      <SlotProfileFields
        pubkey={PUBKEY}
        config={baseConfig()}
        slotKind="natural-person"
        onSaveConfig={vi.fn().mockResolvedValue(undefined)}
        onNip05Checked={vi.fn()}
      />,
    );
    const nip05Input = screen.getByDisplayValue('alex@example.com') as HTMLInputElement;
    fireEvent.change(nip05Input, { target: { value: 'alex-new@example.com' } });

    const checkBtn = screen.getByRole('button', { name: /^check$/i }) as HTMLButtonElement;
    expect(checkBtn.disabled).toBe(true);
    expect(screen.getByText(/save first/i)).toBeDefined();
  });

  it('Check button is disabled with "can\'t be checked" hint for a saved value that passes the loose Save-time regex but fails the strict parser (review fix important-2)', () => {
    // NIP05_RE (the Save-time validator) allows `+` in the local part;
    // parseNip05 (the strict parser checkNip05 actually uses) does not.
    // Without gating Check on parseNip05 too, tapping Check here would
    // silently no-fetch to 'unreachable' via checkNip05's own internal
    // guard, and the result line would render with an empty domain.
    render(
      <SlotProfileFields
        pubkey={PUBKEY}
        config={baseConfig({ nip05: 'alice+tag@example.com' })}
        slotKind="natural-person"
        onSaveConfig={vi.fn().mockResolvedValue(undefined)}
        onNip05Checked={vi.fn()}
      />,
    );
    const checkBtn = screen.getByRole('button', { name: /^check$/i }) as HTMLButtonElement;
    expect(checkBtn.disabled).toBe(true);
    expect(screen.getByText(/this nip-05 can't be checked/i)).toBeDefined();
    expect(mockCheckNip05).not.toHaveBeenCalled();
  });

  it('Check is enabled for a saved, valid, non-empty NIP-05 and calls checkNip05 + onNip05Checked', async () => {
    mockCheckNip05.mockResolvedValue('match');
    const onNip05Checked = vi.fn();
    render(
      <SlotProfileFields
        pubkey={PUBKEY}
        config={baseConfig()}
        slotKind="natural-person"
        onSaveConfig={vi.fn().mockResolvedValue(undefined)}
        onNip05Checked={onNip05Checked}
      />,
    );
    const checkBtn = screen.getByRole('button', { name: /^check$/i }) as HTMLButtonElement;
    expect(checkBtn.disabled).toBe(false);

    fireEvent.click(checkBtn);
    expect(screen.getByRole('button', { name: /checking/i })).toBeDefined();

    await waitFor(() => expect(onNip05Checked).toHaveBeenCalledTimes(1));
    expect(mockCheckNip05).toHaveBeenCalledWith('alex@example.com', PUBKEY);
    const [result, checkedAt] = onNip05Checked.mock.calls[0];
    expect(result).toBe('match');
    expect(typeof checkedAt).toBe('number');
  });

  it('never auto-checks — no fetch call on mount, save, or field change', async () => {
    const onSaveConfig = vi.fn().mockResolvedValue(undefined);
    render(
      <SlotProfileFields
        pubkey={PUBKEY}
        config={baseConfig()}
        slotKind="natural-person"
        onSaveConfig={onSaveConfig}
        onNip05Checked={vi.fn()}
      />,
    );
    const about = screen.getByDisplayValue('A line about Alex') as HTMLTextAreaElement;
    fireEvent.change(about, { target: { value: 'Updated' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(onSaveConfig).toHaveBeenCalledTimes(1));

    expect(mockCheckNip05).not.toHaveBeenCalled();
  });

  it("shows a neutral error and leaves stored state untouched when onNip05Checked rejects (review fix minor 3)", async () => {
    mockCheckNip05.mockResolvedValue('match');
    const onNip05Checked = vi.fn().mockRejectedValue(new Error('no encryption key'));
    render(
      <SlotProfileFields
        pubkey={PUBKEY}
        config={baseConfig({ nip05CheckResult: 'unreachable', nip05CheckedAt: 1_700_000_000_000 })}
        slotKind="natural-person"
        onSaveConfig={vi.fn().mockResolvedValue(undefined)}
        onNip05Checked={onNip05Checked}
      />,
    );
    const checkBtn = screen.getByRole('button', { name: /^check$/i });
    fireEvent.click(checkBtn);

    await waitFor(() => expect(onNip05Checked).toHaveBeenCalledTimes(1));
    expect(screen.getByText(/couldn't save the result/i)).toBeDefined();
    // The stale stored line is untouched — config never changed underneath us.
    expect(screen.getByText(/couldn't reach example\.com to check/i)).toBeDefined();
  });

  it('renders the stored "match" result line with relative time', () => {
    render(
      <SlotProfileFields
        pubkey={PUBKEY}
        config={baseConfig({ nip05CheckResult: 'match', nip05CheckedAt: Date.now() - 3 * 24 * 60 * 60 * 1000 })}
        slotKind="natural-person"
        onSaveConfig={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    expect(screen.getByText(/Verified: example\.com lists this key/)).toBeDefined();
    expect(screen.getByText(/checked 3 days ago/)).toBeDefined();
  });

  it('renders the stored "mismatch" result line', () => {
    render(
      <SlotProfileFields
        pubkey={PUBKEY}
        config={baseConfig({ nip05CheckResult: 'mismatch', nip05CheckedAt: Date.now() })}
        slotKind="natural-person"
        onSaveConfig={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    expect(screen.getByText(/example\.com lists a different key for this name/)).toBeDefined();
  });

  it('renders the stored "not-found" result line', () => {
    render(
      <SlotProfileFields
        pubkey={PUBKEY}
        config={baseConfig({ nip05CheckResult: 'not-found', nip05CheckedAt: Date.now() })}
        slotKind="natural-person"
        onSaveConfig={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    expect(screen.getByText(/example\.com doesn't list this name/)).toBeDefined();
  });

  it('renders the stored "unreachable" result line', () => {
    render(
      <SlotProfileFields
        pubkey={PUBKEY}
        config={baseConfig({ nip05CheckResult: 'unreachable', nip05CheckedAt: Date.now() })}
        slotKind="natural-person"
        onSaveConfig={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    expect(screen.getByText(/Couldn't reach example\.com to check/)).toBeDefined();
  });
});
