#!/usr/bin/env node
// MCP over stdio —— 第一条腿
//
// ★ 这个文件**只做传输**：读 stdin 的一行一个 JSON-RPC，转给 mcp-tools.mjs，写回 stdout。
//   工具定义、人格、检索、索引全在 mcp-tools.mjs 里 —— 两条腿共用同一份。
//   为什么不各写一份：重复定义迟早会漂，而「两条腿暴露的工具不一样」是最难查的那种 bug。
//
// ★★ 2026-11-09 写者收口：这条腿**不再默认自己写盘**。
//   tools/call 先问路由（判据全在 src/adapters/mcp-proxy.mjs）：
//     proxy      → 整条转给 7310 主服务，本进程**不开 store、不写任何文件**
//     offline    → 写工具全拒（SOUL_OFFLINE / status=rejected）；
//                  读工具以只读 store 执行，结果后面挂一块 degraded 说明
//     standalone → 旧行为（只有 SOUL_STDIO_MODE=standalone 时才走）
//   ★ initialize / tools/list 永远在本进程直接答：它们是静态的、不碰盘，
//     而宿主握手不该依赖另一个进程活着。
//   ★ 一旦确认过主服务在线就锁死代理 —— 它中途挂掉也**不落回本机写**。
//
// 启动：node src/adapters/mcp.mjs
// 宿主配置：command=<node 路径>, args=["D:/AI/agent-soul/src/adapters/mcp.mjs"]

import { TOOLS, callTool, SERVER_INFO, closeStore, setStoreMode } from './mcp-tools.mjs';
import { StdioRouter, isWriteCall, degradedBlock, rejectedBlock, hubDownBlock } from './mcp-proxy.mjs';
import { readonlyEnabled, classifyMcpCall, rejection } from '../security/write-manifest.mjs';

const send = (obj) => { process.stdout.write(JSON.stringify(obj) + '\n'); };
const asText = (obj) => JSON.stringify(obj, null, 2);
const rejected = (id, block) => ({
  jsonrpc: '2.0', id,
  result: { isError: true, content: [{ type: 'text', text: asText(block) }] },
});

const router = new StdioRouter();
const initP = router.init();

async function handle(msg) {
  const { id, method, params } = msg || {};

  if (method === 'initialize') {
    return { jsonrpc: '2.0', id, result: {
      protocolVersion: (params && params.protocolVersion) || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    } };
  }
  if (method === 'notifications/initialized' || method === 'initialized') return null;
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };

  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: TOOLS.map(t => ({
      name: t.name, description: t.description, inputSchema: t.inputSchema,
    })) } };
  }

  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};

    // ★★ 2026-11-10（G2a）：显式只读 —— **不论路由是哪一种**，写 action 一律在本进程就拒。
    //   为什么不等主服务去拒：代理那一支的写请求会原样转给 7310 的 /mcp，
    //   而「本进程到底能不能写」不该由另一个进程的状态决定 —— 那正是双写事故的入口形状。
    //   ★ 判据只有一个（src/security/write-manifest.mjs），这里不自己列清单。
    //   ★ 拒绝体用 reason=UNAVAILABLE，**不用 rejectedBlock()** ——
    //     那个函数生成的是 SOUL_OFFLINE（= 主服务不在线），而这里主服务在线，只是不许写。
    // ★ 拼写错先报拼写错 —— 否则打错名字会显示成「只读拒绝」，人就去查模式了。
    if (!TOOLS.some((t) => t.name === name)) {
      return { jsonrpc: '2.0', id, error: { code: -32601, message: '没有这个工具: ' + name } };
    }
    if (readonlyEnabled()) {
      const c = classifyMcpCall(name, args);
      if (c.verdict !== 'read') return rejected(id, rejection('mcp', c, { transport: 'stdio' }));
    }

    // 探测/转发都可能要等（探测最多 500ms），所以先等初始化落定
    let route = 'offline';
    try { await initP; route = await router.routeNow(); }
    catch { route = 'offline'; }

    // ① 代理：整条转过去，本进程不碰任何文件
    if (route === 'proxy') {
      try {
        const r = await router.forward(msg);
        if (r && typeof r === 'object') return r;
        return { jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: asText({ ok: false, status: 'rejected', code: 'SOUL_HUB_BAD', why: '主服务返回了空响应' }) }] } };
      } catch (e) {
        return rejected(id, hubDownBlock(router, name, e));
      }
    }

    // ② 离线：写工具**在进入 callTool 之前**就拒 —— 连 store 都不构造
    if (route === 'offline') {
      // ★ 先分「根本没有这个工具」和「有这个工具但现在不可用」——
      //   否则离线时打错一个名字，得到的是「降级」，人就会去查主服务而不是查拼写。
      if (!TOOLS.some((t) => t.name === name)) {
        return { jsonrpc: '2.0', id, error: { code: -32601, message: '没有这个工具: ' + name } };
      }
      if (isWriteCall(name, args)) return rejected(id, rejectedBlock(router, name, args));
      setStoreMode('ro');
      try {
        const text = await callTool(name, args);
        return { jsonrpc: '2.0', id, result: { content: [
          { type: 'text', text },
          { type: 'text', text: asText(degradedBlock(router)) },
        ] } };
      } catch (e) {
        if (e && e.code === 'SOUL_OFFLINE') {
          return rejected(id, degradedBlock(router, {
            ok: false,
            why: String((e && e.message) || e),
            hint: '离线降级：读工具也读不了。会话存储没有只读打开 —— 数据目录不存在，或读它会造文件。',
          }));
        }
        const code = e && e.code === 'NO_TOOL' ? -32601 : -32603;
        return { jsonrpc: '2.0', id, error: { code, message: String((e && e.message) || e) } };
      }
    }

    // ③ standalone：改动前的行为，显式认领单写者责任
    // ★ 2026-11-10（G2a · F1）：这一句在 AGENT_SOUL_READONLY=1 时**不生效** ——
    //   硬规则在 mcp-tools.mjs 的 setStoreMode() 里（'rw' 被静默忽略，返回当前模式）。
    //   故意不在这里写三元判断：调用点会漏，而这里正是漏过一次的那个点。
    setStoreMode('rw');
    try {
      const text = await callTool(name, args);
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } };
    } catch (e) {
      const code = e && e.code === 'NO_TOOL' ? -32601 : -32603;
      return { jsonrpc: '2.0', id, error: { code, message: String((e && e.message) || e) } };
    }
  }

  if (id === undefined) return null;
  return { jsonrpc: '2.0', id, error: { code: -32601, message: '不认识的方法: ' + method } };
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', async (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); }
    catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON 解析失败' } }); continue; }
    try {
      const res = await handle(msg);
      if (res) send(res);
    } catch (e) {
      if (msg && msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String((e && e.message) || e) } });
    }
  }
});

process.stdin.on('end', () => { try { closeStore(); } catch {} process.exit(0); });

// ★ 横幅放在路由落定之后 —— 否则宿主日志里那句「ready」说的是旧行为。
initP.then(() => {
  process.stderr.write('[agent-soul] MCP server ready (stdio), ' + TOOLS.length + ' tools · ' + router.describe() + '\n');
}).catch((e) => {
  process.stderr.write('[agent-soul] MCP server ready (stdio), ' + TOOLS.length + ' tools · 路由探测异常：' + String((e && e.message) || e) + '\n');
});
