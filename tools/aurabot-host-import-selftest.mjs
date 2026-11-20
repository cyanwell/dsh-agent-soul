import assert from 'node:assert/strict';
import { importAurabotHostBeforeEvaluation } from '../src/util/aurabot-host-import.mjs';

const marker = fn => { Object.defineProperty(fn,'cloneOnly',{value:true}); return fn; };
const groups = {
  config: ['load','save','public','mergeFromPanel'], persona: ['seed','list','read','save','delete','current','rules'],
  gateway: ['onebot','snowluma'], chat: ['hub','local','groupRoles','mutes'], bridge: ['create'],
  modules: ['createHost','create'], effects: ['register'], timers: ['setTimeout','setInterval','clearTimeout','clearInterval'],
  process: ['spawn'], fs: ['readFileSync','existsSync','writeFileSync','unlinkSync','statSync','mkdirSync'],
  clock: ['now'], model: ['defaultModel','askModel','reasoning','vision'],
};
const deps=Object.freeze(Object.fromEntries(Object.entries(groups).map(([group,members])=>[group,Object.freeze(Object.fromEntries(members.map(k=>[k,marker(()=>{})])))])));
const valid=Object.freeze({bootstrap:Object.freeze({mode:'clone',deps})});
let imports=0;const fakeHost={apply:async(_ctx,options)=>({options})};
const load=async options=>importAurabotHostBeforeEvaluation({options,importHost:async()=>{imports++;return fakeHost;}});

for(const invalid of [{},{bootstrap:{mode:'production',deps}},{bootstrap:{mode:'clone',deps:{...deps,extra:{}}}}]){
  const before=imports;await assert.rejects(load(invalid));assert.equal(imports,before,'invalid clone config denied before importHost');
}
const cloneLoaded=await load(valid);assert.equal(imports,1);assert.equal(cloneLoaded.host,fakeHost);assert.equal((await cloneLoaded.host.apply({},cloneLoaded.applyOptions)).options,valid);
const prodLoaded=await load(undefined);assert.equal(imports,2);assert.equal(prodLoaded.host,fakeHost);assert.equal(prodLoaded.applyOptions,undefined);assert.equal((await prodLoaded.host.apply({},prodLoaded.applyOptions)).options,undefined);
console.log('aurabot-host-import-selftest: PASS (invalid options import=0; valid clone/prod import=1 each)');
