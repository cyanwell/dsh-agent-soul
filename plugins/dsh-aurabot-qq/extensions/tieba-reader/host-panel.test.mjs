import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
const host = new URL('../../client/client.js', import.meta.url);
test('custom panel draft updates reach the shared host draft and preserve other configuration', {skip: !existsSync(host)},()=>{
  const code=readFileSync(host,'utf8');const start=code.indexOf('    function ExtPage(');const end=code.indexOf('\n    const BILI_KIND',start);
  assert.ok(start>=0&&end>start);
  const h=(type,props,...children)=>({type,props,children});
  const ExtPage=new Function('useField','h','Empty','Card','Row','ExtPanel','return ('+code.slice(start,end).trim()+')')(()=>({}),h,'Empty','Card','Row','ExtPanel');
  let draft={enabled:true,ext:{'tieba-reader':{bars:'old',cookie:''},other:{keep:true}}};const saved=structuredClone(draft);
  const tree=ExtPage({st:{config:saved,modules:[{id:'tieba-reader',defaults:{enabled:true},settings:[],panel:true}]},draft,setDraft:updater=>{draft=updater(draft);},toast(){},reload(){},mod:'tieba-reader'});
  const child=tree.children.find(n=>n&&n.type==='ExtPanel');assert.ok(child);assert.equal(child.props.draftSettings.bars,'old');
  child.props.setSettings({bars:'new'});assert.equal(draft.ext['tieba-reader'].bars,'new');assert.equal(saved.ext['tieba-reader'].bars,'old');assert.equal(draft.ext.other.keep,true);
  assert.notEqual(JSON.stringify(draft),JSON.stringify(saved));
});
