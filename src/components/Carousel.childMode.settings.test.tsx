// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { Carousel } from './Carousel';
import { CarouselArrowProvider } from './CarouselArrowContext';
import { resolveActiveIdentity } from '../lib/carousel-utils';
import type { CarouselRow } from '../types';

const seen = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));
vi.mock('./SettingsCard', () => ({
  SettingsCard: (props: Record<string, unknown>) => { seen.props = props; return <div data-testid="settings" />; },
}));

const dependant = {
  id: 'kid', guardianPubkey: 'g'.repeat(64), displayName: 'Kid',
  naturalPerson: { publicKey: '0'.repeat(64), privateKey: '', displayName: 'Kid' },
  persona: { publicKey: '1'.repeat(64), privateKey: '', displayName: 'Kidpad' },
  derivationPath: 'dependant-0', createdAt: 0, autonomyStage: 'full-control', primaryKeypair: 'natural-person',
};
const row = { type: 'dependant-persona', dependant } as unknown as CarouselRow;
const WRITERS = [
  'onSavePersonaConfig', 'onRepublishProfile', 'onUploadPersonaPicture', 'onDeletePublicBlob', 'onUpdateOwnPersonaName',
  'onSetPersonaAvatar', 'onClearPersonaAvatar', 'onNip05Checked', 'onSaveDepPersonaConfig', 'onRepublishDepProfile',
  'onUploadDepPersonaPicture', 'onUpdateDepName', 'onUpdateDepPersonaName', 'onSetDepPersonaAvatar',
  'onClearDepPersonaAvatar', 'onDepNip05Checked',
];

function mount(childMode: boolean) {
  seen.props = null;
  const writers = Object.fromEntries(WRITERS.map(n => [n, vi.fn()]));
  render(
    <CarouselArrowProvider>
      <Carousel row={0} col={4} rows={[row]} activeIdentity={resolveActiveIdentity(row)} animating={false}
        onCommit={vi.fn()} onAnimatingChange={vi.fn()} onNavigateDeepPage={vi.fn()} onQRScanned={vi.fn()}
        onEnterChildMode={vi.fn()} onExitChildMode={vi.fn()} onAddPersona={vi.fn()}
        childMode={childMode} childDependant={childMode ? dependant as never : null} stableChildId={childMode ? 'kid' : null}
        {...writers} />
    </CarouselArrowProvider>,
  );
}
afterEach(cleanup);

describe('Carousel settings column in child mode', () => {
  it('hands the settings card no writer: no rename, avatar, profile save, publish, upload or NIP-05 check', () => {
    mount(true);
    for (const name of WRITERS) expect(seen.props![name], name).toBeUndefined();
  });
  it('outside child mode the writers are passed through', () => {
    mount(false);
    for (const name of WRITERS) expect(seen.props![name], name).toBeTypeOf('function');
  });
});
