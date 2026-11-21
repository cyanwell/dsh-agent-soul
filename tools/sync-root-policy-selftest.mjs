import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveSyncRootPolicy, resolveManagedFullCorePolicy } from '../src/util/sync-root-policy.mjs';
const legacy=resolveSyncRootPolicy({managed:false});
assert.deepEqual(legacy,{sourceRoot:'D:/AI/dsh/home/sessions',watch:true,mode:'legacy'});
const root=fs.mkdtempSync(path.join(os.tmpdir(),'sync-root-policy-'));
try{
  const home=path.join(root,'home'),sourceRoot=path.join(home,'source'),dataDir=path.join(home,'data'),persona=path.join(home,'persona');
  fs.mkdirSync(sourceRoot,{recursive:true});fs.mkdirSync(dataDir,{recursive:true});fs.mkdirSync(persona,{recursive:true});
  const self=path.join(persona,'SELF.md');fs.writeFileSync(self,'fixture');
  const outsideSelf=path.resolve(root,'outside-self.md');fs.writeFileSync(outsideSelf,'outside');
  const valid={managed:true,home,sourceRoot,dataDir,personaFiles:[{path:self}],echoDoctorPath:'',fs};
  const managed=resolveSyncRootPolicy(valid);
  assert.deepEqual({sourceRoot:managed.sourceRoot,dataDir:managed.dataDir,watch:managed.watch,mode:managed.mode},{sourceRoot:fs.realpathSync(sourceRoot),dataDir:fs.realpathSync(dataDir),watch:false,mode:'managed-temp'});
  assert.throws(()=>resolveSyncRootPolicy({...valid,sourceRoot:path.join(root,'outside')}),/strict child|missing/);
  assert.throws(()=>resolveSyncRootPolicy({...valid,personaFiles:[{path:outsideSelf}] }),/strict child/);
  assert.throws(()=>resolveSyncRootPolicy({...valid,echoDoctorPath:'D:/AI/memory/hub/echo-doctor.mjs'}),/external echo doctor/);
  const link=path.join(home,'escape-link');
  try{fs.symlinkSync(path.dirname(root),link,'dir');assert.throws(()=>resolveSyncRootPolicy({...valid,sourceRoot:link}),/canonical directory/)}catch(e){if(e.code!=='EPERM'&&e.code!=='EACCES'&&e.code!=='ENOTSUP'&&!/canonical directory|strict child/.test(String(e.message)))throw e;console.log('TEMP symlink check: SKIP (creation unavailable)')}
  assert.throws(()=>resolveSyncRootPolicy({...valid,sourceRoot:home}),/strict child/);
  assert.throws(()=>resolveSyncRootPolicy({...valid,sourceRoot:path.join(home,'..','escape')}),/canonical|missing/);
  const closure={status:'complete',files:['src/index.mjs','src/core-entry.mjs']};
  const config={host:'127.0.0.1',port:0,llm:{enabled:false},integrations:{dshBaseUrl:'',mcpHubUrl:'',heartbeatUrl:''},events:{ingress:{mode:'off'},egress:{mode:'off'},wake:{deliver:false}},echoLive:{enabled:false},echoIndex:{enabled:false},chat:{enabled:false}};
  const full=resolveManagedFullCorePolicy({paths:managed,config,closure,knownNonliteral:[],aurabotEnabled:false});
  assert.deepEqual(full.allowlistedFiles,closure.files);assert.equal(full.externalIntegrations,false);assert.equal(full.aurabotEnabled,false);
  assert.throws(()=>resolveManagedFullCorePolicy({paths:managed,config,closure,knownNonliteral:['dynamic-loader'],aurabotEnabled:false}),/nonliteral/);
  assert.throws(()=>resolveManagedFullCorePolicy({paths:managed,config,closure,knownNonliteral:[],aurabotEnabled:true}),/Aurabot disabled/);
  assert.throws(()=>resolveManagedFullCorePolicy({paths:managed,config:{...config,port:7310},closure,knownNonliteral:[],aurabotEnabled:false}),/port 0/);
  assert.throws(()=>resolveManagedFullCorePolicy({paths:managed,config:{...config,integrations:{...config.integrations,mcpHubUrl:'http://localhost'}},closure,knownNonliteral:[],aurabotEnabled:false}),/external LLM/);
  assert.throws(()=>resolveManagedFullCorePolicy({paths:managed,config:{...config,llm:{enabled:false,apiKeyRef:'dpapi:prod'}},closure,knownNonliteral:[],aurabotEnabled:false}),/external LLM/);
  assert.throws(()=>resolveManagedFullCorePolicy({paths:managed,config:{...config,chat:{enabled:true}},closure,knownNonliteral:[],aurabotEnabled:false}),/mobile chat disabled/);
  assert.throws(()=>resolveManagedFullCorePolicy({paths:managed,config:{...config,statusDir:outsideSelf},closure,knownNonliteral:[],aurabotEnabled:false}),/statusDir escapes/);
  assert.throws(()=>resolveManagedFullCorePolicy({paths:managed,config:{...config,memory:{libraryDir:root}},closure,knownNonliteral:[],aurabotEnabled:false}),/memory libraryDir escapes/);
  assert.throws(()=>resolveManagedFullCorePolicy({paths:managed,config,closure,knownNonliteral:[],aurabotEnabled:false,contractPath:path.resolve(os.tmpdir(),'outside-contract.mjs')}),/escapes clone home/);
  console.log(JSON.stringify({ok:true,legacy,managed:{sourceRoot:managed.sourceRoot,dataDir:managed.dataDir,watch:managed.watch,mode:managed.mode},fullPolicy:full.mode,rejected:['outside-source','outside-persona','doctor-path','same-root','noncanonical-parent','nonliteral-import','aurabot','nonzero-port','external-integration','external-contract'],coreStarted:false}));
}finally{fs.rmSync(root,{recursive:true,force:true});assert.equal(fs.existsSync(root),false,'TEMP root remains');console.log('TEMP cleanup: PASS')}
