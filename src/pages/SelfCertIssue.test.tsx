// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { SigningBackend } from '../lib/signing-backend';
import { shortNpub } from '../lib/signet';
import type { ProScanPickerResult } from './ProScanPicker';

const recipient = 'a'.repeat(64);
vi.mock('./ProScanPicker', () => ({
  ProScanPicker: ({ onConfirmed }: { onConfirmed: (result: ProScanPickerResult) => void }) => (
    <button onClick={() => onConfirmed({
      recipientPubkey: 'a'.repeat(64), credentialType: 'pupil-identity',
      claimedFirm: 'Example School', claimedFirmKind: 'school', claimedRole: 'class-teacher',
    })}>Confirm credential</button>
  ),
}));
vi.mock('../lib/relay-service', () => ({ publishEvent: vi.fn() }));

import { SelfCertIssue } from './SelfCertIssue';

describe('SelfCertIssue authentication', () => {
  it('names the pending credential, firm and recipient before signing, and cancellation issues nothing', async () => {
    const requestAuth = vi.fn(async () => null);
    const signEvent = vi.fn(), onSave = vi.fn(), onComplete = vi.fn();
    render(<SelfCertIssue professionKind="school" proBackend={{ signEvent } as unknown as SigningBackend}
      proPersonaPubkey={'b'.repeat(64)} requestAuth={requestAuth} onSave={onSave}
      onComplete={onComplete} onBack={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm credential' }));
    await waitFor(() => expect(requestAuth).toHaveBeenCalledWith({
      purpose: 'issue-professional-credential-pending', firmName: 'Example School',
      recipientShort: shortNpub(recipient), credentialType: 'Pupil identity',
    }));
    await screen.findByRole('button', { name: 'Confirm credential' });
    expect(signEvent).not.toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });
});
