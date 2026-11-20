import { pathToFileURL } from 'node:url'
const t0 = Date.now()
try {
  const m = await import('dsh-agent-soul-bridge')
  console.log('RESOLVED keys=', Object.keys(m), 'default=', m.default && Object.keys(m.default), 'inject=', JSON.stringify(m.inject), 'default.inject=', JSON.stringify(m.default && m.default.inject))
} catch (e) { console.log('RESOLVE FAIL:', e.code, e.message.slice(0,300)) }
// ws transport test
try {
  const { connectWs } = await import('dsh-agent-soul-bridge/ws')
  let opened = false
  const ws = connectWs('ws://127.0.0.1:7310/control', {
    onopen: () => { opened = true; console.log('WS OPEN ✓ (未发 hello，直接关)'); setTimeout(() => ws.close(), 300) },
    onclose: (r) => { console.log('WS CLOSE:', r, 'opened=', opened); process.exit(0) },
    onerror: (e) => console.log('WS ERR', String(e && e.message || e).slice(0,200)),
  })
  setTimeout(() => { console.log('WS TIMEOUT opened=', opened); process.exit(0) }, 4000)
} catch (e) { console.log('WS IMPORT FAIL:', String(e && e.message || e).slice(0,300)) }
