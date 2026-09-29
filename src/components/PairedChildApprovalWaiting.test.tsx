// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PairedChildApprovalWaiting } from './PairedChildApprovalWaiting';
import { CHILD_WAITING_COPY } from '../lib/child-device-copy';

describe('PairedChildApprovalWaiting', () => {
  it('a child paired straight to the Heartwood is told the ask is on the guardian\'s phone', () => {
    render(<PairedChildApprovalWaiting onCancel={() => {}} direct />);
    expect(screen.getByText(CHILD_WAITING_COPY.title)).toBeTruthy();
    expect(screen.getByText(CHILD_WAITING_COPY.body)).toBeTruthy();
  });

  it('a phone-paired child keeps the existing copy', () => {
    render(<PairedChildApprovalWaiting onCancel={() => {}} />);
    expect(screen.getByText('Asking your guardian to approve…')).toBeTruthy();
  });
});
