// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Profile } from './Profile';

function makeIdentity(extra?: Record<string, unknown>) {
  return {
    id: 'a'.repeat(64),
    primaryKeypair: 'natural-person' as const,
    naturalPerson: { publicKey: 'a'.repeat(64), privateKey: 'b'.repeat(64), displayName: 'Sarah Smith' },
    persona: { publicKey: 'c'.repeat(64), privateKey: 'd'.repeat(64), displayName: 'Sarah Anon' },
    mnemonic: '',
    isChild: false,
    createdAt: 0,
    ...extra,
  } as any;
}

describe('Profile — Professional name row', () => {
  it('renders a "Professional name" row inside the Professional section', () => {
    render(
      <Profile
        identity={makeIdentity({ professionalPersona: { displayName: 'Sarah Jones', publicKey: 'e'.repeat(64), privateKey: 'f'.repeat(64) } })}
        onUpdateName={vi.fn()}
        onUpdatePhoto={vi.fn()}
        ownBadge={null}
        connectedSiteCount={0}
        onNavigateConnections={vi.fn()}
        onNavigateBadgeEmbed={vi.fn()}
        onGoToProfessional={vi.fn()}
        onSaveProName={vi.fn()}
      />
    );
    expect(screen.getByText(/Professional name/)).toBeDefined();
    expect(screen.getByDisplayValue('Sarah Jones')).toBeDefined();
  });

  it('calls onSaveProName with trimmed value on blur', () => {
    const onSaveProName = vi.fn();
    render(
      <Profile
        identity={makeIdentity({ professionalPersona: { displayName: 'Sarah Jones', publicKey: 'e'.repeat(64), privateKey: 'f'.repeat(64) } })}
        onUpdateName={vi.fn()}
        onUpdatePhoto={vi.fn()}
        ownBadge={null}
        connectedSiteCount={0}
        onNavigateConnections={vi.fn()}
        onNavigateBadgeEmbed={vi.fn()}
        onGoToProfessional={vi.fn()}
        onSaveProName={onSaveProName}
      />
    );
    const input = screen.getByDisplayValue('Sarah Jones');
    fireEvent.change(input, { target: { value: '  Sarah Jones QC  ' } });
    fireEvent.blur(input);
    expect(onSaveProName).toHaveBeenCalledWith('Sarah Jones QC');
  });

  it('does not render Professional name row when professionalPersona is absent', () => {
    render(
      <Profile
        identity={makeIdentity({ professionalPersona: undefined })}
        onUpdateName={vi.fn()}
        onUpdatePhoto={vi.fn()}
        ownBadge={null}
        connectedSiteCount={0}
        onNavigateConnections={vi.fn()}
        onNavigateBadgeEmbed={vi.fn()}
        onGoToProfessional={vi.fn()}
        onSaveProName={vi.fn()}
      />
    );
    expect(screen.queryByText(/Professional name/)).toBeNull();
  });
});
