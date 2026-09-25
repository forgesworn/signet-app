import { beforeEach, expect, it, vi } from 'vitest';
import { verifyEvent } from 'nostr-tools/pure';
import { botAppRequestHandler } from './bot-app-requests';
import { approveBotAppGrant, revokeBotAppGrant } from './bot-app-grants';
import { createBot } from './bot-registry';
import { purgeAllUserData, saveConnectedClient } from './db';
import { LocalSigningBackend } from './signing-backend';
import type { NostrEvent } from 'signet-protocol';
const botSecret='01'.repeat(32), clientSecret='02'.repeat(32), root='a'.repeat(64), key='bot request test';
const botKey=new LocalSigningBackend(botSecret).activePublicKeyHex, clientKey=new LocalSigningBackend(clientSecret).activePublicKeyHex;
const grantId='d'.repeat(32), relayUrl='wss://relay.test';
const session={root,encryptionKey:key,isCurrent:()=>true,now:()=>100};
const template={kind:1,pubkey:botKey,created_at:100,content:'Bot post',tags:[]};
async function request(method: string, params: string[] = [], id = 'request') {
  const client=new LocalSigningBackend(clientSecret);
  try { return await client.signEvent({kind:24133,pubkey:clientKey,created_at:100,tags:[['p',botKey]],
    content:await client.nip44Encrypt(botKey,JSON.stringify({id,method,params}))}); } finally {client.destroy();}
}
function setup(overrides: Partial<Parameters<typeof botAppRequestHandler>[0]>={}) {
  const publish=vi.fn((_event:NostrEvent)=>true), signer=vi.fn(async()=>new LocalSigningBackend(botSecret));
  return {publish,signer,handle:botAppRequestHandler({...session,botPubkey:botKey,relayUrl,publish,signer,...overrides})};
}
async function consent(){await approveBotAppGrant({...session,grant:{id:grantId,botPubkey:botKey,clientPubkey:clientKey,appName:'Bot game',relayUrl,
  eventKinds:[1],createdAt:100,expiresAt:200}});}
async function response(event:NostrEvent){const client=new LocalSigningBackend(clientSecret);try{return JSON.parse(await client.nip44Decrypt(botKey,event.content));}finally{client.destroy();}}
beforeEach(async()=>{await purgeAllUserData();await createBot({...session,ownerPersona:'b'.repeat(64),ownedPersonas:['b'.repeat(64)],label:'Helper',source:'imported',importedKey:botSecret,now:100});});
it('never inherits owner client permission and binds the grant to the request relay before decrypting',async()=>{
  await saveConnectedClient({clientPubkey:clientKey,appName:'Owner app',allowAlways:true,connectedAt:100,lastSeenAt:100});
  const first=setup();await first.handle(await request('get_public_key'));expect(first.signer).not.toHaveBeenCalled();
  await consent();const wrongRelay=setup({relayUrl:'wss://other.test'});await wrongRelay.handle(await request('get_public_key'));expect(wrongRelay.signer).not.toHaveBeenCalled();
});
it('serves real signed and encrypted requests only for the selected bot and permitted event kinds',async()=>{
  await consent();const {handle,publish}=setup();
  await handle(await request('sign_event',[JSON.stringify(template)]));
  expect(publish).toHaveBeenCalledOnce();const reply=await response(publish.mock.calls[0][0]),signed=JSON.parse(reply.result);
  expect(verifyEvent(signed)).toBe(true);expect(signed.pubkey).toBe(botKey);expect(signed.kind).toBe(1);
  await handle(await request('sign_event',[JSON.stringify({...template,pubkey:root})],'wrong-author'));
  expect((await response(publish.mock.calls[1][0])).error).toBe('event not authorised');
  await handle(await request('sign_event',[JSON.stringify({...template,kind:0})],'wrong-kind'));
  expect((await response(publish.mock.calls[2][0])).error).toBe('event not authorised');
});
it('does not turn a signing grant into a bot identity decryption oracle',async()=>{
  await consent();const backend=new LocalSigningBackend(botSecret),decrypt=vi.spyOn(backend,'nip44Decrypt');
  const {handle,publish}=setup({signer:async()=>backend});
  await handle(await request('nip44_decrypt',[root,'private message']));
  expect(decrypt).toHaveBeenCalledOnce();expect((await response(publish.mock.calls[0][0])).error).toBe('method not authorised');
});
it('drops duplicate envelopes and forged cached signatures before signing',async()=>{
  await consent();const {handle,publish,signer}=setup(),event=await request('get_public_key');
  verifyEvent(event);await handle({...event,sig:'0'.repeat(128)});expect(signer).not.toHaveBeenCalled();
  await Promise.all([handle(event),handle(event)]);expect(publish).toHaveBeenCalledOnce();
  expect((await response(publish.mock.calls[0][0])).result).toBe(botKey);
});
it('withholds a response when consent is revoked during response encryption',async()=>{
  await consent();const backend=new LocalSigningBackend(botSecret),encrypt=backend.nip44Encrypt.bind(backend);
  vi.spyOn(backend,'nip44Encrypt').mockImplementation(async(peer,text)=>{const result=await encrypt(peer,text);await revokeBotAppGrant({...session,grantId});return result;});
  const {handle,publish}=setup({signer:async()=>backend});await handle(await request('get_public_key'));expect(publish).not.toHaveBeenCalled();
});
