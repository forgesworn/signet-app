// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { HandshakeQR } from './HandshakeQR';
import { compactHandshakeInvite, createHandshakeFrameReader, handshakeFrames } from '../lib/handshake-optical';
vi.mock('./QRCode', () => ({ QRCode: ({ data }: { data: string }) => <canvas data-testid="qr" data-payload={data} /> }));
afterEach(() => { cleanup(); vi.useRealTimers(); });
it('cycles coarse fragments slowly enough for camera sampling, resets for a new invite and stops on leaving', () => {
  vi.useFakeTimers();
  const payload = compactHandshakeInvite({ v: 1, recipient: '1'.repeat(64), secret: '2'.repeat(64),
    expiresAt: 1700000120, relays: ['wss://first.example/', 'wss://second.example/', 'wss://third.example/'] })!;
  const frames = handshakeFrames(payload, true), read = createHandshakeFrameReader();
  const view = render(<HandshakeQR data={payload} />);
  const displayed = () => screen.getByTestId('qr').getAttribute('data-payload')!;
  expect(displayed()).toBe(frames[0]); expect(read(displayed(), 0)).toBeNull();
  act(() => vi.advanceTimersByTime(499)); expect(displayed()).toBe(frames[0]);
  for (let i = 1; i < frames.length; i++) {
    act(() => vi.advanceTimersByTime(i === 1 ? 1 : 500));
    expect(displayed()).toBe(frames[i]);
    expect(read(displayed(), i * 500)).toBe(i === frames.length - 1 ? payload : null);
  }
  view.rerender(<HandshakeQR data="plain-single-invite" />); expect(displayed()).toBe('plain-single-invite');
  expect(vi.getTimerCount()).toBe(0); view.unmount(); expect(vi.getTimerCount()).toBe(0);
});
