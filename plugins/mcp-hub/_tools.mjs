/** 列出 windows-mcp 的工具清单（名字 + 一句话描述）。只读，连一次即退。 */
import { McpStdioClient, loadServers } from './index.js'

const manifest = loadServers()
const cfg = manifest.servers.find((s) => s.enabled && s.transport === 'stdio')
if (!cfg) { console.error('清单里没有可连的 stdio 服务器'); process.exit(1) }
const client = new McpStdioClient(cfg)
try {
  await client.connect({ timeoutMs: 180000 })
  const tools = await client.listTools()
  console.log(`共 ${tools.length} 个工具\n`)
  for (const t of tools) {
    const desc = String(t.description ?? '').replace(/\s+/g, ' ').trim()
    console.log(`- ${t.name} — ${desc.slice(0, 160)}${desc.length > 160 ? '…' : ''}`)
  }
} finally {
  await client.close().catch(() => {})
}
