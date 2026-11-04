// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { HandshakeSeamGapCard } from './HandshakeSeamGapCard';

describe('HandshakeSeamGapCard — Jigsaw edge distance', () => {
  it('shows the default as the placeholder and the hint', () => {
    render(<HandshakeSeamGapCard mm={undefined} onSet={vi.fn()} />);
    const input = screen.getByLabelText('Jigsaw edge distance') as HTMLInputElement;
    expect(input.placeholder).toBe('12.7'); expect(input.value).toBe('');
    expect([input.min, input.max, input.step]).toEqual(['0', '30', '0.5']);
    expect(screen.getByText(/From the top of the Jigsaw lines to the top edge of your phone/)).toBeInTheDocument();
  });
  it('saves a valid distance, ignores an invalid or out-of-range one, and Use default clears it', () => {
    const onSet = vi.fn();
    render(<HandshakeSeamGapCard mm={12} onSet={onSet} />);
    const input = screen.getByLabelText('Jigsaw edge distance') as HTMLInputElement;
    expect(input.value).toBe('12');
    fireEvent.change(input, { target: { value: '15.5' } });
    expect(onSet).toHaveBeenLastCalledWith(15.5);
    onSet.mockClear();
    for (const bad of ['31', '-2', '']) fireEvent.change(input, { target: { value: bad } });
    expect(onSet).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '0' } });
    expect(onSet).toHaveBeenLastCalledWith(0);
    fireEvent.click(screen.getByRole('button', { name: 'Use default' }));
    expect(onSet).toHaveBeenLastCalledWith(undefined);
    expect(input.value).toBe('');
  });
});
