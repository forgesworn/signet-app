// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FollowsImportPanel } from './FollowsImportPanel';
import type { FollowsImportOutcome } from '../lib/follows-import-flow';
import { PICTURES_CONSENT_BODY, PICTURES_CONSENT_TITLE, PICTURES_RELAYS_UNREACHABLE_COPY } from '../lib/contacts-v2-copy';

const done = (over: Partial<Extract<FollowsImportOutcome, { status: 'done' }>> = {}): FollowsImportOutcome => ({
  status: 'done', total: 3, createdAt: 1, added: 3, linked: 0, unchanged: 0, skippedRemoved: 0, covered: 3, trimmedNotice: null,
  unfollowed: [], unfollowedKept: 0, ...over,
});

function renderPanel(onImport: ReturnType<typeof vi.fn>, picturesAvailable: boolean) {
  render(<FollowsImportPanel personaName="Alex" onImport={onImport as never} onUnlink={vi.fn(async () => 0)} picturesAvailable={picturesAvailable} />);
}

describe('FollowsImportPanel — picture consent', () => {
  it('asks first, every time, and imports nothing until the user chooses', async () => {
    const onImport = vi.fn(async () => done({ pictures: { downloaded: 2, failed: 1 } }));
    renderPanel(onImport, true);
    fireEvent.click(screen.getByRole('button', { name: 'Import who this account follows' }));
    expect(screen.getByText(PICTURES_CONSENT_TITLE)).toBeTruthy();
    expect(screen.getByText(PICTURES_CONSENT_BODY)).toBeTruthy();
    expect(onImport).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Download pictures' }));
    await waitFor(() => expect(onImport).toHaveBeenCalledWith({ pictures: true }));
    expect(await screen.findByText("Downloaded 2 pictures, 1 couldn't be downloaded.")).toBeTruthy();
    // The next run asks again.
    fireEvent.click(screen.getByRole('button', { name: 'Import who this account follows' }));
    expect(screen.getByText(PICTURES_CONSENT_TITLE)).toBeTruthy();
  });

  it('"Not now" still imports the names, without pictures', async () => {
    const onImport = vi.fn(async () => done());
    renderPanel(onImport, true);
    fireEvent.click(screen.getByRole('button', { name: 'Import who this account follows' }));
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    await waitFor(() => expect(onImport).toHaveBeenCalledWith({ pictures: false }));
    expect(await screen.findByText(/Added 3/)).toBeTruthy();
    expect(screen.queryByText(/Downloaded/)).toBeNull();
  });

  it('without pictures (paired-child) there is no consent step and names import directly', async () => {
    const onImport = vi.fn(async () => done());
    renderPanel(onImport, false);
    fireEvent.click(screen.getByRole('button', { name: 'Import who this account follows' }));
    expect(screen.queryByText(PICTURES_CONSENT_TITLE)).toBeNull();
    await waitFor(() => expect(onImport).toHaveBeenCalledWith({ pictures: false }));
  });

  it('says "Downloaded N pictures." with nothing failed', async () => {
    renderPanel(vi.fn(async () => done({ pictures: { downloaded: 1, failed: 0 } })), true);
    fireEvent.click(screen.getByRole('button', { name: 'Import who this account follows' }));
    fireEvent.click(screen.getByRole('button', { name: 'Download pictures' }));
    expect(await screen.findByText('Downloaded 1 picture.')).toBeTruthy();
  });

  it('says no relay could be reached instead of "Downloaded 0 pictures."', async () => {
    renderPanel(vi.fn(async () => done({ pictures: { downloaded: 0, failed: 0, unreachable: true } })), true);
    fireEvent.click(screen.getByRole('button', { name: 'Import who this account follows' }));
    fireEvent.click(screen.getByRole('button', { name: 'Download pictures' }));
    expect(await screen.findByText(PICTURES_RELAYS_UNREACHABLE_COPY)).toBeTruthy();
    expect(screen.queryByText(/Downloaded/)).toBeNull();
  });
});
