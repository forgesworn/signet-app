// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedIdentity } from '../lib/carousel-utils';

vi.mock('./QRScanner', () => ({ QRScanner: () => null }));
vi.mock('./MiniIdBadge', () => ({ MiniIdBadge: () => null }));

import { CameraCard } from './CameraCard';

const resolved = { displayName: 'Sam', displayNameIsSet: true, publicKey: 'a'.repeat(64), type: 'Persona', isDependant: false } as ResolvedIdentity;

afterEach(cleanup);

async function submit(value: string) {
  fireEvent.click(document.querySelector('.viewfinder')!);
  fireEvent.change(screen.getByTestId('camera-card-paste-input'), { target: { value } });
  fireEvent.click(screen.getByText('Submit'));
}

describe('CameraCard scan errors', () => {
  it('shows an error the scan handler returns, and clears it on the next scan', async () => {
    const onQRScanned = vi.fn().mockResolvedValueOnce('That is one of your own keys.').mockReturnValueOnce(undefined);
    render(<CameraCard resolved={resolved} onQRScanned={onQRScanned} />);
    await submit('npub1x');
    expect(await screen.findByRole('alert')).toHaveTextContent('That is one of your own keys.');
    await submit('npub1y');
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(onQRScanned).toHaveBeenCalledTimes(2);
  });

  it('shows nothing when the handler returns nothing', async () => {
    render(<CameraCard resolved={resolved} onQRScanned={() => undefined} />);
    await submit('npub1x');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
