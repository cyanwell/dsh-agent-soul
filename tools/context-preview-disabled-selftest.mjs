// Run with node tools/context-preview-disabled-selftest.mjs (no listener or session fixtures).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { METHODS } from 'node:http'
import { syncBuiltinESMExports } from 'node:module'
import { handleContextApi, isContextPath, setSessionsDir } from '../src/adapters/context-http.mjs'

const route = '/api/huanqi/context/composition'
const queries = ['', '?sessionId=synthetic-session&frames=400', '?sessionId=&frames=bad', '?sessionId=%ZZ&frames=-1']
const methods = [...new Set([...METHODS, 'X-SYNTHETIC'])]
const fsCalls = []
const reqCalls = []
const dispatchCalls = []
// Trap at the I/O boundary: any attempted check or read fails before touching disk.
const restorers = []
for (const [target, names] of [
  [fs, ['existsSync', 'statSync', 'openSync', 'readFileSync', 'readFile', 'createReadStream']],
  [fs.promises, ['access', 'stat', 'open', 'readFile']],
]) {
  for (const name of names) {
    const original = target[name]
    restorers.push(() => { target[name] = original })
    target[name] = () => { fsCalls.push(name); throw new Error('unexpected filesystem access') }
  }
}
syncBuiltinESMExports()
try {
  setSessionsDir('synthetic-session-root')
  const options = { get dispatch () { dispatchCalls.push('dispatch'); throw new Error('unexpected dispatch access') } }
  for (const method of methods) {
    for (const query of queries) {
      const req = {
        method,
        url: route + query,
        on () { reqCalls.push('on'); throw new Error('unexpected request body access') },
      }
      const res = {
        writeHead (code, headers) { this.statusCode = code; this.headers = headers },
        end (body) { this.body = body; this.writableEnded = true },
      }
      const label = method + ' ' + req.url
      assert.equal(isContextPath(req), true, label)
      assert.equal(await handleContextApi(req, res, options), true, label)
      assert.equal(res.statusCode, 503, label)
      assert.equal(res.headers['Cache-Control'], 'no-store', label)
      assert.deepEqual(JSON.parse(res.body), {
        ok: false, code: 'CONTEXT_PREVIEW_DISABLED', error: '上下文预览未开放',
      }, label)
    }
  }
} finally {
  for (const restore of restorers) restore()
  syncBuiltinESMExports()
}
assert.deepEqual(fsCalls, [])
assert.deepEqual(reqCalls, [])
assert.deepEqual(dispatchCalls, [])

const page = fs.readFileSync(new URL('../src/web/context.html', import.meta.url), 'utf8')
assert.match(page, /<h2>上下文预览未开放<\/h2>/)
assert.match(page, /不会读取或展示会话内容/)
assert.match(page, /不能据此确认哪些内容可清理/)
assert.doesNotMatch(page, /<script\b|展开全文|删掉不会损失信息/i)
console.log('PASS: ' + methods.length * queries.length + ' handler cases; 0 filesystem, body, or dispatch accesses; static unavailable page')
