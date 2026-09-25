// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SignetIQ } from './SignetIQ';

describe('SignetIQ', () => {
  it('renders the score', () => {
    render(<SignetIQ score={85} />);
    expect(screen.getByText('85')).toBeDefined();
  });

  it('shows the explainer toggle', () => {
    render(<SignetIQ score={85} />);
    expect(screen.getByText('What does this mean?')).toBeDefined();
  });

  it('toggles the explainer on click', () => {
    render(<SignetIQ score={85} />);
    const toggle = screen.getByText('What does this mean?');

    // Initially collapsed
    expect(screen.queryByText('Passport-level')).toBeNull();

    fireEvent.click(toggle);

    // Expanded
    expect(screen.getByText('Peer-verified')).toBeDefined();
    expect(screen.getByText('Passport-level')).toBeDefined();
    expect(screen.getByText('Multi-professional')).toBeDefined();

    // Collapse again
    fireEvent.click(toggle);
    expect(screen.queryByText('Passport-level')).toBeNull();
  });

  it('renders breakdown items when provided', () => {
    render(<SignetIQ score={120} breakdown={[{ label: 'Professional verification', points: 80, max: 80 }]} />);
    expect(screen.getByText('Professional verification')).toBeDefined();
    expect(screen.getByText('80/80')).toBeDefined();
  });

  it('renders total row in breakdown', () => {
    render(<SignetIQ score={120} breakdown={[
      { label: 'Professional verification', points: 80, max: 80 },
      { label: 'Online vouches (capped at 5)', points: 12, max: 20 },
    ]} />);
    expect(screen.getByText('Total')).toBeDefined();
    expect(screen.getByText('92/200')).toBeDefined();
  });
});
