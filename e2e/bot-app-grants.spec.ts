import { test, expect } from '@playwright/test';
import { finalizeEvent, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { encrypt, decrypt, getConversationKey } from 'nostr-tools/nip44';
import { clearDatabase, createIdentityAndUnlock, navigateViaHarness } from './fixtures';
import { privateRelays } from './helpers/private-relays';

test('bot app grant scopes signing, survives reload and revokes without inheriting owner permissions', async ({ page, context }) => {
  test.setTimeout(120000);
  const network=privateRelays(); await network.install(context);
  await clearDatabase(page);await createIdentityAndUnlock(page);await navigateViaHarness(page,'bots');
  await page.getByLabel('Bot name').fill('App Helper');await page.getByRole('button',{name:'Create bot',exact:true}).click();
  const pin=async()=>{for(const digit of '123456')await page.getByRole('button',{name:digit,exact:true}).click();};
  await pin();await expect(page.getByRole('heading',{name:'App Helper · Bot',exact:true})).toBeVisible();
  const card=page.locator('section.card').filter({has:page.getByRole('heading',{name:'App Helper · Bot',exact:true})});
  const bot=await card.locator('p').filter({hasText:/^[0-9a-f]{64}$/}).first().innerText();
  const sk=new Uint8Array(32).fill(5),client=getPublicKey(sk),conversation=getConversationKey(sk,bot);
  const uri=new URL(`nostrconnect://${client}`);uri.searchParams.set('relay','wss://relay.test');uri.searchParams.set('secret','bot-app-test-secret');
  uri.searchParams.set('metadata',JSON.stringify({name:'Bot Game'}));
  await page.getByLabel('Bot app connection QR text').fill(uri.toString());await page.getByText('Review bot app permissions').click();
  await expect(page.getByText('Allow selected bot actions')).toBeDisabled();await page.getByLabel('Write notes',{exact:true}).check();
  await page.getByText('Allow selected bot actions').click();await pin();
  await expect(page.getByRole('status')).toHaveText('Bot app connected.',{timeout:30000});
  const replies=()=>[...network.events.values()].filter(e=>e.kind===24133&&e.pubkey===bot&&e.tags.some(t=>t[0]==='p'&&t[1]===client))
    .map(e=>JSON.parse(decrypt(e.content,conversation)));
  expect(replies().some(r=>r.result==='bot-app-test-secret')).toBe(true);
  const send=(id:string,kind:number)=>network.publish(finalizeEvent({kind:24133,created_at:Math.floor(Date.now()/1000),tags:[['p',bot]],
    content:encrypt(JSON.stringify({id,method:'sign_event',params:[JSON.stringify({pubkey:bot,kind,created_at:Math.floor(Date.now()/1000),tags:[],content:'Bot action'})]}),conversation)},sk));
  send('allowed',1);await expect.poll(()=>replies().find(r=>r.id==='allowed'),{timeout:30000}).toBeTruthy();
  const signed=JSON.parse(replies().find(r=>r.id==='allowed').result);expect(signed.pubkey).toBe(bot);expect(verifyEvent(signed)).toBe(true);
  send('blocked-kind',0);await expect.poll(()=>replies().find(r=>r.id==='blocked-kind')?.error,{timeout:30000}).toBe('event not authorised');
  await page.reload();
  await expect(page.locator('.carousel-viewport')).toBeVisible({timeout:30000});
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: /Bots.*Keys and persona ownership/ }).click();
  await pin();
  await expect(page.getByText('Revoke Bot Game')).toBeVisible({timeout:30000});
  send('after-reload',1);await expect.poll(()=>replies().find(r=>r.id==='after-reload'),{timeout:30000}).toBeTruthy();
  await page.getByText('Revoke Bot Game').click();await expect(page.getByText('Revoked',{exact:true})).toBeVisible();
  send('after-revocation',1);
  await page.waitForTimeout(1200);
  expect(replies().find(r=>r.id==='after-revocation')).toBeUndefined();
});
