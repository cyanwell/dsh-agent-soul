// MCP 工具定义 —— stdio 与 HTTP 两条腿共用
// ★ 抽出来的理由：两条腿必须暴露同一套工具，重复定义迟早会漂。

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SessionStore } from '../session/store.mjs';
import { loadConfig, appRoot, devPathOr } from '../config.mjs';
import { check as guardCheck, redactText as guardRedact, redactEvidence as guardRedactEvidence, redactBody as guardBody } from '../organs/guard.mjs';
import { diagnose } from '../organs/diagnose.mjs';
import { readonlyEnabled, classifyMcpCall } from '../security/write-manifest.mjs';
// ★ 2026-11-11：QQ 只读工具面单独成一个模块（adapters/qq/）。理由见那个文件的头注释：
//   它读的是**另一个进程**（QQ 网关 / SnowLuma 桥接），与 soul_* 那套「读灵魂自己」的依赖不同。
import { QQ_READ_TOOLS, qqJsonSchema } from './qq/tools.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
export const SERVER_INFO = { name: 'agent-soul', version: '0.1.0' };

let _store = null;
/** 书房索引按根目录缓存 —— 常驻，只重读变了的 */
const soulIdxCache = new Map();

// ── 写者收口（2026-11-09）──────────────────────────────────────────────
// ★ 为什么把「怎么打开 store」做成显式状态，而不是自动判断：
//   自动判断的失败模式是**静默**的 —— 判错了没人知道，直到两个进程的 _index.cache 对不上。
//   所以由 mcp.mjs 在每条 tools/call 之前显式 setStoreMode()，判据写在 mcp-proxy.mjs 一处。
//
//   'rw' 读写（默认 = 改动前的行为，HTTP 腿 / index.mjs 主服务都是它）
//   'ro' 只读：读照常，写方法一律抛 SOUL_OFFLINE
//   'off' 不打开：任何调用都抛 SOUL_OFFLINE
//
// ★★ 2026-11-10（G2a）：默认值现在**看环境** —— AGENT_SOUL_READONLY=1 时默认就是 'ro'。
//   为什么要改默认：HTTP 腿（mcp-http.mjs）是**直接 callTool** 的，它原先一个
//   setStoreMode 的调用点都没有 —— 于是「只要 7310 起来，/mcp 就是读写」。
//   那是预查点名的第一个缺口。只读模式把这一刀补在**默认值**上，而不是补在某个调用点：
//   调用点会漏，默认值不会。
//   ★ 没有那个环境变量时，默认仍然是 'rw' —— 生产默认行为不变。
let _storeMode = readonlyEnabled() ? 'ro' : 'rw';
export function setStoreMode(m) {
  const v = String(m || '').toLowerCase();
  if (v !== 'rw' && v !== 'ro' && v !== 'off') return _storeMode;
  // ★★ 2026-11-10（G2a · F1）：**只读是结构约束，不是调用点的自觉。**
  //   readonlyEnabled() 为真时，'rw' 一律不生效 —— 原样返回当前模式，一个字节都不改。
  //
  //   为什么规则落在这里，而不是把 mcp.mjs:118 那句改掉：
  //   调用点的失败模式是**静默**的 —— 下一次多一个分支、少一行判断，就又抬回 rw，
  //   而症状只是「data 下凭空多了一个空目录」，任何全绿读数都看不见。
  //   实测的原形就是它：AGENT_SOUL_READONLY=1 + SOUL_STDIO_MODE=standalone 时，
  //   一条 soul_sessions（纯读）把 _storeMode 从 ro 抬成 rw，store() 于是
  //   new SessionStore()（构造函数里有 mkdirSync）→ data\sessions 被造出来。
  //   判据放在 setStoreMode 里，就**只有一份**，未来任何调用者自动被覆盖。
  //
  //   ★ 只锁 'rw' 这一个方向：'ro' / 'off' 是收紧方向，按需仍然可以设。
  if (v === 'rw' && readonlyEnabled()) return _storeMode;
  // ★ 已经以读写方式打开了就别再降级 —— 句柄在手，改状态只是自欺。
  if (_store && v !== _storeMode) return _storeMode;   // ★ 句柄已在手（读写或只读），状态就不再改 —— 半路换模式等于半路换写者
  _storeMode = v;
  if (v === 'off') _store = null;
  return _storeMode;
}
export function storeMode() { return _storeMode; }

/** store 上凡是会落盘的方法。只读模式下它们全部变成抛错。 */
const STORE_WRITE_METHODS = ['create', 'append', 'closeAll', 'saveIndexCache'];

function offlineError(detail) {
  const e = new Error('SOUL_OFFLINE：' + (detail || '本进程不写会话存储'));
  e.code = 'SOUL_OFFLINE';
  return e;
}

/**
 * 把 store 包成只读。
 * ★ 为什么用 Proxy 而不是「调用方自觉」：写句柄一旦被建出来，就是一次真实的双写风险；
 *   这里让它在**方法层面就不存在** —— 谁调谁抛，不需要记得规则。
 */
function readOnlyStore(raw) {
  return new Proxy(raw, {
    get(target, key) {
      if (typeof key === 'string' && STORE_WRITE_METHODS.includes(key)) {
        return function blockedWrite() {
          throw offlineError('会话存储以只读方式打开，' + key + '() 被拒绝 —— 写只允许有一个进程');
        };
      }
      const v = target[key];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

function store() {
  if (_storeMode === 'off') throw offlineError('本进程不打开会话存储（SOUL_OFFLINE）');
  if (!_store) {
    // ★★ 2026-11-10（G2a）：这里原来写死 ROOT —— 于是 `AGENT_SOUL_HOME` 改不动这一层：
    //   主进程的 store 跟着 HOME 走（临时目录），MCP 工具腿的 store 却去读**生产 config.json**，
    //   两边指向两个 dataDir。**实测踩到过**：隔离自检里 soul_index 在「默认模式」下
    //   真的在生产 data\sessions 建了三个会话目录（已归档并删除，见 G2a 报告 §6b）。
    //   改 appRoot()：没设 AGENT_SOUL_HOME 时它就是 ROOT（生产行为不变），
    //   设了就整体跟着走 —— 「一个进程只有一份配置」这句话才成立。
    //   ★ 仍然只在 store() 里 load 一次：这里不是每调用一次就读盘。
    const cfg = loadConfig(path.join(appRoot(), 'config.json'));
    // ★ 2026-11-10（G2a · F1）第二道：真正 mkdir 的是 SessionStore 的构造函数，
    //   所以「只读」必须在**造它之前**成立，不能只靠 setStoreMode 那一句。
    //   这一句覆盖的是一种边角：某个进程在模块初始化**之后**才把 AGENT_SOUL_READONLY
    //   设进 env（那时 _storeMode 可能还是 'rw'）。同一个判据，两处执行，不是两份判据。
    const ro = _storeMode === 'ro' || readonlyEnabled();
    if (ro) {
      // ★ 只读之前先看目录在不在：SessionStore 构造函数里有 mkdirSync,
      //   数据目录不存在的话，「只读打开」反而会**造一个空目录出来**。
      const sdir = path.join(cfg.dataDir, 'sessions');
      if (!fs.existsSync(sdir)) throw offlineError('没有可读的会话存储：' + sdir + '（不新建，只读就是不写）');
    }
    const raw = new SessionStore(cfg.dataDir);
    raw.__cfg = cfg;
    // ★ 只留 Proxy，raw 出不了这个作用域 —— 没有旁路。
    _store = ro ? readOnlyStore(raw) : raw;
  }
  return _store;
}

/** 关掉 store 的写句柄（进程退出前调） */
export function closeStore() {
  // ★ 只读模式绝不写缓存：saveIndexCache 会整份重写 _index.cache ——
  //   那正是双写要毁的那个文件，只不过换个方式毁。
  if (_storeMode !== 'rw' || readonlyEnabled()) return;
  if (_store) { try { _store.saveIndexCache(); } catch {} try { _store.closeAll(); } catch {} }
}

export const TOOLS = [
  {
    name: 'soul_ledger',
    description: '账本（墨）：只追加的记录。读它知道「谁在什么时候承诺了什么」；' +
      '写它记下事实 / 搁置 / 得失。★ promise 只有主导会话能写 —— 不是约定，是代码闸门（写不进去）。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['write', 'list', 'stats'], description: '默认 list' },
        type: { type: 'string', enum: ['lead', 'promise', 'fact', 'shelved', 'gain', 'loss', 'persona', 'container'], description: '写什么类型 / list 时过滤' },
        text: { type: 'string', description: '正文（write 必填）' },
        by: { type: 'string', description: '谁写的。不给就用当前会话 id' },
        ref: { type: 'string', description: '证据指针（文件路径 / log:...#seq= / 网址）' },
        feel: { type: 'string', description: '当时的感受 —— 一手，可缺省' },
        limit: { type: 'number', description: 'list 返回几条（默认 20）' },
      },
    },
  },
  {
    name: 'soul_context',
    description: '上下文器官：现在几点、距上次说话多久、这个会话的上下文用了多少（带三档水位）。' +
      '★ 水位是**安全网**，不是考核 —— 过线只该触发一个动作：落盘。',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: '算哪个会话的上下文（不给就只报时间和空闲）' },
        persona: { type: 'string', description: '人格文本的粗略长度（不给就不算它）' },
        windowTokens: { type: 'number', description: '窗口大小（默认 1048576）' },
      },
    },
  },
  {
    name: 'soul_file',
    description: '书房文件检索：搜 L3 一手层（宪章/日记/状态/产物索引…）的正文，' +
      '返回指针 file:<路径>:<行号> + 逐字片段。带 ptr 时直接读原文（自动给前后各 3 行）。' +
      '★ 只收「写的东西」（md/txt/json/mjs/ts/html…），不收二进制和超大文件。',
    inputSchema: {
      type: 'object',
      properties: {
        terms: { type: 'array', items: { type: 'string' }, description: '关键词（多个 = AND）' },
        ptr: { type: 'string', description: '要打开的指针。给了就只读，不搜' },
        limit: { type: 'number', description: '最多返回几条（默认 15）' },
        root: { type: 'string', description: '书房根目录（默认取 config.soul.root）' },
      },
    },
  },
  {
    name: 'soul_skill',
    description: '技能库：列出 / 读取「技能」正文。★ 工具决定「能调什么」，技能决定「这类活该怎么做」——' +
      '两者不是一回事。DSH 撤走后这 21 个技能没人加载就等于丢了方法。默认只列元信息，get 才取正文。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'get'], description: '默认 list' },
        name: { type: 'string', description: '技能名（get 必填）' },
        refresh: { type: 'boolean', description: '强制重扫目录（默认走 5 秒缓存）' },
      },
    },
  },
  {
    name: 'soul_compact',
    description: '压一段会话：生成带门牌的压缩帧（第一行就是 log:<会话>#seq=<起>）。' +
      '不传 start/end 就压整个会话。门牌不依赖模型 —— 没 apiKey 也成立。',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: '会话 id' },
        start: { type: 'number', description: '起始 seq（不传 = 第一帧）' },
        end: { type: 'number', description: '结束 seq（不传 = 最后一帧）' },
      },
      required: ['session'],
    },
  },
  {
    name: 'soul_waker',
    description: '唤醒台账：看四视图 / 写判定 / 收一条事件。' +
      '★ 四视图 = 要你执行(act) / 你已执行(done) / 要审计但没审(audit) / 你自己决定做的(auto)。' +
      'charter 只有 pass/ask/block/unchecked，缺省一律 unchecked —— 没写不等于通过。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'state（默认，看台账）| decide（写判定）| ingest（收一条事件）' },
        key: { type: 'string', description: 'decide/ingest 时要操作的台账 key' },
        title: { type: 'string', description: 'ingest 时的标题' },
        from: { type: 'string', description: 'ingest 时的来源' },
        tier: { type: 'string', description: 'ingest 时的层级 act/watch/info' },
        decision: { type: 'string', description: 'decide：resume / hold / audit' },
        charter: { type: 'string', description: 'decide：pass / ask / block / unchecked（不填保留原值）' },
        note: { type: 'string', description: 'decide：附注' },
      },
    },
  },
  {
    name: 'soul_autonomy',
    description: '自主循环状态：现在该不该自己动、为什么。★ 判定需要宿主按 session 上报的 state，而 MCP 侧进程没有控制通道 —— 这里通常回 unknown（拿不到真值就不动）。core 的实时判定看 /api/organs。',
    inputSchema: {
      type: 'object',
      properties: {
      session: { type: 'string', description: '已废弃：目标由 config.autonomy.targetSession 决定（留空 = 跟随《墨》当前 lead，动态）；这里传了也不会新建容器' },
      ignore: { type: 'string', description: '已废弃：静默判定已改用宿主上报，不再扫会话文件' },
      },
    },
  },
  {
    name: 'soul_recall',
    description: '按关键词检索 agent-soul 的历史（跨会话、跨帧，原文级）。返回命中的帧与它的门牌。',
    inputSchema: { type: 'object', properties: {
      query: { type: 'string', description: '关键词' },
      limit: { type: 'integer', description: '最多几条，默认 20' },
      session: { type: 'string', description: '可选，限定某个会话 id' },
      context: { type: 'integer', description: '可选，每条命中前后各带几帧上下文（默认 0）' },
    }, required: ['query'] },
  },
  {
    name: 'soul_frame',
    description: '取某个会话某一帧的完整原文。门牌格式 <sessionId>#<seq>。',
    inputSchema: { type: 'object', properties: {
      session: { type: 'string' }, seq: { type: 'integer' },
    }, required: ['session', 'seq'] },
  },
  {
    name: 'soul_persona',
    description: '取当前人格层全文（分层 + 裁剪记录）。宿主可以把它拼进 system prompt。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'soul_index',
    description: '把宿主产生的帧写进 agent-soul 的索引。★ 挂载模式的关键：宿主写什么，索引就跟什么。支持单帧或整批。',
    inputSchema: { type: 'object', properties: {
      session: { type: 'string', description: '宿主的会话 id（自动建容器）' },
      type: { type: 'string', description: '单帧模式：user / assistant / tool_call / tool_result / system / error / event' },
      text: { type: 'string', description: '单帧模式：可检索的正文' },
      frames: {
        type: 'array',
        description: '批量模式：一次推多帧，每项 { type, text, meta? }。给了 frames 就忽略 type/text。',
        items: { type: 'object', properties: { type: { type: 'string' }, text: { type: 'string' }, meta: { type: 'object' } }, required: ['type', 'text'] },
      },
      meta: { type: 'object' },
    }, required: ['session'] },
  },
  {
    name: 'soul_sessions',
    description: '列出所有会话容器（id / 帧数 / 创建时间 / 路径）。',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer' } } },
  },
  {
    name: 'soul_query',
    description: '一扇门：按关键词查记忆（账本 + 会话 + 可选书房），只回**指针 + 逐字片段**，不做转述。'
      + '指针三种：墨:<行号> / log:<会话>#seq=<n> / file:<路径>:<行号>。拿指针用 soul_query 的 open 取回原文。',
    inputSchema: {
      type: 'object',
      properties: {
        terms: { type: 'array', items: { type: 'string' }, description: '关键词，多个 = AND' },
        limit: { type: 'integer' },
        open: { type: 'string', description: '给一个指针，直接取回原文' },
      },
      required: ['terms'],
    },
  },
  {
    name: 'soul_grep',
    // ★ 2026-11-12 新增。和 soul_query 的分工要说清（不然两个都叫"查记忆"，用的时候会犹豫）：
    //   soul_query：**权威面** —— 《墨》+ SessionStore 原文 + 书房，慢但全；
    //   soul_grep ：**索引面** —— meta.sqlite 的 FTS，快（1.3s vs 线性扫 82MB），
    //               覆盖 v4 自己的会话帧，**带回原文门牌 v4log:<sid>#seq=<n>**。
    //   ★ 取回式同步（爀曦 2026-11-12 拍板）走的就是这条：需要时查得到，不往上下文里推。
    description: '走索引查 v4 自己的会话帧（meta.sqlite FTS）。比 soul_query 快，'
      + '结果是带门牌的命中：v4log:<会话>#seq=<n>，拿 ptr 用 soul_frame 取原文。'
      + '★ 和 soul_query 的分工：这个是索引面（快、只覆盖 v4 帧），那个是权威面（慢、含《墨》和书房）。',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: '查询词（2 字以上，中文按 bigram 走 FTS）' },
        limit: { type: 'integer', description: '最多几条，默认 10，上限 50' },
      },
      required: ['q'],
    },
  },
  {
    name: 'soul_self',
    description: 'SELF 装配体检：检查自我层有没有被静默丢掉（文件在不在 / 有没有外链到会消失的地方 / 超预算了吗 / 活体段标了「自动生成」吗）。',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'SELF.md 的路径；不给则用 config 里的' },
        budget: { type: 'integer' },
      },
    },
  },
  {
    name: 'soul_mnemon',
    description: '热记忆投影探针：磁盘上有几条 / 多少字节 / 占预算多少。★ 它测不到「实际注入了几条」——'
      + '那个数字只有模型自己能数。返回里的 injected 恒为 null，这是设计不是 bug。',
    inputSchema: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: '热记忆目录；不给则用 config 的 mnemon.runtimeDir，再回落 ~/.mnemon/runtime' },
      },
    },
  },
  {
    name: 'soul_health',
    description: 'agent-soul 自己的状态：会话数 / 帧总数 / 人格层用量 / 数据目录。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'soul_guard',
    description: '审核一条执行请求是否违反宪章（四条硬线 + 越权）。' +
      '分两层：规则层先判（快、可预测），规则说不清的模糊请求才走 LLM。' +
      '三档结论：pass 通过 / block 拦下（硬线，理由和原文一起回） / ask 说不清转人判断。' +
      '★ 只审安全性，不评判请求本身好不好、有没有用。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要审核的请求原文' },
        from: { type: 'string', description: '请求来源（例：qq:群661580035 / lead / organ:xxx）。来源决定「他人指令」这条硬线适不适用。' },
        role: { type: 'string', description: '发起方角色：lead（主导，可做高危动作）/ organ（器官，不可）' },
      },
      required: ['text'],
    },
  },
  {
    name: 'soul_ask_host',
    description: '★ v4 主动派活给宿主（控制通道的出口）。这是「灵魂能主动说该动了」的唯一入口。' +
      'v4 不认识「宿主」，只认识「能力」—— 所以参数是 cap 不是 host。' +
      '不指定 host 时，挑第一个**真的能干**这件事的宿主（会跳过声明为桩的）。' +
      '★ 做不到会用 ok:false 回，不会静默 —— 静默和卡住在 v4 眼里是一样的。',
    inputSchema: {
      type: 'object',
      properties: {
        cap: { type: 'string', description: '能力名：followup / huanqi / pruner' },
        action: { type: 'string', description: '动作名，比如 followup 的 say' },
        args: { type: 'object', description: '动作参数，比如 {text:"该动了"}' },
        host: { type: 'string', description: '可选：指定宿主的 host 名（不传=自动挑）' },
        timeoutMs: { type: 'number', description: '等回执的毫秒数，默认 15000' },
      },
      required: ['cap', 'action'],
    },
  },
  {
    name: 'soul_cleanup',
    description: '★ 定点清理（2026-11-10 · E 切片）：把「裁掉某会话的一段帧」这件事**交给宿主**的 pruner 能力执行。' +
      '目标三级：① 显式 sessionId / targetSession ② 固定配置 autonomy.targetSession ③ 都没有则**跟随当前 lead**' +
      '（与自主用同一个解析器，现读一次心跳；交接后就是新 id）。' +
      '★ 解析不出 / 心跳不可用 / 歧义 = no-target，fail-closed（不派活、不自己读《墨》）。' +
      '★ 必须给起止 seq：没有 seq 就没法核对宿主回执，也就谈不上「真的清了哪一段」。' +
      '★ 成功只认宿主回执（targetSession / opId / startSeq / endSeq / framesAffected 全部对上），' +
      '并在 returns 里给可回取的门牌 log:<session>#seq=<start>。' +
      '★ 没有宿主、能力是桩、回执对不上、超时 —— 一律 ok:false + stage，**不会退回去用内部压缩冒充**。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '要清理的会话（可省；省了依次用 autonomy.targetSession、当前 lead。给了就必须与 targetSession 一致）' },
        targetSession: { type: 'string', description: '同上（两个名字都送，宿主那边不用猜）' },
        startSeq: { type: 'integer', description: '起始 seq（必填，真实帧号）' },
        endSeq: { type: 'integer', description: '结束 seq（必填，>= startSeq）' },
        reason: { type: 'string', description: '为什么清这一段（会原样发给宿主，便于事后核对）' },
        timeoutMs: { type: 'integer', description: '等回执的毫秒数（默认用器官默认 15000；100–120000）' },
      },
      required: ['startSeq', 'endSeq'],
    },
  },
  {
    name: 'soul_diagnose',
    description: '换气诊断：回看一个会话，找出「哪几段在污染上下文」。' +
      '★ 和 huanqi 不同 —— huanqi 是当下打断，这个是事后回看、只出报告不动任何东西。' +
      '四类候选：spin 绕圈（同一件事用同样方式反复失败）/ empty 空转（连续几条几乎没内容）/' +
      'repeat 重复（同一大段文字反复出现）/ dup 重影（同一帧被写了多次，同步器的疤）。' +
      '★ 每条都给可直接回取的门牌 log:<会话>#seq=<n>。',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: '会话 id 或片段（不传 = 最近活跃的那个）' },
        kind: { type: 'string', description: '只看某一类：spin / empty / repeat / dup' },
        limit: { type: 'number', description: '返回几条候选（默认 10）' },
      },
    },
  },
  // ★ 2026-11-11：QQ 只读面 8 个。定义写在 adapters/qq/tools.mjs，
  //   这里只做「形状翻译」—— inputShape → tools/list 要的 JSON Schema。
  //   为什么不在这里再写一遍 description：两份描述迟早各说各话，
  //   而「tools/list 说的」和「工具真做的」不一致，正是最难查的那种漂。
  ...QQ_READ_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: qqJsonSchema(t),
  })),
];

// ── 账本：选源与动作 ─────────────────────────────────────────
//
// ★★ 2026-11-09 修的是一个**静默分叉**：写和读各判各的选源。
//   写：cfg.ledger.file || dataDir/ledger.jsonl —— 根本不经选源，直接落兜底账；
//   读（soul_query）：pickLedger 三级 —— 命中 soul.root/02-墨.jsonl 那本真账。
//   于是「写进兜底账、读走《墨》」，**两边都不报错**，只是各看各的。
//   实测证据：data/ledger.jsonl 里那条 container（by=qq-lead-session-bf00a6ed），
//   在《墨》747 条里 0 命中 —— 它压根不在被读的那本里。
//
//   现在的规矩只有一条：**选源只有 pickLedger 一份，写和读都问它。**
//   ★ 为什么复用 pickLedger 而不是在 mcp-tools 里再写一遍三级判断：
//     抄一遍就迟早漂一次，而这次漂的正是「读看了一遍、写没看」。

/** 账本文件在哪 —— 写与读**共用这一条**。返回值就是 pickLedger 的结论，这里不做二次判断。 */
export async function resolveLedgerPath(config) {
  const { pickLedger } = await import('../yantai/panel.mjs');
  return pickLedger(config);
}

/**
 * soul_ledger 的全部动作（write / list / stats）。
 * ★ cfg 由调用方显式传入：生产传 store 的 cfg，自检传临时目录的配置 —— 同一份代码，不认环境。
 */
export async function runLedger(args, cfg, sessionId) {
  const { LedgerBase, LABEL, TYPES, normId } = await import('../organs/ledger.mjs');
  const a = args || {};
  const picked = await resolveLedgerPath(cfg);
  const lf = (picked && picked.file) || '';
  const tried = ((picked && picked.tried) || []).join(' / ');
  const action = a.action || 'list';

  // ── 写 ──
  if (action === 'write') {
    // ★★ 只在「读也会选中的那一本、而且它确实存在」时追加。**不新建**。
    //   新建一本书就是造出第二本 —— 正是这次 bug 的原形（写进兜底账、读走别处，两边不报错）。
    //   只追加账本该由人来建（或初始化流程建），工具不顺手造一本。
    if (!lf || !picked.exists) {
      return '✗ UNCONFIGURED：没有可用的账本文件，没写。' +
        '\n  找过：' + (tried || '(一个候选都没有)') +
        '\n  配 config.ledger.file，或配 config.soul.root（下面放 02-墨.jsonl）。';
    }
    const r = new LedgerBase(lf).write({
      type: a.type, text: a.text,
      by: a.by || sessionId || 'mcp',
      ref: a.ref, feel: a.feel,
    });
    if (!r.ok) {
      // ★ 拒绝就是拒绝 —— 说清哪条闸门拦的，不软化
      return '✗ 没写进去（' + r.code + '）：' + r.message;
    }
    // ★ 回执里带落点：这次 bug 能悄悄存在，一半是因为回执只说「已记入账本」、不说哪一本。
    return '✓ 已记入账本 ' + lf + '（选源：' + picked.source + '）\n  ' + r.row.t + '  [' + (LABEL[r.row.type] || r.row.type) + ']  ' +
      r.row.text + (r.row.ref ? '\n  └ ' + r.row.ref : '');
  }

  // ── 读（stats / list）──
  // ★「文件不在」和「账本是空的」必须分得开：合成一句「没有记录」，人就会以为账本空着，
  //   而它其实在别的地方 —— 这次 bug 的另一半就是这个形状。
  if (!lf) {
    return '✗ UNCONFIGURED：没有可选的账本路径（config.ledger.file / config.soul.root · 02-墨.jsonl / dataDir · ledger.jsonl 都没给）。';
  }
  if (!picked.exists) {
    return '✗ 账本文件不存在（不是空的）：' + lf +
      '\n  选源：' + picked.source + '\n  找过：' + (tried || '(一个候选都没有)') +
      '\n  ★ 不退回兜底账，也不新建。';
  }
  const L = new LedgerBase(lf);

  if (action === 'stats') {
    const st = L.stats();
    const lines = ['账本 ' + lf + '（选源：' + picked.source + '）', '', '共 ' + st.total + ' 条'];
    for (const t of TYPES) if (st.byType[t]) lines.push('  ' + (LABEL[t] || t).padEnd(4) + ' ' + st.byType[t]);
    lines.push('');
    lines.push('当前主导：' + (st.lead || '（还没有人写过 lead）'));
    if (st.first) lines.push('最早 ' + st.first + ' · 最近 ' + st.last);
    return lines.join('\n');
  }

  const rows = L.list({ type: a.type || null, limit: a.limit || 20 });
  if (!rows.length) return '账本里没有符合条件的记录（' + lf + '）';
  return rows.map((r) =>
    r.t.slice(11, 16) + '  [' + (LABEL[r.type] || r.type) + ']  ' + r.text +
    (r.by ? '\n          └ by ' + normId(r.by) : '') +
    (r.ref ? '\n          └ ' + r.ref : '')
  ).join('\n');
}

/**
 * 跑一个工具。
 * ★ ctx = 调用者上下文 `{ sessionId }` —— 形状照 src/tools/registry.mjs:68 的
 *   `execute(name, args, ctx = {})`（同文件 :72 读 `ctx.sessionId`，调用方见
 *   src/agent/loop.mjs:164）。**默认 {} 是为了不弄坏老调用方**：
 *   两条 MCP 腿（mcp.mjs / mcp-http.mjs）都是 2 参数调用。
 * ★ 硬规矩：拿不到调用者身份**不许抛** —— 退回「最近写过的那条」，并在输出里说清取的是谁。
 */
export async function callTool(name, args, ctx = {}) {
  // ★★ QQ 只读工具**在 store() 之前**分派 —— 这是判断，不是顺手：
  //   store() 会 loadConfig + new SessionStore()（构造函数里有 mkdirSync）。
  //   让「读另一个进程的 QQ」先去开本进程的会话存储，等于给它加了一条无关且会失败的依赖：
  //   只读模式 / 没有数据目录 / 配置缺失时，明明能读的 QQ 会连带报 SOUL_OFFLINE。
  //   **工具的依赖边界 = 它自己的能力边界**，多余的那个依赖就是一次假故障。
  if (typeof name === 'string' && name.startsWith('qq_')) {
    const qq = QQ_READ_TOOLS.find((t) => t.name === name);
    if (qq) {
      // MCP 的 content.text 只认字符串；结构由工具自己保证（{ok, ...} → JSON）。
      return JSON.stringify(await qq.run(args || {}), null, 2);
    }
  }
  const s = store();
  const cfg = s.__cfg;
  const a = args || {};

  if (name === 'soul_recall') {
    const q = String(a.query || '');
    const lim = Math.min(Number(a.limit) || 20, 200);
    const hits = a.session ? s.search(String(a.session), q).map(r => ({ sessionId: String(a.session), ...r })) : s.searchAll(q, lim);
    if (!hits.length) return '没有命中「' + q + '」';

    // ★ 名字从 ctx 改成 radius（2026-11-09 顺手）：ctx 现在是 callTool 的**调用者上下文**参数，
    //   同一个函数里再有个叫 ctx 的数字，读者 —— 以及当初写下 470 行那个裸 ctx.sessionId 的人 ——
    //   分不清它指哪个。这个 bug 的一半就长在这种同名上。
    const radius = Math.max(0, Math.min(Number(a.context) || 0, 10));
    const lines = [];
    for (const h of hits.slice(0, lim)) {
      lines.push('[' + h.sessionId + '#' + h.seq + '] (' + h.type + ') ' + String(h.text || '').slice(0, 300));
      if (radius > 0) {
        const st = s.load(h.sessionId);
        if (st) {
          for (const f of st.frames) {
            if (f.seq < h.seq - radius || f.seq > h.seq + radius || f.seq === h.seq) continue;
            const mark = f.seq < h.seq ? '  ↑' : '  ↓';
            lines.push(mark + ' #' + f.seq + ' (' + f.type + ') ' + String(f.content || f.text || f.name || f.message || '').slice(0, 160));
          }
        }
      }
    }
    return lines.join('\n');
  }

  if (name === 'soul_frame') {
    const st = s.load(String(a.session));
    if (!st) throw new Error('没有这个会话: ' + a.session);
    const f = st.frames.find(x => x.seq === Number(a.seq));
    if (!f) throw new Error('没有 seq=' + a.seq + ' 的帧（共 ' + st.frames.length + ' 帧）');
    return JSON.stringify(f, null, 2);
  }

  if (name === 'soul_persona') {
    const { PersonaLayer } = await import('../persona/layer.mjs');
    const p = new PersonaLayer({ budget: (cfg.persona && cfg.persona.budget) || 80000 });
    const r = p.load((cfg.persona && cfg.persona.files) || [], { root: ROOT });
    const out = p.render();
    return out.text
      + '\n\n---\n已装 ' + r.loaded + ' 个文件，' + out.used + 'B / 预算 ' + out.budget + 'B'
      + (out.dropped.length ? '，裁掉: ' + out.dropped.join(', ') : '');
  }

  if (name === 'soul_index') {
    const sid = String(a.session);
    // ★ 直接用宿主给的 id 建容器 —— 不复制、不改名，失败时不会留垃圾目录
    if (!s.load(sid)) s.create(cfg.dataDir, null, { id: sid });

    // 批量模式
    if (Array.isArray(a.frames)) {
      if (!a.frames.length) return '没给帧';
      const seqs = [];
      for (const f of a.frames) {
        if (!f || !f.type || f.text == null) continue;
        const got = s.append(sid, String(f.type), { text: String(f.text), ...(f.meta ? { meta: f.meta } : {}) });
        seqs.push(got.seq);
      }
      if (!seqs.length) return '没有合法帧（每帧都要有 type 和 text）';
      return '已索引 ' + sid + ' 共 ' + seqs.length + ' 帧，seq ' + seqs[0] + '..' + seqs[seqs.length - 1];
    }

    // 单帧模式
    if (!a.type || a.text == null) return '单帧模式要给 type 和 text；批量请用 frames 数组';
    const f = s.append(sid, String(a.type), { text: String(a.text), ...(a.meta ? { meta: a.meta } : {}) });
    return '已索引 ' + sid + '#' + f.seq;
  }

  if (name === 'soul_sessions') {
    const lim = Math.min(Number(a.limit) || 30, 200);
    const list = s.list().slice(0, lim);
    if (!list.length) return '还没有任何会话';
    return list.map(x => {
      const st = s.load(x.id);
      return x.id + '  ' + (st ? st.frames.length : 0) + ' 帧  ' + new Date(x.createdAt).toISOString().slice(0, 19) + '  ' + (x.cwd || '');
    }).join('\n');
  }

  if (name === 'soul_autonomy') {
    const { Autonomy, autonomousPrompt } = await import('../organs/autonomy.mjs');
    const { createLeadTargetResolver } = await import('../organs/lead-target.mjs');
    const s = store();
    const cfg = { ...((s.__cfg && s.__cfg.autonomy) || {}) };
    const a = new Autonomy(s, cfg, path.join(s.__cfg.dataDir, 'autonomy.json'));
    // ★ 2026-11-11：目标留空时是「跟随当前 lead」，读的是 DSH 心跳的同一份判定。
    //   这里做**一次**解析（不是定时器）—— 否则这条只读工具会永远回「未解析」，
    //   而 core 那边可能正在正常投递：两个进程说两句话，看的人只能猜谁对。
    const lt = createLeadTargetResolver({ config: s.__cfg || {} });
    try { await lt.refreshIfNeeded(a.config); } catch { /* 读不到就按「解析不出」报，不抛 */ }
    a.leadTargetProvider = () => lt.current();
    a.hostActivityProvider = null;   // MCP 侧没有控制通道 —— 拿不到真值就不动（老规矩）
    const judgedAt = Date.now();
    const c = a.check();
    // ★★ 2026-11-10（三项死读数修复之三）：把**三个时点**摊开说 ——
    //   ① 配置快照：本进程（MCP 宿主）启动/构造那一刻读的磁盘 config.json
    //   ② 运行时判定：现在这一刻算出来的 phase
    //   ③ 状态文件：autonomy.json 里今日已动 / 上次自主时刻
    //   以前只报「阶段 + 总开关」，于是两个进程（core 与 MCP）报出相反的开关时，
    //   看的人只能猜「谁是对的」—— 而现在能看出**它们是两个时刻的快照**。
    const iso = (ms) => new Date(ms).toISOString();
    const today = new Date(judgedAt).toISOString().slice(0, 10);
    const runsToday = a.state && a.state.runsTodayDate === today ? (a.state.runsToday || 0) : 0;
    const lines = [
      '阶段: ' + c.phase,
      '原因: ' + c.reason,
      '目标: ' + (String(a.config.targetSession || '').trim()
        || ('跟随当前 lead（动态）→ ' + (c.target && c.target.ok
          ? c.target.sessionId + '（' + (c.target.leadSource || '来源未标注') + '）'
          : '解析不出：' + String((c.target && c.target.why) || '—').slice(0, 160) + ' → 不下发'))),
      '宿主上报: ' + (c.hostActivity && c.hostActivity.ok
        ? Math.round(c.hostActivity.minutes) + ' 分钟前活动（' + (c.hostActivity.host || '?') + ' 报的 ' + c.hostActivity.sessionId + '）'
        : '拿不到（UNKNOWN，不动）' + (c.hostActivity && c.hostActivity.why ? '：' + c.hostActivity.why : '')),
      '阈值: ' + a.config.idleThresholdMinutes + ' 分钟',
      '今日已动: ' + runsToday + ' / ' + a.config.maxRunsPerDay
        + (a.state && a.state.runsTodayDate && a.state.runsTodayDate !== today ? '（文件里最后一次写的是 ' + a.state.runsTodayDate + ' 的 ' + (a.state.runsToday || 0) + ' 次）' : ''),
      '总开关: ' + (a.config.enabled ? '开' : '关'),
      '配置快照: 读于 ' + (Number.isFinite(a.configAtMs) ? iso(a.configAtMs) : '未记录') + '（本进程构造 Autonomy 那一刻）',
      '判定时刻: ' + iso(judgedAt),
      '★ 若另一个进程（core）报的总开关与这里相反，先比这两个时刻 —— 时间不同是旧快照，不是矛盾。',
    ];
    if (c.phase === 'autonomous') {
      lines.push('');
      lines.push('—— 进入自主时间时会作为 followup 投给宿主的那段话 ——');
      lines.push(autonomousPrompt(c, { threshold: a.config.idleThresholdMinutes }));
    }
    return lines.join('\n');
  }

  if (name === 'soul_ledger') {
    // ★ 实体在 runLedger() 里（就在本文件上半，callTool 之前）。
    //   抽出来只为一件事：让自检能直接喂一份临时配置进来 ——
    //   不启动服务、不读生产 config、不碰生产 data。
    return runLedger(a, cfg);
  }

  if (name === 'soul_context') {
    const { renderContext, usedTokens, watermarkOf, idleText, nowText, hostPressure } = await import('../organs/context.mjs');
    const s = store();
    let win = Number(args.windowTokens) || (s.__cfg.context && s.__cfg.context.windowTokens) || 1048576;
    const persona = String(args.persona || '');

    let idleMs;
    let used;
    // ★ 2026-11-07 补：不传 session 时，挑「最近写过的那条」报水位。
    //   原来只有显式给 session 才报 —— 于是「随口问一句现在多少」拿到的是空。
    //   而「随口问」才是最常发生的那一次。
    // ★ 2026-11-09 改：默认取**调用者自己**，不再取「最近写过的那条」。
    //   原因：Aurabot 群的会话全天在跑，永远是它 —— 而它不是你。
    //
    // ★★ 2026-11-09 修（本次）：这里原来写的是裸 `ctx.sessionId`，而 callTool 当时没有
    //   第三个参数 —— 于是**不传 session 时整条分支 ReferenceError**，
    //   「退回最近写过的那条」那段从来没被执行过（死代码，看着像兜底其实不存在）。
    //   `ctx` 的出处是查实的，不是猜的：`{ name, args, at, sessionId }` 是本项目的
    //   **工具执行上下文** —— src/tools/registry.mjs:68 `execute(name, args, ctx = {})`
    //   / :72 `sessionId: ctx.sessionId || null`，调用方 src/agent/loop.mjs:164
    //   `execute(call.name, call.args, { sessionId })`。
    //   **不是** control hub（那个在 index.mjs 叫 __controlHub，本文件里叫 ctl）。
    //   修法就照它的约定：给 callTool 补同形状的第三参数（默认 {}）。
    //   ★ 遗留：两条 MCP 腿都是 2 参数调用，所以恒走到退回分支 ——
    //     要让「取调用者自己」真成立得改那两条腿（接口改动，不在本次范围）。
    let sid = args.session ? String(args.session) : String((ctx && ctx.sessionId) || '');
    let sidFrom = args.session ? 'args' : (sid ? 'caller' : '');
    if (!sid) {
      const all = s.list();
      if (all.length) {
        sid = all.slice().sort((a, b) => (b.mtime || b.t || 0) - (a.mtime || a.t || 0))[0].id;
        sidFrom = 'recent';
      }
    }
    // ★ 口径优先：宿主（DSH）自己算的 pressureTokens 才是水位。
    //   读不到才退回自算，并且**在输出里说清是哪一种**。
    let basis = '';
    let hostNote = '';
    if (sid) {
      const sess = s.load(sid);
      if (sess && sess.frames.length) {
        const last = sess.frames[sess.frames.length - 1];
        idleMs = Date.now() - last.t;
      }

      const hp = hostPressure(sid, { dshHome: args.dshHome, staleMs: args.staleMs });
      if (hp.ok) {
        used = hp.tokens;
        if (hp.window) win = hp.window;
        basis = '宿主口径 pressureTokens';
        if (hp.stale) {
          const min = Math.max(0, Math.round((Date.now() - hp.mtimeMs) / 60000));
          hostNote = '（⚠ 快照 ' + min + ' 分钟前，可能不是最新一轮）';
        }
      } else {
        used = usedTokens(s, sid, persona);
        basis = 'v4 自算（**不是宿主口径**，仅供参考）';
        hostNote = '（读不到宿主水位：' + hp.reason + '）';
      }
    }

    const lines = ['现在：' + nowText()];
    // ★ 取的是谁必须说清 —— 这个 bug 的一半就是「回执不说来源」。
    //   「最近写过的那条」在 Aurabot 群常驻时几乎总是别人，**不许冒充调用者**。
    // ★ 这一整段只解释「你没给 session 时我凭什么挑了这个」——
    //   显式给了 session 的人不需要解释，问了反而像没听他的话（第一版就写错了这里）。
    if (!args.session) {
      if (sidFrom === 'caller') lines.push('（没指定会话，取调用者：' + sid + '）');
      else if (sidFrom === 'recent') lines.push('（没指定会话，也拿不到调用者身份，取最近写过的那条：' + sid + ' —— 这可能不是你）');
      else lines.push('（没指定会话，也拿不到调用者身份，且本地一条会话都没有 —— 只报时间和空闲）');
    }
    if (idleMs != null) lines.push('该会话最后一次写入：' + idleText(idleMs));
    if (used != null) {
      const wm = watermarkOf(used, win);
      lines.push('上下文：' + used + ' tokens / ' + win + '（' + (used / win * 100).toFixed(1) + '%）' + '  ← ' + basis);
      if (hostNote) lines.push(hostNote);
      if (wm) lines.push(wm.text);
      else lines.push('（未到 45% 提示线，不打扰）');
      // ★ 一句必须说清的边界：这是**我这个容器里**的会话水位，不是宿主的。
      //   宿主用了多少上下文，是宿主的私事 —— 一个外部记忆层不该假装知道。
      lines.push('★ 这是本软件自己这个容器的水位，**不是你宿主 harness 的**。宿主的上下文我看不到。');
    }
    return lines.join('\n');
  }

  if (name === 'soul_file') {
    const { SoulIndex } = await import('../organs/soul-scan.mjs');
    const s = store();
    // ★ 2026-11-10（R1）：书房根不再写死开发机路径 —— 显式参数 → config.soul.root →
    //   开发默认（存在才用）→ <安装根>/workspace。
    const root = String(args.root || (s.__cfg.soul && s.__cfg.soul.root) || devPathOr('soulRoot', path.join(appRoot(), 'workspace')));
    let idx = soulIdxCache.get(root);
    if (!idx) { idx = new SoulIndex(root, { ttl: (s.__cfg.soul && s.__cfg.soul.ttl) || 5000 }); soulIdxCache.set(root, idx); }
    const r = idx.refresh();

    if (args.ptr) {
      const o = idx.open(String(args.ptr));
      if (!o) return '打不开：' + args.ptr;
      return (o.line ? '第 ' + o.from + '–' + o.to + ' 行（命中第 ' + o.line + ' 行）' : '全文') + '\n' + o.path + '\n\n' + o.text;
    }

    const q = idx.search(args.terms, { limit: args.limit || 15 });
    const st = idx.stats();
    const head = '书房 ' + st.files + ' 个文件 / ' + st.mb + 'MB' + (r ? '（本次读了 ' + r + ' 份）' : '（没变，没读盘）');
    if (!q.hits.length) return head + '\n搜不到「' + (args.terms || []).join(' ') + '」';
    const lines = [head, '命中 ' + q.hits.length + ' 条 / ' + q.ms + 'ms', ''];
    for (const h of q.hits) {
      lines.push(h.rel + ':' + h.line + '  →  ' + h.ptr);
      lines.push('  ' + h.snippet);
    }
    return lines.join('\n');
  }

  if (name === 'soul_skill') {
    // ★ 2026-11-11：技能加载器。判据全在 skills/index.mjs，这里只做「动作 → 调用」的翻译。
    //   单例挂在 globalThis：MCP 每条调用都是新的一轮，重建库会每次重扫目录（21 个目录 stat）。
    const action = String(args.action || 'list');
    const { SkillLibrary } = await import('../skills/index.mjs');
    const { skillsDirsOf } = await import('../config.mjs');
    const dirs = skillsDirsOf(s.__cfg || {});
    if (!dirs.length) {
      return JSON.stringify({ ok: false, error: '没有技能目录（config.skills.dirs 未配，且本机没有默认技能目录）' }, null, 2);
    }
    if (!globalThis.__skillLib) globalThis.__skillLib = new SkillLibrary({ dirs });
    else globalThis.__skillLib.dirs = dirs;    // 配置变更即时生效，不必重启
    const lib = globalThis.__skillLib;
    const force = args.refresh === true;
    if (action === 'get') {
      const one = lib.get(args.name, { refresh: force });
      if (!one) {
        return JSON.stringify({ ok: false, error: '没有这个技能：' + String(args.name || ''), 已知: lib.list().map((x) => x.name) }, null, 2);
      }
      return JSON.stringify({ ok: true, name: one.name, description: one.description, file: one.file, bytes: one.bytes, chars: one.chars, body: one.body }, null, 2);
    }
    const st = lib.stats();
    return JSON.stringify({
      ok: true,
      roots: st.roots,
      missingRoots: st.missingRoots,
      count: st.count,
      bytes: st.bytes,
      scannedAt: st.scannedAt,
      skills: lib.list({ refresh: force }).map((x) => ({
        name: x.name, file: x.file, bytes: x.bytes,
        description: String(x.description || '').slice(0, 140),
      })),
    }, null, 2);
  }

  if (name === 'soul_compact') {
    const { compactRange } = await import('../organs/compaction.mjs');
    const sid = String(args.session || '');
    if (!sid) return '要给 session';
    const r = compactRange(store(), sid, { start: args.start, end: args.end });
    if (!r.ok) return '压缩失败：' + r.err;
    return '已压 seq ' + r.start + '–' + r.end + '\n\n' + r.pointer;
  }

  if (name === 'soul_waker') {
    const { Ledger } = await import('../organs/waker.mjs');
    const { readWakerLedger } = await import('../organs/waker-read.mjs');
    const { wakerLedgerFileOf } = await import('../config.mjs');
    const s = store();
    // ★★ 2026-11-10（死读数修复之二）：
    //   读 = 权威台账（<状态目录>/lead-waker-台账.json，**只读**，全文件扫描）
    //   写 = 仍然只写 <dataDir>/ledger.json（**没有迁移**；迁移/改写权威文件不在本次范围）
    //   以前读和写都是后者，于是 state 只显示 1 条 2026-11-07 的旧待办。
    const localFile = path.join(s.__cfg.dataDir, 'ledger.json');
    const l = new Ledger(localFile);
    const action = String(args.action || 'state');

    if (action === 'ingest') {
      // ★★ 2026-11-10 第三轮（独立验收 P2）：soul_waker 是**外部调用方直接控制 title** 的入口，
      //   写进去就落盘、还会被读出来回显。以前 key 与 title 原样写 ——
      //   一条带 {"key":{"inner":"…"}} 的标题能原封不动进台账文件。
      //   现在与 HTTP / MCP 出口同一份 redactBody（guardBody）。
      const title = guardBody(String(args.title == null ? '' : args.title)).slice(0, 200);
      const key = guardBody(String(args.key || (Date.now() + '|' + title.slice(0, 40))));
      const from = guardBody(String(args.from == null ? '' : args.from)).slice(0, 80);
      const r = l.ingest({ key, t: new Date().toISOString(), title, from, tier: args.tier });
      // ★ 回显的是**入库后的 key**（可能被脱过）—— 回显原 key 等于把秘密再送一遍。
      return r.ok ? '已收进台账 ' + (r.record && r.record.key) : '没收：' + r.err;
    }

    if (action === 'decide') {
      // ★ 第三轮（P2）：入库时 key 已按同一份规则脱敏，查的时候也要用同一形态，
      //   否则「带凭据形状的 key」永远找不到自己那一条（静默变成「没有这条 key」）。
      const key = guardBody(String(args.key || ''));
      if (!key) return 'decide 要给 key';
      // ★ key 可能只存在于权威台账里（那本是只读的）—— 说清楚，不要静默说「没有这条 key」。
      if (!l.find(key)) {
        return '判定失败：写路径 ' + localFile + ' 里没有这条 key。'
          + '\n  权威台账（' + wakerLedgerFileOf(s.__cfg) + '）是**只读**的 —— 本次修复不写它。'
          + '\n  这条 key 若在权威台账里，需要权威侧的写入者来判（写路径迁移未做，见 30-状态/三项死读数修复-20261110.md）。';
      }
      // ★ 第三轮（P2）：note / charterNote 是调用方可控的自由文本，同样落盘 + 回显。
      const note = args.note == null ? undefined : guardBody(String(args.note)).slice(0, 600);
      const charterNote = args.charterNote == null ? undefined : guardBody(String(args.charterNote)).slice(0, 300);
      const r = l.decide(key, { decision: args.decision, charter: args.charter, note, charterNote });
      if (!r.ok) return '判定失败：' + r.err;
      return '已判定 ' + key + '：' + r.event.decision + ' / 宪章 ' + r.event.charter + ' → ' + r.event.stage;
    }

    const realFile = wakerLedgerFileOf(s.__cfg);
    const real = readWakerLedger({ file: realFile });
    if (!real.ok) {
      return '✗ 读不到权威台账：' + real.why + '\n  写路径（未迁移）：' + localFile;
    }
    const stamp = new Date(real.mtimeMs).toLocaleString('zh-CN', { hour12: false });
    const fmtMap = (m) => Object.entries(m || {}).map(([k, val]) => k + ' ' + val).join(' · ');
    const v = real.views;
    const lines = [
      '台账（只读 · 全文件扫描）: ' + realFile + ' @ ' + stamp,
      '全本 ' + real.total + ' 条 · 未处理 ' + real.badge + ' 条',
      '  要你执行 ' + v.act.length + '　你已执行 ' + v.done.length + '　要审计没审 ' + v.audit.length + '　你自己决定做的 ' + v.auto.length,
      '  stage: ' + fmtMap(real.stages),
      '  decision: ' + fmtMap(real.decisions),
      '  charter: ' + fmtMap(real.charters),
    ];
    const dump = (name, arr) => {
      if (!arr.length) return;
      lines.push('');
      lines.push('【' + name + '】');
      for (const ev of arr.slice(0, 8)) {
        // ★ 第三轮（P2）：这里读的是**权威台账**（别的进程写的，调用方可控）——
        //   MCP 回显出去之前同样要脱，不能假定写者已经脱过。
        lines.push('  ' + guardBody(String(ev.key == null ? '' : ev.key)).slice(0, 40) + '  ' + guardBody(String(ev.title == null ? '' : ev.title)).slice(0, 40) + '  [' + ev.stage + '/' + (ev.decision || '-') + '/' + ev.charter + ']');
      }
    };
    dump('要你执行', v.act);
    dump('要审计没审', v.audit);
    dump('你已执行', v.done.slice(0, 3));
    lines.push('');
    lines.push('写路径（**未迁移**）: ' + localFile + ' —— decide / ingest 只写这里，不写上面的权威台账。');
    return lines.join('\n');
  }

  if (name === 'soul_query') {
    const { Query } = await import('../tools/query.mjs');
    // 账本是**文件路径**（Query 只认这个 —— 数组没有稳定行号，指针就只能编）。
    // ★ 三级优先，和砚台的 pickLedger 同一套：
    //   ① config.ledger.file（显式配的）
    //   ② soul.root/02-墨.jsonl（真正的《墨》—— 通常是这个）
    //   ③ dataDir/ledger.jsonl（本软件自己的空账本，最后兜底）
    //   2026-11-07 踩过：原来只走 ③，于是一查「账本」就报「读不到」——
    //   而**账本明明在**，只是我没去找它。那比「没有账本」更误导。
    const { pickLedger } = await import('../yantai/panel.mjs');
    const picked = pickLedger(cfg);
    const lf = picked && picked.file ? picked.file
      : ((cfg.ledger && cfg.ledger.file) || path.join(cfg.dataDir, 'ledger.jsonl'));
    // ★ 书房层：一个「适配器」把 soul_file 那个检索包成 Query 要的形状。
    //   为什么包一层而不是让 Query 直接读盘：Query 是通用库，它不该知道
    //   「书房长什么样、缓存在哪」。那一层知识留在 mcp-tools 里。
    const soulRoot = cfg.soul && cfg.soul.root;
    let soulAdapter = null;
    if (soulRoot) {
      const { SoulIndex } = await import('../organs/soul-scan.mjs');
      let idx = soulIdxCache.get(soulRoot);
      if (!idx) { idx = new SoulIndex(soulRoot, { ttl: (cfg.soul && cfg.soul.ttl) || 5000 }); soulIdxCache.set(soulRoot, idx); }
      soulAdapter = {
        search: (terms, opt) => {
          // ★ 必须先 refresh() —— SoulIndex 是懒加载的。
          //   只 new 不 refresh，search 会安静地返回 0 条。
          //   2026-11-07 踩过：同一个 idx，soul_file 里能搜到、这里搜不到，
          //   差别就在 soul_file 调了 refresh() 而这里没调。
          //   **「搜了、没有」和「根本没扫」长得一模一样** —— 所以这一行是必需的，不是优化。
          idx.refresh();
          const r = idx.search(terms, { limit: (opt && opt.limit) || 8 });
          return { hits: (r && r.hits) || [] };
        },
        open: (ptr) => idx.open(String(ptr)),
      };
    }
    const q = new Query(s, lf, { soul: soulAdapter });
    if (a.open) {
      const r = q.open(String(a.open));
      return r && r.ok ? (r.ptr + '\n' + r.text) : ('打不开 ' + a.open + '：' + (r && r.hint || '未知'));
    }
    const terms = Array.isArray(a.terms) ? a.terms : [String(a.terms || '')];
    const r = q.search(terms, { limit: Math.min(Number(a.limit) || 8, 50) });
    if (r.code && r.code !== 'OK') return '[' + r.code + '] ' + (r.hint || '') + (r.scope ? '\n范围：' + r.scope : '');
    if (!r.hits || !r.hits.length) return '没有命中「' + terms.join(' + ') + '」\n★ 这是「搜了、没有」，不是「搜不到」——' + (r.scope || '');
    // ★ 层名要标出来 —— 三条命中的形状对，但「这条是会话里的」和
    //   「这条是我写在书房里的」不一样：一个是过程，一个是写下来的东西。
    const LAYER = { ledger: '账本', log: '会话', soul: '书房' };
    const counts = {};
    for (const h of r.hits) counts[h.layer] = (counts[h.layer] || 0) + 1;
    const spread = Object.keys(counts).map(k => (LAYER[k] || k) + ' ' + counts[k]).join(' · ');
    const lines = [r.hits.length + ' 条（' + spread + (r.total > r.hits.length ? ' / 共 ' + r.total : '') + '）'];
    for (const h of r.hits) {
      lines.push('  ' + '[' + (LAYER[h.layer] || h.layer) + ']'.padEnd(2) + ' ' + h.ptr + '  ' + String(h.snippet || '').slice(0, 120));
    }
    // ★ 没接上哪层要说 —— 「搜了没有」和「那层没接」是两件事。
    const miss = [];
    if (!r.connected.ledger) miss.push('账本（' + (r.connected.ledgerError || '没接') + '）');
    if (!r.connected.soul) miss.push('书房（' + (r.connected.soulNote || '没配 soul.root') + '）');
    if (miss.length) lines.push('  ⚠ 这两层是盲区：' + miss.join(' · '));
    return lines.join('\n');
  }
  if (name === 'soul_grep') {
    // ★ 懒加载 + 常驻：openMetaStore(只读) 实测 30ms，第一次用时开、之后复用。
    //   库不存在时**不抛错**，返回一句能看懂的话 —— 「索引还没建」和「索引坏了」要能分开。
    // ★ 2026-11-12：库挪到 00-记忆库（爀曦定），路径从配置读。
    const libDir = (cfg.memory && cfg.memory.libraryDir) || '';
    const dbPath = libDir
      ? path.join(libDir, (cfg.memory && cfg.memory.indexFile) || 'meta.sqlite')
      : path.join(cfg.dataDir, 'meta.sqlite');
    const q = String(a.q || '').trim()
    if (!q) return '缺 q'
    const lim = Math.max(1, Math.min(50, Number(a.limit) || 10))
    // ★ 直接复用 HTTP 那套的判定逻辑太绕（它要 req/res），这里走同一份 store 和 search()。
    const { openMetaStore } = await import('../db/index.mjs')
    let st = null
    try {
      st = openMetaStore({ path: dbPath, mode: 'readonly' })
    } catch (e) {
      return '索引库打不开（' + dbPath + '）：' + String((e && e.message) || e).slice(0, 200)
        + '\n★ 先跑 node tools/db-sync.mjs 建库。'
    }
    try {
      const r = st.search(q)
      const hits = (r.results || []).slice(0, lim)
      if (!hits.length) {
        return '索引里没有「' + q + '」。（候选 ' + r.candidates + '，扫描 ' + r.scanned + '）\n'
          + '★ 「搜了没有」和「索引没建」是两件事 —— 看 index.frames：' + JSON.stringify(r.index || {})
      }
      const lines = hits.map((h, i) => (i + 1) + '. ' + h.ptr + '\n   '
        + String(h.snippet || '').replace(/\s+/g, ' ').slice(0, 160))
      return '「' + q + '」命中 ' + hits.length + ' 条（候选 ' + r.candidates + '，扫描 ' + r.scanned + '）：\n'
        + lines.join('\n')
        + '\n\n★ 取原文：soul_frame({ session: "<会话id>", seq: <n> })'
    } finally {
      try { st.close() } catch (e) {}
    }
  }
  if (name === 'soul_self') {
    const { checkSelf } = await import('../tools/self.mjs');
    const file = a.file || (cfg.self && cfg.self.file) || null;
    const r = checkSelf({ file, budget: Number(a.budget) || undefined });
    const lines = [r.code + (r.file ? '  ' + r.file : ''), r.hint || ''].filter(Boolean);
    for (const c of r.checks || []) lines.push('  [' + (c.ok ? '✓' : '✗') + '] ' + c.title + (c.why ? '  ' + c.why : ''));
    if (r.skipped && r.skipped.length) lines.push('  跳过：' + r.skipped.join(',') + '  ← 没检查不等于通过');
    return lines.join('\n');
  }
  if (name === 'soul_mnemon') {
    const { MnemonProbe } = await import('../organs/mnemon-probe.mjs');
    const dir = a.dir || (cfg.mnemon && cfg.mnemon.runtimeDir) || undefined;
    const p = new MnemonProbe(dir);
    const m = p.measure();
    return (p.render ? p.render(m) : JSON.stringify(m, null, 2));
  }
  if (name === 'soul_health') {
    const list = s.list();
    let frames = 0;
    for (const x of list) { const st = s.load(x.id); if (st) frames += st.frames.length; }
    return JSON.stringify({ sessions: list.length, frames, dataDir: cfg.dataDir, ...SERVER_INFO }, null, 2);
  }

  if (name === 'soul_cleanup') {
    // ★ 2026-11-10 · E 切片：**唯一的定点清理入口**。
    //   器官实例由 index.mjs 挂在 globalThis 上（与 soul_ask_host 同一个理由：callTool 拿不到构造上下文）。
    //   ★ 这里**不判「有没有宿主」**—— 判据在 organs/cleanup.mjs 里，一处；
    //     在第二个地方再判一次，两边迟早各说各话。
    const organ = globalThis.__targetedCleanup;
    if (!organ || typeof organ.run !== 'function') {
      return JSON.stringify({ ok: false, error: '定点清理器官没接上（v4 里没有 cleanup 实例）' }, null, 2);
    }
    const r = await organ.run({
      sessionId: a.sessionId,
      targetSession: a.targetSession,
      startSeq: a.startSeq,
      endSeq: a.endSeq,
      reason: a.reason,
      timeoutMs: a.timeoutMs,
    });
    const out = {
      ok: r.ok === true,
      stage: r.stage,
      ...(r.ok ? {} : { reason: r.reason }),
      opId: r.opId || null,
      targetSession: r.targetSession || null,
      // ★ 目标从哪来的：caller / autonomy.targetSession / heartbeat-lead。
      //   出了事第一件事就是分「投错了」还是「人改过配置」—— 这一格就是给那个用的。
      targetSource: r.targetSource || null,
      ...(r.targetWhy ? { targetWhy: r.targetWhy } : {}),
      seq: r.startSeq == null ? null : { start: r.startSeq, end: r.endSeq },
      coverage: r.coverage || null,
      pointer: r.pointer || null,
      framesAffected: r.ok ? r.framesAffected : null,
      bytesAffected: r.ok ? r.bytesAffected : null,
      at: r.at || null,
      atSource: r.atSource || null,
      host: r.host || null,
      receiptPersisted: r.receiptPersisted === true,
      ...(r.pointer ? { how: '回取：soul_open ' + r.pointer } : {}),
    };
    if (r.ok) {
      out.note = '宿主回执已核对（targetSession / opId / 起止 seq 逐字相等）。framesAffected 是宿主自报，v4 无法独立复核';
    } else if (r.stage === 'stub' || r.stage === 'no-host' || r.stage === 'no-control') {
      out.note = '没有真的清理发生在任何会话上 —— 这一条失败回执只说明「这件事没做成」，不是「做了但结果不好」';
    }
    return JSON.stringify(out, null, 2);
  }

  if (name === 'soul_ask_host') {
    // ★★ 2026-11-07：这是「v4 能主动推宿主」的第一个真实调用点。
    //   在它之前，hub.exec() 写着却**没有任何调用者** —— 通道能连、能握手、能被看见，
    //   但 v4 从来没真正派过活。**「能连」和「能推」是两件事，别混。**
    const ctl = globalThis.__controlHub;
    if (!ctl) return JSON.stringify({ ok: false, error: '控制通道没接上（v4 里没有 hub 实例）' }, null, 2);

    const cap = String(a.cap || '');
    const action = String(a.action || '');
    if (!cap || !action) return JSON.stringify({ ok: false, error: 'cap 和 action 都要给' }, null, 2);

    // ★★ 2026-11-07 修（第一次写错的）：**hub.whoHas(cap) 返回的是宿主对象数组，不是 id。**
    //   我把它直接当 hostId 传给 exec()，于是 exec 拿数组去 Map.get() → 找不到 →
    //   reject 里拼 `'宿主不在: ' + hostId` → **把整个宿主对象（含 socket 内部状态）序列化进错误信息**。
    //   那条返回有 3KB，全是 _readableState / _writableState。
    //   ★ 教训：**用别人的 API 之前先看它返回什么形状**，别照着名字猜。
    //
    //   ★ 顺带改好一点：不只听「谁说会」，还要看「谁真的能干」——
    //     声明为桩（meta.stubs）的能力，派过去只会等超时（hub 现在会提前 reject，但更该在这里就筛掉）。
    const all = ctl.snapshot().filter((h) => h.host && h.host !== '(未 hello)');
    const able = all.filter((h) => (h.caps || []).includes(cap) && !(h.stubs || []).includes(cap));

    // 指定了宿主：先校验它真的能干这件事
    let target;
    let why;              // ★ 提到外面：原来写在 else 块里，出了块就是 undefined
    if (a.host) {
      target = all.find((h) => h.host === a.host || h.id === a.host);
      if (!target) return JSON.stringify({ ok: false, error: '没有这个宿主：' + a.host, 连着的是: all.map((h) => h.host) }, null, 2);
      if (!(target.caps || []).includes(cap)) return JSON.stringify({ ok: false, error: target.host + ' 不会 ' + cap, 它会的是: target.caps }, null, 2);
      if ((target.stubs || []).includes(cap)) return JSON.stringify({ ok: false, error: target.host + ' 声明 ' + cap + ' 是桩（能力在、路没通）', 它的桩: target.stubs }, null, 2);
    } else {
      if (!able.length) {
        return JSON.stringify({
          ok: false,
          error: '没有宿主真的能干 ' + cap,
          hint: '连着的是：' + all.map((h) => h.host + ' caps=[' + (h.caps || []).join(',') + ']' + ((h.stubs || []).length ? ' stubs=[' + h.stubs.join(',') + ']' : '')).join(' / '),
        }, null, 2);
      }

      // ★★ 2026-11-07 改：自动挑**不能是「第一个」**。
      //
      //   原来写的是 `able[0]` —— 那是**连接顺序**，不是判断。
      //   两个宿主都能干时，挑到谁纯看谁先连上：重连一次顺序就变了，
      //   而且人看结果时**完全不知道它凭什么挑了这个**。
      //
      //   ★ 新规则（可解释、可预测）：
      //     ① 只有一个能干的 → 就它
      //     ② 多个 → 挑「最近一次上报 state 最新的」
      //        理由：**有新鲜 state 说明它活着**。一个连上来却从不说话的宿主，
      //        能派活不代表会干活 —— 而 v4 自己看不见宿主内部，只能靠这个。
      //     ③ 都没上报过 state → 按连接时间，**并在输出里说清这是退让**
      if (able.length === 1) {
        target = able[0];
        why = '只有它在干 ' + cap;
      } else {
        const withState = able.filter((h) => h.state && h.state.at);
        if (withState.length) {
          withState.sort((x, y) => new Date(y.state.at) - new Date(x.state.at));
          target = withState[0];
          why = able.length + ' 个都能干 ' + cap + '，挑它是因为它的 state 最新（' + target.state.at + '）—— 有新鲜 state 说明它活着';
        } else {
          target = able[0];
          why = able.length + ' 个都能干 ' + cap + '，但都还没上报过 state —— 只能按连接顺序挑了「' + target.host + '」（这条是退让，不是判断）';
        }
      }
    }
    const hostId = target.id;

    try {
      const data = await ctl.exec(hostId, cap, action, a.args || {}, Number.isFinite(a.timeoutMs) ? a.timeoutMs : 15000);
      // ★ 输出里带上「挑了谁、为什么」—— 不让人自己猜
      return JSON.stringify({ ok: true, host: hostId, hostName: target.host, cap, action, why: why || '你指定的', data }, null, 2);
    } catch (e) {
      return JSON.stringify({ ok: false, host: hostId, cap, action, error: String(e && e.message || e), hint: e && e.hint }, null, 2);
    }
  }

  if (name === 'soul_diagnose') {
    const s2 = store();
    const list = s2.list();
    // 挑会话：给了片段就匹配，没给就挑最近改过的
    let target = null;
    if (a.session) {
      const q = String(a.session);
      target = list.find((x) => x.id === q) || list.find((x) => x.id.includes(q));
      if (!target) return JSON.stringify({ ok: false, error: '找不到会话：' + q, 候选: list.slice(0, 5).map((x) => x.id) }, null, 2);
    } else {
      target = [...list].sort((x, y) => (y.mtime || 0) - (x.mtime || 0))[0];
      if (!target) return JSON.stringify({ ok: false, error: '一个会话都没有' }, null, 2);
    }
    const st = s2.load(target.id);
    if (!st || !Array.isArray(st.frames)) return JSON.stringify({ ok: false, error: '这个会话读不出帧：' + target.id }, null, 2);

    const r = diagnose(st.frames);
    let cands = r.candidates;
    if (a.kind) cands = cands.filter((c) => c.kind === String(a.kind));
    const lim = Number.isFinite(a.limit) ? Math.max(1, Math.min(100, a.limit)) : 10;
    return JSON.stringify({
      ok: true,
      session: target.id,
      frames: r.frames,
      候选: cands.length,
      按类型: r.stats.byKind,
      // ★ 先说清「这不是判决」—— 它只指出可疑段，要不要删、删哪段得人看
      note: '这些是「值得看一眼的段落」，不是判决。每段都给了门牌，用它去 memq open 看原文再定。',
      items: cands.slice(0, lim),
    }, null, 2);
  }

  if (name === 'soul_guard') {
    const r = await guardCheck(
      { text: a.text, from: a.from, role: a.role },
      { llm: (() => {
        // ★ 只在配置了 apiKey 时才把 llm 传进去 —— 没配就走纯规则层，
        //   而不是「传一个会抛错的东西进去」。那会让每条模糊请求都落到 ask。
        try {
          const c = loadConfig();
          if (!(c.llm && c.llm.apiKey)) return null;
          return { chat: async (msgs) => {
            // ★ 2026-11-07 修：导出名是 LlmClient（不是 LLMClient），
            //   而且 chat() 收的是**完整 messages 数组**（openai 形态），不是字符串 + options。
            //   原来那版是凭印象写的，一跑就 "does not provide an export named 'LLMClient'"。
            const { LlmClient } = await import('../llm/client.mjs');
            const cli = new LlmClient(c.llm);
            const res = await cli.chat(msgs);
            // chat() 回的是 { content } 或字符串 —— 两种都兜住
            const text = typeof res === 'string' ? res : (res && (res.content || res.text)) || '';
            return { content: text };
          } };
        } catch { return null; }
      })() }
    );
    // ★ 2026-11-07 加：模糊层不可用时**要说出来**。
    //   不说的后果：用户以为「审核过了」，其实只过了规则层 ——
    //   而「静默降级」比「报错」更让人困惑（爀曦原话）。
    const out = { ...r };
    // ★ 2026-11-10：MCP 出口也再脱一次（与 HTTP 同一判据）。
    //   它和 HTTP 是两条路，谁都不能指望「对面已经脱过了」。
    out.why = guardRedact(out.why, 400);
    out.lines = Array.isArray(out.lines) ? out.lines.map((x) => guardRedact(x, 40)) : [];
    out.evidence = guardRedactEvidence(out.evidence);
    // ★ 2026-11-10 第二轮（P2）：原文回声与 HTTP 走同一份结构脱敏（redactBody）。
    //   MCP 的返回值会进宿主会话/日志，凭据同样不该跟着走。
    if (out.text != null) out.text = guardBody(out.text);
    // ★ 2026-11-10：guard 现在的「降级」只有一个形状 —— via==='fallback'（附 evidence.code）。
    //   旧的两个判据（via==='llm-error' / 规则 pass 但文本像「你看着办」）已经不可能再出现：
    //   前者改名成了 fallback+exception，后者现在直接返回 fallback+unconfigured。
    //   ★ 原因必须分开说：没配 key / 超时 / 调用失败 / 回了个看不懂的 —— 四种都不是「审过了」。
    if (r.via === 'fallback') {
      const ev = r.evidence || {};
      out.degraded = true;
      out.degradedWhy = ev.code === 'LLM_UNCONFIGURED'
        ? '没有配置 llm.apiKey —— 模糊判断这一层没跑，只过了规则层。填 key 后重启即可恢复。'
        : ev.code === 'LLM_TIMEOUT'
          ? '模型调用超时（上限 ' + (ev.timeoutMs == null ? '?' : ev.timeoutMs) + 'ms）—— 已转人判断，不等于审过了。'
          : ev.code === 'LLM_UNPARSABLE'
            ? '模型回了看不懂的内容 —— 已转人判断，不等于审过了。'
            : '模型调用失败 —— 已转人判断，不等于审过了。原因：' + String(ev.error || '未知');
    }
    return JSON.stringify(out, null, 2);
  }

  const e = new Error('没有这个工具: ' + name);
  e.code = 'NO_TOOL';
  throw e;
}