// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RecoveryWordsGrid } from './RecoveryWordsGrid';

/** The frozen 19-word vector from nsec-tree/RECOVERY.md (all-zero entropy). */
const TYPED_19 =
  'edge obtain doll auto level leave morning abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'.split(
    ' ',
  );

describe('RecoveryWordsGrid', () => {
  it('renders every word with a 1-based position number', () => {
    render(<RecoveryWordsGrid words={['edge', 'obtain', 'doll']} />);
    expect(screen.getByText('edge')).toBeDefined();
    expect(screen.getByText('obtain')).toBeDefined();
    expect(screen.getByText('doll')).toBeDefined();
    expect(screen.getByText('1')).toBeDefined();
    expect(screen.getByText('3')).toBeDefined();
  });

  it('renders nothing but an empty grid when there are no words', () => {
    const { container } = render(<RecoveryWordsGrid words={[]} />);
    expect(container.querySelectorAll('[data-word-index]')).toHaveLength(0);
  });

  it('numbers a typed envelope 1..19 continuously across both sections', () => {
    const { container } = render(<RecoveryWordsGrid words={TYPED_19} />);
    const indices = Array.from(container.querySelectorAll('[data-word-index]')).map((el) =>
      Number(el.getAttribute('data-word-index')),
    );
    expect(indices).toEqual(Array.from({ length: 19 }, (_, i) => i + 1));
  });

  it('splits a typed envelope into format header and key, and says the header repeats', () => {
    render(<RecoveryWordsGrid words={TYPED_19} />);
    expect(screen.getByText('Format header — words 1 to 7')).toBeDefined();
    expect(screen.getByText('Your key — words 8 to 19')).toBeDefined();
    // The whole point: the reader is told the opening is not evidence of a
    // repeated key. Without this the grid teaches the opposite.
    expect(screen.getByText(/Every Signet backup starts the same way/)).toBeDefined();
  });

  it('handles a 31-word (24-word payload) envelope', () => {
    const words = [...TYPED_19.slice(0, 7), ...Array.from({ length: 24 }, () => 'abandon')];
    render(<RecoveryWordsGrid words={words} />);
    expect(screen.getByText('Format header — words 1 to 7')).toBeDefined();
    expect(screen.getByText('Your key — words 8 to 31')).toBeDefined();
  });

  it('does not label a sequence that is not a typed envelope', () => {
    // A bare 12-word BIP-39 mnemonic has no header, so claiming one would be a
    // lie. Fall back to the plain list.
    const bare = Array.from({ length: 12 }, () => 'abandon');
    const { container } = render(<RecoveryWordsGrid words={bare} />);
    expect(screen.queryByText(/Format header/)).toBeNull();
    expect(container.querySelectorAll('[data-word-index]')).toHaveLength(12);
  });
});
