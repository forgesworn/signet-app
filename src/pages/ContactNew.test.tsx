// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ContactNew } from './ContactNew';

function renderPage(onCreate: () => Promise<void>) {
  const onDone = vi.fn();
  render(<ContactNew subjectName={null} onCreate={onCreate} onDone={onDone} />);
  return { onDone };
}

describe('ContactNew', () => {
  it('T3/I4: shows the generic copy, never the raw error message, when onCreate rejects', async () => {
    const onCreate = vi.fn(async () => { throw new Error('contacts: cannot add — contacts scope not ready'); });
    const { onDone } = renderPage(onCreate);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Dave' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save contact' }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeDefined());
    expect(screen.getByRole('alert')).toHaveTextContent('Could not save this contact.');
    expect(screen.queryByText(/contacts scope not ready/)).toBeNull();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('saves and calls onDone when onCreate resolves', async () => {
    const onCreate = vi.fn(async () => {});
    const { onDone } = renderPage(onCreate);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Dave' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save contact' }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(onCreate).toHaveBeenCalled();
  });

  it('rejects an empty name locally, before ever calling onCreate', () => {
    const onCreate = vi.fn(async () => {});
    renderPage(onCreate);
    fireEvent.click(screen.getByRole('button', { name: 'Save contact' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a name.');
    expect(onCreate).not.toHaveBeenCalled();
  });
});
