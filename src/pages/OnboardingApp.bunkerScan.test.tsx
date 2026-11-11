// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { OnboardingApp } from './OnboardingApp';
import { ScannerSettingsContext, DEFAULT_SCANNER_SETTINGS } from '../components/ScannerSettingsContext';

// The real scanner needs a camera; this stand-in lets a test "scan" a value.
let scanValue = '';
vi.mock('../components/QRScanner', () => ({
  QRScanner: ({ onScan }: { onScan: (data: string) => void }) => (
    <button type="button" data-testid="fake-scanner" onClick={() => onScan(scanValue)}>camera</button>
  ),
}));

const URI = 'bunker://' + 'a'.repeat(64) + '?relay=wss://relay.example.com&secret=x';

function openUriStep(onConnectHeartwood = vi.fn((_uri: string, _name: string) => Promise.resolve()), autoStart = true) {
  const wrap = ({ children }: { children: ReactNode }) => (
    <ScannerSettingsContext.Provider value={{ ...DEFAULT_SCANNER_SETTINGS, autoStart }}>{children}</ScannerSettingsContext.Provider>
  );
  render(<OnboardingApp onCreate={vi.fn()} onImport={vi.fn()} onImportLiteMnemonic={vi.fn()} onImportNsec={vi.fn()}
    onConnectHeartwood={onConnectHeartwood} onConnectNip07={vi.fn()} onStartChildPair={vi.fn()} />, { wrapper: wrap });
  fireEvent.click(screen.getByRole('button', { name: 'I already have a Signet' }));
  fireEvent.click(screen.getByRole('button', { name: 'Connect a remote signer' }));
  return onConnectHeartwood;
}

describe('OnboardingApp remote signer QR scan', () => {
  afterEach(() => { cleanup(); scanValue = ''; });

  it('opens the camera and keeps the paste box on the same step', () => {
    openUriStep();
    expect(screen.getByTestId('fake-scanner')).toBeTruthy();
    expect(screen.getByPlaceholderText('bunker://...')).toBeTruthy();
  });

  it('a scanned bunker:// code goes to the name step and is the URI that connects', async () => {
    const onConnect = openUriStep();
    scanValue = `  ${URI}\n`;
    fireEvent.click(screen.getByTestId('fake-scanner'));
    fireEvent.change(screen.getByPlaceholderText('Name or handle'), { target: { value: 'Moss' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(onConnect).toHaveBeenCalled());
    expect(onConnect.mock.calls[0][0]).toBe(URI);
    expect(onConnect.mock.calls[0][1]).toBe('Moss');
  });

  it('a code that is not a bunker:// connection says so and offers Scan again', () => {
    openUriStep();
    scanValue = 'https://example.com/not-a-signer';
    fireEvent.click(screen.getByTestId('fake-scanner'));
    expect(screen.getByText(/isn't a bunker:\/\/ connection/)).toBeTruthy();
    expect(screen.queryByTestId('fake-scanner')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Scan again' }));
    expect(screen.getByTestId('fake-scanner')).toBeTruthy();
    expect(screen.queryByText(/isn't a bunker:\/\/ connection/)).toBeNull();
  });

  it('with camera auto-start off, the camera waits for Scan QR code', () => {
    openUriStep(undefined, false);
    expect(screen.queryByTestId('fake-scanner')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Scan QR code' }));
    expect(screen.getByTestId('fake-scanner')).toBeTruthy();
  });

  it('pasting still works', () => {
    openUriStep();
    fireEvent.change(screen.getByPlaceholderText('bunker://...'), { target: { value: URI } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByPlaceholderText('Name or handle')).toBeTruthy();
  });
});
