import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createConnection } from 'node:net';
import { createBrowserReader, resolveBrowser } from './browser-client.mjs';
function harness(behavior, timeoutMs=1000) {
  let dispose;const children=[];
  const api={dir:'/module',settings:()=>({}),dataDir:x=>'/data/'+x,onDispose:fn=>{dispose=fn;}};
  const spawnImpl=(exe,args,options)=>{
    const child=new EventEmitter();child.stdout=new PassThrough();child.killed=false;
    const socket=createConnection({host:'127.0.0.1',port:Number(options.env.AURABOT_TIEBA_PORT)});
    socket.on('error',()=>{});
    socket.once('connect',()=>socket.write(options.env.AURABOT_TIEBA_TOKEN+'\n'));
    let buffer='';socket.setEncoding('utf8');socket.on('data',chunk=>{buffer+=chunk;const end=buffer.indexOf('\n');if(end!==-1)behavior?.(child,JSON.parse(buffer.slice(0,end)));});
    child.stdout.on('data',chunk=>socket.write(chunk));
    child.kill=()=>{child.killed=true;socket.destroy();};
    children.push({child,exe,args,options});return child;
  };
  const reader=createBrowserReader(api,()=> 'BDUSS=test-secret',{spawnImpl,resolveImpl:()=>'/electron',timeoutMs});
  return {reader,children,dispose:()=>dispose()};
}
test('credentials go only over authenticated IPC; UTF-8 output survives split chunks',async()=>{
  const h=harness((child,request)=>{
    assert.equal(request.cookie,'BDUSS=test-secret');
    const result=Buffer.from('AURABOT_TIEBA:'+JSON.stringify({ok:true,data:{title:'测试中文'}})+'\n');
    const cut=result.indexOf(Buffer.from('测试'))+1;
    queueMicrotask(()=>{child.stdout.write(result.subarray(0,cut));child.stdout.write(result.subarray(cut));});
  });
  assert.equal((await h.reader('https://tieba.baidu.com/','account')).title,'测试中文');
  const started=h.children[0];assert.doesNotMatch(JSON.stringify([started.args,started.options]),/test-secret/);
  assert.equal(started.options.windowsHide,true);assert.equal(started.child.killed,true);h.dispose();
});
test('dispose cancels active request and queued requests never start another browser',async()=>{
  const h=harness();const first=h.reader('https://tieba.baidu.com/','account');const second=h.reader('https://tieba.baidu.com/','account');
  const firstRejected=assert.rejects(first,/停用|取消/);const secondRejected=assert.rejects(second,/停用|取消/);
  while(!h.children.length) await new Promise(r=>setImmediate(r));h.dispose();await Promise.all([firstRejected,secondRejected]);assert.equal(h.children.length,1);assert.equal(h.children[0].child.killed,true);
});
test('timeout and process failure complete requests instead of hanging',async()=>{
  const h=harness(null,10);await assert.rejects(h.reader('https://tieba.baidu.com/','account'),/超时/);assert.equal(h.children[0].child.killed,true);h.dispose();
  const broken=harness(child=>queueMicrotask(()=>child.emit('error',new Error('private details'))));
  await assert.rejects(broken.reader('https://tieba.baidu.com/','account'),/组件启动失败/);broken.dispose();
});
test('opening login is deduplicated and completion updates its status',async()=>{
  const h=harness();assert.equal(h.reader.openLogin().ok,true);assert.equal(h.reader.openLogin().ok,true);
  while(!h.children.length) await new Promise(r=>setImmediate(r));await new Promise(r=>setTimeout(r,10));assert.equal(h.children.length,1);assert.equal(h.reader.status().loginPending,true);
  await assert.rejects(h.reader('https://tieba.baidu.com/','account'),/手动关闭/);
  assert.equal(h.children.length,1);
  assert.equal(h.children[0].options.windowsHide,false);
  h.children[0].child.stdout.write('AURABOT_TIEBA:'+JSON.stringify({event:'login-opened'})+'\n');
  await new Promise(r=>setTimeout(r,10));assert.match(h.reader.status().lastLogin,/窗口已打开/);assert.equal(h.reader.status().loginPending,true);
  h.children[0].child.stdout.write('AURABOT_TIEBA:'+JSON.stringify({ok:true,data:{loggedIn:true,name:'测试账号',autoClosed:true}})+'\n');
  // 等回环 IPC 把结果走完（Linux 上 setImmediate 一次不够，改成最多等 500ms）
  for (let i = 0; i < 100 && h.reader.status().loginPending; i++) await new Promise(r=>setTimeout(r,5));
  assert.equal(h.reader.status().loginPending,false);assert.match(h.reader.status().lastLogin,/会话已保存/);h.dispose();
  assert.equal(h.reader.status().loginResult.loggedIn,true);assert.match(h.reader.status().lastLogin,/已自动关闭/);
});
test('browser runtime is discovered automatically and absence does not request a manual path',()=>{
  assert.throws(()=>resolveBrowser({dir:'/module'},'win32',()=>false),/未检测到/);
  const discovered=resolveBrowser({dir:'/module'},'win32',path=>path.includes('.runtime'));
  assert.match(discovered,/electron\.exe$/);
});
test('missing runtime opens default browser without reading credentials or claiming the extension logged in',async()=>{
  const opened=[];let dispose;let cookieReads=0;
  const reader=createBrowserReader({dir:'/module',dataDir:x=>x,onDispose:fn=>{dispose=fn;}},()=>{cookieReads++;return 'must-not-be-read';},{resolveImpl:()=>{throw Error('missing');},openExternalImpl:async url=>opened.push(url)});
  const result=await reader.openLogin();assert.deepEqual(opened,['https://tieba.baidu.com/']);assert.equal(result.mode,'external');
  assert.equal(result.cookieGuide.steps.length,4);assert.match(result.cookieGuide.steps.join(' '),/F12/);assert.match(result.cookieGuide.steps.join(' '),/不要复制.*Set-Cookie/);assert.equal(reader.status().cookieGuide,result.cookieGuide);
  assert.equal(result.loggedIn,null);assert.equal(reader.status().account.loggedIn,null);assert.equal(reader.status().loginPending,false);assert.equal(reader.available(),false);assert.equal(cookieReads,0);dispose();
});
test('account checks and logout replace the same cached status; status reads never start a browser',async()=>{
  const h=harness((child,req)=>queueMicrotask(()=>child.stdout.write('AURABOT_TIEBA:'+JSON.stringify({ok:true,data:req.kind==='logout'?{loggedIn:false,message:'已退出'}:{ok:true,loggedIn:true,name:'test',message:'已登录：test'}})+'\n')));
  assert.equal(h.reader.status().account.checkedAt,0);assert.equal(h.children.length,0);
  await h.reader('https://tieba.baidu.com/','account');assert.equal(h.reader.status().account.loggedIn,true);assert.ok(h.reader.status().account.checkedAt>0);
  h.reader.status();assert.equal(h.children.length,1);
  await h.reader('https://tieba.baidu.com/','logout');assert.equal(h.reader.status().account.loggedIn,false);assert.equal(h.reader.status().account.message,'已退出');h.dispose();
});
