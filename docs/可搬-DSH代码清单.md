# 可搬 · DSH 代码清单（给 agent-soul）

> **结论先说三句**
>
> 1. DSH 里对 agent-soul 真正值钱的**不是工具本身**，是工具背后的**三套记账**：
>    超时的记账（谁欠谁一个 deadline）、路径身份的记账（哪个才是真的那个文件）、
>    压缩的记账（哪段被谁替换了、代价是多少）。工具只是这三套记账的皮。
> 2. **一个会改变结论的发现**：dsh-token-meter 不是「精确 token 计量」。它是
>    CHARS_PER_TOKEN = 4 的固定密度估算，**对中文比 agent-soul 现在的 estimateTokens() 还差**
>    （按代码常量推，差约 4 倍）。它值钱的地方不在估算器，在**「用服务商真实 usage 当锚，之后只算增量」**这套结构。
> 3. 最该先搬的是 **dsh-timeout + dsh-tool-call-timeout-policy（当一件事搬）**。
>    一句话理由：**agent-soul 现在只有这一处「没有边」** —— 工具 handler 不返回，
>    整个回合就永远不返回，而且没有任何东西能打断它。

---

## 0 取证方式（可自行复核）

**读过的 DSH 包：15 个**（位置：`<安装目录>\resources\app.asar\dsh\node_modules\@deepseek-ai\<包>\lib\index.js`，
编译产物但未压缩、带完整 JSDoc）：

| 读法 | 包 |
|---|---|
| 整份读完（12） | dsh-tool-fs、dsh-tool-fs-search、dsh-bash-local、dsh-bash-sandbox、dsh-atomic-write、dsh-tool-call-timeout-policy、dsh-timeout、dsh-util-crypto、dsh-util-time、dsh-util-workspace-path、dsh-chunked-list、dsh-compaction-basic |
| 读大部分（3） | dsh-token-meter（index.js 约 75% + types/estimate.js + types/usage-projection.js 全 + types/surface-projection.js + types/route-pricing.js 片段）、dsh-util-values（导出面 + 关键函数）、dsh-fs-local（路径解析与写盘部分定向取证，约 40%） |
| 只看了清单与依赖（3，不计入上面） | dsh-fs（纯接口，4.3 KB）、dsh-sandbox、dsh-subprocess |

**对照读过的 agent-soul 文件：8 个** ——
src/session/store.mjs、src/session/frame.mjs、src/tools/builtin.mjs、src/tools/registry.mjs、
src/llm/client.mjs、src/agent/loop.mjs、src/organs/compaction.mjs、src/organs/context.mjs。

**本文所有代码证据都写函数名，可以 grep 复核：**

~~~powershell
$b = "C:\Users\pc\AppData\Local\Programs\DeepSeek Harness\resources\app.asar\dsh\node_modules\@deepseek-ai"
Select-String -Path "$b\dsh-compaction-basic\lib\index.js" -Pattern "function selectCompactableRange"
~~~

**没有读到的地方，文末第六节逐条写明，不替它下结论。**

---

## 一、总表

| 包名 | 一句用途 | 判断 | 优先级 |
|---|---|---|---|
| dsh-timeout | 超时算术：deadline / clampTimeout / idleWatchdog / timeoutOf | **值得**（零依赖，210 行） | **P0** |
| dsh-tool-call-timeout-policy | 把工具自己声明的 timeoutMs 变成结构化 TOOL_TIMEOUT | **值得**（只依赖上一包） | **P0** |
| dsh-atomic-write | 原子替换 + 跨进程写锁 | **值得**（零依赖，300 行） | **P0** |
| dsh-fs-local（路径身份那部分） | realpath 身份 + 缺失目标回退到最近存在祖先 + contains() | **值得**（这是真正的沙箱边界） | **P0** |
| dsh-tool-fs（拆两半） | 有界读窗口 / 唯一匹配编辑 / 改前必读 | **值得**（各取一半） | **P1** |
| dsh-bash-local（挑 4 处） | 模型友好环境变量 + 双流限额 + 优雅终止契约 | **值得**（不整包搬） | **P1** |
| dsh-token-meter（记账那部分） | 真实 usage 当锚 + 增量推算 + 替换计价 | **值得**（只搬结构，**不搬估算器**） | **P1** |
| dsh-compaction-basic（引擎那部分） | 选区 / 预算 / 收敛判据 / 摘要指令 | **值得**（分 4 块搬，**指令必须改写**） | **P1** |
| dsh-tool-fs-search | ripgrep 起步、--json 解析、上限与抽样 | **有条件值得**（要引入外部 rg 二进制） | **P2** |
| dsh-bash-sandbox | 把命令包进 OS 级沙箱并按 stderr 方言判拒绝 | **不值得**（见三-1） | — |
| dsh-util-values | JSON 边界 / 深冻结 / 流式 JSON 参数扫描 | **大部分不值得**（只有 deepFreeze 4 行可抄） | — |
| dsh-util-crypto | randomUUID + bytesToBase64 的跨环境兜底 | **不值得** | — |
| dsh-util-time | 只有一个导出 canonicalClientTimeZone | **不值得** | — |
| dsh-util-workspace-path | dsh-resource://file/... 地址语法 | **不值得** | — |
| dsh-chunked-list | 不可变分块追加列表 | **不值得** | — |

---

## 二、值得搬的，逐个说

### 2.1 dsh-timeout —— 超时算术（P0）

**它解决什么**

把「超时」拆成三件可复用的东西：算术（钳位与校验）、信号融合（上游取消 + 自己的 deadline）、
原因归属（这个 abort 到底是谁的）。它**不终止任何东西** —— 只发通知，停不停由调用方负责。

**好在哪（代码证据）**

- deadline(upstream, timeoutMs, code)：timeoutMs <= 0 是「不设定时器」的内部哨兵（**不是**公开的「禁用超时」）；
  否则 setTimeout 到点后 timer.abort(new TimeoutReason(code, timeoutMs))，
  再用 AbortSignal.any([upstream, timer.signal]) 把上游取消融进来，返回带 [Symbol.dispose] 的对象负责清定时器。
- TimeoutReason extends Error，字段 code / timeoutMs，name = "TimeoutReason"。
  —— **超时是一个带身份的 reason，不是一个布尔值。**
- timeoutOf(x, code)：从 signal 或异常上取回 reason，**只有 code 对得上才算自己的**。
  注释写明动机：这样「另一个 tools/execute 包装器的定时器先响」不会被误读成自己的超时。
- clampTimeout(requested, def, max, name)：min(requested ?? def, max)，并把 0 明确排除在「禁用」之外。
- assertTimerDelay：timeoutMs > 2147483647 直接抛。这是 Node 的老坑 —— 超过上限的 setTimeout 会被钳成 1 ms。
- idleWatchdog(upstream, timeoutMs, code)：给异步迭代器用的**可重置空闲看门狗**。
  定时器只在 next() 未决时存在（注释：「消费者思考的时间不算提供方空闲时间」），
  且 next 同一时刻只允许一个 outstanding（重复调用直接抛错）。

**搬进哪个文件**

新建 src/util/deadline.mjs（约 60 行：TimeoutReason / MAX_TIMER_DELAY_MS / assertTimerDelay / clampTimeout / deadline / timeoutOf）。
idleWatchdog 单独放 src/util/idle-watchdog.mjs，等 LLM 客户端要做「流式空闲超时」时再接。

**依赖化简**

零。原包 dependencies 为空，只用 node:timers 与全局 AbortController。

**坑**

1. **它不杀东西。** signal 是协作式的。handler 若无视 signal，超时了照样跑完。
   搬的时候必须同时把 signal 传进 handler 签名，否则只是多了一个没人听的闹钟。
2. timeoutOf 必须带 code 调用。不带的话，外层超时会被内层认成自己的，报错位置就错了。
3. deadline 返回的对象靠 Symbol.dispose 清理。要用 await using 得 Node ≥ 20；
   agent-soul 现在有没有用 using 我没读到，稳妥点手动调 d[Symbol.dispose]()。

---

### 2.2 dsh-tool-call-timeout-policy —— 把超时变成结构化结果（P0）

**它解决什么**

工具自己声明 timeoutMs，这一层在 tools/execute 外面套一个 deadline；到点后**不丢弃工具的 promise**
（不做竞速、不放弃它），而是把结果替换成 isError: true 且 error.info.code = "TOOL_TIMEOUT" 的结构化结果。

**好在哪（代码证据）**

~~~js
const TOOL_TIMEOUT = "TOOL_TIMEOUT";
function toolTimeoutResult(timeoutMs) {
  const message = "tool call timed out after " + timeoutMs + "ms";
  return { content: [{ type: "text", text: "Error: " + message }], isError: true,
           error: { message, info: { name: "ToolTimeoutError", code: TOOL_TIMEOUT } } };
}
// apply() 里：
const d = deadline(exec.signal, timeoutMs, TOOL_TIMEOUT);
const upstream = exec.signal;
exec.signal = d.signal;                     // 临时替换
try {
  const result = await next();
  if (timeoutOf(d.signal, "TOOL_TIMEOUT") !== void 0) return toolTimeoutResult(timeoutMs);
  return result;
} finally { exec.signal = upstream; }       // 一定还原
~~~

三点值得抄：

- **替换而不是叠加**：工具看到的是「一个新的 exec.signal」，它不需要知道自己被套了一层。
- **事后归因**：先跑完，再看 signal 上是不是**自己**那个 reason 才替换结果 —— 上游取消不会被误报成超时。
- **结构化 code**：重试层 / 权限层 / UI 都能按 code 分支，不用解析 "timed out after..." 这段字。

**搬进哪个文件**

改 src/tools/registry.mjs 的 execute()：在 await def.handler(args, ctx) 外面包一层。
def.timeoutMs 缺省用「全局默认（如 30 s）+ 上限（如 10 min）」，与 clampTimeout 同义。
超时返回 ok:false、error:{ code:'TOOL_TIMEOUT', message }，与现有 { ok, content } 结构兼容。

**依赖化简**

只依赖 dsh-timeout。原包 dependencies 为空（它 import 的那个是 monorepo 内部包）。

**坑**

1. **别写成 Promise.race([handler, timer])。** 竞速会留下一个还在跑的 handler：
   它稍后写文件、调 MCP、发 HTTP，而 agent 已经往下走了 —— 幽灵副作用。
   DSH 的选择是「等它跑完，再改结果」，代价是**超时不缩短实际耗时**，只保证 agent 不被卡住。
2. registry 现在把 handler 返回值 JSON.stringify 成 content。超时分支要走**另一个**形状（带 error.code），
   否则模型只看到一句英文，脚本没法分支。
3. def.timeoutMs 要和 run_shell 自己的 timeoutMs 区分：外面那层是「agent 等多久」，里面那层是「进程活多久」。
   两层都设，且外层 > 内层（否则外层先响，杀不到进程）。

---

### 2.3 dsh-atomic-write —— 原子替换 + 写锁（P0）

**它解决什么**

「读者要么看到旧的完整内容，要么看到新的完整内容」，以及「跨进程的读-改-写不会互相复活旧状态」。

**好在哪（代码证据）**

writeFileAtomic(filename, content, { mode, dirMode })：

- 先 mkdir(dirname, { recursive: true, mode: dirMode })；
- 临时名 = filename + "." + randomBytes(6) 的 hex + ".tmp"，**同目录**（保证 rename 不跨卷）；
- writeFile(temp, content, { mode, flag: "wx" })：wx 独占创建。注释写明两个目的 ——
  拒绝跟随预先埋在那里的符号链接；新 inode 直接带 mode，**不用 chmod，没有竞态窗口**；
- renameAtomicTemp：Windows 上 EACCES / EBUSY / EPERM 是**暂时性干扰**（杀毒、索引器、句柄），
  重试 8 次，20 ms 起、每次 ×2、封顶 200 ms；
- 失败时 rm(temp, { force: true }) 再抛。

withFileLock(filename, operation, { waitMs, signal })：

- 锁文件是 filename + ".lock"，wx 创建，内容是当前 pid 加换行；
- holderExited(record) 用 process.kill(pid, 0) 探活，**只认 ESRCH**；pid === process.pid 时返回 false（自己不算死）；
- 接管死锁要先拿一张「认领票」：锁路径 + ".takeover-" + sha256(record) 前 16 位。
  在票的保护下**再读一次锁、再探一次 pid**，都对得上才 rm —— 注释解释了为什么：
  防止「另一个竞争者刚拿到锁」和「PID 被复用」时误删活锁；
- 争用时指数退避（20 → 200 ms），DEFAULT_LOCK_WAIT_MS = 2000，到点抛错。

**搬进哪个文件**

新建 src/util/atomic.mjs（writeFileAtomic + withFileLock 两个导出，约 180 行）。

**依赖化简**

零。原包 dependencies 为空。

**坑（这一节的坑比代码本身值钱）**

1. **硬链接会被打断。** rename 换 inode，原来的同 inode 副本就「各叫各的名字」了。
   这条在《墨》里有实录（2026-09-25：edit 的原子写入打断硬链接，「我改了源、副本没变，而两个都叫我的名字」）。
   → **frames.jsonl / 02-墨.jsonl 这类只追加的文件绝对不要用原子替换**，
   用 fs.appendFile（单次 write 走 O_APPEND，短写不撕裂）；原子替换只用在 _index.cache / _index.fp / config.json 上。
2. **没有 fsync。** 代码注释原话：「Crash durability (fsync) is out of scope」。断电可能丢最后一笔。
   要真持久，得在 rename 前后各 fsync 一次文件与目录 —— Windows 上目录 fsync 不可移植，量力而行。
3. **Windows 不重试就是随机失败。** 不照抄那 8 次重试，在开杀软的机器上会看到「偶发写不进去」。
4. withFileLock 的 PID 探活是**单机假设**。注释自己承认：跨主机或多 PID namespace 共享同一文件时，
   两个进程可能同时持锁。agent-soul 单机没问题，但别当分布式锁用。
5. 锁的 waitMs 默认 2 秒。写几十 MB 的大文件时给不够，要显式调大。

---

### 2.4 dsh-fs-local 的**路径身份**部分 —— 真正的沙箱边界（P0）

**它解决什么**

两个字符串「看起来在根目录里」不等于「真的是同一个文件」。..、符号链接、NTFS junction、
大小写、盘符相对路径（C:foo）、UNC —— 每一样都能让 path.resolve + path.relative 的判断失效。

**好在哪（代码证据）**

- resolveLocalTarget(cwd, path) 返回**两样东西**：
  - displayPath —— 给人看的路径；
  - targetKey = FsTargetKey(await realpath.native(displayPath)) —— **给程序判断身份用的**。
- 目标**还不存在**时（新建文件）不直接失败，而是：
  先取 basename 当 missing → 逐级 dirname 往上找 → 找到最近一个能 realpath 的祖先 →
  校验它是目录 → join(realAncestor, ...missing)。
  注释解释了为什么必须这么绕：「保留跨越符号链接祖先的、创建前后的身份一致」。
  （中间有个 Windows 修：missing 里含 ".." 时直接拒绝 —— 父级穿越跨过缺失目录。）
- localDisplayPath：Windows 用 resolve(cwd, path)（原生盘符语义），
  POSIX 在含 .. 时保留**物理写法**而不是先解析 —— 平台差异被显式写出来，而不是一套逻辑糊两边。
- contains(parent, child)：

~~~js
contains(parent, child) {
  const path = relative(this.processPath(parent), this.processPath(child));
  return path === "" || path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path);
}
~~~

  注意 processPath() 返回的是 **targetKey（realpath 之后的）**，不是 displayPath。
  **判断越界用的是身份，不是拼写** —— 这是整个包最值钱的一行。
- 它还把「改前必读」做在了文件系统层：throwGuardedCreateFailure 在 EEXIST 时抛 FS_NOT_OBSERVED，
  文案是 cannot overwrite existing "X" without reading it first。

**搬进哪个文件**

替换 src/tools/builtin.mjs 里的 inside()，抽成 src/tools/paths.mjs：
resolveTarget(cwd, p) → { displayPath, targetKey }，以及 contains(parentKey, childKey)。

**依赖化简**

零。只用 node:fs/promises 的 realpath.native、stat、lstat 和 node:path。

**坑**

1. **agent-soul 现在的 inside() 是可绕过的。** 现码是 path.resolve(WS, p) + path.relative(WS, abs) —— **纯词法**。
   在工作区里 mklink /J 一个指向 C:\Windows 的目录，然后 read_file 那个目录里的 win.ini，会**直接读到**。
   这不算理论风险，Windows 上一行命令就能复现。
2. realpath 要带 .native：promisify(realpath.native)。JS 版本与原生版本在 Windows 上对 junction 的处理历史上有差异。
3. **判断越界用 targetKey，不要用 displayPath**；否则等于没改。
4. relative() 的三段式判据别写漏：空串（同一路径）、".."（直属父级）、".." + 分隔符 前缀、isAbsolute。
   少一段就漏一种。
5. 目标不存在时的祖先回溯**不能省**：省了就会在「新建文件 + 路径含符号链接目录」时算错身份，
   于是同一个文件被当成两个。

---

### 2.5 dsh-tool-fs —— 拆两半：有界读窗口 + 编辑语义（P1）

#### 2.5.1 有界读窗口 buildWindow

**解决什么**

读一个 364 MB 的会话日志（本机确实存在：data/sessions/session-1099f531-.../frames.jsonl = 364 MB），
要能给出「前 2000 行、每行最多 2000 字符、总共最多 50 KB」，而且要**知道总行数** —— 同时内存不能涨。

**好在哪（代码证据）**

~~~js
const lineBufferCap = request.maxLineLength + 1;      // 单行缓冲上限
function appendToLineBuffer(segment) {
  if (lineBuffer.length >= lineBufferCap) return;     // 到顶就不再拼
  lineBuffer += segment;
  if (lineBuffer.length > lineBufferCap) lineBuffer = lineBuffer.slice(0, lineBufferCap);
}
function consumeLine(acc, rawLine, request) {
  acc.totalLines += 1;                                // 超出的行也照数
  if (acc.truncatedByBytes || acc.totalLines < request.offset
      || acc.lines.length >= request.limit) return;
  const text = truncateLine(rawLine, request.maxLineLength);
  const bytes = lineByteSize(text, acc.lines.length);
  if (acc.outputBytes + bytes > request.maxBytes) { acc.truncatedByBytes = true; return; }
  ...
}
~~~

三件事同时成立：**行数精确**（一直扫到 EOF，只计数不留内容）、**内存有界**（单行缓冲封顶 + 输出字节封顶）、
**可续读**（footer 给 Use offset=N+1 to continue）。
常量：READ_LIMIT = 2000、READ_MAX_LINE_LENGTH = 2000、READ_MAX_BYTES = 50 * 1024、
STREAM_MIN_SIZE = 10 MB（≥10 MB 走流式）。
finish() 还有个细节：offset 超过 EOF 抛 FS_NOT_FOUND，但**空文件的 offset=1 不算越界**。

**搬进哪个文件**

新建 src/tools/read-window.mjs，read_file 改成调它。

**坑**

- 现在 read_file 是 fs.readFileSync(abs,'utf8') 再 split 换行 —— 大文件直接吃掉等量堆内存。
  agent-soul 在 list() 里已经踩过这个坑（注释：「1006 个会话 list 一次 6.3 秒，因为其中一个会话是 308MB」），
  只是 read_file 这条路上还没修。
- Buffer.byteLength 才算字节；String.length 是 UTF-16 code unit（中文 1 个字算 1，emoji 算 2）。
- 流式要接 AbortSignal，否则用户取消后还在读。

#### 2.5.2 编辑语义 editText

**解决什么**

「替换这段字」有四种出错方式：找不到、找到多处、换完没变化、换的时候把 CRLF 弄坏。DSH 四种都挡了。

**好在哪（代码证据，来自 dsh-fs-local）**

- parseEditArgs：old_string 非空；old_string !== new_string（相等就是保证的空操作，直接拒）。
- countOccurrences + 判据：0 → FS_EDIT_NOT_FOUND；>1 且没开 replace_all → FS_AMBIGUOUS_EDIT，
  文案带次数：old_string matched N times in "X"; provide a more specific old_string or set replace_all to true。
- **行尾归一化**：normalizeLineEndings / detectLineEndings（取前 4096 字节数 CRLF 与 LF 的占比）/ restoreLineEndings。
  匹配用 LF，写回用原样式 —— 于是「在 Windows 上改一个 CRLF 文件」不会变成整文件 diff。
- 改前必读：FS_NOT_OBSERVED（见 2.4）。

**搬进哪个文件**

新增第 5 个工具 src/tools/edit.mjs，注册进 builtin.mjs。

**坑**

- 「唯一匹配」的默认值不能松。松了模型就会用 old_string: "const" 把整个文件改废。
- 错误要用**不同 code**，否则模型拿不到「该换个更长的 old_string」这条提示。
- 大文件读进来做字符串替换仍要设上限（比如 8 MB 以上拒绝 edit，只允许 read + 分段写）。

---

### 2.6 dsh-bash-local —— 只挑 4 处（P1）

**整包不值得搬**（它一半是 ShellExecutor 的子类骨架、managed range、后台进程生命周期，agent-soul 用不上）。
**但下面四样是纯赚：**

**① 模型友好环境（ENV_OVERRIDES）**

~~~js
const ENV_OVERRIDES = { NO_COLOR: "1", TERM: "dumb", PAGER: "cat", GIT_PAGER: "cat" };
// 合并顺序：ENV_OVERRIDES → 调用方 env → 调用方 dshEnv（调用方能覆盖回来）
~~~

注释写：「the same set Codex hardcodes; Claude Code achieves it via TERM=dumb」。
不加这四行，git log 会进分页器卡住、npm 会吐 ANSI 色码、日志变成一堆控制字符。

**② stdout / stderr 分别限额，超了写 spill 文件**

默认 maxOutputBytes = 64000、maxSpillBytes = 64 MB；finalOutput(reader) 返回 { text, truncated, spillPath }。
比现在 slice(0, 20000) 强的地方：**完整输出还在磁盘上，模型可以再去读**，而不是永远丢了。

**③ 两路合并时的换行判断**

~~~js
const separator = out.text.length > 0 && !out.text.endsWith("\n") ? ... : "";
delta: out.text + (errText.length > 0 ? separator + "[stderr]" + 换行 + errText : "")
~~~

不判断就会拼出 done[stderr]。小事，但每次看到都别扭。

**④ 超时的分开表达**

resolve() 里 timeoutMs = clampTimeout(request.timeoutMs, config.timeoutMs / 120 s /, config.maxTimeoutMs / 600 s /)，
另有独立的 graceMs = 3000（SIGTERM → SIGKILL 的宽限）。
**「等多久」与「杀多狠」是两件事**，现在 run_shell 只有一个 timeout。

**搬进哪个文件**

重构 src/tools/builtin.mjs 的 run_shell（拆到 src/tools/shell.mjs）。

**坑**

1. **Windows 上 execFile('cmd.exe', ['/c', cmd]) 超时只杀 cmd.exe，不杀它生的孙子进程。**
   DSH 把这部分交给 ctx.subprocess（进程树终止）—— **那一层我没读到，所以不下结论。**
   agent-soul 要么用 taskkill /PID <pid> /T /F，要么上 Job Object；
   否则 npm run dev 这类会留下一堆孤儿，越跑越卡。
2. clampTimeout 会把 timeoutMs: 0 拒掉（0 不是「禁用超时」）。调用方要传显式的大数。
3. spill 文件要有清理策略，否则临时目录会慢慢涨。

---

### 2.7 dsh-token-meter —— 只搬记账结构，**估算器别搬**（P1）

**先说清楚它是什么（这条会颠覆「精确计量」的印象）**

~~~js
const CHARS_PER_TOKEN = 4;   // "Fixed text-density estimate used until exact tokenization is needed."
const BLOCK_OVERHEAD = 4;
const ROLE_OVERHEAD = 4;
case "text": tokens += Math.ceil(block.text.length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD;
~~~

**没有分词器。** 它把整段文本按「4 个字符 = 1 token」折算。对中文，
「一个字 ≈ 一个 token」会被估成「四个字一个 token」—— **低估约 4 倍**。
（这是按常见 BPE 分词器的量级估的，我没有在 DSH 里做分词器实测；
但量级差是确定的，因为分子是 .length（UTF-16 code unit），分母是 4。）

而 agent-soul 的 estimateTokens() 已经**比它好**：CJK 区（含 U+3000、U+FF00 全角标点）按 1 字 1 token，
其余按 4 字符 1 token，且明确写了设计意图「宁可估高，不许估低 —— 它是安全网」。
**所以估算器不要换，换了是退步。**

**那它值钱的是什么 —— 三件记账**

**① 用真实 usage 当锚**

~~~js
const pressureFrom = (usage) =>
  usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
~~~
注释：「Prompt-side pressure of one request: input plus cache traffic, no output.」
这是服务商自己的账，不需要估。agent-soul 完全可以拿到 —— 见第四节 4.4 那条空档。

**② 锚之后只算增量**

~~~js
projectedTokens: Math.max(0, pressureTokens + surfaceTokens - sampledSurfaceTokens)
~~~
读法：真实水位 = **上次采样时的真实值** + **采样之后可见消息面的变化量**。
sampledSurfaceTokens 是「采样那一刻的 surface」，所以后一项是**增量**，不是「重新估一遍整个上下文」。
**误差从「整体估算」降到「增量估算」—— 这是全部价值所在。**

**③ 替换用「影子价」记账**

~~~js
if (event.type === "compaction/summary" || event.type === "compaction/prune") {
  return { deltaTokens: 0, claim: { start, end, tokens: shadowedTokenCount } };
}
// 之后那条 replace：deltaTokens = tokens - claim.tokens，claim 清空
~~~
即：**压缩发生时先记一笔「我欠你多少」**（被压区间值多少），**等替换真落地时再相减**。
于是总量 O(1) 维护，且不依赖回放整个历史。
它还有一条硬规矩：claim 与 replace 的区间对不上就直接抛错
（「这是活跃产者的契约违约，不是历史数据，必须响」）。

**搬进哪个文件**

新建 src/session/meter.mjs：
measure(session) → { totalTokens, nodes:[{seq,tokens}], pressureTokens, sampledSurfaceTokens, projectedTokens }。
src/organs/context.mjs 的 usedTokens() 改成调它。

**坑**

1. **别把 chars/4 搬过来**（见上）。保留现有的分区估算，只在外面加「锚 + 增量」。
2. 水位要用 projectedTokens，不要用 surfaceTokens。
   agent-soul 现在 usedTokens() 每次**全量重算**（遍历所有帧 + 跳过被压区间），帧一多就是 O(N)；
   接上锚 + 增量后可降到 O(1) 维护。
3. 采样点的**顺序**很要紧：DSH 是「先落 usage，再把这条消息并入 surface」，
   这样锚点对应的是**这次请求看见的那份 surface**。顺序反了，锚就错位一条消息。
4. 重试要扣掉上一次的账：tokenUsageProjectionDefinition 里 llm/retry-started 会清掉 last 槽位，
   于是重试那次是**替换**而不是**累加**。agent-soul 的 chatRetry 如果把每次 usage 直接相加，会重复计费。

---

### 2.8 dsh-compaction-basic —— 拆 4 块，**指令必须改写**（P1）

**⚠️ 先说最重要的一条：不要照抄那段摘要指令。**

src/organs/compaction.mjs 开头已经把理由写清楚了 —— 老版 DSH 那段硬编码指令
「要求保留 exact file paths / commands / error strings / numeric values / function signatures，
**但通篇没有一句要求标注『这话从哪来』**」。

我把 DSH 的 COMPACTION_INSTRUCTION 逐字读过，**它确实没有**任何 provenance 要求。
七个段落（Primary Request / Key Technical Concepts / Files and Code / Errors and Fixes /
Pending Jobs / Current Work / Next Step / Critical Context）全是「内容」，没有一句「这段从哪来」。
**照抄 = 把当初拒掉的那个缺陷再装回来。**

**该搬的是引擎，引擎有四块真东西：**

**① 选区算法 selectCompactableRange(session, measurement, retainTokens)**

~~~js
let accumulated = 0, keepFromIdx = pricedNodes.length;
for (let index = pricedNodes.length - 1; index >= 0; index -= 1) {   // 从末尾往前累
  accumulated += pricedNodes[index].tokens; keepFromIdx = index;
  if (accumulated >= retainTokens) break;
}
while (keepFromIdx > firstIdx) {                                    // 再往前挪到「成对边界」
  if (toolPairingBalancedBefore(session, surfaceNodes[keepFromIdx])) break;
  keepFromIdx -= 1;
}
return { start: surfaceNodes[firstIdx], end: surfaceNodes[keepFromIdx - 1] };
~~~

三个约束同时满足：**保留最近的尾巴**（按 token 价值算，不是按条数）、
**绝不切断 tool_call / tool_result 对**、**system/message 那一帧永不进选区**。

**② 预算算术 resolveCompactSpec**

~~~js
const messageBudgetTokens  = contextWindow - reservedCompletionTokens;
const pressureBudgetTokens = messageBudgetTokens - policy.headroomTokens;
const thresholdTokens = Math.floor(Math.min(contextWindow * policy.thresholdRatio, pressureBudgetTokens));
const retainTokens    = policy.retainTokens ?? Math.floor(messageBudgetTokens * policy.retainRatio);
~~~
默认 thresholdRatio = 0.8、retainRatio = 0.16、headroomTokens = 65536。
注意它把**输出预留**也从窗口里扣掉了 —— 很多实现忘了这一步，于是「压到 80% 之后还是 400」。

**③ 收敛判据（两条，都值得抄）**

- **摘要必须真的更小**：framedSummaryTokenCount >= shadowedRouteTokenCount 直接 throw。
  「压完更大」在这里是**错误**，不是「这次效果不好」。
- **压完要重测**：compactionRetries 循环里重新 measure，仍高于阈值就再来一轮
  （默认 compactionRetries = 1，即最多 2 轮）。

**④ 事务形状（compaction/start → 干活 → compaction/end）**

先落 compaction/start 再调模型（这就是跨进程锁：assertCompactionInactive 看到不配对的 start 就拒），
失败也要写一条带 errorChain(error) 的 compaction/end。
注释：「a failed close deliberately leaves the unmatched start detectable」
—— **宁可留个响亮的疤，不留静默的错**。

**另外两个小设计，各值一行：**

- 摘要请求把 COMPACTION_INSTRUCTION 作为**最后一条 user 消息**追加在**被压区原文之后**，
  而不是另起一个 system prompt。注释：这样「这次辅助调用是最后一次真实请求的真前缀」，
  **provider 的 KV cache 能复用**，不白烧一遍。
- 摘要期间防抖：assertSelectedSpanStable 只要求「被选中的那段没变」，
  **选区之外**新增的消息不影响 —— 于是摘要期间用户能继续说话。

**搬进哪个文件**

扩写 src/organs/compaction.mjs（保留现有的 pointerText / topicsOf / staleFix / pruneText —— 那是它的长处），
新增 selectRange() / compactSpec() / compactRangeTx() 三块。

**坑**

1. **指令要加门牌。** 在那七段前面加一段：
   「第一行必须是 log:<sid>#seq=<start>（覆盖 seq start–end），第二行写『这段讲的是：…』」——
   这正是现有 pointerText() 已经在做的事，把两者缝起来就对了。
2. **选区边界 = 消息级约束。** 切在 tool_call / tool_result 中间，OpenAI 兼容接口会直接 400。
3. headroomTokens = 65536 是 DSH 对这个部署的取值，不是普适常数；窗口小的（32K/64K）照抄会没有可用预算
   （它会抛 leaving no pressure budget）。agent-soul 的 config.context.windowTokens 默认写 1048576，得确认实际窗口。
4. 压缩后要让**上下文真的变小**。store.mjs 的 usedTokens 已经会跳过 compaction.summary 覆盖的区间
   （inCovered(seq)），这条已经有了 —— 但 #framesToMessages() 有没有同样跳过，**我没读到，需要下一个人核**
   （两处不一致 = 水位以为压了、模型还是看到全文）。

---

### 2.9 dsh-tool-fs-search —— 有条件值得（P2）

**它解决什么**

grep / glob 不自己实现，直接调打包的 ripgrep，但把**全部危险面**包住了：
argv 不经 shell、输出走 --json、上限与抽样、超大结果落盘。

**好在哪（代码证据）**

- **--no-config 是安全措施，不是洁癖。** 注释原话：
  「a host RIPGREP_CONFIG_PATH (or rg.conf next to the binary) can otherwise inject --pre
  and make ripgrep execute an arbitrary preprocessor for every matched file」。
  不加这三个字母，环境变量就能让 rg 对每个匹配文件执行任意命令。
- **--regexp= / --glob= / -- 三段式**：模型给的值全是**普通 argv 元素**（没有 shell，所以没有引号问题），
  目标路径放在 -- 后面，于是以 - 开头的路径不会被当成 flag。
- **--json + NDJSON 解析（parseRecord）**：路径、行号、行内容各有字段，
  不会因为路径里有冒号/换行而错位；非 UTF-8 的行给占位符 "(line is not valid UTF-8)" 而不是整次搜索失败。
- **三态退出码**：0 有结果、1 成功但零结果（noMatches）、其它才算失败；
  classifyRunFailure 把 regex parse error|error parsing glob 单独归成 SEARCH_INVALID_PATTERN。
- **VCS 目录要排除两次**：GLOB_VCS_EXCLUDES = .git .svn .hg .bzr .jj .sl，
  每个名字配两个 --glob：!**/.git（遍历时剪枝）+ !**/.git/**（搜索根本身就在 .git 里时仍然排除）。
- **超上限不截头，而是「按顶层目录轮转抽样」（sampleAcrossTopLevel）**：
  「每个顶层条目先各拿一个，再轮到第二个」—— 于是 100 条上限里能看到 20 个目录，
  而不是被 node_modules 的前 100 个文件占满。
- 常量：GLOB_MAX_RESULTS = 100、GREP_MAX_MATCHES = 250、每行预览 2000 字节、
  原始 stdout 2e7（20 MB）、presentationMeta 65536 字节（capMetaBytes 一条条 pop 直到装得下）。

**搬进哪个文件**

src/tools/search.mjs（grep + glob 两个工具），但先解决依赖问题。

**依赖化简 / 前提**

它硬依赖 @vscode/ripgrep（一个打包的 rg 二进制）。**这与「零第三方依赖」直接冲突。** 两条路：

- **A（推荐）**：不搬进程，只搬**语义** —— 在 Node 里自己走一遍目录，套用它的三条规则：
  VCS 目录双重排除、上限处的顶层轮转抽样、每行预览 2000 字节 + (line truncated)。
  慢一些，但零依赖且行为一致。
- **B**：允许「可选依赖」—— 检测到 rg 就用，没有就退回 A。**别做成硬依赖**。

**坑**

1. --no-config 绝不能省（见上，这是命令执行面）。
2. 没有 -- 分隔，path 传 -foo 会变成 flag。
3. --json 输出是 NDJSON，必须逐行 JSON.parse；对不上的行要**失败**而不是跳过
   （DSH 就是这么定的：raw rg --json 是内部传输格式，格式变了说明底层变了，静默跳过会让搜索悄悄少结果）。

---

## 三、明确不值得搬的

| 包 | 一句话理由 |
|---|---|
| dsh-bash-sandbox | 它只是 confine() → ctx.sandbox.confine(['bash','-c',cmd], policy, signal) 的转接层 + 按 stderr 方言（matchesSignature）判定「这次失败是不是被沙箱拒了」。**真正的沙箱在 dsh-sandbox（OS 级），零依赖的 Node 应用在 Windows 上做不到。** 唯一值得借的是一句判断：把「拒绝」变成结构化的 sandbox.denied 标志，而不是让模型去猜 stderr。 |
| dsh-util-values | 大半是 Cordis / 工具参数边界的东西（PartialArguments 的流式 JSON 扫描、snapshotJsonValue 的原型校验）。agent-soul 的 LLM 客户端是「收完再 JSON.parse」，没有流式参数可扫。**只有 deepFreeze（4 行）值得抄**，用来冻结 config。 |
| dsh-util-crypto | randomUUID() 是为「浏览器非安全上下文没有 crypto.randomUUID」写的 polyfill；agent-soul 跑 Node 22，原生就有。bytesToBase64 用 btoa，Node 里有 Buffer。 |
| dsh-util-time | 整个包只有一个导出 canonicalClientTimeZone(value)，用来校验前端报上来的 IANA 时区。agent-soul 没有「客户端报时区」这条边界。 |
| dsh-util-workspace-path | 全是 dsh-resource://file/session/<id>/<path> 这个 URI 语法的编解码（sessionFileAddress / parseFileAddress / fileMediaUrl）。agent-soul 没有资源 URI 层，Web UI 直接吃文件路径。 |
| dsh-chunked-list | 20 行的「不可变分块追加列表」（每块 64 个值，结构共享）。它的价值在「可被 zod 校验的持久化 checkpoint」，agent-soul 用数组 push 已经够，也没有 checkpoint 需求。 |

---

## 四、搬了能立刻改善 agent-soul 什么（可观测的）

> 每条都写「现在是什么样 / 搬完是什么样 / 怎么验」。
> **没有实测数字的地方我不编**：涉及误差倍率的标明「按代码常量推算」，不是跑出来的。

### 4.1 工具不会再无限期挂住（P0）

- **现在**：registry.execute() 就是 await def.handler(args ?? {}, ctx)，**没有任何 deadline**。
  handler 里任何一个 await 不返回（HTTP 不响应、MCP 对端卡死、new Promise 永不 settle），
  整个回合永远停在那一句；MAX_STEPS 救不了 —— 它根本没走到下一步。
- **搬完**：def.timeoutMs（默认 30 s，上限 10 min），超时返回
  ok:false、error:{ code:'TOOL_TIMEOUT', message:'tool call timed out after 30000ms' }。
- **验收**：注册一个 handler 返回永不 settle 的 Promise，跑一次 execute()。
  搬之前进程挂住；搬之后 ≤ 31 s 拿到 TOOL_TIMEOUT，且**后续回合能继续**。

### 4.2 shell 不再留孤儿进程（P0/P1）

- **现在**：execFile('cmd.exe', ['/c', cmd], { timeout })。超时后 Node 杀的是 cmd.exe 本身。
- **搬完**：超时 → SIGTERM → 3 s 宽限 → 强杀，**并且杀进程树**。
- **验收**：run_shell({ command: 'ping -n 60 127.0.0.1', timeoutMs: 1000 })，等 5 秒后
  用 tasklist 查 PING.EXE 必须为空。（现在会看到它还活着。）
- ⚠️ 这条**只搬得动一半**：进程树终止在 dsh-subprocess 里，**那个包我没读**，
  所以给的是验收方法而不是「照抄这里」。

### 4.3 路径越界真的挡住（P0，安全）

- **现在**：inside() 是纯词法判断，junction 可绕。
- **搬完**：realpath.native 求身份 + contains(targetKey, targetKey)。
- **验收**：先 mklink /J 一个指向 C:\Windows 的工作区内目录，然后 read_file 里面那个 win.ini。
  现在：读到内容。搬完：报「路径越界」。
  再加一条：list_dir('.') 里出现那个链接目录时，stat 走的是 junction 目标而不是链接本身 —— 也一并验。

### 4.4 水位从「估算」变成「锚定」，这是最大的一笔（P1，但成本最低）

- **现在**：estimateTokens() 对全量上下文重新估一次，usedTokens() 每次遍历所有帧。
  误差 = 估算器误差 × 全部上下文。中文按 1 字 1 token 已偏保守（真实约 0.6–0.9），
  于是**系统性高估约 10%–60%**，且随内容构成漂移。
- **关键空档**：src/llm/client.mjs **完全没有读 usage** ——
  SSE 解析只取 choices[0].delta，请求体里也没有 stream_options: { include_usage: true }。
  也就是说：真实用量每一轮都在服务商那里生成，然后**被我们自己丢掉**。
- **搬完（两步，第一步不涉及 DSH 代码）**：
  1. 请求体加 stream_options: { include_usage: true }，SSE 循环里接住 json.usage
     （OpenAI 兼容的最后一帧会带 prompt_tokens / completion_tokens，有的还带
     prompt_tokens_details.cached_tokens），落一帧到会话里。
  2. 用 DSH 的式子算水位：水位 = 上次真实 prompt_tokens + (当前 surface − 采样时 surface)。
- **为什么这就够**：误差不再乘在「整个上下文」上，只乘在「自上次采样以来新增的那一小段」上。
  **算一笔（假设推演，不是实测）**：600 K 上下文、每轮新增 5 K、估算器比例偏 4 倍
  → 旧做法误差 ≈ 600 K × 3 = 1.8 M（荒谬到没法用）；
  新做法误差 ≈ 5 K × 3 = 15 K ≈ **2.5%**。
  **所以「±40% 降到 ±5%」这个说法要改**：不是估得更准了，是**要乘的基数从 600 K 变成了 5 K**。
- **验收**：连续 20 轮，每轮记 projected（自己算的）与 prompt_tokens（服务商给的），做相对误差分布 ——
  第一个数字就应该判死或判活，不用解释。

### 4.5 压缩之后水位真的下降，而且不会「越压越大」（P1）

- **现在**：compactRange() 只 append 一条 meta.kind = 'compaction.summary' 的 event 帧，
  没有任何「摘要必须小于原文」的判据。压完是否更小，靠运气。
- **搬完**：framedSummaryTokenCount >= shadowedRouteTokenCount 直接抛；
  压完重测，仍高于阈值就再压一轮（上限 2 轮）。
- **验收**：对一个造出来的 5 万 token 会话执行压缩，断言
  after < before − (被压区 token − 摘要 token)；再造一个「空摘要」场景（模型只返回两个字），
  必须**报错**而不是写入。

### 4.6 read_file 不再被大文件打死（P1）

- **现在**：fs.readFileSync(abs,'utf8') 全量进内存，再拆行翻一倍。
- **搬完**：流式扫，内存恒定（单行 2000 字符封顶 + 输出 50 KB 封顶），同时给出**精确总行数**。
- **验收**：读本机那个 **364 MB** 的 data/sessions/session-1099f531-.../frames.jsonl，
  取 offset=1、limit=50。现在：进程 RSS 涨 ≥ 700 MB（读 + 拆行）；搬完：涨幅 < 10 MB。
  （文件大小是列目录得到的实测值；内存涨幅是按代码行为推的。）

### 4.7 模型有了 edit，不会再「整文件重写」（P1）

- **现在**：只有 write_file（整文件覆盖）+ read_file。想改一行，模型要么重写全文
  （一次幻觉就废掉整个文件），要么放弃。
- **搬完**：edit 唯一匹配 + FS_AMBIGUOUS_EDIT + FS_NOT_OBSERVED + CRLF 归一化。
- **验收**：三个用例 —— ①old_string 出现两次 → 必须报歧义并给出次数；②没读过就 edit → 必须报「先读」；
  ③对一个 CRLF 文件改一行 → git diff 只能有 1 行变更（现在这类改动常常整文件都变）。

### 4.8 摘要带上「这段讲的是什么」，而不是只有 seq 号（P1）

- **现在**：pointerText() 已经会渲染话题（这是 agent-soul 的长处，比 DSH 强），
  但**没有引擎**去调它 —— 压缩是手工的。
- **搬完**：引擎自动选区 → 调 pointerText() 生成门牌 → 门牌 + 摘要一起成为替换帧。
- **验收**：压完之后，只看门牌那一行，能回答「刚才丢的是什么、什么时候的、有没有真的做过事」
  （topicsOf 里的 toolCalls 计数已经在做这件事：0 次工具调用就明写「都是讨论，未执行」）。

---

## 五、建议的搬迁顺序

| 批次 | 内容 | 为什么是这一批 | 预计改动 |
|---|---|---|---|
| **1** | dsh-timeout + dsh-tool-call-timeout-policy | 唯一一处「没有边」；零依赖；后面的 read / 压缩 / shell 都需要 signal | 新增 src/util/deadline.mjs，改 registry.execute() |
| **2** | dsh-atomic-write + dsh-fs-local 的路径身份 | 都是「写坏了不会立刻发现」那一类：一个管字节，一个管边界 | 新增 src/util/atomic.mjs、src/tools/paths.mjs |
| **3** | stream_options.include_usage + dsh-token-meter 的锚定式子 | 不依赖前两批，但收益最大；第 1 步改 client 只有几行 | 改 client.mjs，新增 src/session/meter.mjs |
| **4** | dsh-compaction-basic 的引擎 + dsh-tool-fs 的读窗口与 edit | 前一批给了水位，压缩才有触发依据 | 扩写 organs/compaction.mjs，新增 read-window.mjs / edit.mjs |
| 可选 | dsh-tool-fs-search 的语义（VCS 排除 / 轮转抽样 / 预览上限） | 只在决定「自己走目录」之后才有意义 | src/tools/search.mjs |

**如果只能现在做一件：第 1 批。**

理由只有一句：**registry.execute() 今天没有任何超时路径，工具不返回 = 整个 agent 不返回，
而这在代码里是一眼就能看见的空缺。** 其余各条都是「做得更好」，只有这一条是「现在会死」。

---

## 六、这份清单的边界（没读到 / 不下结论的地方）

1. **dsh-subprocess（5.3 KB）没读** —— 所以「进程树终止怎么做」只能给验收方法，不能给实现。
2. **dsh-sandbox（15 KB）没读** —— 所以「OS 级沙箱在 Windows 上具体用什么」（WFP？AppContainer？job object？）
   我不下结论；本文对它的判断只基于 dsh-bash-sandbox 里的**调用契约**
   （confine(argv, policy, signal) + denialSignatures + 三种失败分类）。
3. **dsh-token-meter 的 index.js 后 25% 没读完** —— 读到 priceSurface（route pricing，按图片计价）就停了；
   那部分与 agent-soul 无关（它不传图）。
4. **dsh-fs-local 读了约 40%** —— 路径解析、contains、写盘暂存、行尾归一化、FS_NOT_OBSERVED 都读过；
   **Windows 安全描述符（win32.js，koffi 调 Win32 API）完全没读**，agent-soul 也不需要。
5. **dsh-util-values 只读了导出面与关键函数** —— PartialArguments 的状态机内部没有逐行读；
   结论「不值得搬」基于它的用途（流式工具参数），而 agent-soul 没有流式参数。
6. **没做的实测**：没有跑过 DSH 的任何代码，也没有用真实分词器量过 chars/4 的误差。
   文中「约 4 倍」是按「分子是 .length、分母是 4、中文≈1 字 1 token」推的量级，
   写进实现之前应当用一次真实 API 的 usage.prompt_tokens 标定。
