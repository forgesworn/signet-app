// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { ActivateRealIdentity } from './ActivateRealIdentity';

function renderPage(overrides: Partial<React.ComponentProps<typeof ActivateRealIdentity>> = {}) {
  const props = {
    target: { kind: 'owner' as const },
    backupStep: 'none' as const,
    recoveryWords: [] as string[],
    onActivate: vi.fn().mockResolvedValue(undefined),
    onMarkBackedUp: vi.fn().mockResolvedValue(undefined),
    onDone: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
  render(<ActivateRealIdentity {...props} />);
  return props;
}

describe('ActivateRealIdentity', () => {
  it('opens on the explanation and the legal-name field', () => {
    renderPage();
    expect(screen.getByText(/carries your legal name/i)).toBeDefined();
    expect(screen.getByPlaceholderText('Your legal name')).toBeDefined();
  });

  it('keeps Continue disabled until a name is typed', () => {
    renderPage();
    const cont = screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement;
    expect(cont.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText('Your legal name'), { target: { value: 'Real Name' } });
    expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('caps the name at 100 characters', () => {
    renderPage();
    const input = screen.getByPlaceholderText('Your legal name') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'a'.repeat(200) } });
    expect(input.value).toHaveLength(100);
  });

  it('requires the typed confirm before activating', async () => {
    const props = renderPage();
    fireEvent.change(screen.getByPlaceholderText('Your legal name'), { target: { value: 'Real Name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    const confirmBtn = screen.getByRole('button', { name: 'Activate my real identity' }) as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);
    expect(props.onActivate).not.toHaveBeenCalled();

    fireEvent.change(screen.getByPlaceholderText('Real Name'), { target: { value: 'Real Name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Activate my real identity' }));
    await waitFor(() => expect(props.onActivate).toHaveBeenCalledWith('Real Name'));
  });

  it('finishes straight away when there is no backup step', async () => {
    const props = renderPage();
    fireEvent.change(screen.getByPlaceholderText('Your legal name'), { target: { value: 'Real Name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.change(screen.getByPlaceholderText('Real Name'), { target: { value: 'Real Name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Activate my real identity' }));
    await waitFor(() => expect(props.onDone).toHaveBeenCalledTimes(1));
  });

  it('shows the recovery words with a checkbox on the first-backup branch', async () => {
    const props = renderPage({ backupStep: 'first-backup', recoveryWords: ['edge', 'obtain'] });
    fireEvent.change(screen.getByPlaceholderText('Your legal name'), { target: { value: 'Real Name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.change(screen.getByPlaceholderText('Real Name'), { target: { value: 'Real Name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Activate my real identity' }));

    await waitFor(() => expect(screen.getByText('edge')).toBeDefined());
    expect(props.onDone).not.toHaveBeenCalled();
    const done = screen.getByRole('button', { name: 'Done' }) as HTMLButtonElement;
    expect(done.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(props.onMarkBackedUp).toHaveBeenCalledTimes(1));
    expect(props.onDone).toHaveBeenCalledTimes(1);
  });

  it('shows the Lite line and does not mark backed up on the lite-reminder branch', async () => {
    const props = renderPage({ backupStep: 'lite-reminder', recoveryWords: ['edge', 'obtain'] });
    fireEvent.change(screen.getByPlaceholderText('Your legal name'), { target: { value: 'Real Name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.change(screen.getByPlaceholderText('Real Name'), { target: { value: 'Real Name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Activate my real identity' }));

    await waitFor(() => expect(screen.getByText(/Your Lite phrase still works/i)).toBeDefined());
    expect(screen.queryByRole('checkbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(props.onDone).toHaveBeenCalledTimes(1));
    expect(props.onMarkBackedUp).not.toHaveBeenCalled();
  });

  it('surfaces an activation failure inline and stays on the confirm step', async () => {
    const props = renderPage({ onActivate: vi.fn().mockRejectedValue(new Error('Could not save')) });
    fireEvent.change(screen.getByPlaceholderText('Your legal name'), { target: { value: 'Real Name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.change(screen.getByPlaceholderText('Real Name'), { target: { value: 'Real Name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Activate my real identity' }));
    await waitFor(() => expect(screen.getByText('Could not save')).toBeDefined());
    expect(props.onDone).not.toHaveBeenCalled();
  });

  it('never says Guest, provisional or burner', () => {
    const { container } = render(
      <ActivateRealIdentity
        target={{ kind: 'owner' }}
        backupStep="none" recoveryWords={[]}
        onActivate={vi.fn()} onMarkBackedUp={vi.fn()} onDone={vi.fn()} onCancel={vi.fn()}
      />,
    );
    expect(container.textContent).not.toMatch(/guest|provisional|burner/i);
  });
});

/**
 * Security convention: mnemonic words auto-hide after 90 s. Security
 * settings hides its grid; Get Verified advances the phase off the words. This
 * surface hides them in place — auto-advancing here would either mark the
 * backup acknowledged without the checkbox, or drop the user out of activation.
 */
describe('ActivateRealIdentity — recovery-words auto-hide', () => {
  afterEach(() => { vi.useRealTimers(); });

  async function reachBackupStep(backupStep: 'first-backup' | 'lite-reminder' = 'first-backup') {
    // Fake timers BEFORE mount: the auto-hide timer is armed by the effect that
    // runs when the backup step renders, so a later swap would leave a real one
    // that `advanceTimersByTime` can never fire.
    vi.useFakeTimers();
    const props = renderPage({ backupStep, recoveryWords: ['edge', 'obtain'] });
    fireEvent.change(screen.getByPlaceholderText('Your legal name'), { target: { value: 'Real Name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.change(screen.getByPlaceholderText('Real Name'), { target: { value: 'Real Name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Activate my real identity' }));
    // `onActivate` resolves on a microtask, so flush promises rather than
    // `waitFor` — waitFor drives the clock itself under fake timers, which is
    // exactly what these tests are measuring.
    await act(async () => {});
    expect(screen.getByText('edge')).toBeDefined();
    return props;
  }

  it('hides the words 90 seconds after they appear', async () => {
    await reachBackupStep();
    act(() => { vi.advanceTimersByTime(89_000); });
    expect(screen.queryByText('edge')).not.toBeNull();
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(screen.queryByText('edge')).toBeNull();
    expect(screen.getByRole('button', { name: /show.*again/i })).toBeDefined();
  });

  it('shows them again on tap, and re-arms the timer', async () => {
    await reachBackupStep();
    act(() => { vi.advanceTimersByTime(90_000); });
    expect(screen.queryByText('edge')).toBeNull();

    act(() => { fireEvent.click(screen.getByRole('button', { name: /show.*again/i })); });
    expect(screen.queryByText('edge')).not.toBeNull();

    act(() => { vi.advanceTimersByTime(90_000); });
    expect(screen.queryByText('edge')).toBeNull();
  });

  it('keeps the Done gate working while the words are hidden', async () => {
    const props = await reachBackupStep();
    act(() => { vi.advanceTimersByTime(90_000); });
    const done = screen.getByRole('button', { name: 'Done' }) as HTMLButtonElement;
    expect(done.disabled).toBe(true);
    act(() => { fireEvent.click(screen.getByRole('checkbox')); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Done' })); });
    expect(props.onMarkBackedUp).toHaveBeenCalledTimes(1);
  });

  it('arms no timer before the backup step is reached', () => {
    vi.useFakeTimers();
    renderPage({ backupStep: 'first-backup', recoveryWords: ['edge', 'obtain'] });
    act(() => { vi.advanceTimersByTime(120_000); });
    // Still on the name step — nothing to hide, and nothing crashed on unmount.
    expect(screen.getByPlaceholderText('Your legal name')).toBeDefined();
  });
});
