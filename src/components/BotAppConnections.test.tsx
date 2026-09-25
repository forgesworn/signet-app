// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BotAppConnections } from './BotAppConnections';
import { loadBotAppGrants } from '../lib/bot-app-grants';
vi.mock('../lib/bot-app-grants',()=>({loadBotAppGrants:vi.fn(async()=>[])}));
afterEach(cleanup);
it('requires selected actions and passes bot-specific consent and expiry to the authenticated handler',async()=>{
  vi.mocked(loadBotAppGrants).mockResolvedValue([]);
  const connect=vi.fn().mockResolvedValue(undefined),bot='b'.repeat(64),client='c'.repeat(64);
  render(<BotAppConnections root={'a'.repeat(64)} encryptionKey="test" botPubkey={bot} label="Helper" version={0} actions={{connect,revoke:vi.fn()}} />);
  const uri=`nostrconnect://${client}?relay=wss%3A%2F%2Frelay.test&secret=test-secret&metadata=${encodeURIComponent(JSON.stringify({name:'Game'}))}`;
  fireEvent.change(screen.getByLabelText('Bot app connection QR text'),{target:{value:uri}});fireEvent.click(screen.getByText('Review bot app permissions'));
  expect((screen.getByText('Allow selected bot actions') as HTMLButtonElement).disabled).toBe(true);expect(connect).not.toHaveBeenCalled();
  fireEvent.click(screen.getByLabelText('Write notes'));fireEvent.click(screen.getByText('Allow selected bot actions'));
  await waitFor(()=>expect(connect).toHaveBeenCalledOnce());
  expect(connect.mock.calls[0].slice(0,4)).toEqual([bot,expect.objectContaining({clientPubkey:client}),[1],86400]);
  await waitFor(()=>expect(screen.getByRole('status').textContent).toBe('Bot app connected.'));
});
