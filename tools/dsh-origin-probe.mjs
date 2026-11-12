// 部署自检：现在「到哪问心跳」—— 只打印 origin，不打印任何查询串。
//
// 跑法：node tools/dsh-origin-probe.mjs
//   ① 显式配置（integrations.heartbeatUrl / dshBaseUrl）→ 直接用它，不读日志；
//   ② 没配 → 自动发现（最新 server-*.out.log / dsh-origin.txt），打印来源与选中的文件名；
//   ③ 已发现 → 顺手 GET 一次 <origin>/heartbeat/auto，只说通不通（**不打印 primarySessionId**）。
//
// ★ 输出里永远只有 origin / 来源 / 文件名 / 布尔量 —— 这个脚本要能贴进聊天记录不泄密。

import { loadConfig } from '../src/config.mjs';
import { resolveHeartbeatEndpoint, dshLogDirOf, dshOriginFileOf } from '../src/organs/dsh-origin.mjs';
import { readJsonWith } from '../src/web/runtime-status.mjs';

const cfg = loadConfig();
const logDir = dshLogDirOf(cfg);
const originFile = dshOriginFileOf(cfg);
const ep = resolveHeartbeatEndpoint(cfg);

const lines = [
  '日志目录   ' + (logDir || '(没有)'),
  'origin文件 ' + (originFile || '(没有)'),
];
if (!ep.ok) {
  lines.push('结论       UNRESOLVED —— ' + String(ep.why || '未知原因'));
} else {
  lines.push('来源       ' + ep.source + (ep.file ? ' / ' + ep.file : ''));
  lines.push('origin     ' + ep.origin);
  lines.push('心跳地址   ' + ep.url);
  const r = await readJsonWith(ep.url, 3000, globalThis.fetch);
  if (r.ok) {
    const d = r.data || {};
    lines.push('心跳       ok（enabled=' + String(d.enabled) + ' primaryFound=' + String(d.primaryFound)
      + ' 有primarySessionId=' + (d.primarySessionId ? 'yes' : 'no') + '）');
  } else {
    lines.push('心跳       读不到：' + String(r.error || '').slice(0, 120));
  }
}
console.log(lines.join('\n'));
process.exit(ep.ok ? 0 : 2);
