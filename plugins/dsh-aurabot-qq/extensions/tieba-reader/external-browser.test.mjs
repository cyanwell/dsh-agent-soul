import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { openDefaultBrowser } from './external-browser.mjs';
test('system browser launch uses the OS URL handler, never shell commands or cookie arguments',async()=>{
  for(const [platform,command] of [['win32','explorer.exe'],['darwin','/usr/bin/open'],['linux','xdg-open']]) {
    let captured;
    await openDefaultBrowser('https://tieba.baidu.com/',{platform,spawnImpl:(exe,args,options)=>{captured={exe,args,options};const child=new EventEmitter();child.unref=()=>{};queueMicrotask(()=>child.emit('spawn'));return child;}});
    assert.equal(captured.exe,command);assert.deepEqual(captured.args,['https://tieba.baidu.com/']);assert.equal(captured.options.shell,false);
  }
  await assert.rejects(openDefaultBrowser('https://evil.example/'),/只允许/);
});
