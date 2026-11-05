import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForLogin } from './login.cjs';

test('confirmed account saves before closing and reports automatic closure',async()=>{
  let resolveClosed;const closed=new Promise(resolve=>{resolveClosed=resolve;});const events=[];
  const result=await waitForLogin({closed,probe:async()=>({loggedIn:true,name:'测试用户'}),save:async()=>events.push('saved'),close:()=>{events.push('closed');resolveClosed();}});
  assert.deepEqual(events,['saved','closed']);assert.equal(result.loggedIn,true);assert.equal(result.autoClosed,true);
});
test('anonymous, unverifiable and empty-name states do not auto-close',async()=>{
  let resolveClosed;const closed=new Promise(resolve=>{resolveClosed=resolve;});let probes=0,closes=0;
  const states=[{loggedIn:false},{loggedIn:null},{loggedIn:true,name:' '},{loggedIn:true,name:'已确认'}];
  const result=await waitForLogin({closed,probe:async()=>states[probes++],pause:()=>Promise.resolve(),save:async()=>{},close:()=>{closes++;resolveClosed();}});
  assert.equal(probes,4);assert.equal(closes,1);assert.equal(result.name,'已确认');
});
test('manual close during a pending request is not falsely reported as confirmed login',async()=>{
  let resolveClosed;const closed=new Promise(resolve=>{resolveClosed=resolve;});let saved=0;
  const work=waitForLogin({closed,probe:()=>new Promise(()=>{}),save:async()=>{saved++;},close:()=>{throw Error('must not auto-close');}});
  resolveClosed();const result=await work;assert.equal(result.loggedIn,null);assert.equal(result.autoClosed,false);assert.equal(saved,1);
});
test('failed login check keeps window open; failed session save does not close it',async()=>{
  let resolveClosed;const closed=new Promise(resolve=>{resolveClosed=resolve;});let probes=0;
  const result=await waitForLogin({closed,probe:async()=>{probes++;throw Error('verification required');},pause:async()=>resolveClosed(),save:async()=>{},close:()=>{throw Error('must stay open');}});
  assert.equal(probes,1);assert.equal(result.loggedIn,null);
  await assert.rejects(waitForLogin({closed:new Promise(()=>{}),probe:async()=>({loggedIn:true,name:'test'}),save:async()=>{throw Error('save failed');},close:()=>{throw Error('must not close');}}),/save failed/);
});
