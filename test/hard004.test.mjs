import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import { telegramSiweMessage, telegramExpectation, verifyExpectedSiweSignature } from '../src/siwe-auth.mjs';
const read = (p) => readFileSync(p, 'utf8');
const dashboard = read('api/dashboard.mjs');
const bot = read('src/bot.mjs');
const verify = read('api/link/verify.mjs');
function loadHandler(source, deps) {
 const body = source.replace(/^import .*;\n/gm, '').replace('export default async function handler', 'async function handler');
 return new Function(...Object.keys(deps), `${body}\nreturn handler;`)(...Object.values(deps));
}
function response() {
 return { headers: {}, status(n) { this.code=n; return this; }, setHeader(k,v) { this.headers[k]=v; }, json(body) { this.body=body; return this; } };
}
import { resolveLogout, CLEAR_SESSION_COOKIES, resolveDashboardSession, createDashboardSession, SESSION_COOKIE } from '../src/dashboard-auth.mjs';

test('dashboard never issues binding handoffs; new and legacy bot payloads require pending-link proof', () => {
 assert.doesNotMatch(dashboard, /newTelegramHandoff/);
 assert.doesNotMatch(bot, /consumeTelegramHandoff\(/);
 assert.match(bot, /connectRequested.*startCodeOf/);
 assert.match(bot, /newLinkRequest\(message.chat.id\)/);
 assert.match(bot, /existingWallet && !connectRequested/);
 assert.match(read('web/src/main.js'), /\?start=connect`/);
 assert.ok(bot.indexOf('if (!authenticPrivateMessage(message)) return') < bot.indexOf('const connectRequested'));
});

for (const transport of ['cookie', 'bearer']) {
 test(`revoked ${transport} logout is idempotent and never kills newer sessions`, async () => {
  // Real token parsing; test-only secret scoped to this process.
  const before=process.env.DASHBOARD_SESSION_SECRET;
  process.env.DASHBOARD_SESSION_SECRET='offline-hard004-test-secret-0123456789';
  try {
   const token=createDashboardSession('0x1111111111111111111111111111111111111111');
   const headers=transport==='cookie'?{cookie:`${SESSION_COOKIE}=${token}`}:{authorization:`Bearer ${token}`};
   let writes=0;
   const handler=loadHandler(dashboard,{resolveDashboardSession,isDashboardSessionRevoked:async()=>true,requireSameOrigin:()=>true,enforceRateLimit:async()=>true,CLEAR_SESSION_COOKIES,resolveLogout,revokeDashboardSessions:async()=>{writes++;}});
   for(let i=0;i<3;i++) {
    const res=response(); await handler({method:'DELETE',query:{},headers},res);
    assert.equal(res.code,200); assert.equal(res.body.ok,true); assert.deepEqual(res.headers['set-cookie'],CLEAR_SESSION_COOKIES);
   }
   assert.equal(writes,0);
  } finally { if(before===undefined) delete process.env.DASHBOARD_SESSION_SECRET; else process.env.DASHBOARD_SESSION_SECRET=before; }
 });
}
for (const mode of ['active','lookup-error','telegram']) {
 test(`logout boundary: ${mode}`, async()=>{
  let writes=0,unlinks=0;
  const handler=loadHandler(dashboard,{
   resolveDashboardSession:()=>({session:{wallet:'0x1111111111111111111111111111111111111111',iat:100}}),
   isDashboardSessionRevoked:async()=>{if(mode==='lookup-error')throw Error('offline');return false;},
   requireSameOrigin:()=>true,enforceRateLimit:async()=>true,CLEAR_SESSION_COOKIES,resolveLogout,
   revokeDashboardSessions:async()=>{writes++;},recordAgentEvent:async()=>{},
   unlinkWalletByWallet:async()=>{unlinks++;return [];}
  });
  const res=response(); await handler({method:'DELETE',query:mode==='telegram'?{telegram:'1'}:{},headers:{}},res);
  assert.equal(res.code,mode==='lookup-error'?503:200);
  assert.equal(writes,mode==='active'?1:0);
  assert.equal(unlinks,mode==='telegram'?1:0);
  if(mode==='lookup-error')assert.equal(res.body.ok,false);
 });
}

for(const mode of ['valid','wrong-wallet','wrong-chat','expired','replay','unsigned']) {
 test(`signed Telegram binding: ${mode}`,async()=>{
  let bound=0;
  const previousOrigin=process.env.APP_BASE_URL;
  process.env.APP_BASE_URL='https://coverraccoon.com';
  try {
  // Public, unfunded offline fixture; never imported by application code.
  const signer=privateKeyToAccount('0x'+'01'.repeat(32));
  const expiresAt=Date.now()+599000;
  const nonce='ab'.repeat(16);
  const original={wallet:signer.address,nonce,expiresAt,issuedAt:expiresAt-600000,code:'pending'};
  const signature=await signer.signMessage({message:telegramSiweMessage(original)});
  const handler=loadHandler(verify,{
   ANMELDUNG_PAUSIERT:false,requireSameOrigin:()=>true,requireJson:()=>true,
   enforceRateLimit:async()=>true,enforceRateLimitFor:async()=>true,
   getPendingLink:async()=>({chat_id:mode==='wrong-chat'?'456':'123',nonce:mode==='wrong-chat'?'cd'.repeat(16):nonce,expires_at:mode==='expired'?1:expiresAt}),
   isAddress:()=>true,linkSiweExpectation:(p)=>telegramExpectation({...p,issuedAt:p.expiresAt-600000}),
   signingMessage:(p)=>telegramSiweMessage({...p,issuedAt:p.expiresAt-600000}),
   verifyWalletSiweSignature:verifyExpectedSiweSignature,
   consumePendingLink:async()=>{if(mode==='replay')return null;bound++;return '123';},
   recordSecurityEvent:async()=>{},SECURITY_EVENT:{},securityFingerprint:()=> 'fingerprint',
   getLanguage:async()=> 'en',process:{env:{TELEGRAM_BOT_TOKEN:'offline-placeholder'}},fetch:async()=>({ok:true})
  });
  const res=response();
  await handler({method:'POST',body:{code:'pending',wallet:mode==='wrong-wallet'?'0x2222222222222222222222222222222222222222':signer.address,signature:mode==='unsigned'?'0x':signature},headers:{}},res);
  if(mode==='valid') assert.equal(res.code,200);
  assert.equal(bound,mode==='valid'?1:0);
  assert.equal(res.headers['set-cookie'],undefined);
  } finally { if(previousOrigin===undefined)delete process.env.APP_BASE_URL;else process.env.APP_BASE_URL=previousOrigin; }
 });
}

test('Telegram final binding ignores client chat identity and consumes only the verified code',()=>{
 assert.match(verify,/const \{ code, wallet, signature \} = request.body/);
 assert.ok(verify.indexOf("verified !== 'VALID'") < verify.indexOf('consumePendingLink(code, wallet)'));
 assert.doesNotMatch(verify,/createDashboardSession|sessionCookieHeader/);
 const db=read('src/db.mjs');
 assert.match(db,/rpc\('consume_wallet_link'/);
});

import { authenticPrivateMessage } from '../src/telegram-audit.mjs';
for (const scenario of ['new-connect','legacy-connect','wrong-sender','group']) {
 test(`bot routing never binds directly: ${scenario}`,async()=>{
  let pending=0,groups=0;
  const source=bot.slice(bot.indexOf('async function handleMessage('),bot.indexOf('async function handleCallbackQuery('));
  const deps={
   authenticPrivateMessage,handleGroupMessage:async()=>{groups++;},commandOf:()=>'/start',
   recordAgentEvent:async()=>{},telegramTimingMetadata:()=>({}),
   startCodeOf:()=>scenario==='legacy-connect'?'a'.repeat(24):null,
   getLanguage:async()=> 'en',getWalletLink:async()=>({wallet:'existing-wallet'}),
   greeting:()=> 'hello',navigationKeyboard:()=>({}),sendMessage:async()=>{},
   ANMELDUNG_PAUSIERT:false,appBaseUrl:'https://coverraccoon.com',
   newLinkRequest:async(chatId)=>{assert.equal(chatId,123);pending++;return {code:'pending'};}
  };
  const handle=new Function(...Object.keys(deps),`${source}\nreturn handleMessage;`)(...Object.values(deps));
  await handle({chat:{id:123,type:scenario==='group'?'group':'private'},from:{id:scenario==='wrong-sender'?456:123},text:scenario==='legacy-connect'?'/start connect_'+'a'.repeat(24):'/start connect'});
  assert.equal(pending,['new-connect','legacy-connect'].includes(scenario)?1:0);
  assert.equal(groups,scenario==='group'?1:0);
 });
}
