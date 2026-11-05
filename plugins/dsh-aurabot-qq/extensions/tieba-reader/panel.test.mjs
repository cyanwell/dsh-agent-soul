import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import definition from './index.mjs';
import { cookieGuide } from './cookie-guide.mjs';
function harness() {
  const values=[];let index=0;const saved=[];const calls=[];const changes=[];const messages=[];
  const settings={...definition.defaults,cookie:'',cookieSet:true};let draftSettings={...settings};
  const React={useState:initial=>{const i=index++;if(!(i in values))values[i]=typeof initial==='function'?initial():initial;return[values[i],v=>{values[i]=typeof v==='function'?v(values[i]):v;}];},useEffect(){}};
  const h=(type,props,...children)=>({type,props:props||{},children:children.flat(Infinity).filter(x=>x!==null&&x!==undefined&&x!==false)});
  const ui=Object.fromEntries(['Card','Row','Btn','Switch','Empty'].map(x=>[x,x]));
  const call=async(path,body)=>{calls.push({path,body});return path==='/state'?{cookieSet:true,browser:{},shares:0}:{ok:true,message:'完成'};};
  const Panel=new Function('React','h','ui','call',readFileSync(new URL('panel.js',import.meta.url),'utf8'))(React,h,ui,call);
  const render=()=>{index=0;return Panel({settings,draftSettings,setSettings:patch=>{changes.push(patch);draftSettings={...draftSettings,...patch};},save:async patch=>saved.push(patch),toast:message=>messages.push(message)});};
  const walk=node=>typeof node==='object'&&node?[node,...node.children.flatMap(walk),...walk(node.props?.right)]:[];
  const text=node=>typeof node==='string'?node:(node?.children||[]).map(text).join('');
  const button=(tree,label)=>walk(tree).find(n=>n.type==='Btn'&&text(n)===label);
  return{render,walk,text,button,saved,calls,changes,messages,setStateData:data=>{values[0]=data;},commitCookie:()=>{settings.cookie='';settings.cookieSet=true;draftSettings={...draftSettings,cookie:'',cookieSet:true};}};
}
test('panel has separate login/config cards, no preview input, and a feature switch in the login card',()=>{
  const h=harness();const tree=h.render();const cards=h.walk(tree).filter(n=>n.type==='Card');
  assert.deepEqual(cards.map(n=>n.props.title),['贴吧登录','贴吧配置','她刷过什么']);
  assert.equal(cards[0].props.right.type,'Switch');assert.equal(cards[0].props.right.props.on,true);
  assert.equal(h.button(tree,'试刷列表（不发送 QQ）'),undefined);
  assert.ok(h.button(tree,'现在刷一轮'));assert.doesNotMatch(JSON.stringify(tree),/DO_NOT_ECHO|试刷贴吧/);
  assert.doesNotMatch(JSON.stringify(tree),/Electron 程序路径|浏览器组件设置/);
});
test('settings changes only update host draft and no independent save buttons remain',async()=>{
  const h=harness();const tree=h.render();
  assert.equal(h.button(tree,'保存登录配置'),undefined);assert.equal(h.button(tree,'保存贴吧配置'),undefined);
  const login=h.walk(tree).find(n=>n.type==='Card'&&n.props.title==='贴吧登录');
  await login.props.right.props.onChange(false);assert.deepEqual(h.changes[0],{enabled:false});assert.equal(h.saved.length,0);
});

test('cookie instructions describe shared save; unsaved changes do not start login checks',async()=>{
  const h=harness();const tree=h.render();const input=h.walk(tree).find(n=>n.type==='input'&&n.props.type==='password');
  assert.match(input.props.placeholder,/底部保存设置/);assert.match(h.button(tree,'检查登录').props.title,/无需另点登录/);
  input.props.onChange({target:{value:'BDUSS=new-cookie'}});assert.deepEqual(h.changes[0],{cookie:'BDUSS=new-cookie'});
  await h.button(h.render(),'检查登录').props.onClick();assert.equal(h.calls.length,0);assert.match(h.messages.at(-1),/先点击底部/);assert.equal(h.saved.length,0);
});
test('manual share button posts one request to the share action, never the preview route',async()=>{
  const h=harness();await h.button(h.render(),'现在刷一轮').props.onClick();
  assert.equal(h.calls.filter(c=>c.path==='/share').length,1);assert.deepEqual(h.calls.find(c=>c.path==='/share').body,{});
  assert.equal(h.calls.some(c=>c.path==='/preview'),false);
});
test('manual login check updates one account status row without a duplicate result banner',async()=>{
  const h=harness();await h.button(h.render(),'检查登录').props.onClick();
  const tree=h.render();assert.equal(h.walk(tree).filter(n=>n.type==='Row'&&n.props.label==='登录状态').length,1);
  assert.equal(h.walk(tree).filter(n=>n.type==='p'&&h.text(n)==='完成').length,0);
});
test('browse history card matches Bili empty/list structure and distinguishes read and shared entries',()=>{
  const h=harness();h.setStateData({history:[],runs:0,views:0,shares:0,browser:{}});
  let tree=h.render();assert.equal(h.walk(tree).find(n=>n.type==='Empty').props.text,'还没刷过。点「现在刷一轮」试试。');
  h.setStateData({runs:1,views:2,shares:1,browser:{},history:[{kind:'read',at:1,title:'已读帖子',url:'https://tieba.baidu.com/p/12345678',bar:'测试'},{kind:'share',at:2,title:'分享的帖子',url:'https://tieba.baidu.com/p/87654321',text:'分享感想'}]});
  tree=h.render();assert.match(h.text(tree),/今天自动刷了 1 轮/);assert.match(h.text(tree),/看了帖子/);assert.match(h.text(tree),/分享给主人/);assert.match(h.text(tree),/分享感想/);
});
test('default browser mode keeps the complete F12 cookie guide visible in the panel',()=>{
  const h=harness();h.setStateData({history:[],browser:{available:false,cookieGuide}});const tree=h.render();
  assert.equal(h.walk(tree).filter(n=>n.type==='li').length,4);assert.match(h.text(tree),/网络 \/ Network/);assert.match(h.text(tree),/请求标头 \/ Request Headers/);assert.match(h.text(tree),/保存设置/);assert.match(h.text(tree),/不要复制.*Set-Cookie/);
});
test('cookie input stays masked and never echoes the saved value; display/clear buttons are absent',()=>{
  const h=harness();let tree=h.render();let input=h.walk(tree).find(n=>n.type==='input'&&n.props.type==='password');
  assert.equal(h.button(tree,'显示'),undefined);assert.equal(h.button(tree,'隐藏'),undefined);assert.equal(h.button(tree,'清空手动 Cookie'),undefined);
  input.props.onChange({target:{value:'BDUSS=new-secret'}});h.commitCookie();tree=h.render();input=h.walk(tree).find(n=>n.type==='input'&&n.props.type==='password');
  assert.equal(input.props.value,'');assert.match(input.props.placeholder,/已保存，不回显/);assert.doesNotMatch(JSON.stringify(tree),/new-secret/);
});
