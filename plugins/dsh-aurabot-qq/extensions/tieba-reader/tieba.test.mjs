import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { barNames, postUrl, cookieHeader, parseList, parsePost, createTieba } from './tieba.mjs';
import moduleDef from './index.mjs';

const list = '<title>测试吧</title><ul><li class="j_thread_list"><a class="j_th_tit" href="/p/12345678">一个有趣的帖子</a><div class="threadlist_abs">摘要</div></li></ul>';
const post = '<title>测试帖</title><h3 class="core_title_txt">真正的标题</h3><div class="l_post" data-field=\'{"content":{"post_no":1}}\'><a class="p_author_name">作者</a><div class="d_post_content">第一楼<br>正文<script>坏代码</script></div></div>';
test('forum names normalize; links reject non-Tieba and non-post paths', () => {
  assert.deepEqual(barNames('deepseek吧，图拉丁\ndeepseek'), ['deepseek','图拉丁']);
  assert.equal(postUrl('https://tieba.baidu.com/p/12345678?pn=2'), 'https://tieba.baidu.com/p/12345678');
  for (const x of ['http://127.0.0.1/p/12345678','https://tieba.baidu.com.evil/p/12345678','https://tieba.baidu.com@evil/p/12345678','https://tieba.baidu.com/f?kw=a','https://tieba.baidu.com:99/p/12345678']) assert.equal(postUrl(x), null);
});
test('cookies filtered, newline refused, HTML list/comments and post parse', () => {
  assert.equal(cookieHeader('BDUSS=secret; evil=x; STOKEN=abc'), 'BDUSS=secret; STOKEN=abc');
  assert.throws(() => cookieHeader('BDUSS=x\r\nevil:y'));
  assert.equal(parseList(list)[0].title, '一个有趣的帖子');
  assert.equal(parseList('<!--' + list + '-->')[0].url, 'https://tieba.baidu.com/p/12345678');
  assert.equal(parsePost(post,'url').posts[0].text, '第一楼 正文');
  assert.throws(() => parseList('<title>百度安全验证</title>'), /安全验证/);
  assert.throws(() => parsePost('<title>空白页面</title>','url'), /未读到/);
});
test('requests read-only, cookies only sent to Tieba; verification falls back to indexed results', async () => {
  const requests=[];
  const client=createTieba({getCookie:()=> 'BDUSS=private; Other=discard', fetchImpl:async (url,init)=>{
    requests.push({url:String(url),init}); return new Response('<title>百度安全验证</title>');
  },searchWeb:async ()=>({sources:[{url:'https://evil.test/p/12345678',title:'evil'},{url:'https://tieba.baidu.com/p/12345678',title:'结果'}]})});
  const r=await client.browse('deepseek');
  assert.equal(r.mode,'indexed'); assert.equal(r.items.length,1);
  assert.match(r.warning,/可能不是最新/);
  assert.equal((await client.read('https://tieba.baidu.com/p/12345678')).ok,false);
  for(const {url,init} of requests){assert.equal(new URL(url).hostname,'tieba.baidu.com');assert.equal(init.method,'GET');assert.equal(init.redirect,'manual');assert.equal(init.headers.cookie,'BDUSS=private');}
});
test('automatic browse obeys switches, shares a read post once, and deduplicates', async () => {
  const dir=mkdtempSync(join(tmpdir(),'aurabot-tieba-test-'));
  const opts={...moduleDef.defaults,bars:'deepseek',autoBrowse:true,startHour:0,endHour:0,intervalMinutes:10};
  const cfg={enabled:true,dryRun:true,ownerQQ:'12345'};
  let sent=0, modelCalls=0;
  const previous=globalThis.fetch;
  globalThis.fetch=async (url)=>new Response(String(url).includes('/p/')?post:list);
  try {
    const api={lib:()=>({registerSecretField(){}}),settings:()=>opts,config:()=>cfg,dataDir:(f)=>join(dir,f),dsh:{get:()=>null},tool:()=>{},rule:()=>{},every:()=>{},route:()=>{},
      core:{onebot:{state:'connected'},mutes:{muted:()=>false},personas:{current:()=> '人格'}},
      ask:async ()=>{modelCalls++;return '{"share":true,"index":0,"text":"这个挺有意思"}';},
      sendText:async ()=>{sent++;return {message_id:1};},use:()=>null,log:{warn:()=>{}}};
    const ext=moduleDef.setup(api,{renderPage:async (url,kind)=>kind==='browse'
      ? {links:[{url:'https://tieba.baidu.com/p/12345678',title:'一个有趣的帖子'}]}
      : {title:'真正的标题',contents:['第一楼正文']}});
    await ext.tick();assert.equal(sent,0);assert.equal(modelCalls,0);
    cfg.dryRun=false;opts.autoBrowse=false;await ext.tick();assert.equal(sent,0);
    opts.autoBrowse=true;await ext.tick();assert.equal(sent,1);assert.equal(ext.state().shares,1);
    await ext.tick();assert.equal(sent,1);assert.equal(modelCalls,1);
    assert.ok(ext.state().seen.includes('https://tieba.baidu.com/p/12345678'));
  } finally {globalThis.fetch=previous;}
});
test('already-bound tools resolve current module exports after a hot reload', async () => {
  const dir=mkdtempSync(join(tmpdir(),'aurabot-tieba-binding-'));
  const builders=[];
  let current={version:'old',read:async()=>({ok:true,title:'old'})};
  const api={lib:()=>({registerSecretField(){}}),dataDir:f=>join(dir,f),settings:()=>moduleDef.defaults,config:()=>({}),
    dsh:{get:()=>null},tool:b=>builders.push(b),defineTool:t=>t,rule:()=>{},every:()=>{},route:()=>{},
    use:()=>current};
  moduleDef.setup(api,{renderPage:async()=>({})});
  const tools=builders[0]({chat:{kind:'private'},level:'social'});
  assert.ok(tools.some(t=>t.name==='tieba_reader_status'));
  const boundRead=tools.find(t=>t.name==='tieba_read');
  current={version:'new',read:async()=>({ok:true,title:'NEW_BROWSER_RESULT'})};
  const r=await boundRead.execute({url:'https://tieba.baidu.com/p/12345678'});
  assert.equal(r.title,'NEW_BROWSER_RESULT');
});
