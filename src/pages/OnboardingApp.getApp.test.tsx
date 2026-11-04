// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

const mocks = vi.hoisted(() => ({ isNativeApp: vi.fn(() => false) }));
vi.mock('../lib/native', () => mocks);

import { OnboardingApp } from './OnboardingApp';
import { ANDROID_APP_URL } from '../lib/android-promo';

function setUA(ua: string) {
  Object.defineProperty(navigator, 'userAgent', { value: ua, configurable: true });
}
function renderWelcome() {
  render(<OnboardingApp onCreate={vi.fn()} onImport={vi.fn()} onImportLiteMnemonic={vi.fn()} onImportNsec={vi.fn()}
    onConnectHeartwood={vi.fn()} onConnectNip07={vi.fn()} onStartChildPair={vi.fn()} />);
}

describe('OnboardingApp welcome — get the app', () => {
  beforeEach(() => { mocks.isNativeApp.mockReturnValue(false); });
  afterEach(() => cleanup());

  it('Android web: shows the get-the-app card linking to the get page, above Create', () => {
    setUA('Mozilla/5.0 (Linux; Android 14)');
    renderWelcome();
    const link = screen.getByRole('link', { name: 'Get the app' });
    expect(link.getAttribute('href')).toBe(ANDROID_APP_URL);
    const create = screen.getByRole('button', { name: 'Create my Signet' });
    expect(link.compareDocumentPosition(create) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText(/On Android\?/)).toBeNull();
  });

  it('iPhone / desktop web: only a quiet "On Android?" link', () => {
    setUA('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)');
    renderWelcome();
    expect(screen.queryByText('Best on Android: get the app')).toBeNull();
    expect(screen.getByRole('link', { name: 'Get the app →' }).getAttribute('href')).toBe(ANDROID_APP_URL);
  });

  it('inside the APK: no get-the-app prompt at all', () => {
    setUA('Mozilla/5.0 (Linux; Android 14)');
    mocks.isNativeApp.mockReturnValue(true);
    renderWelcome();
    expect(screen.queryByRole('link', { name: /Get the app/ })).toBeNull();
  });
});
