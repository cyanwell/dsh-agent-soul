import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const temp = fs.realpathSync(os.tmpdir());
const root = fs.mkdtempSync(path.join(temp, "echo-containment-"));
const insideRoot = path.join(root, "clone");
const outside = path.join(root, "outside");
const target = path.join(insideRoot, "payload.txt");
const inRoot = (base, candidate) => { const b=path.resolve(base), c=path.resolve(candidate); return c===b || c.startsWith(b+path.sep); };
let symlink = "unavailable";
try {
  fs.mkdirSync(insideRoot); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, "secret.txt"), "outside"); fs.writeFileSync(target, "inside");
  assert.equal(inRoot(insideRoot,target),true);
  assert.equal(inRoot(insideRoot,path.join(insideRoot,"..","escape.txt")),false);
  assert.equal(inRoot(insideRoot,path.join(insideRoot,"..","outside","secret.txt")),false);
  try { fs.symlinkSync(path.join(outside,"secret.txt"),path.join(insideRoot,"linked.txt"),"file"); symlink="created"; const st=fs.lstatSync(path.join(insideRoot,"linked.txt")); assert.equal(st.isSymbolicLink(),true); assert.equal(inRoot(insideRoot,path.join(insideRoot,"linked.txt")),true); assert.equal(fs.realpathSync(path.join(insideRoot,"linked.txt")).startsWith(insideRoot+path.sep),false,"canonical symlink target escapes clone"); } catch(e) { if(!["EPERM","EACCES","ENOTSUP","UNKNOWN"].includes(e.code)) throw e; }
  console.log(JSON.stringify({status:"PASS",rootContained:true,traversalRejected:true,symlink}));
} finally { fs.rmSync(root,{recursive:true,force:true}); }
assert.equal(fs.existsSync(root),false,"TEMP root removed");
