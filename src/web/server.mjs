// HTTP 服务 —— 静态壳 + JSON API + SSE 流

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { FRAME } from '../session/frame.mjs';
import { loadConfig, appRoot, resolvePath, DEFAULTS } from '../config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// 器官模块（纯函数 / 无副作用，直接引即可）
import { Diary } from './diary.mjs';
import { watermarkOf } from '../organs/context.mjs';
import { SoulIndex } from '../organs/soul-scan.mjs';

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => {
      raw += c;
      if (raw.length > 8 * 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}

// ═══════════════════════════════════════════════════════════════════════
// 配置层 —— 参数可视化（GET /api/config）与设置面板（POST /api/config）
//
// ★ 三条不许妥协的规矩：
//   ① apiKey 绝不回显 —— 只回 hasKey。响应里任何地方都不出现它的值、长度、前缀。
//   ② 校验不过就不写盘 —— 先攒齐所有错误一次性返回，不做「边校验边写」。
//   ③ 写完必须读回来 —— 响应里的值来自磁盘重新解析，不是来自我们刚拼的那个对象。
//      「我以为我写进去了」和「它确实在磁盘上」是两件事。
// ═══════════════════════════════════════════════════════════════════════

/** config.json 的位置：跟着 appRoot()（开发目录 / exe 解压目录各自一份） */
function configFile() { return path.join(appRoot(), 'config.json'); }

/** 环境变量覆盖 —— 与 config.mjs 里 loadConfig() 的那五处一一对应 */
const CONFIG_ENV = {
  'llm.apiKey': 'AGENT_SOUL_KEY',
  'llm.baseUrl': 'AGENT_SOUL_BASE_URL',
  'llm.model': 'AGENT_SOUL_MODEL',
  // ★ host / port / dataDir / workspace 在 config.json 里是**顶层**键，不是 server.*
  'port': 'AGENT_SOUL_PORT',
  'dataDir': 'AGENT_SOUL_DATA',
};

/**
 * 为什么这一组改了要重启。
 * ★ 不写「全部需要重启」这种糊话 —— 每条都说清是哪个对象在启动时把值拷走了。
 */
const CFG_RESTART_WHY = {
  llm: 'LlmClient 在启动时把地址 / 模型 / key 拷成自己的字段，之后不再回看配置文件。',
  context: '配置只在进程启动时 load 一次 —— 文件改了，进程里那份对象不会跟着变。',
  persona: '人格层在启动时把文件读进内存，预算也是那一刻的快照。',
  events: '调度器的 tick 间隔与两条规则在启动时定下。',
  organs: '换气阈值在会话第一次调用时读取；已经在跑的检测器不会改。',
  autonomy: '自主循环在启动时构造，配置被 spread 进实例。',
  soul: '书房索引第一次用到时建好并常驻，不会自己重建。',
  server: '监听地址在 server.listen() 那一刻定死；SessionStore 也只在启动时拿一次数据目录。',
};

/**
 * 字段表 —— 参数页和设置页都由它渲染。
 *
 * ★ 这是「界面」和「程序」的唯一对账表：一个字段在这里没登记，
 *   页面上就看不见它，POST 也改不动它（未知键会被拒）。宁可漏也不许悄悄多。
 * ★ wired:false = 配置里有、程序里没接线。★ 这种必须说出来，不能装作它有效。
 */
const CFG_GROUPS = [
  {
    id: 'llm', name: '模型接入',
    note: '一轮对话发去哪里、用哪个模型、回答多长多热。',
    fields: [
      { key: 'llm.baseUrl', label: '接口地址', type: 'string', restart: true,
        pattern: /^https?:\/\/[^\s]+$/i, patternMessage: '要是一个 http(s):// 开头的地址',
        note: '模型请求发往哪里。换供应商就改它 —— OpenAI 兼容端点，不带 /chat/completions。' },
      { key: 'llm.apiKey', label: 'API Key', type: 'secret', restart: true,
        note: '调用模型的凭据。★ 只显示「有没有配」，不回显内容，连长度都不给。' },
      { key: 'llm.model', label: '模型名', type: 'string', restart: true,
        note: '请求体里的 model 字段。名字由供应商定，写错会在第一次对话时报 HTTP 400。' },
      { key: 'llm.maxTokens', label: '回复上限', type: 'int', min: 1, max: 200000, unit: 'tokens', restart: true,
        note: '单次回复最多多少 token。调太小会在半句话上截断。' },
      { key: 'llm.temperature', label: '温度', type: 'float', min: 0, max: 2, step: 0.1, restart: true,
        note: '越高越发散；0 附近最稳，超过 1.5 容易跑偏。' },
    ],
  },
  {
    id: 'context', name: '上下文',
    note: '组装一轮对话时，往回看多远。',
    fields: [
      { key: 'context.maxFrames', label: '回看帧数', type: 'int', min: 1, max: 10000, unit: 'frames', restart: true,
        note: '每轮带多少条历史帧进去。索引不参与上下文组装，只做检索。' },
      { key: 'context.windowTokens', label: '窗口大小', type: 'int', min: 1024, max: 10000000, unit: 'tokens', restart: true,
        note: '水位百分比的分母。★ 只影响「用了多少」的显示，不影响模型真实窗口。' },
    ],
  },
  {
    id: 'persona', name: '人格层',
    note: '装哪些文件、上限多大、超了裁谁。',
    fields: [
      { key: 'persona.budget', label: '预算', type: 'int', min: 1000, max: 2000000, unit: 'bytes', restart: true,
        note: '字节上限。超了按 core 永不裁 → work → context 的顺序，从最可换的开始裁。' },
      { key: 'persona.files', label: '装载清单', type: 'files', restart: true,
        note: '每项的 path 必须真实存在；tier 决定超预算时先裁谁。' },
    ],
  },
  {
    id: 'events', name: '事件层',
    note: '每隔一会儿看一眼表，以及「静默」这条规则。',
    fields: [
      { key: 'events.intervalMs', label: '心跳间隔', type: 'int', min: 5000, max: 3600000, unit: 'ms', restart: true,
        note: '调度器多久 tick 一次。调小更灵敏，也更费 CPU。' },
      { key: 'events.silenceMs', label: '静默阈值', type: 'int', min: 60000, max: 86400000, unit: 'ms', restart: true,
        note: '会话静默多久记一条事件。实际检查间隔是它的一半。' },
      { key: 'events.session', label: '挂在哪个会话', type: 'string', allowNull: true, restart: true,
        note: '事件写进哪个会话；留空 = 不指定。' },
    ],
  },
  {
    id: 'organs', name: '器官',
    note: '看不见的东西要看得见 —— 换气是其中唯一有开关的一项。',
    fields: [
      { key: 'organs.huanqi.enabled', label: '换气开关', type: 'bool', restart: true, wired: false,
        note: '★ 配置里有、程序里没接线：当前没有任何代码读它，改了不会有任何变化。' },
      { key: 'organs.huanqi.stallThreshold', label: '连续空转阈值', type: 'int', min: 1, max: 50, unit: 'times', restart: true,
        note: '连续几次没产出就中断这一回合。太小会误杀，太大就是白烧。' },
    ],
  },
  {
    id: 'autonomy', name: '自主',
    note: '人不在了，它自己动。★ 默认关着 —— 打开是一个明确的决定。',
    fields: [
      { key: 'autonomy.enabled', label: '总开关', type: 'bool', restart: true,
        note: '关着时连手动触发也不许绕过 —— 这是老版立下的规矩，不因这次改界面而松。' },
      { key: 'autonomy.idleThresholdMinutes', label: '静默多久算人不在', type: 'int', min: 1, max: 1440, unit: 'minutes', restart: true,
        note: '到点才进入自主时间。判据是磁盘上会话文件的 mtime，不靠谁记得去写。' },
      { key: 'autonomy.maxRunsPerDay', label: '每日预算', type: 'int', min: 0, max: 1000, unit: 'runs', restart: true,
        note: '一天最多自己动几次。这是上限，不是目标。' },
      { key: 'autonomy.quietHours', label: '安静时段', type: 'hours', allowNull: true, restart: true,
        note: '这两个整点之间不动，例如 [2, 7]；留空 = 不设。' },
      { key: 'autonomy.ignoreSessions', label: '排除会话', type: 'strings', restart: true,
        note: '哪些会话不算「有人在」。本进程自己的会话会被 index.mjs 自动加进来。' },
      { key: 'autonomy.session', label: '自主落在哪个会话', type: 'string', allowNull: true, restart: true,
        note: '留空 = 用名为 autonomy 的会话（不存在就新建）。' },
    ],
  },
  {
    id: 'soul', name: '书房',
    note: '扫哪儿、多久重扫一次。',
    fields: [
      { key: 'soul.root', label: '书房根目录', type: 'path', pathKind: 'dir', allowNull: true, restart: true,
        note: '扫它来算「书房 N 文件」。★ 留空 = 不配书房，器官卡就显示「未配置」—— 不替用户指一个别人的目录。' },
      { key: 'soul.ttl', label: '索引缓存窗口', type: 'int', min: 0, max: 600000, unit: 'ms', restart: true,
        note: '这么多毫秒内不重扫。调小更实时，代价是每次都要全量 walk。' },
    ],
  },
  {
    id: 'server', name: '服务',
    note: '监听在哪、库放在哪。★ 这一组改错会让下次启动起不来。',
    // ★★ 这四个键在 config.json 里是**顶层**的（host / port / dataDir / workspace），
    //    不是 server.* —— loadConfig() 读的就是顶层。第一版我按分组名加了 server. 前缀，
    //    结果 GET 全部显示「未设置」；POST 更糟：会往一个 loadConfig 根本不看的嵌套键里写，
    //    界面报「已写入、读回一致」，程序毫无变化。页面上显示的名字必须是文件里的名字。
    fields: [
      { key: 'host', label: '监听地址', type: 'string', restart: true,
        pattern: /^\S+$/, patternMessage: '不能有空格',
        note: '127.0.0.1 = 只有本机能连；0.0.0.0 = 局域网可达（自己判断该不该）。' },
      { key: 'port', label: '端口', type: 'int', min: 1, max: 65535, unit: 'port', restart: true,
        note: 'GUI 与 MCP 共用这一个端口。★ 环境变量 AGENT_SOUL_PORT 会盖过这里。' },
      { key: 'dataDir', label: '数据目录', type: 'path', pathKind: 'dir', restart: true,
        note: '会话与状态文件放哪。换了等于换一个库 —— 旧数据不会跟过去。' },
      { key: 'workspace', label: '工作区', type: 'path', pathKind: 'dir', allowNull: true, restart: true,
        note: '工具读写的工作区。留空 = 程序根目录。' },
    ],
  },
];

const CFG_FIELD_INDEX = (() => {
  const m = new Map();
  for (const g of CFG_GROUPS) for (const fd of g.fields) m.set(fd.key, Object.assign({ group: g.id }, fd));
  return m;
})();

const sha256hex = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

function getIn(obj, key) {
  let o = obj;
  for (const k of String(key).split('.')) {
    if (o === null || typeof o !== 'object') return undefined;
    o = o[k];
  }
  return o;
}

function setIn(obj, key, val) {
  const ks = String(key).split('.');
  let o = obj;
  for (let i = 0; i < ks.length - 1; i++) {
    if (!o[ks[i]] || typeof o[ks[i]] !== 'object') o[ks[i]] = {};
    o = o[ks[i]];
  }
  o[ks[ks.length - 1]] = val;
  return obj;
}

/** 路径比较要归一化 —— 同一个目录写成 D:/x 和 D:\\x，不该算「改过」 */
function normPathValue(p) {
  if (typeof p !== 'string' || !p) return '';
  try { return path.resolve(resolvePath(p)).replace(/\\/g, '/').toLowerCase(); } catch { return p; }
}

function sameValue(a, b, type) {
  if (type === 'path') return normPathValue(a) === normPathValue(b);
  const A = a === undefined ? null : a;
  const B = b === undefined ? null : b;
  return JSON.stringify(A) === JSON.stringify(B);
}

function fmtDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return String(ms);
  if (n < 1000) return n + ' ms';
  if (n < 60000) return (n / 1000).toFixed(n % 1000 ? 1 : 0) + ' 秒';
  if (n < 3600000) return (n / 60000).toFixed(n % 60000 ? 1 : 0) + ' 分钟';
  return (n / 3600000).toFixed(n % 3600000 ? 1 : 0) + ' 小时';
}

/** 人类可读的值。服务端统一算好，两个页面就不会各写一套格式。 */
function displayOf(fd, v) {
  if (v === undefined || v === null) return '未设置';
  if (fd.type === 'bool') return v ? '开' : '关';
  if (fd.type === 'int' || fd.type === 'float') {
    const n = Number(v);
    if (fd.unit === 'ms') return n.toLocaleString('en-US') + ' ms · ' + fmtDuration(n);
    if (fd.unit === 'bytes') return n.toLocaleString('en-US') + ' B';
    return n.toLocaleString('en-US');
  }
  if (fd.type === 'hours') {
    return Array.isArray(v) && v.length === 2 ? v[0] + ' – ' + v[1] + ' 点' : String(v);
  }
  if (fd.type === 'strings') return Array.isArray(v) && v.length ? v.join('、') : '（空）';
  if (fd.type === 'files') return Array.isArray(v) ? v.length + ' 个文件' : String(v);
  return String(v);
}

/** 读磁盘上的 config.json（不抛 —— 坏了也把错误带回去给页面看） */
function readConfigFile() {
  const file = configFile();
  if (!fs.existsSync(file)) {
    return { file, exists: false, data: {}, text: '', bytes: 0, sha256: null, mtime: null, error: null };
  }
  try {
    const text = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(text);
    const st = fs.statSync(file);
    return {
      file, exists: true, data, text,
      bytes: Buffer.byteLength(text),
      sha256: sha256hex(text).slice(0, 16),
      mtime: st.mtime.toISOString(),
      error: null,
    };
  } catch (e) {
    return { file, exists: true, data: null, text: '', bytes: 0, sha256: null, mtime: null,
      error: 'config.json 读不出来：' + String((e && e.message) || e) };
  }
}

/** 生效配置（含环境变量覆盖与路径解析）—— 与程序启动时用的是同一个函数 */
function loadEffective() {
  try { return { cfg: loadConfig(configFile()), error: null }; }
  catch (e) { return { cfg: null, error: String((e && e.message) || e) }; }
}

function describeField(fd, fileData, eff) {
  const out = {
    key: fd.key, label: fd.label, type: fd.type, note: fd.note,
    restart: fd.restart !== false,
    restartWhy: CFG_RESTART_WHY[fd.group] || '',
    wired: fd.wired !== false,
    envVar: CONFIG_ENV[fd.key] || null,
    // 给设置页用的控件元信息 —— 服务端说清约束，前端就不用自己记一套范围
    min: fd.min == null ? null : fd.min,
    max: fd.max == null ? null : fd.max,
    step: fd.step == null ? null : fd.step,
    unit: fd.unit || null,
    allowNull: fd.allowNull === true,
    pathKind: fd.pathKind || null,
  };

  // ★ 凭据：只给布尔值。value / fileValue / source / changed 一律不写进响应。
  if (fd.type === 'secret') {
    const raw = eff ? getIn(eff, fd.key) : undefined;
    out.hasKey = typeof raw === 'string' && raw.length > 0;
    out.display = out.hasKey ? '已配置' : '未配置';
    out.defaultDisplay = '未配置';
    out.fileValue = null;
    return out;
  }

  const value = eff ? getIn(eff, fd.key) : undefined;
  const fileValue = fileData ? getIn(fileData, fd.key) : undefined;
  const def = getIn(DEFAULTS, fd.key);
  const envVar = CONFIG_ENV[fd.key];
  const envSet = Boolean(envVar && process.env[envVar] !== undefined && process.env[envVar] !== '');

  out.value = value === undefined ? null : value;
  out.fileValue = fileValue === undefined ? null : fileValue;
  out.hasFileValue = fileValue !== undefined;
  out.defaultValue = def === undefined ? null : def;
  out.source = envSet ? 'env' : (fileValue !== undefined ? 'file' : 'default');
  out.changed = fileValue !== undefined && !sameValue(fileValue, def, fd.type);
  out.display = displayOf(fd, value);
  out.defaultDisplay = displayOf(fd, def);

  if (fd.type === 'path' && typeof value === 'string') {
    const abs = path.resolve(resolvePath(value));
    out.resolved = abs;
    try { out.pathType = fs.statSync(abs).isDirectory() ? 'dir' : 'file'; out.exists = true; }
    catch { out.pathType = null; out.exists = false; }
  }
  if (fd.type === 'files' && Array.isArray(value)) {
    out.items = value.map((it) => {
      const p = it && typeof it === 'object' ? String(it.path || '') : String(it || '');
      const abs = p ? path.resolve(resolvePath(p)) : '';
      let ok = false;
      try { ok = fs.statSync(abs).isFile(); } catch { ok = false; }
      return { path: p, name: (it && it.name) || path.basename(abs || p), tier: (it && it.tier) || 'context', exists: ok };
    });
  }
  return out;
}

/** 一次完整的「当前状态」快照 —— GET 与 POST 的成功响应共用它 */
function buildConfigView() {
  const f = readConfigFile();
  const eff = loadEffective();
  const groups = [];
  for (const g of CFG_GROUPS) {
    const fields = g.fields.map((fd) => describeField(Object.assign({ group: g.id }, fd), f.data, eff.cfg));
    groups.push({ id: g.id, name: g.name, note: g.note, restartWhy: CFG_RESTART_WHY[g.id] || '', fields });
  }
  const all = [];
  for (const g of groups) for (const x of g.fields) all.push(x);
  return {
    ok: !f.error && !eff.error,
    at: new Date().toISOString(),
    file: f.file,
    exists: f.exists,
    sha256: f.sha256,
    bytes: f.bytes,
    mtime: f.mtime,
    fileError: f.error,
    configError: eff.error,
    groups,
    stats: {
      total: all.length,
      changed: all.filter((x) => x.changed).length,
      env: all.filter((x) => x.source === 'env').length,
      restart: all.filter((x) => x.restart).length,
      unwired: all.filter((x) => x.wired === false).length,
    },
  };
}

/** 单个字段的校验。返回错误句子数组（空 = 通过）。 */
function validateField(fd, v) {
  const errs = [];
  if (v === null) {
    if (!fd.allowNull) errs.push(fd.label + ' 不能为空');
    return errs;
  }
  switch (fd.type) {
    case 'bool':
      if (typeof v !== 'boolean') errs.push(fd.label + ' 只能是开或关');
      break;
    case 'int':
      if (typeof v !== 'number' || !Number.isInteger(v)) errs.push(fd.label + ' 必须是整数');
      else if (fd.min != null && v < fd.min) errs.push(fd.label + ' 不能小于 ' + fd.min);
      else if (fd.max != null && v > fd.max) errs.push(fd.label + ' 不能大于 ' + fd.max);
      break;
    case 'float':
      if (typeof v !== 'number' || !Number.isFinite(v)) errs.push(fd.label + ' 必须是数字');
      else if (fd.min != null && v < fd.min) errs.push(fd.label + ' 不能小于 ' + fd.min);
      else if (fd.max != null && v > fd.max) errs.push(fd.label + ' 不能大于 ' + fd.max);
      break;
    case 'string': {
      if (typeof v !== 'string') { errs.push(fd.label + ' 必须是文本'); break; }
      const s = v.trim();
      if (!s && !fd.allowNull) errs.push(fd.label + ' 不能是空白');
      else if (s.length > 2000) errs.push(fd.label + ' 太长（最多 2000 字符）');
      else if (s && fd.pattern && !fd.pattern.test(s)) errs.push(fd.patternMessage || (fd.label + ' 格式不对'));
      break;
    }
    case 'path': {
      if (typeof v !== 'string' || !v.trim()) { errs.push(fd.label + ' 不能是空路径'); break; }
      const abs = path.resolve(resolvePath(v.trim()));
      let st = null;
      try { st = fs.statSync(abs); } catch { st = null; }
      if (!st) errs.push(fd.label + ' 指向的路径不存在：' + abs);
      else if (fd.pathKind === 'dir' && !st.isDirectory()) errs.push(fd.label + ' 不是目录：' + abs);
      else if (fd.pathKind === 'file' && !st.isFile()) errs.push(fd.label + ' 不是文件：' + abs);
      break;
    }
    case 'strings': {
      if (!Array.isArray(v)) { errs.push(fd.label + ' 要是字符串数组'); break; }
      if (v.some((x) => typeof x !== 'string' || !x.trim())) errs.push(fd.label + ' 里有空项');
      if (v.length > 200) errs.push(fd.label + ' 最多 200 项');
      break;
    }
    case 'hours': {
      if (!Array.isArray(v) || v.length !== 2) { errs.push(fd.label + ' 要两个整点，例如 [2, 7]'); break; }
      if (!v.every((h) => typeof h === 'number' && Number.isInteger(h) && h >= 0 && h <= 23)) {
        errs.push(fd.label + ' 的小时要在 0..23 之间');
      }
      break;
    }
    case 'files': {
      if (!Array.isArray(v)) { errs.push(fd.label + ' 要是数组'); break; }
      v.forEach((it, i) => {
        const at = '第 ' + (i + 1) + ' 项';
        if (!it || typeof it !== 'object') { errs.push(at + ' 格式不对'); return; }
        if (typeof it.path !== 'string' || !it.path.trim()) { errs.push(at + ' path 不能为空'); return; }
        if (['core', 'work', 'context'].indexOf(it.tier) < 0) { errs.push(at + ' 的 tier 只能是 core / work / context'); }
        const abs = path.resolve(resolvePath(it.path.trim()));
        let ok = false;
        try { ok = fs.statSync(abs).isFile(); } catch { ok = false; }
        if (!ok) errs.push(at + ' 的文件不存在：' + abs);
      });
      break;
    }
    default:
      break;
  }
  return errs;
}

/** 把提交上来的值收拾成要落盘的形状 */
function normalizeField(fd, v) {
  if (v === null) return null;
  switch (fd.type) {
    case 'int': return Math.trunc(Number(v));
    case 'float': return Number(v);
    case 'bool': return Boolean(v);
    case 'string': return String(v).trim();
    case 'path': return String(v).trim();
    case 'strings': return v.map((x) => String(x).trim()).filter(Boolean);
    case 'hours': return [Number(v[0]), Number(v[1])];
    case 'files': return v.map((it) => {
      const abs = path.resolve(resolvePath(String(it.path).trim()));
      return {
        path: String(it.path).trim(),
        tier: it.tier,
        name: (it.name && String(it.name).trim()) || path.basename(abs),
      };
    });
    default: return v;
  }
}

/**
 * 原子写：同目录先写 .tmp，落盘后再 rename 覆盖。
 *
 * ★ 为什么非要这么写：rename 是原子的 —— 要么旧文件还在，要么新文件整份在位，
 *   不存在「写到一半程序被关掉，config.json 变成半截 JSON」这种状态。
 *   config.json 坏了，下次启动直接起不来，所以这一步不能省。
 * ★ Windows 上如果编辑器正开着这个文件，rename 会 EBUSY —— 所以重试几次再说失败。
 */
async function writeFileAtomic(file, text) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeFileSync(fd, text, 'utf8');
    try { fs.fsyncSync(fd); } catch { /* 有些文件系统不支持 fsync，不影响 rename 的原子性 */ }
    fs.closeSync(fd);
    fd = null;
  } catch (e) {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }

  let lastErr = null;
  for (let i = 0; i < 4; i++) {
    try { fs.renameSync(tmp, file); return; }
    catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 60 * (i + 1))); }
  }
  try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
  throw new Error('rename 失败（文件可能正被别的程序占着）：' + String((lastErr && lastErr.message) || lastErr));
}

export function createServer({ store, loop, tools, config, bus, sched, persona, autonomy, ledger }) {
  // ★ overview 缓存：首次采集要 3.2 秒（1006 个会话建索引），开页面等这么久不可接受。
  //   30 秒内的重复请求直接回缓存；?fresh=1 强制重算。
  let ovCache = null, ovAt = 0;
  const OV_TTL = 30000;
  let soulIdx = null;   // 书房索引（懒建，常驻）
  // ★ 磁盘占用单独缓存 5 分钟 —— 1006 个会话 × 2 次 stat 是 3 秒的大头，
  //   而磁盘大小不会每 30 秒变一次。overview 的 30 秒缓存挡不住首次，这一层能。
  let diskCache = null, diskAt = 0;
  const DISK_TTL = 300000;
  // ★ 同一个进程、同一个端口，既服务 UI 也服务 MCP。
  //   理由：爀曦 2026-11-07 说清了形态 ——「双击桌面图标 → 程序界面出来了，MCP 服务器也起来了」。
  //   两个进程 = 要起两次 = 用户会忘。**一个进程两个职责**才对。
  let mcpHandler = null;
  (async () => { try { const m = await import('../adapters/mcp-http.mjs'); mcpHandler = m.createMcpHttpHandler(); } catch { /* 没挂上也不影响 UI */ } })();

  const server = http.createServer(async (req, res) => {
    // MCP over HTTP 先试（它认 /mcp，其余交回下面）
    if (mcpHandler) {
      try { if (await mcpHandler(req, res)) return; } catch { /* 落到 UI 路由 */ }
    }
    const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    const p = url.pathname;

    try {
      // —— 静态壳 ——
      if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
        const f = path.join(HERE, 'dashboard.html');
        const html = fs.readFileSync(fs.existsSync(f) ? f : path.join(HERE, 'shell.html'));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(html);
      }
      if (req.method === 'GET' && p === '/chat') {
        const html = fs.readFileSync(path.join(HERE, 'shell.html'));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(html);
      }
      // ★ 参数 / 设置 / 器官三页：同一个壳，三块面板。
      //   缺文件时明确报 404 并说缺哪个 —— 不要让浏览器拿到一屏 404 HTML 再猜。
      if (req.method === 'GET' && (p === '/params' || p === '/settings' || p === '/organs' || p === '/diary' || p === '/yantai')) {
        const name = p === '/params' ? 'params.html' : p === '/settings' ? 'settings.html' : p === '/organs' ? 'organs.html' : p === '/yantai' ? 'yantai.html' : 'diary.html';
        const f = path.join(HERE, name);
        if (!fs.existsSync(f)) return json(res, 404, { error: '页面文件缺失：src/web/' + name });
        const html = fs.readFileSync(f, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) });
        return res.end(html);
      }

      // —— 仪表盘 · 数据可视化（全部真实读数，不写死一个） ——
      if (p === '/api/overview' && req.method === 'GET') {
        const fresh = url.searchParams.get('fresh') === '1';
        if (!fresh && ovCache && Date.now() - ovAt < OV_TTL) {
          return json(res, 200, { ...ovCache, cached: true, cacheAgeMs: Date.now() - ovAt });
        }
        const t0 = Date.now();
        const prof = [];
        const mark = (n, t) => prof.push(n + ':' + (Date.now() - t));
        const _t1 = Date.now();
        const metas = fresh ? store.list({ fresh: true }) : store.list();
        mark('list', _t1);
        const _t2 = Date.now();
        try { store.buildIndex(); } catch { /* 索引没建好也不挡这一页 */ }
        mark('buildIndex', _t2);

        const _t3 = Date.now();
        let indexRows = 0;
        if (store.ix && typeof store.ix.forEach === 'function') {
          for (const [, arr] of store.ix) indexRows += Array.isArray(arr) ? arr.length : 0;
        }

        const sizeOf = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };
        mark('indexRows', _t3);
        const _t4 = Date.now();
        let dataBytes = 0, cacheBytes = 0;
        if (!diskCache || Date.now() - diskAt > DISK_TTL) {
          try { for (const m of metas) dataBytes += sizeOf(path.join(store.root, m.id, 'frames.jsonl')) + sizeOf(path.join(store.root, m.id, 'index.jsonl')); } catch {}
          cacheBytes = sizeOf(path.join(store.root, '_index.cache')) + sizeOf(path.join(store.root, '_index.fp'));
          diskCache = { dataBytes, cacheBytes }; diskAt = Date.now();
        } else { dataBytes = diskCache.dataBytes; cacheBytes = diskCache.cacheBytes; }

        mark('disk', _t4);
        const _t5 = Date.now();
        // 检索实测（挑一个真实存在的会话，量一次）
        let searchMs = null, searchHits = 0;
        try {
          if (metas.length) {
            const probe = metas[0].id;
            const t1 = Date.now();
            searchHits = store.search(probe, '会话').length;
            searchMs = Date.now() - t1;
          }
        } catch { /* 量不到就 null */ }

        mark('search', _t5);
        const _t6 = Date.now();
        const mem = process.memoryUsage();
        const pr = (() => { try { return persona && persona.render(); } catch { return null; } })();

        const payload = {
          at: new Date().toISOString(),
          tookMs: Date.now() - t0,
          sessions: metas.length,
          indexRows,
          dataMB: Math.round(dataBytes / 1048576 * 10) / 10,
          cacheMB: Math.round(cacheBytes / 1048576 * 10) / 10,
          searchMs,
          searchHits,
          memMB: Math.round(mem.rss / 1048576),
          heapMB: Math.round(mem.heapUsed / 1048576),
          uptimeSec: Math.round(process.uptime()),
          node: process.version,
          llmReady: loop.llm.ready(),
          model: config.llm.model,
          tools: tools.tools.size,
          persona: pr ? { used: pr.used, budget: pr.budget, dropped: pr.dropped } : null,
          events: { rules: sched ? sched.rules.length : 0, ticks: sched ? sched.stats().ticks : 0 },
        };
        mark('rest', _t6);
        if (url.searchParams.get('prof') === '1') payload.prof = prof;
        ovCache = payload; ovAt = Date.now();
        return json(res, 200, { ...payload, cached: false });
      }

      // —— 砚台（把「我现在是什么状态」摊开在一屏里） ——
      if (req.method === 'GET' && p === '/api/yantai') {
        const { gather } = await import('../yantai/panel.mjs');
        try {
          // ★ 水位那一块必须说清一句：**它是安全网，不是考核。**
          //   过线只该触发一个动作 —— 落盘；禁止第二个 —— 缩。
          const r = await gather({ store, config, persona, ledger: null, loop: null });
          // ★ motto 是个对象（{ text, src }）—— 直接展开成 JSON 顶层会变成 [object Object]。
          //   摊平成两个字段，界面才好用。
          const { motto, ...rest } = r;
          return json(res, 200, {
            at: new Date().toISOString(),
            motto: motto && motto.text ? motto.text : String(motto || ''),
            mottoSrc: motto && motto.src ? motto.src : '',
            ...rest,
          });
        } catch (e) {
          return json(res, 500, { code: 'GATHER_FAIL', hint: '砚台读数失败：' + (e && e.message) });
        }
      }

      // —— 日记（一手层的一部分，不是「宿主加的面板」） ——
      if (req.method === 'GET' && p === '/api/diary/list') {
        const d = new Diary(config.diary && config.diary.dir, { maxSnippet: config.diary && config.diary.maxSnippet });
        const r = d.list();
        // ★ state 和 entries 一起给 —— 界面靠 state 区分「没配 / 不存在 / 空的 / 有东西」
        return json(res, 200, { at: new Date().toISOString(), state: r.state, entries: r.entries });
      }
      if (req.method === 'GET' && p === '/api/diary/doc') {
        const u = new URL(req.url, 'http://x');
        const d = new Diary(config.diary && config.diary.dir, { maxSnippet: config.diary && config.diary.maxSnippet });
        const r = d.read(u.searchParams.get('name'));
        if (!r.ok) return json(res, r.code === 'NOT_FOUND' ? 404 : 400, r);
        return json(res, 200, r);
      }

      // —— 器官状态（五张卡，看不见的东西要看得见） ——
      if (p === '/api/organs' && req.method === 'GET') {
        const out = [];
        const safe = (f) => { try { return f(); } catch (e) { return { error: String(e && e.message || e) }; } };

        // ① 换气 —— 按会话统计「连续几次没产出」
        out.push(safe(() => {
          const th = (config.organs && config.organs.huanqi && config.organs.huanqi.stallThreshold) || 3;
          const dets = loop.__huanqiByRound || new Map();
          let worst = 0, worstSid = '';
          for (const [sid, d] of dets) {
            const n = d && Number.isFinite(d.streak) ? d.streak : 0;
            if (n > worst) { worst = n; worstSid = sid; }
          }
          return { name: '换气', key: 'huanqi', value: worst + ' / ' + th, note: worstSid ? ('最紧的是 ' + worstSid.slice(0, 12)) : '没有正在盯的会话', level: worst >= th ? 'bad' : worst >= th - 1 ? 'warn' : 'ok' };
        }));

        // ② 自主
        out.push(safe(() => {
          if (!autonomy) return { name: '自主', key: 'autonomy', value: '—', note: '未接入', level: 'ok' };
          const c = autonomy.check();
          return { name: '自主', key: 'autonomy', value: c.phase, note: c.reason + '（' + (autonomy.state.runsToday || 0) + '/' + autonomy.config.maxRunsPerDay + '）', level: c.phase === 'autonomous' ? 'warn' : 'ok' };
        }));

        // ③ 唤醒台账
        out.push(safe(() => {
          if (!ledger) return { name: '台账', key: 'waker', value: '—', note: '未接入', level: 'ok' };
          const v = ledger.views();
          return { name: '台账', key: 'waker', value: v.badge + ' 未处理', note: '等你 ' + v.act.length + ' · 待审计 ' + v.audit.length + ' · 已完成 ' + v.done.length, level: v.audit.length ? 'warn' : 'ok' };
        }));

        // ④ 压缩水位
        out.push(safe(() => {
          const pr = persona ? persona.render() : null;
          const win = (config.context && config.context.windowTokens) || 1048576;
          
          // ★ 2026-11-07 修的真 bug：原来 pct 算的是 pr.used（**字节**）÷ win（**token**）。
          //   两种单位相除，CJK 下大约高估 3 倍 —— 而这个数字是「水位」，
          //   高估它等于让人以为自己快满了，然后开始缩。**那把尺子一错，判断就全错。**
          //   人格层有它自己的预算，用字节比字节；水位的 token 口径在砚台那张卡里，各标各的尺子。
          const pct = pr && pr.budget ? (pr.used / pr.budget * 100).toFixed(1) : '0';
          const wm = watermarkOf(pr ? pr.used : 0, (pr && pr.budget) || win);
          return { name: '人格占比', key: 'watermark', value: pct + '%', note: (pr ? pr.used : 0) + 'B / 预算 ' + (pr ? pr.budget : 0) + 'B（字节 ÷ 字节）' + (pr && pr.dropped && pr.dropped.length ? '（丢 ' + pr.dropped.length + ' 项）' : ''), level: wm ? wm.level : 'ok' };
        }));

        // ⑤ 书房扫描
        out.push(safe(() => {
          // ★ 不硬编码任何人的书房路径 —— 没配就是不配，显示「未配置」。
          //   发布版带着我的 1657 个文件是错的。
          const root = config.soul && config.soul.root;
          if (!root) return { name: '书房', key: 'soul', value: '—', note: '未配置（config.soul.root）', level: 'ok' };
          if (!soulIdx) soulIdx = new SoulIndex(root, { ttl: (config.soul && config.soul.ttl) || 5000 });
          const read = soulIdx.refresh();
          const st = soulIdx.stats();
          return { name: '书房', key: 'soul', value: st.files + ' 文件', note: st.mb + 'MB · 本次读 ' + read + ' 份 · 上次 walk ' + st.lastWalkMs + 'ms', level: 'ok' };
        }));

        return json(res, 200, { at: new Date().toISOString(), organs: out });
      }

      // —— 健康 ——
      if (p === '/api/health') {
        return json(res, 200, {
          ok: true,
          llmReady: loop.llm.ready(),
          model: config.llm.model,
          tools: [...tools.tools.keys()],
          sessions: store.list().length,
        });
      }

      // —— 事件与心跳 ——
      if (p === '/api/events' && req.method === 'GET') {
        return json(res, 200, {
          bus: bus ? bus.stats() : null,
          scheduler: sched ? sched.stats() : null,
          recent: bus ? bus.recent(20) : [],
        });
      }
      if (p === '/api/persona' && req.method === 'GET') {
        if (!persona) return json(res, 200, { text: '', note: '未配置人格层' });
        const r = persona.render();
        return json(res, 200, { text: r.text, used: r.used, budget: r.budget, dropped: r.dropped, stats: persona.stats() });
      }

      // —— 配置 · 读（/params 用）——
      // ★ 返回的是「生效值」，不是「文件里写的字」：环境变量会盖过文件，
      //   路径也会被 resolvePath 解析。页面上看到的数，就是程序下一次真会用的数。
      if (p === '/api/config' && req.method === 'GET') {
        const view = buildConfigView();
        return json(res, view.ok ? 200 : 500, view);
      }

      // —— 配置 · 写（/settings 用）——
      if (p === '/api/config' && req.method === 'POST') {
        const t0 = Date.now();
        const body = await readBody(req);
        const patch = (body && typeof body === 'object' && body.patch && typeof body.patch === 'object' && !Array.isArray(body.patch))
          ? body.patch
          : (body && typeof body === 'object' && !Array.isArray(body) ? body : {});

        const errors = [];
        const clean = {};

        // ① 未知键先拦 —— 打错一个字母不该被悄悄忽略
        for (const k of Object.keys(patch)) {
          if (!CFG_FIELD_INDEX.has(k)) errors.push({ field: k, message: '没有这个参数（字段表里没登记）' });
        }

        // ② 逐字段校验，全部收齐再返回 —— 不做「改一个报一个」
        for (const [key, raw] of Object.entries(patch)) {
          const fd = CFG_FIELD_INDEX.get(key);
          if (!fd) continue;

          if (fd.type === 'secret') {
            // ★ 凭据单独一条路：null = 明确清除；空串/空白 = 拒。
            //   错误信息里绝不回显提交上来的内容，一个字都不带。
            if (raw === null) { clean[key] = ''; continue; }
            if (typeof raw !== 'string') { errors.push({ field: key, message: 'API Key 必须是文本' }); continue; }
            const s = raw.trim();
            if (!s) { errors.push({ field: key, message: 'API Key 不能是空白；要清除请提交 null' }); continue; }
            if (/\s/.test(s)) { errors.push({ field: key, message: 'API Key 里不能有空格或换行' }); continue; }
            if (s.length > 512) { errors.push({ field: key, message: 'API Key 太长（超过 512 字符）' }); continue; }
            clean[key] = s;
            continue;
          }

          const errs = validateField(fd, raw);
          if (errs.length) errors.push({ field: key, message: errs.join('；') });
          else clean[key] = normalizeField(fd, raw);
        }

        if (!Object.keys(clean).length && !errors.length) {
          errors.push({ field: '(patch)', message: '没有要改的项' });
        }

        // ★ 校验没过就到此为止 —— 一个字都不写盘。这条是硬规矩。
        if (errors.length) {
          return json(res, 400, {
            ok: false, written: false, wrote: false,
            tookMs: Date.now() - t0,
            errors,
            note: '校验没过 —— 一个字都没写盘',
            file: configFile(),
          });
        }

        // ③ 用磁盘上的最新内容当底 —— 不用内存里那份旧对象，
        //    否则会覆盖掉别人刚手改过的字段。
        const before = readConfigFile();
        if (before.error) {
          return json(res, 500, {
            ok: false, written: false, tookMs: Date.now() - t0,
            errors: [{ field: 'config.json', message: before.error }],
            note: '现存的 config.json 就读不出来，不敢往里写',
          });
        }

        // ★ 必须拷贝。直接改 before.data 会让下面「改前 → 改后」的对照两头都变成新值 ——
        //   第一版就是这么错的：界面显示「90 → 90」，看着像没改过。
        const next = structuredClone((before.data && typeof before.data === 'object') ? before.data : {});
        for (const k of Object.keys(clean)) setIn(next, k, clean[k]);

        let text;
        try { text = JSON.stringify(next, null, 2) + '\n'; }
        catch (e) {
          return json(res, 500, { ok: false, written: false, tookMs: Date.now() - t0,
            errors: [{ field: 'config.json', message: '序列化失败：' + String((e && e.message) || e) }] });
        }

        // ④ 原子写：.tmp → rename。要么旧文件整份还在，要么新文件整份在位。
        try { await writeFileAtomic(before.file, text); }
        catch (e) {
          return json(res, 500, { ok: false, written: false, tookMs: Date.now() - t0,
            errors: [{ field: 'config.json', message: '写盘失败：' + String((e && e.message) || e) }] });
        }

        // ⑤ 读回来 —— 响应里所有值都来自磁盘重新解析，不是来自刚拼的那个对象
        const back = buildConfigView();
        const backRaw = readConfigFile();
        const changed = [];
        const verify = [];
        for (const k of Object.keys(clean)) {
          const fd = CFG_FIELD_INDEX.get(k);
          const prev = getIn(before.data || {}, k);
          const now = backRaw.data ? getIn(backRaw.data, k) : undefined;
          verify.push({ key: k, match: sameValue(now, clean[k], fd ? fd.type : 'string') });
          if (fd && fd.type === 'secret') {
            changed.push({ key: k, label: fd.label, before: prev ? '已配置' : '未配置', after: now ? '已配置' : '未配置', restart: true });
          } else {
            changed.push({
              key: k,
              label: fd ? fd.label : k,
              before: displayOf(fd || {}, prev),
              after: displayOf(fd || {}, now),
              restart: fd ? fd.restart !== false : true,
            });
          }
        }
        const matchAll = verify.every((x) => x.match);
        const restartRequired = changed.filter((c) => c.restart);

        // ★ 写成功但读回对不上 —— 必须报出来，不能报成功。
        if (!matchAll) {
          return json(res, 500, {
            ok: false, written: true, tookMs: Date.now() - t0,
            errors: [{ field: 'config.json', message: '写盘后读回的值与提交的不一致（可能被别的程序改过）' }],
            verify, changed, file: before.file,
          });
        }

        return json(res, 200, {
          ok: true,
          written: true,
          tookMs: Date.now() - t0,
          at: new Date().toISOString(),
          file: back.file,
          exists: back.exists,
          sha256: back.sha256,
          bytes: back.bytes,
          mtime: back.mtime,
          changed,
          restartRequired,
          restartNote: restartRequired.length
            ? '这些项已经落盘，但进程里还是旧值 —— 重启后生效'
            : '没有需要重启的项',
          readBack: { checked: verify.length, match: matchAll },
          groups: back.groups,
          stats: back.stats,
        });
      }

      // —— 会话列表 ——
      if (p === '/api/sessions' && req.method === 'GET') {
        return json(res, 200, { sessions: store.list() });
      }

      // —— 新建会话 ——
      if (p === '/api/sessions' && req.method === 'POST') {
        const body = await readBody(req);
        const h = store.create(body.cwd || config.dataDir, body.persona || null);
        return json(res, 200, { session: h });
      }

      // —— 读会话帧 ——
      const mFrames = p.match(/^\/api\/session\/([\w-]+)\/frames$/);
      if (mFrames && req.method === 'GET') {
        const s = store.load(mFrames[1]);
        if (!s) return json(res, 404, { error: '会话不存在' });
        return json(res, 200, { header: s.header, frames: s.frames });
      }

      // —— 检索 ——
      if (p === '/api/search' && req.method === 'GET') {
        const q = url.searchParams.get('q') || '';
        const sid = url.searchParams.get('session');
        if (!q) return json(res, 200, { hits: [] });
        const hits = sid ? store.search(sid, q).map(r => ({ sessionId: sid, ...r })) : store.searchAll(q, 100);
        return json(res, 200, { hits });
      }

      // —— 跑一个回合（SSE）——
      if (p === '/api/turn' && req.method === 'POST') {
        const body = await readBody(req);
        const sessionId = body.sessionId;
        const text = String(body.text || '').trim();
        if (!sessionId || !text) return json(res, 400, { error: '缺 sessionId 或 text' });
        const s = store.load(sessionId);
        if (!s) return json(res, 404, { error: '会话不存在' });

        store.append(sessionId, FRAME.USER, { text });

        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });
        const send = (obj) => { try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch { /* 客户端断了 */ } };
        send({ kind: 'start', sessionId });

        try {
          await loop.turn(sessionId, (e) => send(e));
        } catch (e) {
          send({ kind: 'error', message: String((e && e.message) || e) });
        }
        send({ kind: 'end' });
        return res.end();
      }

      return json(res, 404, { error: '没有这个路由: ' + p });
    } catch (e) {
      if (!res.headersSent) json(res, 500, { error: String((e && e.message) || e) });
      else try { res.end(); } catch { /* ignore */ }
    }
  });

  /**
   * 预热 —— 启动时把「第一次访问才会算」的慢活先干完。
   *
   * ★ 为什么要有它：首次 /api/overview 要 3.9 秒（建索引 + 2012 次 stat + 书房全扫）。
   *   而那三样在**启动后一秒钟内就不会再变**。
   *   「双击图标 → 界面出来」这个形态里，启动多花几秒是没人看见的；
   *   但打开页面等 4 秒是**每次都看得见**的。
   *   把慢的挪到看不见的地方 —— 这就是预热。
   */
  server.warmup = async () => {
    const t0 = Date.now();
    const steps = [];
    try { store.buildIndex(); steps.push('索引 ' + store.list().length + ' 会话'); } catch (e) { steps.push('索引 ✗'); }
    try { store.saveIndexCache(); } catch { /* 写不了不影响 */ }
    try {
      const metas = store.list();
      const sizeOf = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };
      let dataBytes = 0;
      for (const m of metas) dataBytes += sizeOf(path.join(store.root, m.id, 'frames.jsonl')) + sizeOf(path.join(store.root, m.id, 'index.jsonl'));
      const cacheBytes = sizeOf(path.join(store.root, '_index.cache')) + sizeOf(path.join(store.root, '_index.fp'));
      diskCache = { dataBytes, cacheBytes }; diskAt = Date.now();
      steps.push('磁盘 ' + Math.round(dataBytes / 1048576) + 'MB');
    } catch { steps.push('磁盘 ✗'); }
    // ★ 没配书房就不扫 —— 发布版不该带着开发机的 1657 个文件。
    //   这里和 /api/organs 用的是同一条判据：config.soul.root 有值才动。
    try {
      const root = config.soul && config.soul.root;
      if (!root) { steps.push('书房 未配置'); }
      else {
        soulIdx = new SoulIndex(root, { ttl: (config.soul && config.soul.ttl) || 5000 });
        soulIdx.refresh();
        steps.push('书房 ' + soulIdx.size + ' 文件');
      }
    } catch { steps.push('书房 ✗'); }
    return { ms: Date.now() - t0, steps };
  };

  return server;
}
