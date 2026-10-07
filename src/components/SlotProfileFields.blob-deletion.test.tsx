// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { SlotProfileFields } from './SlotProfileFields';
import type { PublicProfileConfig, PersonaPublicProfile } from '../types';
import type { DeleteOutcome } from '../lib/blob-deletion';

// Blossom clean-up for the public picture and banner (design 2026-10-07 §2: R2, R4, R6).

const PNG_3x2 = 'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAFUlEQVR4nGM8wcXFwMDAwMDAxAADABByAOAp6i43AAAAAElFTkSuQmCC';
const imageFile = () => new File([Uint8Array.from(atob(PNG_3x2), c => c.charCodeAt(0))], 'x.png', { type: 'image/png' });

const SERVER = 'https://nostr.download';
const OLD = 'a1'.repeat(32);
const MID = 'c3'.repeat(32);
const PUBKEY = 'a'.repeat(64);

const PUBLISHED: PersonaPublicProfile = { enabled: true, lastEventId: 'e'.repeat(64), lastPublishedAt: 1_700_000_000, lastPublishedRelay: 'wss://relay.example' };

/** A saved config whose banner is hosted on our Blossom server. */
function savedConfig(over: Partial<PublicProfileConfig> = {}): PublicProfileConfig {
  return { displayName: 'Alex', about: 'About', bannerUrl: `${SERVER}/${OLD}`, bannerBlossomHash: OLD, ...over };
}

function setup(opts: {
  config?: PublicProfileConfig;
  publishedState?: PersonaPublicProfile;
  withPublish?: boolean;
  outcome?: DeleteOutcome | 'throw';
  onSaveConfig?: () => Promise<void>;
  onPublishNow?: () => Promise<void>;
} = {}) {
  const order: string[] = [];
  const uploads = [MID, 'd4'.repeat(32)];
  const onUploadPicture = vi.fn(async () => {
    const sha256 = uploads.shift()!;
    return { url: `${SERVER}/${sha256}`, sha256 };
  });
  const onSaveConfig = vi.fn(async () => { order.push('save'); await opts.onSaveConfig?.(); });
  const onPublishNow = opts.withPublish === false ? undefined : vi.fn(async () => { order.push('publish'); await opts.onPublishNow?.(); });
  const onDeleteBlob = vi.fn(async (hash: string) => {
    order.push(`delete:${hash.slice(0, 2)}`);
    if (opts.outcome === 'throw') throw new Error('boom');
    return (opts.outcome ?? 'deleted') as DeleteOutcome;
  });
  const view = render(
    <SlotProfileFields
      pubkey={PUBKEY}
      config={opts.config ?? savedConfig()}
      publishedState={opts.publishedState}
      slotKind="natural-person"
      blossomConsent
      onSaveConfig={onSaveConfig}
      onPublishNow={onPublishNow}
      onUploadPicture={onUploadPicture}
      onDeleteBlob={onDeleteBlob}
    />,
  );
  const bannerInput = () => Array.from(view.container.querySelectorAll('input[type="file"]'))[1] as HTMLInputElement;
  const pickBanner = async (expectedUploads: number) => {
    fireEvent.change(bannerInput(), { target: { files: [imageFile()] } });
    await waitFor(() => expect(onUploadPicture).toHaveBeenCalledTimes(expectedUploads));
    // let the upload's state settle
    await waitFor(() => expect((screen.getAllByRole('button', { name: 'Remove' }).length)).toBeGreaterThan(0));
  };
  const save = () => fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
  return { order, onUploadPicture, onSaveConfig, onPublishNow, onDeleteBlob, view, pickBanner, save };
}

describe('R2: orphans are deleted silently', () => {
  it('a picture replaced before Save is deleted, and the one kept is not', async () => {
    const t = setup();
    await t.pickBanner(1);
    await waitFor(() => expect(screen.getAllByRole('button').length).toBeGreaterThan(0));
    // second pick replaces the first (MID) before any Save
    fireEvent.change(Array.from(t.view.container.querySelectorAll('input[type="file"]'))[1], { target: { files: [imageFile()] } });
    await waitFor(() => expect(t.onUploadPicture).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(t.onDeleteBlob).toHaveBeenCalledTimes(1));
    expect(t.onDeleteBlob).toHaveBeenCalledWith(MID, SERVER);
    expect(screen.queryByRole('status')).toBeNull(); // silent
  });

  it('a picture removed before Save is deleted', async () => {
    const t = setup();
    await t.pickBanner(1);
    const removes = screen.getAllByRole('button', { name: 'Remove' });
    fireEvent.click(removes[removes.length - 1]);
    await waitFor(() => expect(t.onDeleteBlob).toHaveBeenCalledWith(MID, SERVER));
  });

  it('a picture abandoned by leaving the form is deleted', async () => {
    const t = setup();
    await t.pickBanner(1);
    expect(t.onDeleteBlob).not.toHaveBeenCalled();
    cleanup(); // the form unmounts without Save
    await waitFor(() => expect(t.onDeleteBlob).toHaveBeenCalledWith(MID, SERVER));
  });

  it('the saved config\'s own blob is never swept as an orphan when the form closes', async () => {
    const t = setup();
    cleanup();
    expect(t.onDeleteBlob).not.toHaveBeenCalled();
  });

  it('a picture that is saved is kept, and then closing the form deletes nothing', async () => {
    const t = setup({ publishedState: undefined });
    await t.pickBanner(1);
    t.save();
    await waitFor(() => expect(t.onSaveConfig).toHaveBeenCalledTimes(1));
    // The previously saved blob (OLD) goes; the new one (MID) must not.
    await waitFor(() => expect(t.onDeleteBlob).toHaveBeenCalledWith(OLD, SERVER));
    cleanup();
    expect(t.onDeleteBlob).not.toHaveBeenCalledWith(MID, SERVER);
  });
});

describe('R4: replaced or removed saved blobs', () => {
  it('not published: the old blob is deleted after the save, with the result line', async () => {
    const t = setup();
    await t.pickBanner(1);
    t.save();
    expect(await screen.findByText('Old picture deleted from nostr.download.')).toBeDefined();
    expect(t.onDeleteBlob).toHaveBeenCalledWith(OLD, SERVER);
    expect(t.order).toEqual(['save', 'delete:a1']); // after the save, never before
  });

  it('not published: removing the saved banner and saving deletes it', async () => {
    const t = setup();
    const removes = screen.getAllByRole('button', { name: 'Remove' });
    fireEvent.click(removes[removes.length - 1]);
    t.save();
    expect(await screen.findByText('Old picture deleted from nostr.download.')).toBeDefined();
    expect(t.onDeleteBlob).toHaveBeenCalledWith(OLD, SERVER);
  });

  it('published and "Save locally for now": the old blob stays and the line says why', async () => {
    const t = setup({ publishedState: PUBLISHED });
    await t.pickBanner(1);
    t.save();
    fireEvent.click(await screen.findByRole('button', { name: /save locally for now/i }));
    expect(await screen.findByText('The old picture stays on nostr.download because your published profile still shows it.')).toBeDefined();
    expect(t.onDeleteBlob).not.toHaveBeenCalledWith(OLD, SERVER);
    expect(t.onPublishNow).not.toHaveBeenCalled();
  });

  it('published and the save republishes: the old blob is deleted after the publish lands', async () => {
    const t = setup({ publishedState: PUBLISHED });
    await t.pickBanner(1);
    t.save();
    fireEvent.click(await screen.findByRole('button', { name: /yes, republish/i }));
    expect(await screen.findByText('Old picture deleted from nostr.download.')).toBeDefined();
    expect(t.order).toEqual(['save', 'publish', 'delete:a1']);
  });

  it('published and the republish fails: the old blob is kept', async () => {
    const t = setup({ publishedState: PUBLISHED, onPublishNow: async () => { throw new Error('relay said no'); } });
    await t.pickBanner(1);
    t.save();
    fireEvent.click(await screen.findByRole('button', { name: /yes, republish/i }));
    expect(await screen.findByText('relay said no')).toBeDefined();
    expect(t.onDeleteBlob).not.toHaveBeenCalledWith(OLD, SERVER);
  });

  it('published with no republish path wired: the old blob stays', async () => {
    const t = setup({ publishedState: PUBLISHED, withPublish: false });
    await t.pickBanner(1);
    t.save();
    expect(await screen.findByText(/The old picture stays on nostr\.download/)).toBeDefined();
    expect(t.onDeleteBlob).not.toHaveBeenCalledWith(OLD, SERVER);
  });

  it('a blob a pasted external link replaces is deleted; an external link being replaced is not', async () => {
    const t = setup();
    const urlInput = screen.getAllByPlaceholderText('or paste URL');
    fireEvent.change(urlInput[urlInput.length - 1], { target: { value: 'https://example.com/banner.jpg' } });
    t.save();
    await waitFor(() => expect(t.onDeleteBlob).toHaveBeenCalledWith(OLD, SERVER));

    cleanup();
    const t2 = setup({ config: savedConfig({ bannerUrl: 'https://example.com/old.jpg', bannerBlossomHash: undefined }) });
    await t2.pickBanner(1);
    t2.save();
    await waitFor(() => expect(t2.onSaveConfig).toHaveBeenCalled());
    expect(t2.onDeleteBlob).not.toHaveBeenCalledWith(expect.anything(), expect.anything());
  });
});

describe('R6: a failed delete never blocks the save', () => {
  it('a refused delete (401/403) shows the "Couldn\'t delete" line and the save stands', async () => {
    const t = setup({ outcome: 'failed' });
    await t.pickBanner(1);
    t.save();
    expect(await screen.findByText("Couldn't delete the old picture from nostr.download.")).toBeDefined();
    expect(t.onSaveConfig).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).toBeNull(); // no save error
  });

  it('a delete that throws is reported the same way and still does not block', async () => {
    const t = setup({ outcome: 'throw' });
    await t.pickBanner(1);
    t.save();
    expect(await screen.findByText("Couldn't delete the old picture from nostr.download.")).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a blob something else still references says nothing (R1 answers "kept")', async () => {
    const t = setup({ outcome: 'kept' });
    await t.pickBanner(1);
    t.save();
    await waitFor(() => expect(t.onDeleteBlob).toHaveBeenCalledWith(OLD, SERVER));
    expect(screen.queryByText(/Old picture deleted|Couldn't delete/)).toBeNull();
  });

  it('a failed save deletes nothing', async () => {
    const t = setup({ onSaveConfig: async () => { throw new Error('disk full'); } });
    await t.pickBanner(1);
    t.save();
    expect(await screen.findByText('disk full')).toBeDefined();
    expect(t.onDeleteBlob).not.toHaveBeenCalledWith(OLD, SERVER);
  });
});

