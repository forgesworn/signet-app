// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ContactsGrantList } from './ContactsGrantList';
import {
  CANCEL_LABEL, CONFIRM_LABEL, CONTACTS_GRANTS_LIST_EMPTY, CONTACTS_GRANT_CAPABILITY_COPY,
  CONTACTS_GRANT_DISCONNECT_LABEL, CONTACTS_GRANT_FORGET_LABEL, CONTACTS_GRANT_PUBLISH_STATE,
  OWNER_DIRECTORY_LABEL, CONTACTS_GRANT_RECONNECT_COPY, contactsGrantDirectoryLine,
} from '../lib/contacts-v2-copy';
import type { AppGrantV2 } from '../types';

const DIRECTORIES = [{ directoryId: 'owner', label: OWNER_DIRECTORY_LABEL }];

function grant(overrides: Partial<AppGrantV2> = {}): AppGrantV2 {
  return {
    grantId: 'a'.repeat(32),
    directoryId: 'owner',
    appPubkey: 'b'.repeat(64),
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_000_000,
    appName: 'Flock',
    capabilities: ['signet.contacts.read:directory'],
    railPubkey: 'c'.repeat(64),
    railPrivateKey: 'd'.repeat(64),
    relay: 'wss://relay.example.com',
    maxStalenessSeconds: 21600,
    appLabels: {},
    seenOperationIds: [],
    ...overrides,
  };
}

const noop = () => { /* not under test */ };

function renderList(grants: AppGrantV2[], props: Partial<Parameters<typeof ContactsGrantList>[0]> = {}) {
  return render(
    <ContactsGrantList
      grants={grants}
      directories={DIRECTORIES}
      confirmingGrantId={null}
      busyGrantId={null}
      onConfirmDisconnect={noop}
      onCancelDisconnect={noop}
      onDisconnect={noop}
      onForget={noop}
      {...props}
    />,
  );
}

describe('ContactsGrantList', () => {
  it('says so plainly when nothing is connected', () => {
    renderList([]);
    expect(screen.getByText(CONTACTS_GRANTS_LIST_EMPTY)).toBeDefined();
  });

  it('names the app, its contact list and one line per capability', () => {
    renderList([grant({
      capabilities: ['signet.contacts.read:directory', 'signet.contacts.blocks.read'],
    })]);
    expect(screen.getByText('Flock')).toBeDefined();
    expect(screen.getByText(contactsGrantDirectoryLine(OWNER_DIRECTORY_LABEL))).toBeDefined();
    expect(screen.getByText(CONTACTS_GRANT_CAPABILITY_COPY['signet.contacts.read:directory'])).toBeDefined();
    expect(screen.getByText(CONTACTS_GRANT_CAPABILITY_COPY['signet.contacts.blocks.read'])).toBeDefined();
  });

  it('shows the last publish state, including a truncated copy (R-5)', () => {
    renderList([grant({ lastPublishState: 'truncated' })]);
    expect(screen.getByText(CONTACTS_GRANT_PUBLISH_STATE.truncated)).toBeDefined();
  });

  it('treats a grant with no recorded publish state as up to date', () => {
    renderList([grant()]);
    expect(screen.getByText(CONTACTS_GRANT_PUBLISH_STATE.ok)).toBeDefined();
  });

  it('offers Disconnect for a live grant and Forget for a revoked one', () => {
    renderList([grant()]);
    expect(screen.getByText(CONTACTS_GRANT_DISCONNECT_LABEL)).toBeDefined();
    expect(screen.queryByText(CONTACTS_GRANT_FORGET_LABEL)).toBeNull();
  });

  it('lists a revoked grant as ended, with Forget and no Disconnect', () => {
    renderList([grant({ revokedAt: 1_700_000_500 })]);
    expect(screen.getByText(CONTACTS_GRANT_FORGET_LABEL)).toBeDefined();
    expect(screen.queryByText(CONTACTS_GRANT_DISCONNECT_LABEL)).toBeNull();
    // The publish-state line is replaced by the ended line.
    expect(screen.queryByText(CONTACTS_GRANT_PUBLISH_STATE.ok)).toBeNull();
  });

  it('asks before disconnecting, and only acts on Confirm', () => {
    const onConfirmDisconnect = vi.fn();
    const onDisconnect = vi.fn();
    const { rerender } = renderList([grant()], { onConfirmDisconnect, onDisconnect });

    fireEvent.click(screen.getByText(CONTACTS_GRANT_DISCONNECT_LABEL));
    expect(onConfirmDisconnect).toHaveBeenCalledWith('a'.repeat(32));
    expect(onDisconnect).not.toHaveBeenCalled();

    rerender(
      <ContactsGrantList
        grants={[grant()]}
        directories={DIRECTORIES}
        confirmingGrantId={'a'.repeat(32)}
        busyGrantId={null}
        onConfirmDisconnect={onConfirmDisconnect}
        onCancelDisconnect={noop}
        onDisconnect={onDisconnect}
        onForget={noop}
      />,
    );
    expect(screen.getByText(CANCEL_LABEL)).toBeDefined();
    fireEvent.click(screen.getByText(CONFIRM_LABEL));
    expect(onDisconnect).toHaveBeenCalledWith('a'.repeat(32));
  });

  it('forgets a revoked grant on tap', () => {
    const onForget = vi.fn();
    renderList([grant({ revokedAt: 1_700_000_500 })], { onForget });
    fireEvent.click(screen.getByText(CONTACTS_GRANT_FORGET_LABEL));
    expect(onForget).toHaveBeenCalledWith('a'.repeat(32));
  });

  it('renders a failure message when one is passed', () => {
    renderList([grant()], { error: 'Could not disconnect that app. Please try again.' });
    expect(screen.getByText('Could not disconnect that app. Please try again.')).toBeDefined();
  });
});


it('explains that a retired permission needs fresh consent instead of showing a blank row', () => {
  // Simulate a pre-upgrade grant loaded from encrypted local storage.
  const capabilities = ['signet.contacts.read:directory', 'signet.contacts.read:methods'] as AppGrantV2['capabilities'];
  renderList([grant({ capabilities })]);
  expect(screen.getByText(CONTACTS_GRANT_RECONNECT_COPY)).toBeDefined();
  expect(screen.getByText(CONTACTS_GRANT_CAPABILITY_COPY['signet.contacts.read:directory'])).toBeDefined();
});
