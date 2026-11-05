// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { SigningSettings } from './SigningSettings';

vi.mock('../components/QRCode', () => ({ QRCode: ({ data }: { data: string }) => <div data-testid="qr">{data}</div> }));

const URL = `bunker://${'b'.repeat(64)}?relay=wss%3A%2F%2Frelay.example.com`;

function page(over: Partial<Parameters<typeof SigningSettings>[0]> = {}) {
  render(<SigningSettings bunkerServerEnabled onSetBunkerServerEnabled={() => {}} {...over} />);
}

describe('Bunker URL block', () => {
  afterEach(cleanup);

  it('shows the URL and QR when there is one', () => {
    page({ bunkerUrl: URL });
    expect(screen.getByTestId('qr').textContent).toBe(URL);
  });

  it('is hidden in a dependant context, with no advice to set a relay', () => {
    page({ bunkerUrl: null, showPairingUrl: false });
    expect(screen.queryByText('Bunker URL for pairing devices')).toBeNull();
    expect(screen.queryByText(/Set a relay/)).toBeNull();
    expect(screen.queryByTestId('qr')).toBeNull();
    // The master switch is still there.
    expect(screen.getByRole('button', { name: 'Turn the Bunker off' })).toBeDefined();
  });

  it('asks for a relay only when a relay is what is missing', () => {
    page({ bunkerUrl: null });
    expect(screen.getByText('Set a relay in Settings → Advanced first.')).toBeDefined();
  });

  it('says there is no key to serve when that is why there is no URL', () => {
    page({ bunkerUrl: null, pairingKeyAvailable: false });
    expect(screen.getByText(/no key the Bunker can serve/)).toBeDefined();
    expect(screen.queryByText(/Set a relay/)).toBeNull();
  });
});
