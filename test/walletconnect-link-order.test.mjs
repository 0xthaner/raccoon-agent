import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ensureAppKitMainnetAccount, normalizeAddress, eoaLoginTexts, guardedChallengeSignSubmit } from '../web/src/eoa-login.js';
const main=readFileSync('web/src/main.js','utf8');
const start=main.indexOf('async function verbindeWalletConnect()');
const source=main.slice(start,main.indexOf("wcButton.addEventListener",start));
const A='0x1111111111111111111111111111111111111111';
const B='0x2222222222222222222222222222222222222222';
async function attempt({initial=137,duringSwitch=false,afterConfirmation=false,afterSwitchAccount=A,finalChain=1,finalAccount=A}={}) {
 const calls=[];let chain=initial,address=A,networkCallback,error;
 const modal={getAddress:()=>address,getChainId:()=>chain,
  switchNetwork:async()=>{calls.push('switch');if(duringSwitch)networkCallback?.({chainId:137});chain=1;address=afterSwitchAccount;},
  subscribeNetwork:(callback)=>{calls.push('arm');networkCallback=callback;return ()=>{calls.push('unarm');};}
 };
 const deps={hinweiseAkzeptiert:true,wcButton:{},show:(message)=>{error=message;},debugWallet:()=>{},
  dashboardRestorePromise:Promise.resolve(),getWalletConnectModal:async()=>modal,
  resetRestoredConnection:async()=>{calls.push('reset');},
  connectWithModal:async()=>{calls.push('connect');return {wallet:A,provider:{request:async({method})=>{calls.push(method);return 'offline-signature';}}};},
  eoaLoginTexts,language:'en',ensureAppKitMainnetAccount,appKitMainnet:{id:1},normalizeAddress,
  withTimeout:(promise)=>promise,trenneWalletConnect:async()=>{},
  finish:async(wallet,sign,isAborted)=>guardedChallengeSignSubmit({texts:eoaLoginTexts('en'),isAborted,
   getChallenge:async()=>{calls.push('challenge');if(afterConfirmation){chain=137;networkCallback({chainId:137});chain=1;}else chain=finalChain;address=finalAccount;return {ok:true,message:'offline challenge'};},
   sign,submit:async()=>{calls.push('verify');return {ok:true};}
  })
 };
 const fn=new Function(...Object.keys(deps),`${source}\nreturn verbindeWalletConnect;`)(...Object.values(deps));
 await fn();return {calls,error};
}
test('Polygon-to-Mainnet synchronization completes before guard is armed',async()=>{
 const {calls}=await attempt({duringSwitch:true});
 assert.deepEqual(calls,['reset','connect','switch','arm','challenge','personal_sign','verify','unarm']);
});
test('Mainnet wallet continues with the same shared link/dashboard signer',async()=>{
 const {calls}=await attempt({initial:1});assert.ok(calls.includes('verify'));
});
test('Mainnet subscription notification does not invalidate signing',async()=>{
 // The callback condition explicitly permits both numeric and hexadecimal Mainnet IDs.
 const callbackSource=source.match(/const unsubscribe = modal.subscribeNetwork\?\.\(\(state\) => \{([^]*?)\}\);/)[1];
 for(const chainId of [1,'1','0x1']) {
  const aborted=new Function('state',`let abgebrochen=false;${callbackSource};return abgebrochen;`)({chainId});
  assert.equal(aborted,false);
 }
});
test('network change after confirmation stays latched even if Mainnet is restored',async()=>{
 const {calls,error}=await attempt({afterConfirmation:true});
 assert.equal(error,eoaLoginTexts('en').chainChanged);assert.ok(!calls.includes('personal_sign'));assert.ok(!calls.includes('verify'));
});
test('account changed during switch rejects before challenge',async()=>{
 const {calls,error}=await attempt({afterSwitchAccount:B});
 assert.equal(error,eoaLoginTexts('en').accountChanged);assert.ok(!calls.includes('challenge'));
});
test('final chain check prevents personal_sign',async()=>{
 const {calls,error}=await attempt({finalChain:137});
 assert.equal(error,eoaLoginTexts('en').notMainnet);assert.ok(!calls.includes('personal_sign'));
});
for(const finalAccount of [B,undefined]) {
 test(`final account check prevents personal_sign (${finalAccount?'changed':'missing'})`,async()=>{
  const {calls,error}=await attempt({finalAccount:finalAccount??''});
  assert.equal(error,eoaLoginTexts('en').accountChanged);assert.ok(!calls.includes('personal_sign'));assert.ok(!calls.includes('verify'));
 });
}
test('Telegram and dashboard use the same guarded signer; HARD-004 signature gate remains',()=>{
 assert.match(main,/if \(!code\) return openDashboard\(wallet, sign, isAborted\)/);
 assert.match(main,/fetch\(`\/api\/link\?code=/);
 assert.match(main,/fetch\('\/api\/link\/verify'/);
 const verify=readFileSync('api/link/verify.mjs','utf8');
 assert.ok(verify.indexOf("verified !== 'VALID'")<verify.indexOf('consumePendingLink(code, wallet)'));
 assert.doesNotMatch(readFileSync('src/bot.mjs','utf8'),/consumeTelegramHandoff\(/);
});
