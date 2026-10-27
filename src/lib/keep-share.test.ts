import { describe, it, expect, vi } from 'vitest';
import { shareInviteLink, type ShareDeps } from './keep-share';

const LINK = 'stampede://keep?x=1';

function deps(over: Partial<ShareDeps> = {}): ShareDeps {
  return {
    isNative: () => false,
    nativeShare: vi.fn(async () => {}),
    webShare: vi.fn(async () => {}),
    copy: vi.fn(async () => {}),
    ...over,
  };
}

describe('shareInviteLink', () => {
  it('opens the native sheet in the app, not the web share or the clipboard', async () => {
    const d = deps({ isNative: () => true });
    expect(await shareInviteLink(LINK, d)).toBe('shared');
    expect(d.nativeShare).toHaveBeenCalledWith(LINK);
    expect(d.webShare).not.toHaveBeenCalled();
    expect(d.copy).not.toHaveBeenCalled();
  });

  it('uses the web share in a browser', async () => {
    const d = deps();
    expect(await shareInviteLink(LINK, d)).toBe('shared');
    expect(d.webShare).toHaveBeenCalledWith(LINK);
    expect(d.nativeShare).not.toHaveBeenCalled();
  });

  it('reports a dismissed native sheet as cancelled and does not copy', async () => {
    const d = deps({ isNative: () => true, nativeShare: vi.fn(async () => { throw new Error('Share canceled'); }) });
    expect(await shareInviteLink(LINK, d)).toBe('cancelled');
    expect(d.copy).not.toHaveBeenCalled();
  });

  it('reports a dismissed web share as cancelled', async () => {
    const abort = new DOMException('x', 'AbortError');
    const d = deps({ webShare: vi.fn(async () => { throw abort; }) });
    expect(await shareInviteLink(LINK, d)).toBe('cancelled');
  });

  it('copies when the native sheet fails', async () => {
    const d = deps({ isNative: () => true, nativeShare: vi.fn(async () => { throw new Error('Unimplemented'); }) });
    expect(await shareInviteLink(LINK, d)).toBe('copied');
    expect(d.copy).toHaveBeenCalledWith(LINK);
  });

  it('copies when there is no web share', async () => {
    const d = deps({ webShare: undefined });
    expect(await shareInviteLink(LINK, d)).toBe('copied');
  });

  it('fails when nothing can share or copy, or the clipboard refuses', async () => {
    expect(await shareInviteLink(LINK, deps({ webShare: undefined, copy: undefined }))).toBe('failed');
    expect(await shareInviteLink(LINK, deps({ webShare: undefined, copy: vi.fn(async () => { throw new Error('no'); }) }))).toBe('failed');
  });
});
