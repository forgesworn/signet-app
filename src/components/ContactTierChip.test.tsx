// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ContactTierChip } from './ContactTierChip';

describe('ContactTierChip', () => {
  it('renders a direct tier with no provenance suffix', () => {
    render(<ContactTierChip tier="kin" source="direct" />);
    expect(screen.getByText('Kin')).toBeDefined();
    expect(screen.queryByText(/via/)).toBeNull();
  });

  it('names the guardian for a vouched tier', () => {
    render(<ContactTierChip tier="kin" source="guardian-vouched" guardianName="Joe" />);
    expect(screen.getByText('Kin')).toBeDefined();
    expect(screen.getByText('via Joe')).toBeDefined();
  });

  it('marks a guardian-limited tier', () => {
    render(<ContactTierChip tier="ken" source="guardian-limited" guardianName="Joe" />);
    expect(screen.getByText('guardian-limited')).toBeDefined();
  });

  it('renders a Blocked badge beside the tier', () => {
    render(<ContactTierChip tier="kith" source="direct" blocked />);
    expect(screen.getByText('Blocked')).toBeDefined();
    expect(screen.getByText('Kith')).toBeDefined();
  });

  it('labels the no-tier case', () => {
    render(<ContactTierChip tier="none" />);
    expect(screen.getByText('No tier')).toBeDefined();
  });
});
