import { createRequire } from 'node:module'
import fs from 'node:fs'
const SITES = [
  'D:/AI/dsh/home/profiles/desktop/node_modules/dsh-agent-soul-bridge/index.js',
  'D:/AI/dsh/home/profiles/desktop/index.js',
]
for (const site of SITES) {
  const req = createRequire(site)
  try {
    const r = req.resolve('dsh-yanqing-pruner')
    console.log(site + '\n  -> ' + r + '\n  realpath=' + fs.realpathSync(r))
    const st = fs.statSync(r)
    console.log('  size=' + st.size)
  } catch (e) { console.log(site + '\n  RESOLVE_FAIL: ' + String(e && e.message || e)) }
}
// ESM 侧：按真实 specifier 解析（node_modules 里是否有这一份）
const pkgDir = 'D:/AI/dsh/home/profiles/desktop/node_modules/dsh-yanqing-pruner/package.json'
console.log('pkg exists:', fs.existsSync(pkgDir))
