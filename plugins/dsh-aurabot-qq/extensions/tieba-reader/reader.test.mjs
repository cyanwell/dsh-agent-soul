import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseList, parseHome, parsePost, createTieba, cleanTitle } from './tieba.mjs';
import sessionHelpers from './session.cjs';
const fixture = name => readFileSync(new URL('fixtures/' + name, import.meta.url), 'utf8');
test('post title uses only document title or clean thread heading, never SVG icon titles',()=>{
  const html='<html><head><title>真正的帖子标题-百度贴吧</title></head><body><svg><title>icon_arrow14_right</title></svg><svg><title>编组 14icon_pure_list_Unfold16@1x</title></svg><div class="pb-content-wrap">正文</div></body></html>';
  assert.equal(parsePost(html,'url').title,'真正的帖子标题');
  const heading=html.replace('<div class="pb-content-wrap">','<h1 class="core_title_txt">优先的帖子标题<svg><title>icon_arrow14_right</title></svg></h1><div class="pb-content-wrap">');
  assert.equal(parsePost(heading,'url').title,'优先的帖子标题');
  assert.equal(cleanTitle('旧标题-百度贴吧icon_arrow14_right编组 14icon_pure_play12'),'旧标题');
  assert.equal(cleanTitle('讨论 icon_arrow14_right 的用法'),'讨论 icon_arrow14_right 的用法');
});
test('homepage parser reads recommendations and hot posts, rejects external links and deduplicates',()=>{
  const items=parseHome(fixture('home.html'));assert.equal(items.length,2);assert.equal(items[0].section,'首页推荐');assert.equal(items[0].bar,'测试');assert.equal(items[1].section,'首页热门');
  assert.throws(()=>parseHome('<title>百度安全验证</title>'),/安全验证/);
});

test('modern and commented legacy forums; modern post excludes scripts and nested duplicate replies', () => {
  assert.equal(parseList(fixture('forum-modern.html'))[0].title, '现代列表标题');
  assert.equal(parseList(fixture('forum-modern.html')).length, 1);
  assert.equal(parseList(fixture('forum-legacy.html'))[0].title, '旧版列表标题');
  const p = parsePost(fixture('post-modern.html'), 'https://tieba.baidu.com/p/12345678');
  assert.equal(p.posts.length, 3);
  assert.equal(p.posts[0].text, '楼主正文 第二行');
  assert.equal(p.imageCount, 1);
  assert.equal(p.posts[1].text, '回复一嵌套回复文字');
  const imageOnly = parsePost('<title>图片帖</title><div class="pb-content-wrap"><img src="/x.png"></div>', 'url');
  assert.match(imageOnly.posts[0].text, /未识别图片/);
  assert.throws(() => parsePost('<title>百度安全验证</title>', 'url'), /安全验证/);
});

test('browser HTML parsing and account check use the same browser reader; search falls back through browser', async () => {
  const calls = [];
  const client = createTieba({getCookie:()=>'',fetchImpl:async()=>new Response('',{status:403}),searchWeb:async()=>{throw Error('must not use index');},
    renderPage:async (url,kind)=>{calls.push(kind);return kind==='account' ? {ok:true,loggedIn:true,name:'test'} : {html: kind==='browse' ? fixture('forum-modern.html') : kind==='search' ? '<div class="s_post"><div class="p_title"><a href="/p/12345678">搜索标题</a></div></div>' : fixture('post-modern.html')};}});
  assert.equal((await client.browse('测试')).mode,'browser');
  assert.equal((await client.read('https://tieba.baidu.com/p/12345678')).posts.length,3);
  assert.equal((await client.account()).loggedIn,true);
  assert.equal((await client.search('关键词')).mode,'browser');
  assert.deepEqual(calls,['browse','read','account','search']);
});

test('unchanged configured cookies preserve browser verification; change/clear/logout replace session', async () => {
  const dir=mkdtempSync(join(tmpdir(),'tieba-session-'));
  let cleared=0;const set=[];
  const ses={clearStorageData:async()=>{cleared++;},cookies:{set:async c=>set.push(c),get:async()=>set,flushStore:async()=>{}}};
  try {
    await sessionHelpers.configureCookies(ses,'',dir);assert.equal(cleared,0);
    await sessionHelpers.configureCookies(ses,'',dir);assert.equal(cleared,0);
    await sessionHelpers.configureCookies(ses,'BDUSS=secret; Other=discard',dir);assert.equal(cleared,1);assert.equal(set.length,1);
    await sessionHelpers.configureCookies(ses,'Other=changed; BDUSS=secret',dir);assert.equal(cleared,1);
    assert.doesNotMatch(readFileSync(join(dir,'configured-cookie.sha256'),'utf8'),/secret/);
    await sessionHelpers.configureCookies(ses,'',dir);assert.equal(cleared,2);
    await sessionHelpers.clearSession(ses,dir);assert.equal(cleared,3);
    await sessionHelpers.configureCookies(ses,'',dir);assert.equal(cleared,3);
    await assert.rejects(sessionHelpers.configureCookies(ses,'BDUSS=x\nCookie=y',dir));
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('navigation restricts login hosts and refuses local/unrelated destinations', () => {
  for(const url of ['http://tieba.baidu.com/p/12345','https://evil.example/','file:///C:/secret','https://tieba.baidu.com.evil/']) {
    assert.throws(()=>sessionHelpers.validUrl(url,'read'));
    assert.equal(sessionHelpers.allowNavigation(url,'login'),false);
  }
  assert.equal(sessionHelpers.allowNavigation('https://passport.baidu.com/v2/','login'),true);
  assert.equal(sessionHelpers.allowNavigation('https://passport.baidu.com/v2/','read'),false);
  assert.equal(sessionHelpers.validUrl('https://tieba.baidu.com/p/12345678','read'),'https://tieba.baidu.com/p/12345678');
});
test('without browser component imported cookies are checked through HTTP and reading can fall back to direct HTML',async()=>{
  const calls=[];
  const client=createTieba({getCookie:()=> 'BDUSS=manual-cookie',browserAvailable:()=>false,renderPage:async()=>{throw Error('must not run a browser');},searchWeb:async()=>({sources:[]}),
    fetchImpl:async(url,options)=>{calls.push(options.headers.cookie);return new Response(String(url).includes('json_userinfo')?JSON.stringify({data:{user_name:'test-user'}}):fixture('forum-legacy.html'));}});
  assert.equal((await client.account()).loggedIn,true);assert.equal((await client.browse('测试')).mode,'direct');
  assert.deepEqual(calls,['BDUSS=manual-cookie','BDUSS=manual-cookie']);
});
