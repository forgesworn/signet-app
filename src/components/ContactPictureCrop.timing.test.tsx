// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ContactPictureCrop } from './ContactPictureCrop';
import type { CropPicture } from '../lib/picture-crop-loader';

// `findBy*` can hand the stage back before React has run its passive effects:
// they flush on a scheduler task, and on a loaded machine that task can land
// after Testing Library's own setTimeout(0) drain. A wheel listener attached in
// useEffect then misses the first scroll (the page scrolls instead), which made
// ContactPictureCrop.test.tsx's wheel test fail on CI now and then.
//
// A MutationObserver callback runs in the microtask right after the commit that
// inserts the stage: layout effects have run by then, passive effects have not.
// Scrolling there pins the listener to the commit, with no timing luck involved.
describe('ContactPictureCrop wheel listener timing', () => {
  it('takes the wheel in the same commit that puts the photo on screen', async () => {
    const picture: CropPicture = { src: 'blob:photo', width: 1000, height: 500, release: vi.fn() };
    let prevented: boolean | undefined;
    const observer = new MutationObserver(() => {
      const stage = screen.queryByTestId('crop-stage');
      if (!stage || prevented !== undefined) return;
      observer.disconnect();
      const event = createEvent.wheel(stage, { deltaY: -100 });
      fireEvent(stage, event);
      prevented = event.defaultPrevented;
    });
    observer.observe(document.body, { childList: true, subtree: true });
    try {
      render(<ContactPictureCrop file={new Blob([new Uint8Array([1])])} onUse={vi.fn()} onCancel={vi.fn()} loadPicture={async () => picture} />);
      await waitFor(() => expect(prevented).toBeDefined());
      expect(prevented).toBe(true);
    } finally {
      observer.disconnect();
    }
  });
});
