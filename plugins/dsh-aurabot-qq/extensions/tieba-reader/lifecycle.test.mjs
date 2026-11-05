import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import moduleDef from './index.mjs';

function harness(t, overrides={}) {
  const dir=mkdtempSync(join(tmpdir(),'tieba-lifecycle-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  if(overrides.state)writeFileSync(join(dir,'state.json'),JSON.stringify(overrides.state));
  const settings={...moduleDef.defaults,bars:'测试',autoBrowse:true,startHour:0,endHour:0,intervalMinutes:10,...overrides.settings};
  const cfg={enabled:true,dryRun:false,ownerQQ:'12345'};
  const disposers=[];const kinds=[];const sentTexts=[];let reads=0,asks=0,sends=0;let now=Date.UTC(2026,9,29,10);
  const secrets=[];const routes=new Map();const builders=[];
  const api={lib:()=>({registerSecretField:path=>secrets.push(path)}),settings:()=>settings,config:()=>cfg,dataDir:f=>join(dir,f),onDispose:fn=>disposers.push(fn),dsh:{get:()=>null},tool:b=>builders.push(b),defineTool:t=>t,rule(){},every(){},route:(path,fn)=>routes.set(path,fn),
    core:{onebot:{state:'connected'},mutes:{muted:()=>false},personas:{current:()=> '人格'}},
    ask:async()=>{asks++;return overrides.ask ? overrides.ask() : '{"share":true,"index":0,"text":"分享感想"}';},
    sendText:async(_chat,text)=>{sends++;sentTexts.push(text);return overrides.send ? overrides.send() : {message_id:1};},use:()=>null,log:{warn(){}}};
  let browses=0;
  const renderPage=async (_url,kind)=>{
    kinds.push(kind);
    if(kind==='browse'||kind==='home') return {links:[{url:'https://tieba.baidu.com/p/'+(overrides.postIds?.[browses++] || '12345678'),title:'标题'}]};
    reads++;return {title:'标题',contents:['正文']};
  };
  const ext=moduleDef.setup(api,{renderPage,now:()=>now});
  return {ext,settings,cfg,secrets,routes,builders,kinds,sentTexts,persisted:()=>JSON.parse(readFileSync(join(dir,'state.json'),'utf8')),dispose:()=>disposers.forEach(fn=>fn()),advance:()=>{now+=600001;},counts:()=>({reads,asks,sends})};
}
test('zero sharing budget still reads and never calls model or sends',async t=>{
  const h=harness(t,{settings:{maxSharesPerDay:0}});await h.ext.tick();
  assert.deepEqual(h.counts(),{reads:1,asks:0,sends:0});assert.equal(h.ext.state().views,1);
});
test('daily budget exhausted still browses new posts',async t=>{
  const h=harness(t,{settings:{maxSharesPerDay:1},postIds:['12345678','87654321']});await h.ext.tick();h.advance();
  assert.equal(h.ext.state().shares,1);
  await h.ext.tick();assert.match(h.ext.state().lastResult,/分享额度/);assert.deepEqual(h.counts(),{reads:2,asks:1,sends:1});
});
test('dispose while waiting on model prevents share and queued future ticks',async t=>{
  let resolve;const pending=new Promise(r=>{resolve=r;});const h=harness(t,{ask:()=>pending});
  const work=h.ext.tick();await new Promise(r=>setImmediate(r));assert.equal(h.counts().asks,1);
  h.dispose();resolve('{"share":true,"index":0,"text":"不应发送"}');await work;
  assert.equal(h.counts().sends,0);h.advance();await h.ext.tick();assert.equal(h.counts().reads,1);
});
test('switching to dry-run while model is pending prevents share',async t=>{
  let resolve;const pending=new Promise(r=>{resolve=r;});const h=harness(t,{ask:()=>pending});
  const work=h.ext.tick();await new Promise(r=>setImmediate(r));h.cfg.dryRun=true;resolve('{"share":true,"index":0,"text":"不应发送"}');await work;
  assert.equal(h.counts().sends,0);
});
test('send failure and invalid model output remain retryable, not permanently marked seen',async t=>{
  const h=harness(t,{send:()=>null});await h.ext.tick();assert.equal(h.ext.state().seen.length,0);h.advance();await h.ext.tick();assert.equal(h.counts().sends,2);
  const bad=harness(t,{ask:()=> 'invalid JSON'});await bad.ext.tick();assert.equal(bad.ext.state().seen.length,0);assert.equal(bad.counts().sends,0);
});

test('manual share route works with scheduling off and outside hours, but respects daily quota',async t=>{
  const h=harness(t,{settings:{autoBrowse:false,startHour:0,endHour:1,maxSharesPerDay:1}});
  assert.equal((await h.ext.tick()).ok,false);
  const result=await h.routes.get('/share')();assert.equal(result.shared,1);assert.equal(h.counts().sends,1);
  assert.match((await h.routes.get('/share')()).message,/额度/);assert.equal(h.counts().sends,1);
});
test('manual share obeys feature switch, global switch and dry-run',async t=>{
  const h=harness(t,{settings:{enabled:false}});
  assert.match((await h.ext.run({manual:true})).message,/已关闭/);assert.equal((await h.ext.browse('测试')).ok,false);
  assert.deepEqual(h.builders[0]({chat:{kind:'private'},level:'social'}),[]);
  h.settings.enabled=true;h.cfg.enabled=false;assert.match((await h.ext.run({manual:true})).message,/总开关/);
  h.cfg.enabled=true;h.cfg.dryRun=true;assert.match((await h.ext.run({manual:true})).message,/试运行/);
  assert.deepEqual(h.counts(),{reads:0,asks:0,sends:0});
});
test('turning feature off during manual model generation stops the pending share',async t=>{
  let resolve;const pending=new Promise(r=>{resolve=r;});const h=harness(t,{settings:{autoBrowse:false},ask:()=>pending});
  const work=h.ext.run({manual:true});await new Promise(r=>setImmediate(r));h.settings.enabled=false;
  resolve('{"share":true,"index":0,"text":"不应发送"}');assert.equal((await work).ok,false);assert.equal(h.counts().sends,0);
});
test('cookie stays registered as a secret although all settings are rendered in the grouped panel',t=>{
  const h=harness(t);assert.deepEqual(moduleDef.settings,[]);assert.deepEqual(h.secrets,[['ext','tieba-reader','cookie']]);
});
test('history records reads even without shares; manual rounds do not increase automatic round count',async t=>{
  const automatic=harness(t,{settings:{maxSharesPerDay:0}});await automatic.ext.tick();
  assert.equal(automatic.ext.state().runs,1);assert.equal(automatic.ext.state().history[0].kind,'read');assert.equal(automatic.ext.state().shares,0);
  const manual=harness(t,{settings:{autoBrowse:false}});await manual.ext.run({manual:true});
  assert.equal(manual.ext.state().runs,0);assert.equal(manual.ext.state().views,1);assert.deepEqual(manual.ext.state().history.map(x=>x.kind),['share','read']);assert.equal(manual.ext.state().history[0].text,'分享感想');
});
test('blank forum config uses homepage for both automatic and manual browsing; explicit forums stay scoped',async t=>{
  const automatic=harness(t,{settings:{bars:'',maxSharesPerDay:0}});await automatic.ext.tick();assert.deepEqual(automatic.kinds,['home','read']);
  assert.equal(automatic.ext.state().history[0].origin,'home');assert.equal((await automatic.routes.get('/state')()).browseMode,'home');
  const manual=harness(t,{settings:{bars:'',autoBrowse:false}});assert.equal((await manual.ext.run({manual:true})).shared,1);assert.match(manual.sentTexts[0],/刚逛贴吧首页/);assert.doesNotMatch(manual.sentTexts[0],/首页吧/);
  const scoped=harness(t);await scoped.ext.tick();assert.deepEqual(scoped.kinds,['browse','read']);
});
test('existing malformed titles are repaired without removing history or changing URLs and counts',t=>{
  const title='买的328，感觉和媒体评分差异巨大-百度贴吧icon_arrow14_right编组 14icon_pure_play12';
  const h=harness(t,{state:{shares:5,views:12,history:[{kind:'share',at:123,title,url:'https://tieba.baidu.com/p/12345678',text:'原分享文字'}],lastResult:'已分享：'+title}});
  const state=h.persisted();assert.equal(state.history[0].title,'买的328，感觉和媒体评分差异巨大');assert.equal(state.lastResult,'已分享：买的328，感觉和媒体评分差异巨大');
  assert.equal(state.shares,5);assert.equal(state.views,12);assert.equal(state.history.length,1);assert.equal(state.history[0].text,'原分享文字');assert.equal(state.history[0].url,'https://tieba.baidu.com/p/12345678');
});
