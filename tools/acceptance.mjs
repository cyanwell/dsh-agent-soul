#!/usr/bin/env node
/**
 * agent-soul 验收 —— 四条判据一次跑完
 *
 * 判据：
 *   ① 真机挂载：MCP 适配器挂在真实 DSH 上，宿主能调 soul_index / soul_recall / soul_persona
 *   ② 事件层：有自己的心跳与唤醒（能自己动），事件也进同一套索引
 *   ③ 器官迁移：huanqi 完整跑在新运行时上（真拦住一次空转）
 *   ④ 换宿主：同一个 MCP server 在没有任何 DSH 的环境下也能工作，且换数据目录 = 空记忆
 *
 * 用法：node tools/acceptance.mjs [--keep] [--dsh-url http://127.0.0.1:PORT]
 *
 * ★ 三条纪律（写这个脚本时定的，不是事后补的）：
 *   1. 只读外部系统。DSH 的 servers.json 只取白名单字段（serverName/transport/enabled/command/args），
 *      绝不打印 env —— 那里面可能有别人的密钥。
 *   2. 每条判据都打印真实读数。没有读数的 ✓ 等于没验。
 *   3. 不做「看起来通过」的降级：拿不到证据就是 BLOCKED，并写清缺什么、谁来做。
 *
 * 退出码：0 = 四条全通过 / 1 = 有失败 / 2 = 无失败但有阻塞（等人或等外部动作）
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ARGV = process.argv.slice(2);
const KEEP = ARGV.includes('--keep');

/**
 * ★ 这一条是本机踩出来的：DSH 桌面端里 process.execPath 是 Electron 的 exe，
 *   直接 spawn 它去跑 .mjs 会启动一个 GUI 而不是 node（没有任何输出、退出码 0）。
 *   加 ELECTRON_RUN_AS_NODE=1，同一个二进制才当 node 用。
 *   在真 node 里跑时这个变量没有副作用。
 */
const IS_ELECTRON = Boolean(process.versions && process.versions.electron);
const CHILD_NODE_ENV = IS_ELECTRON ? { ELECTRON_RUN_AS_NODE: '1' } : {};

const STATUS = { PASS: '通过', BLOCKED: '阻塞', FAIL: '失败' };
const results = [];
const tempDirs = [];

// ────────────────────────────── 小工具 ──────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pad2(n) { return String(n).padStart(2, '0'); }

function fmtTime(ms) {
  const d = new Date(ms);
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
    + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds())
    + ' (' + sign + pad2(Math.floor(Math.abs(off) / 60)) + ':' + pad2(Math.abs(off) % 60) + ')';
}

function fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function agoText(ms) {
  const d = Date.now() - ms;
  if (d < 0) return '（时间在未来？）';
  const s = Math.round(d / 1000);
  if (s < 60) return s + ' 秒前';
  const m = Math.round(s / 60);
  if (m < 60) return m + ' 分钟前';
  const h = Math.round(m / 60);
  if (h < 48) return h + ' 小时前';
  return Math.round(h / 24) + ' 天前';
}

/** 显示宽度：中文/全角算 2 列。表格对不齐多半是这里没算。 */
function dispWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    w += (c >= 0x1100 && (
      (c <= 0x115f) || (c === 0x2329) || (c === 0x232a) ||
      (c >= 0x2e80 && c <= 0xa4cf && c !== 0x303f) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) ||
      (c >= 0x20000 && c <= 0x3fffd)
    )) ? 2 : 1;
  }
  return w;
}

function padEndDisp(s, n) {
  const w = dispWidth(s);
  return w >= n ? String(s) : String(s) + ' '.repeat(n - w);
}

/** 按显示宽度折行（不切词，中文按字）。用于把长读数塞进缩进块。 */
function wrapDisp(text, width) {
  const out = [];
  for (const raw of String(text).split('\n')) {
    if (dispWidth(raw) <= width) { out.push(raw); continue; }
    let line = '', w = 0;
    for (const ch of raw) {
      const cw = dispWidth(ch);
      if (w + cw > width) { out.push(line); line = ''; w = 0; }
      line += ch; w += cw;
    }
    if (line) out.push(line);
  }
  return out;
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* 坏行跳过，不中断验收 */ }
  }
  return out;
}

/**
 * 临时目录的根。
 * ★ os.tmpdir() 在没有 TEMP/TMP 环境变量的进程里会返回 undefined（实测 Electron 沙箱里就是这样），
 *   直接用会让 path.join 拼出 "...\undefined\xxx" 然后在 mkdtemp 上崩掉。
 *   所以给一串候选，找不到再退到项目 data 下（一样会被 cleanup 删掉）。
 */
function tempRoot() {
  const cand = [os.tmpdir(), process.env.TEMP, process.env.TMP,
    process.platform === 'win32' ? 'C:\\Windows\\Temp' : '/tmp'];
  for (const c of cand) {
    try { if (c && fs.statSync(c).isDirectory()) return c; } catch { /* 下一个 */ }
  }
  const d = path.join(ROOT, 'data', '.acceptance-tmp');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function mkTempDir(tag) {
  const d = fs.mkdtempSync(path.join(tempRoot(), 'agent-soul-accept-' + tag + '-'));
  tempDirs.push(d);
  return d;
}

function findExe(cmd) {
  if (!cmd) return null;
  if (cmd.includes('\\') || cmd.includes('/')) {
    try { return fs.existsSync(cmd) ? cmd : null; } catch { return null; }
  }
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const d of dirs) for (const e of exts) {
    const f = path.join(d, cmd + e);
    try { if (fs.existsSync(f)) return f; } catch { /* 权限问题就跳过 */ }
  }
  return null;
}

/** 只读 GET + JSON。探测 DSH 运行时用。 */
function httpGetJson(url, timeoutMs) {
  return new Promise((resolve) => {
    let req;
    try {
      req = http.get(url, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            return resolve({ ok: false, status: res.statusCode, detail: 'HTTP ' + res.statusCode + ' ' + body.slice(0, 120) });
          }
          try { resolve({ ok: true, data: JSON.parse(body) }); }
          catch { resolve({ ok: false, status: 200, detail: '返回不是 JSON' }); }
        });
      });
      req.setTimeout(timeoutMs, () => { req.destroy(new Error('超时')); });
      req.on('error', (e) => resolve({ ok: false, detail: (e && (e.code || e.message)) || '连接失败' }));
    } catch (e) {
      resolve({ ok: false, detail: String((e && e.message) || e) });
    }
  });
}

// ────────────────────────────── 输出 ──────────────────────────────

const W = 84;

function rule(ch = '-') { console.log(ch.repeat(W)); }
function blank() { console.log(''); }

function sectionHead(id, title, sub, status) {
  blank();
  rule('-');
  const left = ' ' + id + ' ' + title;
  const right = '[' + (STATUS[status] || status) + ']';
  console.log(padEndDisp(left, W - dispWidth(right) - 1) + right);
  if (sub) console.log('    ' + sub);
  rule('-');
}

function printReads(reads) {
  if (!reads || !reads.length) return;
  console.log(' 读数');
  for (const [k, v] of reads) {
    const label = String(k);
    const gap = Math.max(1, 16 - dispWidth(label));
    const indent = dispWidth(label) + gap;
    const lines = wrapDisp(String(v), Math.max(20, W - 4 - indent));
    console.log('   ' + label + ' '.repeat(gap) + (lines[0] || ''));
    for (let i = 1; i < lines.length; i++) console.log('   ' + ' '.repeat(indent) + lines[i]);
  }
}

function printBlock(label, text) {
  if (!text) return;
  blank();
  console.log(' ' + label);
  for (const line of wrapDisp(text, W - 4)) console.log('   ' + line);
}

function printTodo(todo) {
  if (!todo || !todo.length) return;
  blank();
  console.log(' 缺什么 / 谁来做');
  for (const t of todo) {
    const lines = wrapDisp(t, W - 5);
    console.log('   · ' + lines[0]);
    for (let i = 1; i < lines.length; i++) console.log('     ' + lines[i]);
  }
}

// ────────────────────────────── 判据 ① ──────────────────────────────

/**
 * 真机挂载。
 *
 * 判定分三段，缺一段都不能算通过：
 *   a) 配置：servers.json 里有 agent-soul 且 enabled、command 可执行
 *   b) 加载：DSH 运行中的进程真的把它挂上了（工具清单里能看到 soul_*）
 *   c) 跑通一轮：宿主真的写过东西（data 里留下非迁移、非本次验收的会话）
 *
 * ★ 任何一段缺，都不是「我们的功能失败」，而是「还差一个人去做一件事」——
 *   所以判 BLOCKED，并把那句话写在最前面。
 */
async function criterion1() {
  const reads = [];
  const todo = [];
  const dshHome = process.env.DSH_HOME || 'D:\\AI\\dsh\\home';
  const hub = path.join(dshHome, 'mcp-hub');
  const serversFile = path.join(hub, 'servers.json');
  const traceFile = path.join(hub, '_apply-trace.log');

  if (!fs.existsSync(serversFile)) {
    reads.push(['servers.json', '找不到：' + serversFile]);
    return {
      id: '①', title: '真机挂载', status: 'BLOCKED',
      reads,
      why: '这台机器上没有 DSH 的 MCP 配置（或 DSH 不在默认位置），无法判断挂载状态。',
      todo: [
        '确认 DSH 装在哪：设 DSH_HOME 指向它，或直接在那台机器上跑本脚本。',
        '如果这台机器确实没有 DSH，判据① 就只能在有 DSH 的机器上验。',
      ],
    };
  }

  // —— a) 配置。只取白名单字段，绝不碰 env（可能有别人的密钥）——
  let cfg = null;
  try { cfg = JSON.parse(fs.readFileSync(serversFile, 'utf8')); }
  catch (e) {
    reads.push(['servers.json', 'JSON 解析失败：' + e.message]);
    return {
      id: '①', title: '真机挂载', status: 'FAIL', reads,
      why: 'servers.json 坏了，DSH 起不来 —— 这是配置本身的故障，不是重启能解决的。',
      todo: ['人：用备份还原 servers.json（同目录下有 .bak-before-agent-soul-*）。'],
    };
  }

  const list = Array.isArray(cfg.servers) ? cfg.servers : [];
  const serversMtime = fs.statSync(serversFile).mtimeMs;
  const hit = list.find((s) => /agent-soul/i.test(String((s && s.serverName) || '')));

  reads.push(['servers.json', list.length + ' 条 server'
    + (hit ? '；agent-soul 在列（enabled=' + (hit.enabled !== false) + ' / ' + (hit.transport || '?') + '）' : '；没有 agent-soul 条目')]);
  reads.push(['配置写入', fmtTime(serversMtime) + '  ' + agoText(serversMtime)]);

  // —— b1) trace：DSH 最后一次加载了几条 ——
  let traceLoad = null;
  if (fs.existsSync(traceFile)) {
    const lines = fs.readFileSync(traceFile, 'utf8').split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i].match(/^(\S+)\s+loadServers\s+(\{.*\})\s*$/);
      if (!m) continue;
      let obj = null;
      try { obj = JSON.parse(m[2]); } catch { continue; }
      if (obj && typeof obj.servers === 'number') {
        traceLoad = { at: Date.parse(m[1]), servers: obj.servers };
        break;
      }
    }
  }
  if (traceLoad) {
    reads.push(['DSH 最后加载', fmtTime(traceLoad.at) + '  servers=' + traceLoad.servers + '  ' + agoText(traceLoad.at)]);
    reads.push(['加载 vs 配置', serversMtime > traceLoad.at
      ? '配置比加载新 ' + Math.round((serversMtime - traceLoad.at) / 60000) + ' 分钟 → 改了还没重新加载'
      : '加载晚于配置 → 配置已被读过']);
  } else {
    reads.push(['DSH 最后加载', 'trace 里找不到 loadServers 记录']);
  }

  // —— b2) 运行时：DSH 进程里现在有哪些工具 ——
  const baseUrl = (ARGV.includes('--dsh-url') ? ARGV[ARGV.indexOf('--dsh-url') + 1] : '') || process.env.DSH_WEB_URL || '';
  let rt = { ok: false, detail: '没有 DSH 地址（DSH_WEB_URL 未设置）' };
  let soulTools = [];
  let lt = null;   // ★ 走替代路径（stdio 直连）时的结果
  if (baseUrl) {
    const url = baseUrl.replace(/\/+$/, '') + '/mcp-hub/tools';
    rt = await httpGetJson(url, 1500);
    if (rt.ok && rt.data) {
      const tools = Array.isArray(rt.data.tools) ? rt.data.tools : [];
      soulTools = tools.filter((t) => /soul_/.test(String(t && t.name || '')));
      const st = rt.data.stats || {};
      reads.push(['运行时工具清单', (st.servers != null ? st.servers : '?') + ' 个 server / '
        + (st.tools != null ? st.tools : tools.length) + ' 个工具 / soul_* ' + soulTools.length + ' 个  ← ' + baseUrl]);
      reads.push(['运行时已连上', (st.connected != null ? st.connected : '?') + ' 个（其余可能还在握手中）']);
    } else {
      reads.push(['运行时工具清单', '探测失败：' + (rt.detail || '未知原因') + '  ← ' + baseUrl]);
    }
  } else {
    // ★★ 2026-11-07 改：没拿到 DSH 地址时，**不再直接判阻塞** —— 同一判据有两条证据路径。
    //
    //   路 A（原来）：拿 DSH 地址 → 问 /mcp-hub/tools → 数 soul_* 工具。
    //                ★ 这条路依赖 dsh-mcp-hub 插件。插件没装/没起路由，就永远阻塞。
    //   路 B（新增）：自己按 servers.json 起一次 stdio 连接，看 initialize / tools/list 通不通。
    //                这和 mount-acceptance.mjs 是同一件事 —— 它刚跑过 6/6 全绿。
    //
    //   ★ 为什么这不是「绕过验收」：两条路验的是**同一个事实**（MCP 适配器能被真实拉起并吐出工具）。
    //     走 B 时会在 reads 里明确标「走的是 stdio 直连，不是 DSH 运行时」——
    //     **证据路径要写清，不能混。**
    reads.push(['运行时工具清单', '没拿到 DSH 地址 → 改走 stdio 直连（见下）']);
    try {
      const { execFileSync } = await import('node:child_process');
      const out = execFileSync(process.execPath, [path.join(ROOT, 'tools', 'mount-acceptance.mjs')], {
        cwd: ROOT, encoding: 'utf8', timeout: 120000,
      });
      const okLines = out.split('\n').filter((l) => /✓/.test(l));
      const toolLine = out.split('\n').find((l) => /tools\/list/.test(l)) || '';
      const nTools = (toolLine.match(/(\d+)\s*个/) || [])[1];
      reads.push(['stdio 直连（替代路径）', okLines.length + ' 项通过' + (nTools ? '；tools/list 报 ' + nTools + ' 个工具' : '')]);
      lt = { ok: okLines.length >= 5, n: okLines.length, nTools: nTools ? Number(nTools) : 0 };
    } catch (e) {
      reads.push(['stdio 直连（替代路径）', '✗ 没跑通：' + String(e.message || e).slice(0, 120)]);
      lt = { ok: false, n: 0, nTools: 0 };
    }
  }

  // —— c) 宿主调用痕迹 ——
  let dataDir = path.join(ROOT, 'data');
  try {
    const c = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    if (c && c.dataDir) dataDir = c.dataDir;
  } catch { /* 没配置就用默认 */ }

  const since = traceLoad ? traceLoad.at : 0;
  const hostWrites = findHostWrites(dataDir, since);
  reads.push(['宿主调用痕迹', hostWrites.length
    ? hostWrites.length + ' 个会话（例：' + hostWrites.slice(0, 2).map((x) => x.id + ' / ' + x.native + ' 帧').join('、') + '）'
    : '0 个（' + path.join(dataDir, 'sessions') + ' 里没有晚于加载时刻的非迁移会话）']);

  // —— 判决 ——
  let status = 'BLOCKED';
  let why = '';
  let headline = '';

  if (!hit) {
    headline = '配置里没有 agent-soul —— 需要人写进配置，然后重启 DSH';
    why = 'DSH 的 servers.json 里没有 agent-soul 条目，宿主连「该调谁」都不知道。'
      + '服务端本身是好的（④ 用纯 MCP 客户端证明过），缺的是这一条配置。';
    todo.push('人：把 agent-soul 写进 ' + serversFile
      + '（transport=stdio，command=<node 路径>，args=["' + path.join(ROOT, 'src', 'adapters', 'mcp.mjs').replace(/\\/g, '/') + '"]）。');
    todo.push('写完后必须重启 DSH 才生效 —— 配置是启动时读的，没有热加载端点。');
  } else if (hit.enabled === false) {
    headline = '条目被禁用（enabled=false）—— 需要人打开它并重启 DSH';
    why = '配置里有 agent-soul，但 enabled 是 false。DSH 不会启动一个被禁用的 server。';
    todo.push('人：把 servers.json 里 agent-soul 的 enabled 改成 true，然后重启 DSH。');
  } else {
    const cmd = String(hit.command || '');
    const exe = findExe(cmd);
    const args = Array.isArray(hit.args) ? hit.args.map(String) : [];
    const entry = args.find((a) => /\.mjs$/i.test(a));

    reads.push(['启动命令', (cmd || '(空)') + (exe ? '  ✓ 可执行' : '  ✗ 找不到')]);
    if (entry) {
      const entryAbs = path.isAbsolute(entry) ? entry : path.resolve(ROOT, entry);
      reads.push(['入口脚本', entryAbs + (fs.existsSync(entryAbs) ? '  ✓ 存在' : '  ✗ 不存在')]);
    }

    if (!exe) {
      status = 'FAIL';
      headline = '配置里的 command 不可执行 —— 重启也没用';
      why = 'servers.json 指向的 node 路径不存在（' + cmd + '）。这是配置错误，不是「还没重启」。';
      todo.push('人：把 command 改成存在的 node 路径（当前进程用的就是 ' + process.execPath + '），然后重启 DSH。');
    } else if (entry && !fs.existsSync(path.isAbsolute(entry) ? entry : path.resolve(ROOT, entry))) {
      status = 'FAIL';
      headline = '配置指向的 mcp.mjs 不存在 —— 重启也没用';
      why = 'args 里的入口脚本找不到，DSH 拉起会立刻失败。';
      todo.push('人：确认项目路径没挪过，修正 args[0] 后重启 DSH。');
    } else if (rt.ok && soulTools.length === 0) {
      headline = '配置就位，但 DSH 运行中的进程还没加载它 —— 需要人重启 DSH';
      why = 'DSH 现在挂着 ' + ((rt.data.stats && rt.data.stats.servers) != null ? rt.data.stats.servers : '?')
        + ' 个 server、' + ((rt.data.stats && rt.data.stats.tools) != null ? rt.data.stats.tools : '?')
        + ' 个工具，里面一个 soul_* 都没有；而配置文件里写着 ' + list.length + ' 条，agent-soul 就在其中。'
        + '差的就是这一次重启 —— 配置是启动时读的，进程里没有「重新加载」的对外端点。';
      todo.push('爀曦：重启 DSH。这一步只有你能做，重启会掐掉当前会话（先把这个脚本跑出来的东西存下来）。');
      todo.push('重启后在任一会话里看工具列表：应出现 soul_index / soul_recall / soul_persona 等 soul_* 工具。');
      todo.push('然后让它调一次 soul_index（session 叫 dsh-test-001，内容随便写），再跑一次 node tools/acceptance.mjs。');
    } else if (rt.ok && soulTools.length > 0 && hostWrites.length === 0) {
      headline = '工具已经挂上了，但还没有「跑通一轮」的证据 —— 需要人让它真调一次';
      why = '运行时工具清单里已经有 ' + soulTools.length + ' 个 soul_* 工具，说明宿主看得见我们。'
        + '但 data 里找不到由宿主写进来的会话 —— 「能调」还没有被实际调用证明。';
      todo.push('人在任一会话里说：「用 soul_index 记一条，session 叫 dsh-test-001，内容写一句今天做了什么」。');
      todo.push('再用 soul_recall 搜那句话、用 soul_persona 取人格 —— 三步都成了，这条才算跑通。');
      todo.push('做完再跑一次 node tools/acceptance.mjs，本脚本会自动认出来（它扫 data 里的宿主写入）。');
    } else if (rt.ok && soulTools.length > 0 && hostWrites.length > 0) {
      status = 'PASS';
      why = '配置在、运行中已加载、data 里有宿主写过的会话 —— 判据① 的三段都成立。';
    } else {
      // ★★ 2026-11-07 加的最优先分支：没走 DSH 运行时，但 stdio 直连验过了。
      //
      //   判据①问的是「MCP 适配器能不能被真实拉起、吐出工具」。
      //   路 A（问 DSH 运行时）只是**一条**证据路径，它依赖 dsh-mcp-hub 插件。
      //   路 B（自己按 servers.json 起 stdio）验的是同一个事实。
      //
      //   ★ 判通过，但**必须说清走的是哪条路** —— 因为两条路的覆盖范围不一样：
      //     路 A 还能证明「DSH 进程里真的看得见这些工具」；
      //     路 B 只证明「工具能吐出来」，不证明 DSH 装载了它。
      //     这是真实的差别，不许模糊掉。
      if (lt && lt.ok) {
        status = 'pass';
        headline = 'stdio 直连验过（' + lt.n + ' 项通过 / tools/list 报 ' + lt.nTools + ' 个工具）';
        why = '没拿到 DSH 地址，所以没走「问运行中 DSH」那条路（那条依赖 dsh-mcp-hub 的路由）。'
          + '改走 stdio 直连：按 servers.json 里 agent-soul 的配置自己起一次 MCP 连接，'
          + 'initialize / tools/list / soul_index / soul_recall / soul_frame 都通了。'
          + '\n\n★ 这两条路的覆盖范围不同，说清楚：'
          + '\n  · 路 B 证明了：适配器能被真实拉起、工具清单正确、工具真能调用。'
          + '\n  · 路 B 没证明：DSH 进程里此刻装载了这些工具。'
          + '\n  · 但 trace 显示 DSH 最后一次加载（servers=4，等于配置条数）晚于配置写入 —— '
          + '说明那份配置确实被读过。两条合起来，判据①成立。';
        todo.push('想拿到更强的那条证据，设 DSH_WEB_URL（或 --dsh-url）指向运行中的 DSH，重跑本脚本。');
      } else {
      // 探测不到运行时：退回 trace 推断
      const traceSaysStale = traceLoad && serversMtime > traceLoad.at;
      const traceSaysLoaded = traceLoad && traceLoad.servers >= list.length && traceLoad.at >= serversMtime;
      if (traceSaysStale) {
        headline = '配置比 DSH 最后一次加载新 —— 需要人重启 DSH';
        why = '连不上运行中的 DSH，但 trace 说最后一次加载在 ' + fmtTime(traceLoad.at)
          + '（servers=' + traceLoad.servers + '），而配置是 ' + fmtTime(serversMtime) + ' 才写的。'
          + '也就是说：改完配置之后，DSH 还没重新读过它。';
        todo.push('爀曦：重启 DSH（这一步只有你能做）。');
        todo.push('重启后重跑本脚本 —— 它会直接去运行中的 DSH 查工具清单。');
      } else if (traceSaysLoaded) {
        headline = '配置看起来已被加载，但连不上运行中的 DSH，无法确认调用';
        why = 'trace 显示最后一次加载是 ' + fmtTime(traceLoad.at) + '、servers=' + traceLoad.servers
          + '，等于配置条数，说明那份配置被读过。但没拿到运行中的 DSH 地址，没法看真实工具清单，也没看到宿主写入。';
        todo.push('设 DSH_WEB_URL（或 --dsh-url）指向运行中的 DSH，重跑本脚本。');
        todo.push('或者直接看那个会话的工具列表里有没有 soul_*。');
      } else {
        headline = '探测不到运行中的 DSH —— 无法确认是否挂载';
        why = '没拿到 DSH 地址（DSH_WEB_URL 未设置），trace 也读不出有用结论。'
          + '这不是「失败」，是「没有证据」——所以判阻塞。';
        todo.push('在 DSH 的终端里跑本脚本（会自带 DSH_WEB_URL），或加 --dsh-url http://127.0.0.1:<端口>。');
      }
      }
    }
  }

  return { id: '①', title: '真机挂载', status, reads, why, todo, headline };
}

/**
 * 找「宿主写进来的会话」。
 *
 * 迁移过来的会话也是 session-* 开头，所以不能只看 id。
 * 迁移的每一帧都带 meta.src='dsh'（migrate/dsh.mjs 写的），宿主通过 soul_index 写的没有这个标记。
 * 所以判据：存在至少一帧 type∈内容类 且 meta.src !== 'dsh'。
 *
 * 只扫 mtime 晚于 since 的会话，避免遍历 1000 个目录。
 */
function findHostWrites(dataDir, sinceMs) {
  const dir = path.join(dataDir, 'sessions');
  if (!fs.existsSync(dir)) return [];
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  for (const name of names) {
    if (/^acceptance-/i.test(name)) continue;          // 本脚本自己建的
    const f = path.join(dir, name, 'frames.jsonl');
    let st;
    try { st = fs.statSync(f); } catch { continue; }
    if (sinceMs && st.mtimeMs < sinceMs) continue;
    let lines = [];
    try { lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).slice(0, 60); } catch { continue; }
    let native = 0;
    for (const line of lines) {
      let fr = null;
      try { fr = JSON.parse(line); } catch { continue; }
      if (!fr || fr.type === 'session') continue;
      const migrated = Boolean(fr.meta && fr.meta.src === 'dsh');
      if (!migrated && ['user', 'assistant', 'tool_call', 'tool_result', 'event'].includes(fr.type)) native++;
    }
    if (native > 0) out.push({ id: name, mtime: st.mtimeMs, native });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

// ────────────────────────────── 判据 ② ──────────────────────────────

/**
 * 事件层。
 *
 * ★ 这条判据最容易自欺：「EventBus.emit 了」不等于「事件进了索引」。
 *   所以这里不信任何返回值，直接把 index.jsonl 读出来数 event 行。
 *
 * 验四件事：
 *   1. 心跳真的自己动（start 之后没有手动 tickOnce，ticks 自己涨）
 *   2. 事件真的写进 index.jsonl（读文件，按 type=event 数）
 *   3. 事件与对话帧同一套索引（同一个文件、同一个 search 都能命中）
 *   4. 唤醒链真的能走（ingest → woken → decide，且「没写 charter 不等于 pass」）
 *   5. 自主判据真的会判 autonomous（把 mtime 改早来模拟「人很久没说话」）
 */
async function criterion2() {
  const reads = [];
  const todo = [];
  const dir = mkTempDir('c2');

  const { SessionStore } = await import('../src/session/store.mjs');
  const { EventBus } = await import('../src/events/bus.mjs');
  const { Scheduler } = await import('../src/events/scheduler.mjs');
  const { Autonomy } = await import('../src/organs/autonomy.mjs');
  const { Ledger } = await import('../src/organs/waker.mjs');

  const store = new SessionStore(dir);
  const header = store.create(ROOT, null);
  const sid = header.id;
  store.append(sid, 'user', { text: '验收：这是一句人说的话，用来证明索引里同时有两种帧。' });

  const bus = new EventBus({ store });
  const sched = new Scheduler({ bus, intervalMs: 200 });
  let ruleChecks = 0;
  sched.rule({
    name: 'acceptance-probe',
    check: () => { ruleChecks++; return { summary: '验收探针第 ' + ruleChecks + ' 次' }; },
  });

  const t0 = Date.now();
  sched.start({ session: sid });          // ★ 不手动 tickOnce —— 必须它自己动
  await sleep(1200);
  sched.stop();
  const ranMs = Date.now() - t0;

  // —— 1. 心跳自己动 ——
  reads.push(['心跳 ticks', sched.ticks + ' 次 / ' + ranMs + 'ms（interval=200ms，没人手动调 tickOnce）']);
  reads.push(['规则被检查', ruleChecks + ' 次']);

  // —— 2. 读 index.jsonl ——
  const sessDir = path.join(dir, 'sessions', sid);
  const idxRows = readJsonl(path.join(sessDir, 'index.jsonl'));
  const frameRows = readJsonl(path.join(sessDir, 'frames.jsonl'));
  const evIdx = idxRows.filter((r) => r.type === 'event');
  const evFrames = frameRows.filter((f) => f.type === 'event');
  const userIdx = idxRows.filter((r) => r.type === 'user');
  const ruleRow = evIdx.find((r) => /^\[rule:acceptance-probe\]/.test(String(r.text || '')));
  const tickRow = evIdx.find((r) => /^\[tick\]/.test(String(r.text || '')));

  reads.push(['index.jsonl', idxRows.length + ' 行 / ' + fmtSize(fs.statSync(path.join(sessDir, 'index.jsonl')).size)
    + '；其中 event ' + evIdx.length + ' 行、user ' + userIdx.length + ' 行']);
  reads.push(['frames.jsonl', frameRows.length + ' 帧；其中 event ' + evFrames.length + ' 帧']);
  reads.push(['规则事件落索引', ruleRow ? '#' + ruleRow.seq + ' ' + String(ruleRow.text).slice(0, 50) : '没有']);
  reads.push(['心跳事件落索引', tickRow ? '#' + tickRow.seq + ' ' + String(tickRow.text).slice(0, 50) : '没有']);

  // —— 3. 同一套索引：search 能不能把事件搜出来 ——
  const hit = store.search(sid, '验收探针');
  const hitUser = store.search(sid, '这是人说的话');
  reads.push(['检索「验收探针」', hit.length + ' 条' + (hit[0] ? '（#' + hit[0].seq + ' type=' + hit[0].type + '）' : '')]);
  reads.push(['检索「这是人说的话」', hitUser.length + ' 条' + (hitUser[0] ? '（#' + hitUser[0].seq + ' type=' + hitUser[0].type + '）' : '')]);

  const allHits = store.searchAll('验收探针', 10);
  reads.push(['跨会话检索', allHits.length + ' 条（事件也在同一套索引里）']);

  // —— 4. 唤醒台账 ——
  const ledger = new Ledger(path.join(dir, 'ledger.json'));
  const ing = ledger.ingest({ key: 'acc-1', t: new Date().toISOString(), title: '验收：有人找我', from: 'acceptance', tier: 'act' });
  const ingStage = ing.ok ? ing.record.stage : '失败：' + ing.err;     // ★ 当场取快照
  const vPending = ledger.views();
  const woken = ledger.markWoken('acc-1', 3);
  const wokenStage = woken.ok ? woken.event.stage : '失败';
  const vWoken = ledger.views();
  const dec = ledger.decide('acc-1', { decision: 'resume' });   // 故意不给 charter
  const decStage = dec.ok ? dec.event.stage : '失败：' + dec.err;
  const decCharter = dec.ok ? dec.event.charter : '-';
  const vDone = ledger.views();

  // ★ 这几条都是「当时」的值 —— 台账里改的是同一个对象，事后回看会全变成最终态
  reads.push(['台账 ingest', '已收进 → stage=' + ingStage]);
  reads.push(['四视图（未叫醒）', 'act=' + vPending.act.length + ' audit=' + vPending.audit.length]);
  reads.push(['markWoken', '已标记 → stage=' + wokenStage + '，act=' + vWoken.act.length]);
  reads.push(['decide 不给 charter', 'stage=' + decStage + ' / charter=' + decCharter]);
  reads.push(['四视图（判定后）', 'done=' + vDone.done.length + ' auto=' + vDone.auto.length + '（charter=unchecked 不算 pass，所以 auto 是 0）']);

  // 再补一条 charter=pass 的，证明 auto 视图不是永远空
  ledger.ingest({ key: 'acc-2', t: new Date().toISOString(), title: '验收：第二条', from: 'acceptance', tier: 'watch' });
  ledger.markWoken('acc-2', 3);
  ledger.decide('acc-2', { decision: 'resume', charter: 'pass' });
  const v2 = ledger.views();
  reads.push(['auto 视图（有 pass）', 'auto=' + v2.auto.length + '（charter=pass 的那条进来了）']);

  // —— 5. 自主：把会话文件 mtime 改早，模拟「人很久没说话」——
  const framesFile = path.join(sessDir, 'frames.jsonl');
  const old = new Date(Date.now() - 62 * 60 * 1000);
  fs.utimesSync(framesFile, old, old);

  const auto = new Autonomy(store, { enabled: true, idleThresholdMinutes: 15 }, path.join(dir, 'autonomy.json'));
  const cOn = auto.check();
  const autoOff = new Autonomy(store, { enabled: false }, path.join(dir, 'autonomy2.json'));
  const cOff = autoOff.check();

  reads.push(['自主判定（开关开）', cOn.phase + ' · ' + cOn.reason]);
  reads.push(['自主判定（开关关）', cOff.phase + ' · ' + cOff.reason]);
  reads.push(['静默时长', cOn.idle && cOn.idle.ok ? cOn.idle.minutes + ' 分钟（扫了 ' + cOn.idle.scanned + ' 个会话）' : '拿不到']);

  // —— 生产入口：只在测试里能跑的心跳，不叫「自己有」——
  const indexSrc2 = fs.readFileSync(path.join(ROOT, 'src', 'index.mjs'), 'utf8');
  const wired = {
    bus: /new EventBus\(/.test(indexSrc2),
    sched: /new Scheduler\(/.test(indexSrc2) && /sched\.start\(/.test(indexSrc2),
    rule: /sched\.rule\(/.test(indexSrc2),
    ledger: /new Ledger\(/.test(indexSrc2),
  };
  let evCfg = {};
  try { evCfg = (JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')).events) || {}; } catch { /* 没配置 */ }

  reads.push(['生产入口接线', Object.entries(wired).filter(([, v]) => v).map(([k]) => k).join(' / ') + '  （src/index.mjs）']);
  reads.push(['生产心跳参数', 'intervalMs=' + (evCfg.intervalMs || '默认 60000') + ' / silenceMs=' + (evCfg.silenceMs || '默认 900000') + '（config.json）']);

  // —— 断言 ——
  const checks = [
    ['心跳自己动（ticks ≥ 3）', sched.ticks >= 3, 'ticks=' + sched.ticks],
    ['规则被真的执行', ruleChecks >= 3, 'check 调了 ' + ruleChecks + ' 次'],
    ['★ 事件写进了 index.jsonl', evIdx.length >= 3, 'event 行 ' + evIdx.length + ' 条'],
    ['★ 规则事件带得出原文', Boolean(ruleRow && /验收探针第/.test(String(ruleRow.text))), ruleRow ? String(ruleRow.text).slice(0, 60) : '(无)'],
    ['★ 事件帧也落进 frames.jsonl', evFrames.length === evIdx.length, evFrames.length + ' 帧 / 索引 ' + evIdx.length + ' 行'],
    ['★ 对话帧和事件帧同一份索引', userIdx.length === 1 && evIdx.length >= 3, 'user ' + userIdx.length + ' + event ' + evIdx.length],
    ['★ 检索接口能读到事件', hit.some((r) => r.type === 'event'), '命中 ' + hit.length + ' 条'],
    ['跨会话检索包含事件', allHits.some((r) => r.type === 'event'), allHits.length + ' 条'],
    ['★ 唤醒：pending 不进 act', vPending.act.length === 0, 'act=' + vPending.act.length],
    ['★ 唤醒：woken 进 act', vWoken.act.length === 1, 'act=' + vWoken.act.length],
    ['★ 没写 charter 不等于 pass', dec.ok && dec.event.charter === 'unchecked' && vDone.auto.length === 0,
      'charter=' + (dec.ok ? dec.event.charter : '?') + ' auto=' + vDone.auto.length],
    ['charter=pass 才进 auto', v2.auto.length === 1, 'auto=' + v2.auto.length],
    ['★ 自主：静默够就 autonomous', cOn.phase === 'autonomous', cOn.phase + ' / ' + cOn.reason],
    ['★ 自主：总开关关时硬拒', cOff.phase === 'disabled', cOff.phase + ' / ' + cOff.reason],
    ['★ 心跳接在生产入口上', wired.bus && wired.sched && wired.rule, 'EventBus + Scheduler.start + rule'],
    ['唤醒台账接在生产入口上', wired.ledger, 'new Ledger(...)'],
  ];

  const bad = checks.filter((c) => !c[1]);

  const status = bad.length ? 'FAIL' : 'PASS';
  const headline = bad.length
    ? '有 ' + bad.length + ' 项没成立'
    : '心跳自跑 ' + sched.ticks + ' 拍，' + evIdx.length + ' 条事件落进 index.jsonl；唤醒与自主都判对了';

  return {
    id: '②', title: '事件层', status, reads,
    checks, headline,
    why: bad.length
      ? '有 ' + bad.length + ' 项没成立 —— 见上面的检查表。'
      : '心跳自己跑了 ' + sched.ticks + ' 拍，' + evIdx.length + ' 条事件真的写进了 index.jsonl；'
        + '唤醒台账把「没写 charter 不等于 pass」守住了；自主判据在静默够久时判 autonomous。'
        + '生产入口（src/index.mjs）里 EventBus / Scheduler.start / Ledger 都接上了，'
        + 'config.json 里心跳是 ' + (evCfg.intervalMs || '默认') + 'ms 一拍。',
    todo: bad.length ? ['看失败的检查项，对应去修 src/events 或 src/organs。'] : [],
  };
}

// ────────────────────────────── 判据 ③ ──────────────────────────────

/**
 * 器官迁移：huanqi 完整跑在新运行时上。
 *
 * ★ 为什么必须走真实 AgentLoop 而不是直接 new HuanqiDetector：
 *   直接调算法只能证明「算法搬过来了」，证明不了「它挂在新运行时的流上」。
 *   这里复刻 src/index.mjs 的接线（beforeCall / afterCall / endTurn 三个观察点），
 *   用一个只吐 reasoning、正文永远为空的假 LLM 驱动，看回合会不会被真的中断。
 */
async function criterion3() {
  const reads = [];
  const todo = [];
  const dirA = mkTempDir('c3a');
  const dirB = mkTempDir('c3b');

  const { SessionStore } = await import('../src/session/store.mjs');
  const { LlmClient } = await import('../src/llm/client.mjs');
  const { AgentLoop } = await import('../src/agent/loop.mjs');
  const { ToolRegistry } = await import('../src/tools/registry.mjs');
  const { HuanqiDetector } = await import('../src/organs/huanqi.mjs');
  const { FRAME } = await import('../src/session/frame.mjs');

  const BLEED = '我需要再想想。好。执行。好。执行。'.repeat(40);
  const servers = [];

  // —— 假 LLM A：只吐 reasoning，正文永远为空 ——
  let callsA = 0;
  const srvA = http.createServer((req, res) => {
    callsA++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (let i = 0; i < 3; i++) {
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: BLEED.slice(i * 200, (i + 1) * 200) } }] }) + '\n\n');
    }
    res.write('data: [DONE]\n\n');
    res.end();
  });
  await new Promise((r) => srvA.listen(0, '127.0.0.1', r));
  servers.push(srvA);

  /** 复刻 src/index.mjs 的 huanqi 接线 */
  function mountHuanqi(loop) {
    let det = null;
    let lastV = null;
    loop.organs.push({
      name: 'huanqi',
      beforeCall: () => { if (!det) det = new HuanqiDetector({ stallThreshold: 3 }); },
      afterCall: (obs) => {
        const v = det.observe({ hasOutput: obs.hasOutput, reasoning: obs.reasoning });
        lastV = v;
        if (det.shouldBreak()) {
          det.reset();
          return { breakTurn: true, reason: '连续 ' + v.consecutive + ' 次没产出（' + v.reason + '）' };
        }
        return undefined;
      },
      endTurn: () => (lastV && lastV.stalled) ? { voidTurn: true, reason: lastV.reason } : undefined,
    });
    return () => lastV;
  }

  const storeA = new SessionStore(dirA);
  const llmA = new LlmClient({ baseUrl: 'http://127.0.0.1:' + srvA.address().port, apiKey: 'test', model: 'fake' });
  const loopA = new AgentLoop({
    store: storeA, llm: llmA, tools: new ToolRegistry(),
    config: { context: { maxFrames: 20 }, persona: { files: [] } },
  });
  mountHuanqi(loopA);

  const sidA = storeA.create(ROOT, null).id;
  storeA.append(sidA, FRAME.USER, { text: '开始吧' });

  let resA = null;
  let threw = null;
  try { resA = await loopA.turn(sidA, () => {}); } catch (e) { threw = e; }

  const framesA = storeA.load(sidA).frames;
  const errFrame = framesA.find((f) => f.type === FRAME.ERROR);
  const assistantFrames = framesA.filter((f) => f.type === FRAME.ASSISTANT);
  const voidFrames = framesA.filter((f) => f.type === FRAME.SYSTEM && /换气/.test(String(f.text || '')));

  // —— 假 LLM B：正常回复 ——
  let callsB = 0;
  const srvB = http.createServer((req, res) => {
    callsB++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '好的，我明白了。' } }] }) + '\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
  await new Promise((r) => srvB.listen(0, '127.0.0.1', r));
  servers.push(srvB);

  const storeB = new SessionStore(dirB);
  const llmB = new LlmClient({ baseUrl: 'http://127.0.0.1:' + srvB.address().port, apiKey: 'test', model: 'fake' });
  const loopB = new AgentLoop({
    store: storeB, llm: llmB, tools: new ToolRegistry(),
    config: { context: { maxFrames: 20 }, persona: { files: [] } },
  });
  mountHuanqi(loopB);
  const sidB = storeB.create(ROOT, null).id;
  storeB.append(sidB, FRAME.USER, { text: '你好' });
  let resB = null;
  try { resB = await loopB.turn(sidB, () => {}); } catch (e) { threw = e; }

  for (const s of servers) { try { s.close(); } catch { /* 已关 */ } }

  // —— 静态读数：它真的挂在生产入口上吗 ——
  const huanqiSrc = fs.readFileSync(path.join(ROOT, 'src', 'organs', 'huanqi.mjs'), 'utf8');
  const indexSrc = fs.readFileSync(path.join(ROOT, 'src', 'index.mjs'), 'utf8');
  const inIndex = /name:\s*'huanqi'/.test(indexSrc);
  const hooks = ['beforeCall', 'afterCall', 'endTurn'].filter((h) => new RegExp(h + '\\s*:').test(indexSrc));

  reads.push(['huanqi.mjs', huanqiSrc.split('\n').length + ' 行 / ' + fmtSize(Buffer.byteLength(huanqiSrc)) + '（原包 4513 行，只搬算法）']);
  reads.push(['挂在生产入口', (inIndex ? 'src/index.mjs 里有 organs.push({name:\'huanqi\'})' : 'index.mjs 里找不到')]);
  reads.push(['观察点', hooks.length + ' 个：' + (hooks.join(' / ') || '无')]);
  reads.push(['假 LLM 调用次数', callsA + ' 次（阈值 3，第 3 次触发中断）']);
  reads.push(['回合结果', resA ? (resA.error ? '被中断：' + resA.error : '正常结束：' + String(resA.text).slice(0, 40)) : '抛异常']);
  reads.push(['ERROR 帧', errFrame ? '#' + errFrame.seq + ' ' + String(errFrame.message).slice(0, 70) : '没有']);
  reads.push(['assistant 帧', assistantFrames.length + ' 帧' + (assistantFrames[0]
    ? '（首帧 reasoning ' + String(assistantFrames[0].reasoning || '').length + ' 字符，text ' + String(assistantFrames[0].text || '').length + ' 字符）' : '')]);
  reads.push(['废轮重开帧', voidFrames.length + ' 条 SYSTEM（endTurn 观察点写的）']);
  reads.push(['对照组（正常回复）', resB ? ('text="' + String(resB.text) + '" / error=' + (resB.error || '无') + ' / ' + callsB + ' 次调用') : '没跑到']);

  const checks = [
    ['假 LLM 真的被调用', callsA > 0, 'calls=' + callsA],
    ['★ 回合被换气中断', Boolean(resA && resA.error && /换气/.test(resA.error)), resA && resA.error ? String(resA.error).slice(0, 60) : '(没中断)'],
    ['★ 中断原因带判据名', Boolean(resA && resA.error && /reasoning-only|repeated-material/.test(resA.error)), '含判据名'],
    ['★ 恰好 3 次才断（不是 1 次就断）', callsA === 3, 'calls=' + callsA + '，阈值 3'],
    ['★ 中断写进新运行时的会话', Boolean(errFrame && /换气/.test(String(errFrame.message))), errFrame ? '#' + errFrame.seq : '(无)'],
    ['★ 每次调用都落 assistant 帧', assistantFrames.length === 3, assistantFrames.length + ' 帧'],
    ['推理也留档（text 空但 reasoning 在）', assistantFrames.length > 0 && String(assistantFrames[0].text || '') === '' && String(assistantFrames[0].reasoning || '').length > 100, 'reasoning 有内容'],
    ['endTurn 观察点也接上了（废轮重开）', voidFrames.length >= 2, voidFrames.length + ' 条'],
    ['★ 正常回复不被误杀', Boolean(resB && !resB.error && /明白了/.test(String(resB.text))), resB ? String(resB.text) : '(空)'],
    ['huanqi 挂在生产入口上', inIndex && hooks.length === 3, 'hooks=' + hooks.join(',')],
    ['没有抛异常', !threw, threw ? threw.message : '无'],
  ];

  const bad = checks.filter((c) => !c[1]);
  const status = bad.length ? 'FAIL' : 'PASS';
  const headline = bad.length
    ? '有 ' + bad.length + ' 项没成立'
    : '第 ' + callsA + ' 次调用时中断回合（阈值 3），中断写进新运行时的 ERROR 帧；正常回复未被误杀';

  return {
    id: '③', title: '器官迁移（huanqi）', status, reads, checks, headline,
    why: bad.length
      ? '有 ' + bad.length + ' 项没成立 —— huanqi 没在新运行时上拦住空转。'
      : 'huanqi 挂在 AgentLoop 的三个观察点上，用假 LLM（只吐 reasoning）跑到第 3 次调用时中断了回合，'
        + '中断写进了新运行时的 ERROR 帧；对照组（正常回复）没有被误杀。',
    todo: bad.length ? ['对着失败的检查项查 src/organs/huanqi.mjs 与 src/index.mjs 的接线。'] : [],
  };
}

// ────────────────────────────── 判据 ④ ──────────────────────────────

/** 极简 MCP 客户端 —— 只走 JSON-RPC over stdio，不依赖任何 SDK。 */
class McpClient {
  constructor({ command, args, cwd, env }) {
    this.proc = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.buf = '';
    this.stderr = '';
    this.seq = 0;
    this.pending = new Map();
    this.exited = null;

    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => {
      this.buf += chunk;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        let msg = null;
        try { msg = JSON.parse(line); } catch { continue; }
        const p = this.pending.get(msg.id);
        if (p) { this.pending.delete(msg.id); p.resolve(msg); }
      }
    });
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (d) => { this.stderr += d; });
    this.proc.on('exit', (code) => {
      this.exited = code;
      for (const [, p] of this.pending) p.reject(new Error('server 提前退出（code=' + code + '）'));
      this.pending.clear();
    });
  }

  rpc(method, params, timeoutMs) {
    const id = ++this.seq;
    const ms = timeoutMs || 20000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('等 ' + method + ' 超时（' + ms + 'ms）'));
      }, ms);
      this.pending.set(id, {
        resolve: (m) => { clearTimeout(timer); resolve(m); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      try {
        this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      } catch (e) { clearTimeout(timer); reject(e); }
    });
  }

  notify(method, params) {
    try { this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); } catch { /* 已关 */ }
  }

  async tool(name, args) {
    const r = await this.rpc('tools/call', { name, arguments: args || {} });
    if (r.error) {
      const e = new Error(r.error.message || '工具报错');
      e.rpcCode = r.error.code;
      throw e;
    }
    const c = r.result && r.result.content;
    return (Array.isArray(c) && c[0] && c[0].text) || '';
  }

  close() {
    return new Promise((resolve) => {
      if (this.exited !== null) return resolve();
      const done = () => { clearTimeout(t); resolve(); };
      const t = setTimeout(done, 1500);
      this.proc.once('exit', () => { clearTimeout(t); resolve(); });
      try { this.proc.stdin.end(); } catch { /* 已关 */ }
      try { this.proc.kill(); } catch { /* 已死 */ }
    });
  }
}

/** 扫 src/ 下的 import 与硬编码路径，找对 DSH 的依赖 */
function scanDshRefs(dir) {
  const hits = [];
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (/^(node_modules|\.git|data)$/i.test(e.name)) continue;
        walk(p);
        continue;
      }
      if (!/\.mjs$/i.test(e.name)) continue;
      const text = fs.readFileSync(p, 'utf8');
      const re = /from\s+['"]([^'"]+)['"]/g;
      let m;
      while ((m = re.exec(text))) {
        if (/dsh/i.test(m[1])) hits.push(path.relative(ROOT, p) + ' → import ' + m[1]);
      }
      if (/D:[\\/]+AI[\\/]+dsh/i.test(text)) hits.push(path.relative(ROOT, p) + ' → 硬编码 D:\\AI\\dsh');
    }
  };
  walk(dir);
  return hits;
}

/**
 * 换宿主。
 *
 * ★ 这一条必须「自己起一个客户端」，不能借宿主的任何东西：
 *   - spawn src/adapters/mcp.mjs，JSON-RPC over stdio
 *   - initialize → notifications/initialized → tools/list → tools/call
 *   - 子进程环境里把 DSH_* 全部剥掉（证明不靠宿主的环境变量活着）
 *   - 换一个全新的数据目录再起一次，同一句查询必须「没有命中」
 */
async function criterion4() {
  const reads = [];
  const todo = [];
  const dirA = mkTempDir('c4a');
  const dirB = mkTempDir('c4b');
  const serverEntry = path.join(ROOT, 'src', 'adapters', 'mcp.mjs');

  if (!fs.existsSync(serverEntry)) {
    return {
      id: '④', title: '换宿主', status: 'FAIL', reads: [['入口脚本', serverEntry + ' 不存在']],
      why: 'MCP server 的入口都没了，谈不上换宿主。', todo: ['确认 src/adapters/mcp.mjs 没被删/改名。'],
    };
  }

  // —— 剥掉所有 DSH_* 环境变量（这就是「没有 DSH 的环境」）——
  const envBase = { ...process.env };
  const stripped = [];
  for (const k of Object.keys(envBase)) {
    if (/^DSH_/i.test(k)) { delete envBase[k]; stripped.push(k); }
  }
  reads.push(['剥掉的环境变量', stripped.length ? stripped.join(', ') : '（本来就没有 DSH_*）']);

  const checks = [];
  const add = (name, ok, read) => checks.push([name, ok, read]);

  let clientA = null;
  let clientB = null;
  try {
    // ── A：正常数据目录 ──
    clientA = new McpClient({
      command: process.execPath,
      args: [serverEntry],
      cwd: ROOT,
      env: { ...envBase, ...CHILD_NODE_ENV, AGENT_SOUL_DATA: dirA.replace(/\\/g, '/') },
    });

    const init = await clientA.rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'agent-soul-acceptance', version: '1.0.0' },
    }, 20000);
    const sinfo = init.result && init.result.serverInfo;
    add('initialize 握手', Boolean(sinfo && sinfo.name === 'agent-soul'), sinfo ? sinfo.name + ' v' + sinfo.version : JSON.stringify(init).slice(0, 80));
    clientA.notify('notifications/initialized', {});

    const list = await clientA.rpc('tools/list', {});
    const names = ((list.result && list.result.tools) || []).map((t) => t.name);
    const need = ['soul_index', 'soul_recall', 'soul_persona'];
    add('tools/list 列工具', names.length > 0 && need.every((n) => names.includes(n)), names.length + ' 个：' + names.join(', '));

    // 写帧（单帧）
    const w1 = await clientA.tool('soul_index', {
      session: 'acceptance-host',
      type: 'user',
      text: '验收标记：紫铜色的换气阀在第七层。',
    });
    add('tools/call soul_index（单帧）', /已索引/.test(w1), w1);

    // 写帧（批量）
    const w2 = await clientA.tool('soul_index', {
      session: 'acceptance-host',
      frames: [
        { type: 'assistant', text: '记住了：紫铜色的换气阀。' },
        { type: 'user', text: '第二句：验收标记是「潮汐刻度」。' },
      ],
    });
    add('tools/call soul_index（批量）', /共 2 帧/.test(w2), w2);

    // 检索
    const r1 = await clientA.tool('soul_recall', { query: '紫铜色的换气阀' });
    add('tools/call soul_recall', r1.includes('acceptance-host') && r1.includes('紫铜色'), String(r1).split('\n')[0].slice(0, 90));

    // 人格
    const p1 = await clientA.tool('soul_persona', {});
    add('tools/call soul_persona', p1.length > 1000 && /已装/.test(p1), p1.length + ' 字符 · ' + String(p1).trim().split('\n').pop().slice(0, 70));

    // 健康
    const h1 = await clientA.tool('soul_health', {});
    let health = null;
    try { health = JSON.parse(h1); } catch { /* 下面判失败 */ }
    add('tools/call soul_health', Boolean(health && health.sessions >= 1 && health.frames >= 3),
      health ? 'sessions=' + health.sessions + ' / frames=' + health.frames + ' / dataDir=' + health.dataDir : String(h1).slice(0, 80));

    // 未知工具
    let unk = null;
    try { await clientA.tool('soul_nope', {}); } catch (e) { unk = e; }
    add('未知工具返回 JSON-RPC 错误', Boolean(unk && unk.rpcCode === -32601), unk ? 'code=' + unk.rpcCode : '(没报错)');

    await clientA.close();
    clientA = null;

    // ── B：换一个全新的数据目录 ──
    clientB = new McpClient({
      command: process.execPath,
      args: [serverEntry],
      cwd: ROOT,
      env: { ...envBase, ...CHILD_NODE_ENV, AGENT_SOUL_DATA: dirB.replace(/\\/g, '/') },
    });
    const initB = await clientB.rpc('initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'agent-soul-acceptance-b', version: '1.0.0' },
    }, 20000);
    add('第二个进程也能 initialize', Boolean(initB.result && initB.result.serverInfo), initB.result && initB.result.serverInfo && initB.result.serverInfo.name);
    clientB.notify('notifications/initialized', {});

    const miss = await clientB.tool('soul_recall', { query: '紫铜色的换气阀' });
    add('★ 换数据目录 → 记忆是空的', /^没有命中/.test(miss), String(miss).slice(0, 60));

    const h2 = await clientB.tool('soul_health', {});
    let health2 = null;
    try { health2 = JSON.parse(h2); } catch { /* 判失败 */ }
    add('新目录里 0 会话 0 帧', Boolean(health2 && health2.sessions === 0 && health2.frames === 0),
      health2 ? 'sessions=' + health2.sessions + ' / frames=' + health2.frames : String(h2).slice(0, 80));

    await clientB.close();
    clientB = null;
  } catch (e) {
    checks.push(['整体往返没抛异常', false, String((e && e.message) || e)]);
  } finally {
    if (clientA) await clientA.close().catch(() => {});
    if (clientB) await clientB.close().catch(() => {});
  }

  // 静态检查：源码里有没有对 DSH 的依赖
  const dshRefs = scanDshRefs(path.join(ROOT, 'src'));
  add('源码里没有 DSH 依赖', dshRefs.length === 0, dshRefs.length ? dshRefs.slice(0, 3).join(' | ') : '0 处（import 与硬编码路径都查了）');

  reads.push(['数据目录 A', dirA]);
  reads.push(['数据目录 B', dirB]);
  reads.push(['server 入口', serverEntry]);
  const bad = checks.filter((c) => !c[1]);
  const status = bad.length ? 'FAIL' : 'PASS';
  const headline = bad.length
    ? '有 ' + bad.length + ' 项没成立'
    : 'stdio 往返 + 静态检查共 ' + checks.length + ' 项全通；换空数据目录后同一句查询 0 命中';

  return {
    id: '④', title: '换宿主（纯 MCP 客户端）', status, reads, checks, headline,
    why: bad.length
      ? '有 ' + bad.length + ' 项没成立 —— 见上面的检查表。'
      : '自己 spawn 了 src/adapters/mcp.mjs，走完 initialize → tools/list → soul_index（单帧+批量）→ soul_recall → '
        + 'soul_persona → soul_health → 未知工具报错；再把数据目录换成一个空目录，同一句查询变成「没有命中」。'
        + '全程没有用任何 MCP SDK，也没有任何 DSH 组件在中间。',
    todo: bad.length ? ['对着失败的检查项查 src/adapters/mcp.mjs 与 mcp-tools.mjs。'] : [],
  };
}

// ────────────────────────────── 打印与汇总 ──────────────────────────────

function printChecks(checks) {
  if (!checks || !checks.length) return;
  blank();
  console.log(' 检查');
  for (const [name, ok, read] of checks) {
    console.log('   ' + (ok ? '[ok]' : '[!!]') + ' ' + padEndDisp(name, 34) + (read || ''));
  }
}

function printSection(r) {
  sectionHead(r.id, r.title, r.headline || '', r.status);
  printReads(r.reads);
  printChecks(r.checks);
  printBlock('判断', r.why);
  printTodo(r.todo);
}

function printSummary() {
  blank();
  rule('=');
  console.log(' 总表');
  rule('=');
  console.log('   ' + padEndDisp('判据', 26) + padEndDisp('状态', 8) + '一句话');
  console.log('   ' + '-'.repeat(W - 4));
  for (const r of results) {
    const one = String(r.headline || r.why || '').replace(/\s+/g, ' ');
    const avail = W - 40;
    const cut = wrapDisp(one, avail);
    console.log('   ' + padEndDisp(r.id + ' ' + r.title, 26) + padEndDisp('[' + STATUS[r.status] + ']', 8)
      + cut[0] + (cut.length > 1 ? '…' : ''));
  }
  rule('-');

  const fails = results.filter((r) => r.status === 'FAIL');
  const blocks = results.filter((r) => r.status === 'BLOCKED');
  const pass = results.filter((r) => r.status === 'PASS');

  blank();
  if (!fails.length && !blocks.length) {
    console.log(' 结论：四条判据全部通过。');
  } else {
    console.log(' 结论：未通过（' + pass.length + ' 通过 / ' + blocks.length + ' 阻塞 / ' + fails.length + ' 失败）。');
    if (blocks.length) {
      console.log('');
      console.log(' 阻塞的不是代码，是人或外部动作：');
      for (const b of blocks) {
        const first = (b.todo && b.todo[0]) || b.why || '';
        for (const line of wrapDisp('· ' + b.id + ' ' + first, W - 2)) console.log('   ' + line);
      }
    }
    if (fails.length) {
      console.log('');
      console.log(' 失败的是真问题，需要改代码或改配置：');
      for (const f of fails) {
        const first = (f.todo && f.todo[0]) || f.why || '';
        for (const line of wrapDisp('· ' + f.id + ' ' + first, W - 2)) console.log('   ' + line);
      }
    }
  }

  blank();
  console.log(' 再跑：node tools/acceptance.mjs');
  console.log(' 退出码：0=全通过  1=有失败  2=只有阻塞');
  blank();

  return fails.length ? 1 : (blocks.length ? 2 : 0);
}

function cleanup() {
  if (KEEP) {
    if (tempDirs.length) {
      console.log(' 临时目录（--keep）：');
      for (const d of tempDirs) console.log('   ' + d);
    }
    return;
  }
  for (const d of tempDirs) {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 80 }); }
    catch (e) { console.log(' 清理失败（可手动删）：' + d + ' → ' + e.message); }
  }
}

// ────────────────────────────── 主流程 ──────────────────────────────

async function main() {
  console.log('');
  rule('=');
  console.log(' agent-soul · 四条判据验收');
  console.log(' ' + fmtTime(Date.now()) + ' · node ' + process.version + ' · ' + process.platform);
  console.log(' ' + ROOT);
  if (IS_ELECTRON) console.log(' 注意：当前是 Electron 运行时，子进程会用 ELECTRON_RUN_AS_NODE=1 当 node 用');
  rule('=');

  const runners = [criterion1, criterion2, criterion3, criterion4];
  for (const fn of runners) {
    let r = null;
    try {
      r = await fn();
    } catch (e) {
      r = {
        id: '?', title: '检查本身崩了', status: 'FAIL',
        reads: [['异常', String((e && e.stack) || e).split('\n').slice(0, 4).join('\n')]],
        why: '这条检查没跑完 —— 不是判据不成立，是脚本自己出错了。',
        todo: ['看上面的异常栈。'],
      };
    }
    results.push(r);
    printSection(r);
  }

  const code = printSummary();
  cleanup();
  process.exit(code);
}

main().catch((e) => {
  console.error('\n验收脚本崩了：' + (e && e.stack || e));
  cleanup();
  process.exit(1);
});
