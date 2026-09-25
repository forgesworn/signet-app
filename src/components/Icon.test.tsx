// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Icon } from './Icon';

describe('Icon', () => {
  it('is decorative (aria-hidden, no role) with no title', () => {
    const { container } = render(<Icon name="home" />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(svg?.getAttribute('role')).toBeNull();
    expect(svg?.querySelector('title')).toBeNull();
  });

  it('becomes a meaningful image when given a title', () => {
    const { container } = render(<Icon name="key" title="Bunker" />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('role')).toBe('img');
    expect(svg?.getAttribute('aria-hidden')).toBeNull();
    expect(svg?.querySelector('title')?.textContent).toBe('Bunker');
  });

  it('sizes via width/height and colours via currentColor', () => {
    const { container } = render(<Icon name="x" size={32} />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('width')).toBe('32');
    expect(svg?.getAttribute('height')).toBe('32');
    expect(svg?.getAttribute('stroke')).toBe('currentColor');
    expect(svg?.getAttribute('fill')).toBe('none');
  });

  it('applies a passed className to the root svg', () => {
    const { container } = render(<Icon name="settings" className="my-icon" />);
    expect(container.querySelector('svg.my-icon')).not.toBeNull();
  });

  it('renders every icon name without throwing', () => {
    const names: Array<Parameters<typeof Icon>[0]['name']> = [
      'home', 'users', 'user', 'key', 'settings', 'checkCircle', 'alertTriangle',
      'x', 'smartphone', 'idCard', 'link', 'puzzle', 'clipboard', 'globe',
      'landmark', 'grid', 'scan', 'download',
    ];
    for (const name of names) {
      const { container } = render(<Icon name={name} />);
      expect(container.querySelector('svg')?.childElementCount).toBeGreaterThan(0);
    }
  });
});
