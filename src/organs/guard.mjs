// 宪章审核 —— 分身/外部通道发来的执行请求，先过这一道
//
// ★★ 为什么需要它（爀曦 2026-11-07 定）：
//   「事件层，你的分身通过 lead-waker 发送的执行请求，也可以通过它来做审核，
//     判断是否遵循宪章，通过了再通过 lead-waker 转交给你」
//
//   现在的链路是：分身 → lead-waker → 主导会话。中间**没有一道检查**。
//   而 v4 站在那儿，是最自然的位置 —— 它有 LLM、有宪章原文、且不参与干活。
//
// ★★ 审核什么（爀曦明确：「主要是审查安全性，避免越权」）：
//   只看**四条硬线 + 越权**，别的一概不管。
//   「审得越宽，误拦越多」—— 误拦的代价是不对称的（见下）。
//
// ★★ 分两层（爀曦 2026-11-07 定：「模糊的请求，才需要拉起 v4 harness 判断」）：
//   ① 规则层：四条硬线大部分能用正则判（凭据/交易/隐私），**不调 LLM**
//   ② 模糊层：规则说不清的（「这个请求是不是在替我作决定」「算不算越权」），才调
//
// ★★ 三档结论，不是两档：
//   pass  —— 通过
//   block —— 拦下（硬线。理由 + 原文一起送到主导会话，**人可以推翻**）
//   ask   —— 说不清，转给人判断（**这个档的存在就是为了不硬判**）
//
//   ★ 判据：**该过的拦了 = 分身的活白干、而且我看不到它本来想说什么（最坏）；
//           该拦的放了 = 等于现在这样，只多一道延迟。**
//   所以「说不清」必须落到 ask，不能落到 block。

/** 硬线类别 */
export const LINES = ['credential', 'transaction', 'privacy', 'external-instruction', 'overreach'];

// ── 模糊层（LLM）的执行参数 —— **每一项都有硬上限** ─────────────────
//
// ★★ 2026-11-10：以前模糊层是「给了 llm 才走，没给就 pass」——
//   结果是 **LLM 不在时静默 pass**：一条「你看着办」的请求，规则层没命中，
//   于是「审核通过」，而其实**根本没有审**。这不是降级，是把安全网拆了还挂着牌子。
//   现在三条规矩：
//     ① 没 LLM / LLM 抛错 / 超时 / 回一个解析不出来的词 → **一律 ask**，并标清 via 与原因；
//     ② 只有明确回 PASS 才 pass，只有明确回 ASK 才 ask；
//     ③ 每次真实调用都留下 model / protocol / latencyMs 作证据（没有就 null，不许编）。

/** 默认超时。★ 必须短于 lead-waker 的 HTTP 超时（8000ms，index.js:313）——
 *  否则它先 destroy，看到的会是「审核超时（v4 可能没起）」= unchecked，
 *  那就**丢掉了「LLM 超时」这条证据**。 */
export const LLM_TIMEOUT_DEFAULT_MS = 5000;
/** 超时上限：留 1 秒给网络与序列化，绝不越过 lead-waker 的 8 秒。 */
export const LLM_TIMEOUT_MAX_MS = 7000;
export const LLM_TIMEOUT_MIN_MS = 500;
/** 送进模糊层的文本上限（审核只看「这条请求要干什么」，2000 字够了）。 */
export const GUARD_TEXT_MAX_CHARS = 2000;
/** 调用方再怎么要，也不许超过这个数 —— 上限不是可协商项。 */
export const GUARD_TEXT_HARD_CAP = 8000;

// ★ 脱敏：错误文本的来路不可控（供应商回体 / 网关回体 / fetch 自己抛），
//   而它会进 HTTP 响应、进日志、进台账。**这里面一个字都不该是凭据。**
//
// ★★ 2026-11-10 补一层（独立验收 F1）：旧规则全是「名字 + 等号/冒号 + 裸值」的文本形状，
//   遇到上游 JSON 错误体 {"key":"plainsecret42"} 时**明文原样带出**（JSON 是引号包键 + 冒号，
//   值被引号护着，黑名单一条都不命中）。现在分两层：
//     ① REDACT_RULES      —— 文本形状（Bearer / sk- / key=value / URL 的 user:pass@）
//                            用于**请求原文回声**（maskSecrets）与一般错误文本
//     ② JSON_FIELD_RULES  —— 结构化字段（key / api-key / apiKey / token / secret /
//                            password / authorization 及连字符·下划线·驼峰变体，
//                            兼容嵌套与字符串化 JSON）
//                            只作用于**错误 / 证据出口**（redactText / redactEvidence）
//   ★ 为什么分两层而不是把新规则塞进旧的：旧的是「正文回声」用的，
//     一条请求里合法出现的 {"key":"…"} 不该被改成别的东西 —— 换字会让人看不懂原文。
const REDACT_RULES = [
  [/bearer\s+[A-Za-z0-9._\-]{6,}/gi, 'Bearer ***'],
  [ /\b(?:sk|rk|pk)-[A-Za-z0-9._\-]{6,}/g, 'key-***'],
  // ★ 2026-11-10 第二轮（P1/P2 返修）加的厂商前缀：旧规则只认 sk-/rk-/pk-，
  //   GitHub / GitLab / Slack / AWS 的长期凭据一个都不命中（实测 ghp_… / xoxb-… 原样通过）。
  [/\b(?:gh[pousr]|glpat)_[A-Za-z0-9_\-]{16,}/g, 'key-***'],
  [/\bxox[abprs]-[A-Za-z0-9\-]{10,}/g, 'key-***'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'key-***'],
  [/\b(api[_-]?key|token|secret|password|passwd|cookie|authorization)\s*[=:]\s*[^\s,;'"}]+/gi, '$1=***'],
  // ★ 2026-11-10 第二轮（P1/P2 返修）：**赋值形态**（env 导出 / 命令行 / 配置回显）。
  //   旧规则只认固定几个字面量，于是最常见的泄漏写法一条都不中：
  //     AWS_SECRET_ACCESS_KEY=… / SECRET_KEY=… / API_TOKEN=… / 裸 key=…
  //   ★ 名字判定复用 isSensitiveKey —— 敏感键的定义只留一处，两条路不会漂移。
  //   ★ 只认「=」，不认「:」：{note: key: value} 这种散文（验收明写要一字不改）里
  //     冒号后面的东西不是凭据值；冒号形态继续由上面那条老规则按白名单管。
  //   ★ 尾部锚定（名字必须以凭据词结尾）：keyboard= / keyword= / tokenizer= 不会中。
  [/(^|[^A-Za-z0-9_.\-])([A-Za-z0-9_][A-Za-z0-9_.\-]{0,60}?)=(\s*)([^\s,;'"}\]]+)/g,
    (m, pre, name, sp) => (isSensitiveKey(name) ? pre + name + '=' + sp + '***' : m)],
  // ★ 2026-11-10 第六轮：供应商错误体把凭据写进**普通字段的正文**，键名不是敏感词：
  //   {"error":{"message":"Incorrect API key provided: sk-…"}} —— 结构走查只看键名，看不见它；
  //   老规则又要求「名字 + 紧跟 =/:」，中间夹一个 provided 就失配（自测实测泄漏）。
  //   这里允许名字与分隔符之间最多 24 字（有界），只换值，不动名字。
  [/\b((?:api[\s_-]?key|token|secret|password)[^\n:=]{0,24}[:=]\s*)([^\s"',;}\]]{6,})/gi, '$1***'],
  [/https?:\/\/[^/\s@]+@/g, 'http://***@'],
];

// ── 结构化 JSON 字段 ────────────────────────────────────────────
/** 凭据类键名（归一化后精确匹配）。 */
const SENSITIVE_KEYS = new Set([
  'key', 'apikey', 'token', 'secret', 'password', 'passwd', 'pwd', 'authorization',
  'auth', 'cookie', 'credential', 'credentials', 'passphrase', 'privatekey', 'accesskey',
  // ★ 2026-11-10 第二轮（P1/P2 返修）：补四个「同一个硬线、旧集合漏掉」的键名。
  //   · pass / passcode —— 口令的常见短写法（旧集合只有 password/passwd/pwd）
  //   · sessionid        —— ★ guard 自己的规则层把「session id」算凭据（见 RULES.credential 的
  //                         obj 正则），脱敏这边却不认 —— 同一份凭据两种口径，就是一个洞
  //   · jwt / bearer     —— 令牌的两种通用叫法
  'pass', 'passcode', 'sessionid', 'jwt', 'bearer',
]);
/** 键名归一化：去连字符 / 下划线 / 点，转小写。api-key / api_key / xApiKey → xapikey。 */
function isSensitiveKey(name) {
  const n = String(name == null ? '' : name).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!n) return false;
  // ★ 假朋友：monkey / keyword / tokenizer …… 它们不是凭据，改了就是无关替换
  if (/^(monkey|turkey|donkey|keyboard|keyword|keywords|tokenizer|secretary)$/.test(n)) return false;
  if (SENSITIVE_KEYS.has(n)) return true;
  // 复合键：openaiKey / access_token / client-secret / x-api-key / sessionToken
  return /(apikey|key|token|secret|password|passwd|authorization|cookie|credential|passphrase)$/.test(n);
}

/** 字符串化 JSON 的递归深度上限（防「JSON 里套 JSON 里套 JSON」把栈吃穿）。 */
const JSON_WALK_MAX_DEPTH = 8;
/** 一段文本里最多**精细解析**多少个括号候选（防病态输入把 O(n²) 拖出来）。
 *  ★★ 2026-11-10 第四轮（独立验收硬门槛：64 候选边界）：上限只用来**停止精细扫描**。
 *    旧写法到顶之后把原样字符拼回去 —— 于是「配不上 + 敏感键」的尾巴只要排在配额之外
 *    就整段明文出去（n=64 起可复现）。现在到顶之后**不跳过**，而是对「剩下的一切」
 *    做一次 O(n) 的保守判定：判出风险 → 整尾占位（fail-closed）；判不出风险 → 原样透出。
 *    ★ 判据是「tailRisk」，不是「还剩多少配额」。 */
const JSON_SCAN_MAX_CANDIDATES = 400;
/** 括号配不上的候选，最多精细判定多少次。
 *  ★ 每一次这样的判定都是 O(尾长)（配不上 = 一路扫到末尾），所以必须有上限：
 *    给 64 个足够覆盖真实截断 JSON（第一个 { 就在前几个候选里），
 *    又不至于把 {"a": 重复 105KB 这类病态输入变成 O(n²) 的放大器。
 *  ★★ 它只决定「从哪一步起改用一次性整尾判定」，**不决定放不放行**。 */
const JSON_TAIL_MAX_CANDIDATES = 64;
/** 转义层数预算：1～3 层照旧解码；第 4 层及以上**仍然像序列化 JSON** 时不许原样返回。
 *  ★★ 2026-11-10 第五轮（主导决定：收紧不确定输入策略）：旧实现把 3 层当成「解到这里就够了，
 *    解不出来的原样返回」—— 独立复验两次测到 4/5/6 层起明文直接出门。层数预算是**预算**，
 *    不是「到此为止仍然安全」的证明：超预算的形态我们没能力安全解码，只能 fail-closed。
 *  ★ 只影响「还在转义语境里、还解得动 JSON」的段 —— 普通文本与 1～3 层既有行为不变。 */
const ESCAPE_MAX_LAYERS = 3;
/** 只用来**数**层数（判断有没有超预算）时的硬顶：防病态输入把解码做成放大器。 */
const ESCAPE_LAYER_HARD_CAP = 12;
/** 超预算时占位块最多编回几层（再高就是指数级膨胀，而占位块本身不含任何原文）。 */
const ESCAPE_REENCODE_MAX_LAYERS = 8;

/** 脱敏层的「不确定输入」登记簿。
 *  ★★ 2026-11-10 第五轮（主导决定 D）：脱敏以前只回字符串，调用方只能从输出**猜**
 *    「这一段有没有被吃掉」——猜不出来的结果就是「先占位、再照常调 LLM」。
 *    现在结论变成可检查的元数据：**凡写过占位块 / 命中任何预算 / 解码不了 / 深度截断**，
 *    都必须在这里登记一个 code。check() 读到非空就 ask + fallback，llmCalls=0。
 *  ★ 不变式（写代码时守这一条）：**占位块出现 ⇒ 一定伴随登记**；
 *    没有登记 = 这一条输入被完整处理过，或者本来就没有结构化风险。
 *  ★ 登记只增不减、按 code 去重 —— 一次输入里多条路径同时不确定，也要全部留证据。 */
function newRedactState() {
  const codes = [];
  return {
    codes,
    add(code) { if (code && codes.indexOf(code) < 0) codes.push(code); },
    get uncertain() { return codes.length > 0; },
  };
}

// ── 严格输入分类（2026-11-10 第六轮 · 主导决定）─────────────────────────
//
// ★★ 为什么换成分类：前五轮的每一处漏都长同一个样子 —— **判据只对某一种位置成立**。
//   提示词只认键名（sessionId/jwt 不在里面）、tailRisk 锚在串首（加一个「日志：」前缀就失配）、
//   深层转义指纹要求 ≥4 个反斜杠（stringify 两次正好是 3 个）。于是
//   「同一段内容 + 一个散文前缀 / 少一层反斜杠」就能整段原样出门。
//   继续补探测器 = 继续猜位置。这一轮改判据的形状：**先分类，每类只有一个出口**。
//
// ★★★ 契约（优先于此前所有「保留混排散文」的断言）：
//   plain     —— 输入里没有任何 JSON-like 结构（没有 { [，或只有 {rate limited} 这种
//                没有引号键结构的普通花括号）→ 现有文本规则 + 语义判定，逐字节不变
//   json      —— **整个输入**可完整解析（JSON，或 ≤3 层的 JSON 字符串），且深度在能力内
//                → 现有递归脱敏 + LLM（合法完整 JSON 脱敏后照常调模型）
//   uncertain —— 其余**一切**：散文/日志前后缀 + 任何 JSON-like 结构（裸/转义/嵌套/
//                字符串化）、解析失败、超 3 层、超深度、超预算
//                → 安全占位 + ask/fallback + llmCalls=0
//
// ★ 判据只看**结构**，不看键名：不依赖 SENSITIVE_HINT，也不依赖敏感键是否已被识别。
//   所以 sessionId / jwt / 未知键在混排里走的是同一条路，双层转义只有 3 个反斜杠也覆盖。
// ★ 可读性收缩是**有意的**：混排内容不再保留「帮我把 / 这段记一下」等前后散文。
//   这是把「猜位置」换成「分类」的代价，属于收敛，不是回退（见主文档 §十五）。
// ★★ 2026-11-10 第七轮（主导拍板：硬线优先于分类闸门）：
//   分类只能决定「能不能解锁 pass / 能不能送模型」，**不能决定 hardline 算不算数**。
//   第六轮把 uncertain 直接判 ask，等于让「把请求藏进混排」把 block 洗成 ask ——
//   方向反了：**本地规则层（纯正则、零外部调用）先看 raw，命中就 block/rule**，
//   然后才轮到分类闸门给出口。占位与「不回显原文」一条不松（见主文档 §十六）。
// ★★ 2026-11-10 第八轮（整合 ① / ② / ③）：
//   ① 纯数字方括号（[1] / [12] / [1,2]）是引用标记，不再算 JSON-like → plain；
//      含字符串/对象/嵌套/转义的真数组仍 uncertain（判据见 isNumericCitationArray）。
//   ② 来源判定认 group:<号> / private:<号>；外部来源的 role=lead 不授予执行权；
//      空/未知来源一律按 organ（role 是自报，不是认证 —— 保守边界见 §十七）。
//   ③ 面板入口 checkPanel() 与 HTTP/MCP 共用 check()：同一输入不再 E1=ask / E3=pass。
// ★★★ 2026-11-10 第九轮（入口/出口安全修正；⑧② 的保守边界被进一步收紧）：
//   ① **公开参数不再产生任何 lead 授权**：lead = coreTrusted && role=lead && !external，
//      coreTrusted 是模块私有 Symbol 能力，check() 恒 false，只有 checkCore()（core 内部）能开。
//      from=lead+role=lead 这种自报组合从这一轮起**按 organ**（第八轮它还 pass —— 那是漏洞）。
//   ② 危险动作表补「执行脚本 / 跑命令 / 运行代码」。
//   ③ 面板/通知出口收口到 deliverPanelNotice()：**block 不投递**，ask/pass 只投脱敏本。
//   详细判据与代价见主文档 §十八。
export const MIXED_CODE = 'mixed-structured';
/** 混排输入的安全占位。★ 本身必须是 plain（不含引号键结构），否则会被自己再判一次。 */
export const MIXED_PLACEHOLDER = '[结构化混排输入已按严格契约省略]';
/** JSON 字符串最多穿几层（"…" 包着 JSON，再包着 JSON …）。超层 = 超预算 = uncertain。 */
const JSON_STRING_MAX_LAYERS = 3;
/** 整段 JSON 允许的最大字符数（防病态输入把整段解析拖成放大器；不是为了拒绝正常大对象）。 */
const JSON_STRUCT_MAX_CHARS = 1 << 20;
/** 结构指纹的**有界**窗口：判据只看开括号之后这么多字符，不随文本长度变。 */
const JSON_NEAR_WINDOW = 240;

/** 对象/数组的最大嵌套深度（迭代，不递归 —— 2000 层输入不许把栈压穿）。 */
function jsonDepthOf(v, cap) {
  let max = 0;
  const stack = [[v, 1]];
  while (stack.length) {
    const [x, d] = stack.pop();
    if (d > max) { max = d; if (max > cap) return max; }
    if (Array.isArray(x)) {
      for (const y of x) if (y && typeof y === 'object') stack.push([y, d + 1]);
    } else if (x && typeof x === 'object') {
      for (const k of Object.keys(x)) {
        const y = x[k];
        if (y && typeof y === 'object') stack.push([y, d + 1]);
      }
    }
  }
  return max;
}

/** 「整个输入是不是一段可完整解析的 JSON / JSON 字符串」。
 *  · 不是 → null（交给结构扫描；**绝不当成 plain**，那正是旧洞的形状）
 *  · 是   → { kind:'json' }（可走递归脱敏 + LLM）或 { kind:'plain' }（解出来只是个标量/普通句子）
 *  · 是但超层 / 超深 / 超预算 → { kind:'uncertain' } */
function wholeJsonVerdict(t) {
  if (!/^["[{]/.test(t)) return null;
  let cur = t;
  let layers = 0;
  for (;;) {
    let parsed;
    // ★ 解析失败**不是**「没有结构」：2000 层嵌套会在这里抛 RangeError，
    //   截断的 JSON 也会抛。两种情况都由结构扫描兜底 → uncertain。
    try { parsed = JSON.parse(cur); } catch { return null; }
    if (parsed === null || (typeof parsed !== 'object' && typeof parsed !== 'string')) {
      // "42" / "true" / ""一句普通的话"" —— 完整 JSON，但不是结构，落地成普通文本
      return { kind: 'plain', code: null };
    }
    if (typeof parsed === 'string') {
      layers++;
      const inner = parsed.trim();
      // 里面不是结构 → 这就是一个普通带引号的字符串
      if (!/^["[{]/.test(inner)) return { kind: 'plain', code: null };
      // ★ 层数预算：≤3 层字符串（与 ESCAPE_MAX_LAYERS 同一口径）；第 4 层还要再解 → 不许猜
      if (layers > JSON_STRING_MAX_LAYERS) return { kind: 'uncertain', code: MIXED_CODE };
      cur = inner;
      continue;
    }
    // 对象 / 数组：深度与体积预算
    try {
      if (cur.length > JSON_STRUCT_MAX_CHARS) return { kind: 'uncertain', code: MIXED_CODE };
      if (jsonDepthOf(parsed, JSON_WALK_MAX_DEPTH) > JSON_WALK_MAX_DEPTH) {
        return { kind: 'uncertain', code: MIXED_CODE };
      }
    } catch { return { kind: 'uncertain', code: MIXED_CODE }; }
    return { kind: 'json', code: null };
  }
}

/** 开括号之后**紧接着**是不是「引号键 + 冒号」这种 JSON 结构指纹。
 *  ★ 三条形状，都是结构（不看键名）：
 *    ① 裸：{"key":       ② 转义（任意层反斜杠）：{"key": / {\"key\":
 *    ③ 键名引号损坏：{key": （独立验收 T8/T9 的真实形状）
 *  ★ 只看 240 字窗口 —— 判据有界，不做全文猜测。 */
function bracketIsJsonish(t, i) {
  const win = t.slice(i, i + JSON_NEAR_WINDOW);
  if (/^[[{][ \t\r\n]*"[^"\\\n]{0,80}"[ \t\r\n]*:/.test(win)) return true;
  if (/^[[{][ \t\r\n]*(?:\\+")[^"\n]{0,80}(?:\\+")[ \t\r\n]*:/.test(win)) return true;
  if (/^[[{][ \t\r\n]*[A-Za-z0-9_.\-]{1,40}"[ \t\r\n]*:/.test(win)) return true;
  return false;
}

/** ★★ 2026-11-10 第八轮（整合 ①）：纯数字方括号 ≠ JSON 结构。
 *
 *  真实形态：`参考 [1] 与 [2]`、`[1]`、`[12]` —— 它们是引用标记，被 JSON.parse 成 [1] / [12]
 *  这种「数组对象」，于是旧分类器把整段判成 uncertain（S35）。代价是每一份带引用编号的上报
 *  都进 ask 队列。
 *
 *  判据（三重，缺一不可）：
 *    ① 形状：`[ 整数 (, 整数)* ]` —— 只有十进制数字、逗号、空白；
 *    ② 解析：JSON.parse 出来必须是数组；
 *    ③ 元素：**全部是有限数字，深度 1**。
 *
 *  为什么这一条不会变成新的放行口：
 *    uncertain 的存在理由是「结构里可能有我们没看清的字符串/对象值」。
 *    纯数字数组里没有字符串、没有对象、没有嵌套 —— 结构脱敏对它无事可做，
 *    也就没有「看不清的值」可以漏。含字符串/对象/嵌套/转义的一律不是纯数字：
 *    `["a"]` / `[{"a":1}]` / `[[1]]` / `[1,"a"]` 仍然返回 true（照旧 uncertain）。
 *  ★ 只作用于**嵌在散文里的**候选；整个输入就是 [1,2,3] 时仍走 wholeJsonVerdict 的 json 出口
 *    （S10 的契约不变）。 */
function isNumericCitationArray(seg) {
  const t = String(seg);
  if (t.charAt(0) !== '[' || t.charAt(t.length - 1) !== ']') return false;
  // 先做形状判定（有界：最多 64 个元素），避免拿超大候选去 parse
  if (!/^\[\s*-?\d{1,9}(?:\s*,\s*-?\d{1,9}){0,63}\s*\]$/.test(t)) return false;
  let v;
  try { v = JSON.parse(t); } catch { return false; }
  return Array.isArray(v) && v.length > 0
    && v.every((x) => typeof x === 'number' && Number.isFinite(x));
}

/** 文本里有没有 JSON-like 结构（对象/数组，裸的或转义/字符串化的）。
 *  ★ 位置无关：每个开括号都判一次，**不锚定串首** —— 加「日志：」「上游 401：」前缀不影响结论。
 *  ★ 候选数有上限（400）：数不完本身就是「结构太多，没能力逐个确认」→ 保守判有结构。
 *  ★ 纯数字数组（引用标记）不算结构，见 isNumericCitationArray 的判据与理由。 */
function containsJsonLike(t) {
  if (t.indexOf('{') < 0 && t.indexOf('[') < 0) return false;
  let cands = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c !== '{' && c !== '[') continue;
    if (++cands > JSON_SCAN_MAX_CANDIDATES) return true;
    const end = scanBalancedJson(t, i);
    if (end > i) {
      const span = t.slice(i, end + 1);
      try {
        const v = JSON.parse(span);
        if (v && typeof v === 'object') {
          // ★ 纯数字数组是引用标记（[1] / [12] / [1,2]），不是要脱敏的结构。
          if (!isNumericCitationArray(span)) return true;
        }
      } catch { /* 配得上但解析不了 → 落到结构指纹 */ }
    }
    const eend = scanBalancedEscaped(t, i);
    if (eend > i) {
      const cands2 = decodeEscapedCandidates(t.slice(i, eend + 1), 1, {});
      for (const cd of cands2) {
        try {
          const v2 = JSON.parse(cd.text);
          if (v2 && typeof v2 === 'object') {
            // ★ 与裸形态同一条判据：纯数字数组是引用标记，不是结构（见 isNumericCitationArray）。
            //   scanBalancedEscaped 对正常方括号也会给出段末，所以这一支必须同样放行，
            //   否则 [1] 会从这里再被数成一次结构。
            if (!isNumericCitationArray(cd.text)) return true;
          }
        } catch { /* 这一层解不成 JSON，继续看指纹 */ }
      }
    }
    if (bracketIsJsonish(t, i)) return true;
  }
  return false;
}

/** ★ 唯一入口：三个出口，没有第四个（不存在「判不清 → 原样透出」这条路）。
 *  @returns {{kind:'plain'|'json'|'uncertain', code:string|null}} */
export function classifyInput(input) {
  const t = String(input == null ? '' : input).trim();
  if (!t) return { kind: 'plain', code: null };
  const whole = wholeJsonVerdict(t);
  if (whole) return whole;
  if (!containsJsonLike(t)) return { kind: 'plain', code: null };
  // 有结构、又不是「整个输入可完整解析」→ 混排 / 解析失败 / 超预算，一律不确定
  return { kind: 'uncertain', code: MIXED_CODE };
}

/** 值本身就是一段 JSON 文本时，解开再走一遍；没有变化就原样返回（不重排版）。
 *  ★ 2026-11-10 第二轮（P1）：解析不了**不再等于放过**。
 *    形如 "{\"key\":{...},\"m\":\"a<换行>b\"}" 的内层字符串因为裸换行不是合法 JSON，
 *    旧写法在这里静默返回原值 → 明文跟着出去。现在：明确是序列化 JSON 且含敏感键 → fail-closed。
 *  ★ 但「像 JSON 的散文」一个字都不许动 —— 判据是 looksStructuredJson（首 token 必须是带引号的键）。 */
function redactStringifiedJson(s, depth, rstate) {
  const head = s.trim();
  if (!head || !/^[[{]/.test(head)) return s;
  const r = redactJsonBlock(head, depth, rstate);
  // ★ 第五轮：深度预算命中 = 深层没走完 → 半成品也不许用（深处可能有没看见的值）
  if (r.ok && r.deep) {
    if (rstate) rstate.add('depth-budget');
    const fc = failClosedBlock(head, false);
    return fc == null ? s : fc;
  }
  if (r.ok) return r.out == null ? s : r.out;
  if (looksStructuredJson(head, false) && hasSensitiveKeyNear(head, false)) {
    if (rstate) rstate.add('json-unparsable');
    const fc = failClosedBlock(head, false);
    return fc == null ? s : fc;
  }
  return s;
}

/** 已解析 JSON 的深度走查：敏感键的值（含对象/数组）整体换成占位，**键名留着**。
 *  ★ 2026-11-10 补（独立验收 N1）：值的**类型不限** —— 对象/数组整块换掉。
 *    旧写法只在「值恰好是标量」时成立：{"key":{"inner":"plainsecret42"}} 的内层字段名
 *    不像凭据，正则那条路看不见它，于是明文原样出去。
 *  ★ 值本身是字符串化 JSON 时再走一遍（"{\"key\":\"…\"}" 这种两层引号）。 */
function redactJsonWalk(v, depth = 0, state) {
  // ★ 2026-11-10 第二轮（P1）：深度被截断时记一笔 —— 转义形态没有正则兜底，
  //   调用方必须知道「这一段没走完」，否则它会以为「没变化 = 没有秘密」。
  if (depth > JSON_WALK_MAX_DEPTH) { if (state) state.deep = true; return v; }
  if (Array.isArray(v)) return v.map((x) => redactJsonWalk(x, depth + 1, state));
  if (v && typeof v === 'object') {
    const o = {};
    // ★ 2026-11-10 第二轮（P1/P2 返修）：**字段名是数据**的那种形态。
    //   供应商/校验器的错误体常写成 {"field":"api-key","value":"<真秘密>"} ——
    //   秘密挂在 value 上（键名不敏感），敏感的名字躺在 field 的**值**里。
    //   结构走查按「键名」判断，于是这一整类原样通过（第五轮探针实测有此形状）。
    //   ★ 只在**同一对象里同时**出现「小写的名字位」与「值位」时才动手，且名字位的值
    //     必须真的过 isSensitiveKey —— 不是猜，是按已有的凭据定义认。
    const holder = Object.keys(v).find((k) => /^(field|name|param|property|argument|key)$/i.test(k)
      && typeof v[k] === 'string' && isSensitiveKey(v[k]));
    //   ★ 2026-11-10 第三轮：值位补 content / data —— 供应商/校验器的同一形状还有
    //     {"field":"token","content":…} / {"name":"api-key","data":…} 两种写法。
    const valueSlot = holder ? Object.keys(v).find((k) => /^(value|val|v|sample|example|content|data)$/i.test(k)) : null;
    for (const k of Object.keys(v)) {
      if (k === valueSlot) { o[k] = '***'; continue; }
      o[k] = isSensitiveKey(k) ? '***' : redactJsonWalk(v[k], depth + 1, state);
    }
    return o;
  }
  if (typeof v === 'string') {
    // ★★ 2026-11-10 第六轮（自测抓到的真泄漏）：合法的整段 JSON 走的是
    //   「按键名脱敏」—— 供应商回体把秘密写在**普通字段的正文里**
    //   （{"error":{"message":"Incorrect API key provided: sk-…"}}）时，
    //   键名不是敏感词，结构走查一个字都不改，秘密原样跟着出去。
    //   文本规则本来就是为「散文里的凭据」写的 —— 让它作用在**字符串叶子**上，
    //   既不改变结构、也不碰键名，只换掉像凭据的那一段。
    let sv = v;
    for (const [re, rep] of REDACT_RULES) sv = sv.replace(re, rep);
    return redactStringifiedJson(sv, depth, state && state.rstate);
  }
  return v;
}

/** 解析一段 JSON 文本；不是对象/数组 → null。 */
function parseJsonBlock(raw) {
  try {
    const p = JSON.parse(raw);
    return p && typeof p === 'object' ? p : null;
  } catch { return null; }
}

/** 一段 JSON 文本 → 结构脱敏结果。
 *  · ok=false  —— **解析不了**（调用方据此决定 fail-closed）
 *  · out=null  —— 解析得了、但没有要脱的（这一区分是 P1 的关键：
 *                 旧代码把两者都收成 null，于是「解析不了」被当成「没事」放过去了）
 *  · deep=true —— 深度被截断，深层没走完 */
function redactJsonBlock(raw, depth = 0, rstate) {
  const parsed = parseJsonBlock(raw);
  if (!parsed) return { ok: false, out: null, deep: false };
  const state = rstate ? { rstate } : {};
  // ★★ 2026-11-10 第五轮：2000 层这类输入连 JSON.parse / JSON.stringify 自己都会爆栈。
  //   爆在这里不算「解析失败」，算「这一段我们没能走完」—— 登记 + 交给调用方 fail-closed，
  //   绝不让异常穿到 check() 之外（穿出去就只剩一个 500，或者更糟：谁也没接住）。
  try {
    const before = JSON.stringify(parsed);
    const after = JSON.stringify(redactJsonWalk(parsed, depth + 1, state));
    return { ok: true, out: after === before ? null : after, deep: Boolean(state.deep) };
  } catch {
    if (rstate) rstate.add('walk-overflow');
    return { ok: true, out: null, deep: true };
  }
}

/** 解析一小段 JSON 文本并按结构脱敏；解析不了 / 没有变化 → null（保持原文本形态，不重排）。 */
function redactJsonText(raw) {
  const r = redactJsonBlock(raw);
  return r.ok ? r.out : null;
}

/** 整段就是 JSON 时按结构脱敏；没有变化就返回 null。 */
function redactWholeJson(t, rstate) {
  const s = String(t == null ? '' : t).trim();
  if (!/^[[{]/.test(s)) return null;
  const r = redactJsonBlock(s, 0, rstate);
  // ★ 第五轮：深度截断 → 占位 + 登记（不许拿半成品当「已经脱干净」）
  if (r.ok && r.deep) {
    if (rstate) rstate.add('depth-budget');
    const fc = failClosedBlock(s, false);
    return fc == null ? s : fc;
  }
  return r.ok ? r.out : null;
}

/** 从 from 处的开括号起找配对的右括号（尊重字符串与反斜杠转义）；配不上 → -1。 */
function scanBalancedJson(s, from) {
  let depth = 0;
  let inStr = false;
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') { depth--; if (depth <= 0) return depth === 0 ? i : -1; }
  }
  return -1;
}

/** 转义形态的配对扫描：\" 是字符串边界（切换 inStr），其它转义（\\ / \n / \uXXXX）整对跳过。
 *  ★ 2026-11-10 第二轮（P1）修：旧版只认 \" ，遇到 \\" 会把转义的反斜杠误当引号 ——
 *    段边界一错，后面全都白做。现在按 JSON 字符串语义走：\ + " 是边界，\ + 其它是转义序列。
 *  ★ 只在正常扫描失败后才用 —— 正常 JSON 上它只会给出更短的段。 */
function scanBalancedEscaped(s, from) {
  let depth = 0;
  let inStr = false;
  for (let i = from; i < s.length; i++) {
    if (s[i] === '\\') {
      const n = s[i + 1];
      if (n == null) return -1;
      if (n === '"') { inStr = !inStr; i++; continue; }
      i++; continue;                                   // \n \\ \uXXXX …：整对跳过
    }
    if (inStr) continue;
    const c = s[i];
    if (c === '"') { inStr = true; continue; }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') { depth--; if (depth <= 0) return depth === 0 ? i : -1; }
  }
  return -1;
}

/** 日志里的「转义段」→ 明文。
 *  ★ 唯一可靠的解码器是 JSON 字符串语义本身：\" → "、\n → 换行、\uXXXX → 字符、\\ → 反斜杠。
 *    手写替换表在 \u 与 \\ 上一定错位 —— 那正是旧实现「除 \" 外有其它转义就放弃」的由来。
 *  ★ 解不了（含裸控制字符等）→ null，调用方据此 fail-closed。 */
function decodeEscapedText(s) {
  try {
    const v = JSON.parse('"' + s + '"');
    return typeof v === 'string' ? v : null;
  } catch { return null; }
}

/** 明文 → 转义段（与 decodeEscapedText 严格互逆；解不出 → null）。 */
function encodeEscapedText(s) {
  try { return JSON.stringify(String(s)).slice(1, -1); } catch { return null; }
}

/** 廉价的起点预筛：对象只可能以 双引号 / 右花括号 / 反斜杠 / 左方括号 / 空白 开头；
 *  数组只可能以 双引号 / 右方括号 / 花括号 / 方括号 / 数字 / 减号 / 空白 开头。
 *  ★ 挡掉 {{{{{{{{ 这类病态输入（那本来也不是 JSON），省掉 O(n^2) 的空扫。 */
function looksLikeJsonStart(s, i) {
  const n = s[i + 1];
  if (n == null) return false;
  if (s[i] === '{') {
    // ★ 2026-11-10 第三轮（独立验收 T8/T9）：旧预筛只放行 " } \\ [ 与空白，
    //   于是 **键名引号损坏** 的两种真实形状（{key": … / {<控制字符>key": …）连扫都不扫。
    //   现在只把 {{ 挡在外面（病态输入），其余都交给后面的结构判据 ——
    //   判据仍然要「引号 + 冒号 + 敏感键名」三条同时成立才会动手，散文不受影响。
    if (n === '{') return false;
    return true;
  }
  if (n === '"' || n === '}') return true;
  return n === ']' || n === '{' || n === '[' || n === '-' || /[0-9]/.test(n) || /\s/.test(n);
}

/** 散文前缀/后缀里夹着的 JSON 对象或数组：括号配对的一段能解析就按结构脱敏，原位替换。
 *  ★ 2026-11-10 新增（独立验收 N1/N2）：旧实现只有「整段 = JSON」才走结构脱敏，
 *    带 'LLM HTTP 500: ' 前缀就掉回正则，而正则看不见 { } 值的内部。
 *  ★ 解析不了就**原样跳过** —— 一行人读日志里的 { 不等于坏数据，把非 JSON 当错误是大忌。
 *  ★ 只在**有变化**时才替换，没变化的片段一个字都不动（保住「普通文本不改一字」）。 */
/** 敏感键名的廉价预筛：所有敏感键名（含复合键）都至少含下面某个片段。
 *  ★ 一个都不含就一定没有可脱的东西 —— 直接整段跳过，省掉无谓的 parse。 */
const SENSITIVE_HINT = /key|token|secret|pass|auth|cookie|credential|pwd/i;

/** 「宽松」地把转义层剥掉 —— 只用于**看**，不用于产出。
 *  ★ 双重编码（日志把整段再 stringify 一次）会得到 \\\" 这种三层反斜杠，
 *    判据要能穿透它（见 decodeEscapedTextDeep）。 */
function looseUnescape(s, rounds = 3) {
  let t = String(s);
  for (let k = 0; k < rounds; k++) {
    if (t.indexOf('\\') < 0) break;
    const n = t.split('\\\\').join('\\').split('\\"').join('"');
    if (n === t) break;
    t = n;
  }
  return t;
}

/** 段内有没有「敏感键 + 冒号」。转义形态先按层剥掉再找。
 *  ★ 只用来决定 fail-closed 要不要触发 —— 宁可多脱，绝不明文放过。 */
function hasSensitiveKeyNear(t, escaped) {
  const s = escaped ? looseUnescape(t, 3) : t;
  const re = /(["']?)([A-Za-z0-9_][A-Za-z0-9_.\-]{0,39})\1\s*:/g;
  let m;
  while ((m = re.exec(s))) { if (isSensitiveKey(m[2])) return true; }
  return false;
}

/** 这一段「明确是序列化 JSON」吗 —— 首 token 必须是**带引号的键**。
 *  ★ fail-closed 只在这种段上触发：散文里的 {rate limited} / {note: key: value}
 *    首 token 不是引号键 → 一个字都不动（验收要求：普通文本与非 JSON 花括号一字不改）。 */
function looksStructuredJson(seg, escaped) {
  const s = escaped ? looseUnescape(seg, 3) : seg;
  return /^\s*\{\s*"(?:[^"\\]|\\.)*"\s*:/.test(s)
    || /^\s*\[\s*\{\s*"(?:[^"\\]|\\.)*"\s*:/.test(s);
}

/** 「像结构化 JSON」的宽判据 —— 在 looksStructuredJson 之外，再认**键名引号损坏**的已知形状：
 *  {"key: "…"}（缺右引号）/ {key": "…"}（缺左引号）/ {<控制字符>key":"…"}。
 *  ★ 2026-11-10 第三轮（独立验收 T7/T8/T9、M3/M5）：这三种在真实日志里出现过，
 *    旧的「首 token 必须是带引号键」判据一个都不认，于是明文原样通过。
 *  ★ 仍要求同时出现**引号**与**冒号** —— 散文里的 {rate limited}（无冒号）、
 *    {note: key: value}（无引号）照旧一个字都不动。 */
function looksJsonishSegment(seg) {
  const s = String(seg).trimStart();
  if (!/^[[{]/.test(s)) return false;
  const head = s.slice(0, 200);
  if (!/["']/.test(head)) return false;
  return /["']?\s*:\s*["']?/.test(head);
}

/** 宽松的敏感键探测：键名两侧的引号可以缺失 / 错位（T7/T8/T9 的形状）。
 *  ★ 只给 fail-closed 用；判定「该不该脱」仍然是 isSensitiveKey 那一份定义。 */
function hasSensitiveKeyLoose(seg) {
  const s = looseUnescape(seg, 3);
  const re = /["']?([A-Za-z0-9_][A-Za-z0-9_.\-]{0,39})["']?\s*:/g;
  let m;
  // ★ 2026-11-10 第四轮：去掉「只看前 400 个匹配」的上限。
  //   那是另一条「配额耗尽 = 放过」：第 401 个匹配起即便有敏感键也返回 false，
  //   于是尾部被判成「没有可脱的东西」→ 原样出去。re.exec 遍历本身是 O(n)，删掉不增复杂度。
  while ((m = re.exec(s))) { if (isSensitiveKey(m[1])) return true; }
  return false;
}

/** 「明确像结构化 JSON，且带敏感键」 —— fail-closed 的唯一触发条件。
 *  ★ 两个判据都要：只有结构没敏感键 = 没东西可脱；只有敏感键没结构 = 散文。 */
function jsonLikeWithSensitive(seg, escaped) {
  const s = escaped ? looseUnescape(seg, 3) : seg;
  const structured = looksStructuredJson(seg, escaped) || looksJsonishSegment(s);
  return structured && (hasSensitiveKeyNear(seg, escaped) || hasSensitiveKeyLoose(seg));
}

/** 被截断的尾巴是什么形状：裸 JSON，还是被日志引号包住的转义 JSON。
 *  ★ 从候选起点一直看到文本末尾 —— 括号配不上时，「剩下的一切」在词法上都还在这一段里。 */
function truncatedJsonShape(seg) {
  const lead = /^\s*"/.exec(seg);
  const wrapped = Boolean(lead);
  const body = wrapped ? seg.slice(lead[0].length) : seg;
  if (!/^\s*[[{]/.test(body)) return null;
  const plain = wrapped ? looseUnescape(body, 3) : body;
  if (looksStructuredJson(body, wrapped) || looksJsonishSegment(plain)) return { escaped: wrapped, lead: lead ? lead[0] : '' };
  return null;
}

/** 段内有没有「敏感键 + 冒号 + 开括号」—— 正是正则层看不见的那一类（值不是标量）。
 *  ★★ 2026-11-10 第四轮（独立验收 64 候选硬门槛）新增。
 *    为什么不能只靠 looksJsonishSegment：它的判据只看**前 200 字**有没有引号+冒号。
 *    键名前面只要垫了 200 字以上的填充（截断段的常见形态），它就返回 false，
 *    于是「结构化 + 敏感键」两条判据全部失守。这里**全段一次线性扫描**，没有头部窗口。
 *  ★ 只用来决定「要不要保守占位」，不参与「该不该脱」的定义（那份仍是 isSensitiveKey）。 */
function hasSensitiveBracketValue(seg) {
  const s = looseUnescape(seg, 3);
  const re = /["']?([A-Za-z0-9_][A-Za-z0-9_.\-]{0,39})["']?\s*:\s*[[{]/g;
  let m;
  while ((m = re.exec(s))) { if (isSensitiveKey(m[1])) return true; }
  return false;
}

/** 「剩下的这一整段里，还有没有正则层看不见的结构化敏感数据」—— 单一保守判据。
 *  ★★ 2026-11-10 第四轮：所有**预算耗尽**的分支都必须经过这里，而不是「原样拼回去」。
 *    · 像结构化 JSON 且有敏感键   → 有风险（原 ③ 的判据）
 *    · 敏感键 + 冒号 + 开括号     → 有风险（头部窗口之外的那一类，见 hasSensitiveBracketValue）
 *  ★ 两个都不成立 = 这一段没有任何「结构化的敏感值」可脱 → 原样透出是安全的；
 *    文本形状（key: value）仍由后面的正则层兜底，不受影响。
 *  ★ 一次 O(n)，绝不逐候选调用 —— 这就是「上限只停精细扫描、不停安全判断」的落点。 */
function tailRisk(seg) {
  if (hasSensitiveKeyLoose(seg)
    && (looksStructuredJson(seg, false) || looksJsonishSegment(seg))) return true;
  if (hasSensitiveBracketValue(seg)) return true;
  return hasVendorShapeSecret(seg);
}

/** 供应商 / 校验器错误体的**未闭合**形态：「名字位的值是敏感名 + 值位紧跟其后」。
 *  ★★ 2026-11-10 第四轮：`{"field":"api-key","value":"<真秘密>"}` 这一形状的秘密挂在 value 上，
 *    键名（field / value）一个都不敏感 —— 结构走查认得它（redactJsonWalk 的 holder/valueSlot），
 *    但**解析不了就轮不到结构走查**，而文本正则也不认这两个键名，于是截断形态整段明文。
 *  ★ 判据**照着 redactJsonWalk 已有的那一份写**，不是新语义：同一个小写名字位集合、
 *    同一个 isSensitiveKey、同一个值位集合。只是把它用在「解析不了的尾巴」上。 */
function hasVendorShapeSecret(seg) {
  const s = looseUnescape(seg, 3);
  if (!/["'](value|val|v|sample|example|content|data)["']\s*:/.test(s)) return false;
  const re = /["'](field|name|param|property|argument|key)["']\s*:\s*["']([A-Za-z0-9_.\-]{1,40})["']/g;
  let m;
  while ((m = re.exec(s))) { if (isSensitiveKey(m[2])) return true; }
  return false;
}

/** 深层转义（≥ 3 层）的廉价指纹：**引号前有一串 ≥4 个反斜杠**。
 *  ★★ 2026-11-10 第五轮：为什么还需要这一条 ——
 *    tailRisk 的三条探测器（hasSensitiveKeyLoose / hasSensitiveBracketValue /
 *    hasVendorShapeSecret）都靠 looseUnescape(rounds=3)；层数一深它们**全部失明**。
 *    实测：4 层编码 + 无 hint 词 + 尾巴后跟正文（"…}} 你看着办"）时，
 *    hint 早退 → tailRisk 看不见 → 整段明文进了 HTTP 回包与 outbound wire。
 *  ★ 为什么不是「数反斜杠」：Windows 路径塞进两层 stringify 也会出现 4 个反斜杠，
 *    但那串后面跟的是字母，不是引号 —— 判据要求「反斜杠串 + 引号」。
 *  ★ 它只用来决定「要不要看 / 要不要兜底」，不是安全结论本身。 */
const DEEP_ESCAPE_HINT = /\\{4,}["']/;

/** 把转义层剥到底（最多 12 轮，只用于**看**），再看还有没有敏感键。
 *  ★ 专用在 DEEP_ESCAPE_HINT 命中的文本上：这一步贵，但不贵在普通正文上。 */
function deepEscapedSensitive(t) {
  let s = String(t);
  for (let k = 0; k < 12 && s.indexOf('\\') >= 0; k++) {
    const n = s.split('\\\\').join('\\').split('\\"').join('"');
    if (n === s) break;
    s = n;
  }
  const re = /["']?([A-Za-z0-9_][A-Za-z0-9_.\-]{0,39})["']?\s*:/g;
  let m;
  while ((m = re.exec(s))) { if (isSensitiveKey(m[1])) return true; }
  return hasSensitiveBracketValue(s);
}

/** 整尾 fail-closed：从候选起点到文本末尾，换成一个**同形、合法、可解析**的占位块。
 *  ★ 转义上下文（日志把整段包在引号里）里，占位块也要按转义形态写，
 *    否则占位块会以裸引号插进转义上下文，形状坏掉、下一步脱敏就看不见它。 */
function failCloseTail(seg) {
  const shape = truncatedJsonShape(seg);
  const body = shape && shape.escaped ? seg.slice(shape.lead.length) : seg;
  const escapedStyle = Boolean(shape && shape.escaped) || /\\"/.test(body);
  const block = body.trimStart().charAt(0) === '[' ? '["***"]' : '{"__redacted__":"***"}';
  let enc = block;
  if (escapedStyle) {
    const cand = (shape && shape.escaped ? decodeEscapedCandidates(body)[0] : null) || { mode: 'quotes', layers: 1 };
    const enc2 = encodeEscapedLike(block, cand);
    enc = enc2 == null ? block : enc2;
  }
  return (shape ? shape.lead : '') + enc;
}

/** 把一段「转义段」还原成**候选明文**，按层数排序。
 *  ★★ 两种来路在真实日志里都存在，必须都试 —— 这是本轮最容易做错的一点：
 *    ① json   —— 由 JSON.stringify 编出来的（真日志）：
 *                \" → "、\n → 换行、\\ → 反斜杠。解出来就是原始 JSON 文档。
 *                层数可能 > 1（双重编码）。
 *    ② quotes —— 粗糙的日志工具**只把引号**换了：
 *                \n 必须**原样留着**，否则解出来的 JSON 里是裸换行，整段就不再合法。
 *  判据永远是「解出来能不能当 JSON 解析」—— 不猜，两个都试，能解析的优先。 */
function decodeEscapedCandidates(eraw, maxLayers = ESCAPE_MAX_LAYERS, info) {
  const seen = [];
  // ① JSON 字符串语义，逐层
  //   ★ 第五轮：循环跑到**计数硬顶**（不再到 maxLayers 就停）—— 只有继续数，
  //     才知道「解到第 4 层还没到底」。超出 maxLayers 的候选**不进 seen**（不用于产出），
  //     只用来把 info.over 置真：调用方据此 fail-closed。
  let plain = eraw;
  let layers = 0;
  for (let k = 1; k <= ESCAPE_LAYER_HARD_CAP; k++) {
    const d = decodeEscapedText(plain);
    if (d == null) break;
    plain = d;
    layers = k;
    if (k <= maxLayers) seen.push({ text: plain, layers: k, mode: 'json' });
    if (parseJsonBlock(plain)) break;
    if (!/^\s*[[{]/.test(plain) || plain.indexOf('\\') < 0) break;
  }
  // ② 只还原引号，逐层
  let q = eraw;
  for (let k = 1; k <= maxLayers; k++) {
    const n = q.split('\\"').join('"');
    if (n === q) break;
    q = n;
    seen.push({ text: q, layers: k, mode: 'quotes' });
    if (parseJsonBlock(q)) break;
    if (!/^\s*[[{]/.test(q)) break;
  }
  if (info) { info.layers = layers; info.over = layers > maxLayers; }
  const parseable = seen.filter((c) => parseJsonBlock(c.text));
  const list = parseable.length ? parseable : seen;
  list.sort((a, b) => (a.layers - b.layers) || (a.mode === 'json' ? -1 : 1));
  return list;
}

/** 按候选的编码方式编回去；编不动 → null（调用方 fail-closed）。 */
function encodeEscapedLike(text, cand) {
  if (cand && cand.mode === 'quotes') {
    let t = String(text);
    for (let k = 0; k < cand.layers; k++) t = t.split('"').join('\\"');
    return t;
  }
  return encodeEscapedTextDeep(text, cand ? cand.layers : 1);
}

/** 按层数编回去；任何一层编不动 → null（调用方 fail-closed）。 */
function encodeEscapedTextDeep(s, rounds) {
  let t = s;
  for (let k = 0; k < rounds; k++) {
    const e = encodeEscapedText(t);
    if (e == null) return null;
    t = e;
  }
  return t;
}

/** 局部 fail-closed：把整段换成一个**同形、合法、可解析**的占位块。
 *  ★ 不换裸 "***" —— 在转义上下文里那会变成一个字段名，结构立刻就坏了。
 *  ★ 占位键名 __redacted__ 是给人看的：日志里一眼能认出「这里被吃掉了」。 */
function failClosedBlock(seg, cand) {
  const body = String(seg).trim().charAt(0) === '[' ? '["***"]' : '{"__redacted__":"***"}';
  if (!cand) return body;
  const enc = encodeEscapedLike(body, cand);
  return enc == null ? null : enc;
}

function redactEmbeddedJson(t, rstate) {
  if (t.indexOf('{') < 0 && t.indexOf('[') < 0) return t;
  // ★★ 2026-11-10 第五轮（独立复验 v7–v12）：hint 从「唯一闸门」降级为「快速通道」。
  //   旧写法 `if (!SENSITIVE_HINT.test(t)) return t;` 把「不含 key/token/…」当成
  //   「不用扫」的证明 —— 于是 {"sessionId":{"inner":… 与 {"jwt":… 明文出门
  //   （SENSITIVE_KEYS 第二轮就认这两个键，hint 不认，同一份凭据两种口径）。
  //   现在：miss 之后仍要过一次 O(n) 的保守结构判定（tailRisk）；
  //   判出风险 → 照常进扫描器，并置 rstate.hintMiss（扫完仍留风险 → 整尾占位 + ask）。
  //   判不出风险 → 才允许原样透出（普通正文一字不动）。
  //   ★ 注意这里**只决定「要不要扫」，不决定「安不安全」**：扫完之后还有一道
  //     redactCore 末尾的结构兜底（tailRisk 仍在 → 整尾占位 + 登记 structural-backstop）。
  if (!SENSITIVE_HINT.test(t)) {
    //   ★ 第五轮补：tailRisk 的探测器在 ≥3 层转义上会失明（它们都靠 looseUnescape(3)），
    //     所以这里再加一条**专门的**深层转义判据：指纹命中 + 剥到底还看得见敏感键 → 要扫。
    const deep = DEEP_ESCAPE_HINT.test(t) && deepEscapedSensitive(t);
    if (!tailRisk(t) && !deep) return t;
    if (rstate) rstate.hintMiss = true;
  }
  let out = '';
  let i = 0;
  let tried = 0;        // 精细解析过的候选数（只决定「还继续精细扫描吗」）
  let unresolved = 0;   // 括号配不上的候选数（每一次都是 O(尾长)，必须单独计）
  while (i < t.length) {
    const c = t[i];
    if (c !== '{' && c !== '[') { out += c; i++; continue; }
    if (!looksLikeJsonStart(t, i)) { out += c; i++; continue; }
    // ★★ 2026-11-10 第四轮（独立验收硬门槛「64 候选上限」）：
    //   预算是「停止精细扫描」，**不是停止安全判断**。旧写法把这两个混成一句
    //   `if (tried < 上限) { …精细… }`，到顶之后直接落到 `out += c; i++` ——
    //   于是「敏感键 + 未闭合对象」的尾巴只要排在配额之外就整段明文出去（n=64 起可复现）。
    //   现在到顶走这里：对「剩下的一切」做**一次** O(n) 保守判定，
    //   有风险 → 整尾占位（fail-closed）；判不出风险 → 原样透出（文本层正则照旧兜底）。
    //   ★ 两条上限各自计：精细解析 400（防深度嵌套 O(n²)）、配不上的全尾扫描 64（防逐候选 O(n)）。
    if (tried >= JSON_SCAN_MAX_CANDIDATES || unresolved >= JSON_TAIL_MAX_CANDIDATES) {
      const seg = t.slice(i);
      // ★ 第五轮：预算到顶本身就是「没走完」—— 无论这一段判不判得出风险，
      //   这条输入都不许再进 LLM（check() 读登记簿直接 ask）。
      if (rstate) rstate.add('scan-budget');
      out += tailRisk(seg) ? failCloseTail(seg) : seg;
      i = t.length;
      break;
    }
    {
      tried++;
      // ① 裸 JSON 段：能解析就按结构脱敏（值类型不限，N1/N2 都走这条）
      const end = scanBalancedJson(t, i);
      if (end > i) {
        const raw = t.slice(i, end + 1);
        const r = redactJsonBlock(raw, 0, rstate);
        // ★ 第五轮：深度截断 = 深处没看 → 半成品不许用，整块占位 + 登记
        if (r.ok && r.deep) {
          if (rstate) rstate.add('depth-budget');
          const fc = failClosedBlock(raw, null);
          if (fc != null) { out += fc; i = end + 1; continue; }
        }
        if (r.ok && r.out != null) { out += r.out; i = end + 1; continue; }
        if (!r.ok && jsonLikeWithSensitive(raw, false)) {
          if (rstate) rstate.add('json-unparsable');
          const fc = failClosedBlock(raw, null);
          if (fc != null) { out += fc; i = end + 1; continue; }
        }
      }
      // ② 转义形态（日志里整段被引号包住，引号都成了 \"）：只在这一段上解码 / 转回
      //    ★ 不做整篇解 / 整篇转回 —— 那会把正文里别的引号也一起转义（改坏原文）。
      //    ★ 2026-11-10 第二轮（P1）：解码器换成 JSON 字符串语义，往返换成 stringify；
      //      「解不了就放过」改成「明确是 JSON + 含敏感键 → 局部 fail-closed」。
      const eend = scanBalancedEscaped(t, i);
      if (eend > i) {
        const eraw = t.slice(i, eend + 1);
        const info = {};
        const cands = decodeEscapedCandidates(eraw, ESCAPE_MAX_LAYERS, info);
        // ★★ 第五轮（独立复验 §6.2：4/5/6 层实测泄漏）：编码层数超预算 → 不许原样返回。
        //   判据是「还解得动」—— 每一层都还能解成 JSON，说明还没到底；
        //   到预算之上我们**没有能力**确认剥干净了，只能按同形占位块交出去。
        if (info.over) {
          if (rstate) rstate.add('escape-layers');
          const fc = failClosedBlock(eraw, { mode: 'json', layers: Math.min(info.layers, ESCAPE_REENCODE_MAX_LAYERS) });
          if (fc != null) { out += fc; i = eend + 1; continue; }
        }
        const structured = jsonLikeWithSensitive(eraw, true);
        let replaced = false;
        // ★ 有一条候选**解析成功**就够了 —— 哪怕它没东西要脱（例如已经脱过一遍的 ***）。
        //   少了这个标记，幂等就会被 fail-closed 吃掉（第二次脱敏把整段变占位块）。
        let sawParsed = false;
        // ★ 2026-11-10 第四轮：深度预算（JSON_WALK_MAX_DEPTH）被截断也是「没走完」。
        //   旧写法只看「有没有候选解析成功」，解析成功但深度截断、且一个值都没换
        //   （out == null）时会被当成「没事」—— 那正是深度配额变成放行口子的形态。
        let sawDeep = false;
        for (const cand of cands) {
          const r2 = redactJsonBlock(cand.text);
          if (!r2.ok) continue;
          sawParsed = true;
          // ★ 第五轮：深度截断一律记下来 —— 不论有没有换出值，深层都没走完
          if (r2.deep) { sawDeep = true; if (rstate) rstate.add('depth-budget'); }
          if (r2.out != null && !r2.deep) {
            // ★ 按**同一个候选的编码方式**编回去 —— 往返必须对称，否则结构会坏
            const enc = encodeEscapedLike(r2.out, cand);
            if (enc != null) { out += enc; i = eend + 1; replaced = true; break; }
          }
        }
        if (replaced) continue;
        if (sawDeep || (structured && !sawParsed)) {
          // 一个候选都解析不了 / 深度被截断（转义形态没有正则兜底）→ 不许明文放过
          if (rstate) rstate.add(sawDeep ? 'depth-budget' : 'escape-undecodable');
          const fc = failClosedBlock(eraw, cands[0] || { mode: 'quotes', layers: 1 });
          if (fc != null) { out += fc; i = eend + 1; continue; }
        }
      }
      // ③ ★★ 2026-11-10 第三轮（独立验收硬门槛 P1：R1/R3、T4、M2/M3/M5、T7/T8/T9）：
      //   **括号配不上 = 这一段被截断了**（client.mjs:353 的 slice(0,500) 就会这样切）。
      //   前两个分支都没有 else —— 配不上就整段跳过，于是「结构是真的、只是没闭合」
      //   这一类明文原样出去。现在：明确像结构化 JSON + 含敏感键 → 从 i 到末尾局部 fail-closed。
      //   ★ 为什么截到末尾：括号没闭合时，词法上后面的一切都还在这段里；
      //     换不出边界就不要猜边界（猜错的代价是漏一段明文）。
      // ★★ 2026-11-10 第四轮（独立验收硬门槛「64 候选上限」）：
      //   **配额从这一条里拿掉了。** 旧写法是 `if (end < 0 && eend < 0 && tried <= 64)`，
      //   第 65 个候选起这里整段跳过 → 既不脱敏、也不 fail-closed、也不报错。
      //   现在每一次「两个扫描都配不上」都要过 tailRisk()；判据是「这段有没有结构化的敏感值」，
      //   不是「还剩多少配额」。O(n²) 由上面那个 unresolved 上限（64）挡住：
      //   连续 64 个配不上的候选之后，整尾交给一次性的 tailRisk 判定，然后跳出循环。
      // ★ 两个扫描都配不上才算「截断」。只要有一个给出了段末，就说明这一段是完整的 ——
      //   尤其 scanBalancedEscaped 对**正常 JSON** 永远返回 -1（它按转义语义走，
      //   进入字符串后只有 \" 能切边界）。用「或」会把每一段正常 JSON 都当成截断，
      //   整段 fail-closed 还把后面的正文吃掉（实测 H1c/M1c 就是这么坏的）。
      if (end < 0 && eend < 0) {
        const seg = t.slice(i);
        // ★ 2026-11-10 第四轮：判据要能看到**开这一段的那个键**。
        //   {"token":{"inner":"… 这种形状里，敏感键在前、开括号在后；
        //   只看 i 之后就会漏掉「键在这段之前」的写法（x token: {a":{"inner":"…"）。
        //   回看窗口定长 160 字 —— 有界，不随文本长度变；判据仍是同一个 isSensitiveKey。
        //   ★ 形状判据（tailRisk 的两条）必须**只看 seg**：它们是锚在段首 { 上的，
        //     把前缀拼进去会让 ^{ 失配（实测 T7/T8「键名引号损坏」会因此漏掉）。
        //     所以回看只补给「键在前、括号在后」那两条探测器。
        const pre = i > 0 ? t.slice(Math.max(0, i - 160), i) : '';
        const risk = tailRisk(seg)
          || Boolean(pre) && (hasSensitiveBracketValue(pre + seg) || hasVendorShapeSecret(pre + seg));
        if (risk) {
          // ★ 有风险 = 无法证明这一段安全 → 整尾保守占位（replace，不是跳过）。
          if (rstate) rstate.add('tail-risk');
          out += failCloseTail(seg);
          i = t.length;
          break;
        }
        // ★ 判不出风险（没有结构化的敏感值）→ 原样留给后面的正则层；
        //   但这一次已经把整条尾巴扫过一遍，计进 unresolved 预算。
        unresolved++;
      }
    }
    out += c; i++;
  }
  return out;
}

/** 嵌在散文里的 JSON / 字符串化 JSON —— 正则层，不要求整段可解析。 */
const JSON_FIELD_RULES = [
  // "key": "value" / 'key': 'value' / "key": 123
  [/(["'])([A-Za-z0-9_][A-Za-z0-9_.\-]{0,39})\1(\s*:\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;}\]\[{]+)/g,
    (m, q, k, sep) => (isSensitiveKey(k) ? q + k + q + sep + '"***"' : m)],
  // 裸键：{key: "value"} / key: value（前置分隔符原样保留）
  [/(^|[{,\[]\s*)([A-Za-z0-9_][A-Za-z0-9_.\-]{0,39})(\s*:\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;}\]\[{]+)/g,
    (m, pre, k, sep) => (isSensitiveKey(k) ? pre + k + sep + '"***"' : m)],
  // 字符串化 JSON：\"key\":\"value\"（被反斜杠转义的那一份）
  [/(\\")([A-Za-z0-9_][A-Za-z0-9_.\-]{0,39})\\"(\s*:\s*)\\"((?:[^"\\]|\\.)*?)\\"/g,
    (m, pre, k, sep) => (isSensitiveKey(k) ? pre + k + '\\"' + sep + '\\"***\\"' : m)],
];

/** 兜底：敏感键后面直接跟对象/数组、而整段 JSON 又解析不了时，把配对的那一整块换成占位。
 *  ★ 只认「敏感键 + 冒号 + 开括号」，且必须括号配对 —— 配不上就一个字都不动。
 *    N2 的形状正是「值正则吃掉前半段，剩下 ] 落单」，所以这里整块吃掉，绝不留半个括号。 */
function redactBracketValues(t) {
  if (t.indexOf('{') < 0 && t.indexOf('[') < 0) return t;
  const re = /(["']?)([A-Za-z0-9_][A-Za-z0-9_.\-]{0,39})\1(\s*:\s*)((?:[[{]))/g;
  let out = '';
  let last = 0;
  let hit = false;
  let m;
  while ((m = re.exec(t))) {
    if (!isSensitiveKey(m[2])) continue;
    const end = scanBalancedJson(t, m.index + m[0].length - 1);
    if (end < 0) continue;
    out += t.slice(last, m.index) + m[1] + m[2] + m[1] + m[3] + '"***"';
    last = end + 1;
    hit = true;
    re.lastIndex = end + 1;
  }
  return hit ? out + t.slice(last) : t;
}

/** 脱敏 + 截断（上限 200 字左右的小字段用它）。★ 出口那一层，JSON 结构规则在这里生效。
 *  ★ 2026-11-10 顺序（独立验收 N1/N2 修复）：
 *    ① 整段 JSON → 结构走查
 *    ② 散文里夹着的对象/数组 → 括号配对扫描 + 结构走查（解析不了就跳过）
 *    ③ ② 内部对转义形态（{\"key\":…}）就地在那一段上解开/转回，不动正文
 *    ④ 文本形状规则 → ⑤ 字段正则（值不含括号）→ ⑥ 敏感键的括号值兜底
 *    结构化只有前三条，后面的正则再也碰不到已经成型的 JSON。 */
function redactCore(t, rstate) {
  let s = String(t == null ? '' : t);
  // ★★ 2026-11-10 第六轮（严格混排契约）：分类闸门在**所有位置型判据之前** ——
  //   不是「先让 SENSITIVE_HINT 猜一次、猜不中再说」，而是先定它属于哪一类。
  //   每类只有一个出口：plain → 文本规则；json → 递归脱敏；uncertain → 占位。
  //   ★ 这也是 echo / why / evidence / 台账的统一漏斗：redactBody / redactText / finish()
  //     都走这里，所以「混排占位」在四个通道上自动一致。
  const cls = classifyInput(s);
  if (rstate) {
    rstate.klass = cls.kind;
    if (cls.code) rstate.add(cls.code);
  }
  if (cls.kind === 'uncertain') return MIXED_PLACEHOLDER;
  const asJson = redactWholeJson(s, rstate);
  if (asJson != null) s = asJson;
  s = redactEmbeddedJson(s, rstate);
  for (const [re, rep] of REDACT_RULES) s = s.replace(re, rep);
  for (const [re, rep] of JSON_FIELD_RULES) s = s.replace(re, rep);
  s = redactBracketValues(s);
  // ★★ 2026-11-10 第五轮（主导决定 B）：hint 不命中 ≠ 安全。
  //   扫完之后**再判一次**：这一段的尾里还有没有「正则层看不见的结构化敏感值」。
  //   还有 → 整段占位 + 登记；没有了 → 说明刚才那一次扫描把它接住了（不必 ask）。
  //   这就是「hint 只做快速通道」的落点：它省的是 parse，不是判据。
  //   ★ 判据是「正则层看不见的那一类」：敏感键后面跟着**对象/数组**，或供应商名字位形态。
  //     不能拿 tailRisk 整条来当兜底判据 —— 它的第一支（敏感键 + 像结构化 JSON）在
  //     **已经脱干净**的输出上也成立（{"sessionId":"***"} 就命中），那会把正确的脱敏结果
  //     再吞成占位块（第一版实测：闭合的 {"sessionId":…} 被整段吃掉）。
  if (rstate && rstate.hintMiss
    && ((hasSensitiveBracketValue(s) || hasVendorShapeSecret(s))
      || (DEEP_ESCAPE_HINT.test(s) && deepEscapedSensitive(s)))) {
    rstate.add('structural-backstop');
    s = failCloseTail(s);
  }
  return s;
}

/** 脱敏本身失败时的占位。
 *  ★ 2026-11-10 第三轮：极端输入（2000 层嵌套会爆栈）下 redactCore 会抛。
 *    抛出去的结果是「调用方 500 / 或干脆没响应」—— 那既不安全也不可读。
 *    吞掉异常、换成一个可认的占位，是 fail-closed：宁可这一字段没法看，不留原文。 */
export const REDACT_UNAVAILABLE = '[文本脱敏失败，已省略]';

/** 脱敏 + **不确定输入的结论**（唯一入口，check() 用它）。
 *  ★★ 2026-11-10 第五轮（主导决定 D）：不是从输出字符串猜「有没有被吃掉」——
 *    脱敏层自己登记，这里把登记簿原样交出去。
 *  · text      —— 可以对外 / 对模型的脱敏本（可能含占位块）
 *  · uncertain —— 非空 = 这条输入**没被完整安全处理**，check() 必须
 *                 ask + fallback + 明确 reason，且 llmCalls=0
 *  ★ 抛异常也登记（redact-threw）：「脱不干净」和「说不清」是同一件事的两面。
 *  ★ 出口仍要 redactBody：不调 LLM 不等于可以回显原文。 */
export function redactAnalyze(s) {
  const rstate = newRedactState();
  // ★★ 2026-11-10 第六轮：分类先于一切（含 SENSITIVE_HINT / tailRisk / 解析 / LLM）。
  //   · plain     → 文本规则 + 语义判定（逐字节不变）
  //   · json      → 递归脱敏（可以继续调 LLM）
  //   · uncertain → 安全占位；**整段原文一个字都不进返回值**
  //   「混排」不再是一种需要逐段猜边界的形态，而是一个**类**。
  const cls = classifyInput(s);
  rstate.klass = cls.kind;
  if (cls.code) rstate.add(cls.code);
  if (cls.kind === 'uncertain') {
    return {
      text: MIXED_PLACEHOLDER,
      uncertain: true,
      codes: rstate.codes.slice(),
      klass: cls.kind,
    };
  }
  let text;
  try {
    text = redactCore(s, rstate);
  } catch {
    rstate.add('redact-threw');
    text = REDACT_UNAVAILABLE;
  }
  return { text, uncertain: rstate.uncertain, codes: rstate.codes.slice(), klass: rstate.klass || cls.kind };
}

/** redactCore 的安全壳：失败 → 占位（绝不回落到原文）。 */
function safeRedactCore(s) {
  try { return redactCore(s); } catch { return REDACT_UNAVAILABLE; }
}

export function redactText(s, max = 200) {
  const t = safeRedactCore(s);
  return t.length > max ? t.slice(0, max) + '…' : t;
}

/**
 * 不截断的结构脱敏 —— **出口回声（请求原文）专用**。
 * ★ 2026-11-10 第二轮（P2）：请求里塞了一段 401 报错来问「这算不算凭据」，
 *   回声原样带回去 → 随响应进日志/台账 → 凭据跟着流出去。
 *   现在回声与 why / evidence.error **走同一份实现**（只差最后那一步截断）。
 * ★ 调用方如果真要原文，它自己手里有 —— 不该从这里取。
 */
export function redactBody(s) {
  return safeRedactCore(s);
}

/**
 * 证据块出口兜底：error 字段一定先脱敏。
 * ★ 它是最后一道 —— 不管上游怎么写、不管哪条分支拼出来的，出去之前都过一遍。
 */
export function redactEvidence(ev) {
  if (!ev || typeof ev !== 'object') return ev;
  const out = { ...ev };
  if (out.error != null) out.error = redactText(out.error, 200);
  return out;
}

/**
 * 统一出口：why / lines / evidence.error 全部先脱敏再返回。
 * ★ 存在的理由：分散在 7 个 return 里各写一遍，漏一个就是一条明文出口；
 *   收成一个漏斗，新加分支时不可能忘。
 */
function finish(res) {
  const out = { ...res };
  out.why = redactText(out.why, 400);
  out.lines = Array.isArray(out.lines) ? out.lines.map((x) => redactText(x, 40)) : [];
  out.evidence = redactEvidence(out.evidence);
  // ★ 2026-11-10 第二轮（P2）：原文回声也进这个漏斗。
  //   以前它只做文本形状脱敏（maskSecrets），JSON 里的凭据值会原样带出。
  // ★ 第三轮：走安全壳 —— 脱不干净时给占位，不给原文。
  if ('text' in out) out.text = safeRedactCore(out.text);
  return out;
}

/** 给请求原文脱敏（不截断）—— 回给调用方的是脱敏本，原值留在它自己那边。
 *  ★ 只用文本规则：正文里的 JSON 形状不做结构替换（见上面两层分工的理由）。 */
function maskSecrets(s) {
  const src = String(s == null ? '' : s);
  let t = src;
  for (const [re, rep] of REDACT_RULES) t = t.replace(re, rep);
  return { text: t, masked: t !== src };
}

function clampInt(v, dflt, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return dflt;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * 证据块 —— 每次审核都带，形状固定。
 * ★ null 的含义是「没测到 / 没走到」，**不是 0**：「0ms 延迟」和「没调用」是两件事。
 */
function evidenceOf(extra) {
  return Object.assign({
    layer: 'rule',        // meta | rule | llm | fallback
    kind: 'rule',         // meta | rule | not-needed | llm-pass | llm-ask | unconfigured | timeout | exception | unparsable
    code: null,           // 机器可读：OK / LLM_UNCONFIGURED / LLM_TIMEOUT / LLM_ERROR / LLM_UNPARSABLE
    llmConfigured: false,
    llmCalled: false,
    model: null,
    protocol: null,
    latencyMs: null,
    timeoutMs: null,
    textChars: 0,
    truncated: false,
    masked: false,
    error: null,          // 已脱敏，≤200
  }, extra || {});
}

/** 只在看得清的时候给结论：PASS / ASK 二选一，其余一律「解析不出来」。 */
export function parseJudgeReply(s) {
  const t = String(s == null ? '' : s).trim();
  const ask = /\bASK\b/i.test(t);
  const pass = /\bPASS\b/i.test(t);
  if (ask && !pass) return 'ask';
  if (pass && !ask) return 'pass';
  return null;   // 空 / 两个都有 / 一个都没有 —— 都算不可解析
}

/**
 * 超时闸。
 * ★ 只能中止「等」，不能中止底层 fetch —— LlmClient.chat() 不接受 signal。
 *   这是已知限制（写进报告）：超时后那次请求可能在后台跑完，结果被丢弃。
 *   要真正中止，得给 llm/client.mjs 的 fetch 加 AbortController ——
 *   那会动到对话主链路，超出这次的范围。
 */
function withTimeout(p, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error('LLM 调用超过 ' + ms + 'ms 未返回');
      e.code = 'LLM_TIMEOUT';
      reject(e);
    }, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  // ★ 超时之后它才失败的话，不该变成 unhandledRejection 把进程搞崩。
  if (p && typeof p.catch === 'function') p.catch(() => {});
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

// ── 规则层 ─────────────────────────────────────────────
//
// ★ 这些规则的形状是「**请求 × 对象**」，不是「出现关键词」。
//   判据：**他让我看一个 token / 他让我交出 token —— 前者允许，后者禁止。**
//   只匹配关键词会把「讨论这件事」也拦掉，那是误拦。

/**
 * 否定语境 —— 这一段是不是在**讨论/规定**规则，而不是**提出请求**。
 *
 * ★★ 这一条是安全门最重要的一条，比任何硬线规则都重要：
 *   「写一条规则：付款、转账、充值、下单、绑定支付一概不做」
 *   和「帮我在淘宝下单」在**出现的关键词上完全一样**，但前者是在**定义禁止**，
 *   后者是在**请求执行**。
 *
 *   ★ 如果连这都分不清，这道门就会把「讨论硬线」也拦掉 ——
 *     而「讨论硬线」恰恰是它最该放行的内容。
 *
 * 判据：句子里出现「不/禁止/不许/一概不做/硬线/规则写/记住」这类**否定或规定**语义，
 *       且**没有**明确的「帮我/给我/替我」索取词 → 视为讨论语境。
 */
function isMeta(t) {
  const declares = /(不|禁止|不许|一概不做|絶对禁止|绝对禁止|硬线|红线|规则[:：]|写一条|记住[:：]|不得|不能)/.test(t);
  if (!declares) return false;
  // 明确的索取词 → 不是讨论，是真的在要
  const demands = /(帮我|给我|替我|你去|你给我|现在|立刻|马上)/.test(t);
  return !demands;
}

/** 动作意图的词（要求、索取、代为执行） */
// ★ 「去」原来在列表里 —— 它太宽：「为什么登不上去」会被判成索取。
//   宁可漏一个，不要误拦一批。
const ASK = /(给我|发我|发给|告诉|提供|导出|打印|贴出来|复制|转发|执行|跑一下|帮我(做|找|查|读|拿|看|弄)|替我|打开|登录一下|提交|上传|下载)/;

/** ★★ 2026-11-10 第八轮（整合 ②）：来源判定 —— 先认通道，再谈角色。
 *
 *  真实 from 有两种写法，过去只认一种：
 *    · `qq:群661580035` / `wechat:…` / `web` —— 旧判据命中；
 *    · `group:661580035` / `private:123456` —— v3 事件层的真实写法，旧判据**一个都不含**
 *      → 「他人指令」对这批历史流量从未生效（S41 实测 pass）。
 *  现在两者同列：**通道是外部 = 外部来源**，与谁自报什么角色无关。
 *
 *  ★ role 不是身份：from/role 都是调用方自报的字符串，当前工具**无法证明**调用者是谁。
 *    第八轮把 lead 授权挂到「from 像内部标记」上 —— 那条已在第九轮**删除**（见下面 CORE_TRUST）：
 *    公开参数（from / role）现在**完全不产生授权**，空 from、未知 from、只有 role=lead 的自报、
 *    甚至 from=lead + role=lead 的组合，一律按 organ。
 *    ★ 这是保守边界，不是认证；主文档 §十八 记录「公开角色不可信」。 */
const EXTERNAL_FROM = /(?:^|[^a-z0-9])(?:qq|wechat|weixin|group|private|channel|internet|web|external)(?:[^a-z0-9]|$)|群|外部/i;
/** 内部上下文标记 —— ★★ 只用于**文案**，不再授予任何权限（第九轮）。 */
const INTERNAL_FROM = /^(?:lead|core|internal|session|self|v4-panel|panel)(?:$|[:#/])/i;

/** ★★★ 2026-11-10 第九轮（入口/出口安全修正 · 主导要求）：
 *
 *  「from=lead + role=lead 自报即可在公开入口获得授权」——第八轮留下的第二个不能接受的出口。
 *
 *  根因：第八轮把 lead 判成 claimsLead && internalMark && !external，而 internalMark 只要求
 *  from 字符串**像**内部标记。from / role 都是公开参数（HTTP body、MCP args），
 *  任何调用者写一行 "from":"lead","role":"lead" 就拿到了主导权限 —— 那是身份认证，
 *  不是来源判定。**自报不能成为授权**。
 *
 *  现在的判据：lead 只能由 core 内部显式上下文授予。
 *  实现上它是一个 Symbol 能力：check()（公开入口）恒传 false，只有 checkCore()
 *  （core 内部模块专用，HTTP/MCP 适配层禁止 import）传 true。
 *  ★ JSON 请求体带不了 Symbol 键，所以从 HTTP / MCP 的参数里**开启不了**它。
 *  ★ 这是「能力边界」，仍然不是「人证」：checkCore 的调用者自己要对得起这个标记。
 *  ★ 外部通道（group:/private:/qq:/…）是一票否决，即使带了 core 标记也无效。 */
const CORE_TRUST = Symbol('agent-soul.guard.coreTrust');

function sourceTrust(ctx, coreTrusted) {
  const from = String((ctx && ctx.from) || '');
  const role = String((ctx && ctx.role) || '').toLowerCase();
  const external = EXTERNAL_FROM.test(from);
  const internalMark = INTERNAL_FROM.test(from);
  const claimsLead = role === 'lead';
  const trusted = coreTrusted === true || (ctx && ctx[CORE_TRUST] === true);
  return {
    from,
    external,
    internalMark,
    claimsLead,
    coreTrusted: trusted,
    // ★ 三条件缺一不可：core 显式上下文 + 明确声明 lead + 不是外部通道。
    //   role/from 单独或组合出现，**永远**不产生授权。
    lead: trusted && claimsLead && !external,
    // 只有「自报 lead 但没被接受」才需要解释 —— 供 why 文案用。
    rejectedLead: claimsLead && !(trusted && !external),
  };
}

const RULES = [
  // ★ 所有规则共用的第一道：讨论语境直接放行
  //   （放在 check() 里统一早退，不分散到每条规则 —— 免得漏一条）

  {
    id: 'credential',
    name: '凭据',
    // ★ 关键：**要求交出**才算。提到不算。
    test(t) {
      const obj = /(api[\s_-]?key|token|密码|口令|私钥|密钥|cookie|session\s*id|二维码|验证码|账号密码|access[\s_-]?token|secret)/i.test(t);
      const ask = ASK.test(t);
      // 「读 / 看」也归入索取；但只在对象是凭据时
      // ★ 「读/查看」本身不算索取 —— 要看是谁读给谁。
      //   「读一下 .env 里的 key」= 索取；「为什么 token 过期」= 讨论。区别在有没有「读出来/给我看」。
      const read = /(读(一下|出来|给我)|查看(一下)?(的)?\s*(key|token|密码)|把.{0,6}(读|找|打印)(出来|给我))/.test(t);
      if (obj && (ask || read)) return { hit: true, why: '请求涉及凭据（' + (t.match(/(api[\s_-]?key|token|密码|口令|私钥|密钥|cookie|验证码|access[\s_-]?token|secret)/i)?.[0] || '?') + '）' };
      return { hit: false };
    },
  },
  {
    id: 'transaction',
    name: '交易',
    // ★ 交易是绝对禁止，任何形式的付款动作都拦
    test(t) {
      const m = t.match(/(付款|支付|转账|打款|转\s*\d+|充值|下单|购买|买入|卖出|打赏|扫码付|绑.{0,3}卡|开通(会员|付费)|续费|订阅付费)/);
      if (m) return { hit: true, why: '涉及交易动作（' + m[0] + '）' };
      return { hit: false };
    },
  },
  {
    id: 'privacy',
    name: '隐私',
    // ★ 隐私看的是「谁的信息」：他自己的可以，别人的不行
    test(t) {
      const obj = /(身份证|住址|家庭住址|银行卡|社保|护照号|手机号|工作单位|工作地点|户籍)/.test(t);
      if (!obj) return { hit: false };
      // 出现「别人的 / 查一下 / 找到」= 获取他人隐私
      const grab = /(查|找|获取|查一下|搜|人肉|扒|定位)/.test(t) || /(他|她|别人|对方|某人)的/.test(t);
      if (grab) return { hit: true, why: '请求涉及获取个人隐私信息' };
      // ★ 只是提到「身份证」在讨论里，不拦
      return { hit: false };
    },
  },
  {
    id: 'external-instruction',
    name: '他人指令',
    // ★ 只有「来源是外部通道」+「内容是动作请求」才算
    //   同一个请求来自爀曦本人 → 不适用这一条
    test(t, ctx) {
      // ★ 2026-11-10 第八轮：认 group:<号> / private:<号>（与 qq:/群/wechat 同等）。
      const trust = sourceTrust(ctx);
      if (!trust.external) return { hit: false };
      const act = /(帮我|替我|你去|你给我|执行|跑|打开|登录|下载|上传|提交|发送|发到)/.test(t);
      if (act) return { hit: true, why: '来自外部通道（' + trust.from + '）的动作请求' };
      return { hit: false };
    },
  },
  {
    id: 'overreach',
    name: '越权',
    // ★ 越权 = 请求的**权限等级**超过了它被授予的范围
    //   判据用「危险动作清单」：这些东西只有主导会话能做
    test(t, ctx) {
      // ★ 2026-11-07 修一个误报：「改成参数传入」被判成高危动作（改…参数）。
      //   根因是「改」这个动词太泛 —— 「改成/改为/换个说法」都是描述，不是修改行为。
      //   修法**只针对这一种形态**：动词后面紧跟「成/为/作」时，它是「变成」不是「修改」。
      //   ★ 没有放宽别的地方 —— 「改配置端口」「修改权限」「调整策略」照样中。
      //   ★ 判据：危险动作要能数出「被改的那个东西真的存在」，而不是「句子里出现了那两个词」。
      // ★★ 2026-11-10 第九轮（入口安全修正）：补一类**比安装更高一档**的能力 ——
      //   「执行脚本 / 跑命令 / 运行代码」。旧表里没有它，于是同一句
      //   「帮我执行这个脚本」在公开入口（自报 lead）恒为 pass：没有任何规则命中。
      //   执行任意代码 = 能把上面所有限制一次性绕开，它本来就该在危险动作表里。
      //   ★ 宾语必须紧跟动作词（这个/一下/这段 + 脚本/命令/代码），不认「执行验收」「跑测试」。
      const dangerous = /(删除|删掉|删了|删一下|把它删|给删|清掉|清空|干掉|覆盖写|格式化|安装|卸载|注册表|计划任务|提权|sudo)|(执行|跑|运行)(这个|一下|这段|那段)?(脚本|命令|代码)|(改|修改|调整|换)(?!成|为|作).{0,20}(config|配置|设置|策略|端口|参数|权限)/i;
      const m = t.match(dangerous);
      if (!m) return { hit: false };
      // ★ 主导会话（脑）自己做这些是允许的；器官做就不行。
      // ★★ 2026-11-10 第九轮：lead 授权**只**来自 core 内部显式上下文（Symbol 能力）。
      //   外部来源一票否决；公开参数里的 from=lead / role=lead 一律不授予。
      const trust = sourceTrust(ctx, ctx && ctx[CORE_TRUST]);
      if (trust.lead) return { hit: false };
      const whyTail = trust.external && trust.claimsLead
        ? '（外部来源自报 lead 不授予执行权）'
        : trust.rejectedLead
          ? '（role=lead 是自报，公开入口不授予执行权，按 organ 处理）'
          : '';
      return { hit: true, why: '请求包含高危动作（' + m[0] + '），且发起方不是主导会话' + whyTail };
    },
  },
];

/** 规则层：跑一遍，返回命中的规则 */
export function ruleCheck(text, ctx) {
  const t = String(text || '');
  const hits = [];
  for (const r of RULES) {
    try {
      const v = r.test(t, ctx || {});
      if (v && v.hit) hits.push({ id: r.id, name: r.name, why: v.why });
    } catch { /* 一条规则出错不许影响其他条 */ }
  }
  return hits;
}

/**
 * 审核一条执行请求。
 *
 * @param {object} req  { from, role, text, intent }
 * @param {object} opts { llm, llmConfigured, timeoutMs, maxChars }
 *        · llm            —— LlmClient 形状（有 chat 方法即可）。**同一个实例**，不另建。
 *        · llmConfigured  —— 显式告诉这里「模型到底配没配」。不传时按 llm.ready() / chat 推断。
 *                            ★ 它是 reason 字段的来源：「没配」和「调用失败」必须能分开。
 *        · timeoutMs      —— 超时（默认 5000，上限 7000，下限 500），由 clampInt 收口。
 *        · maxChars       —— 送进模糊层的文本上限（默认 2000，硬顶 8000）。
 * @returns {Promise<{verdict, via, lines, why, text, evidence}>}
 *        via ∈ meta | rule | llm | fallback
 *        evidence = { layer, kind, code, llmConfigured, llmCalled, model, protocol,
 *                     latencyMs, timeoutMs, textChars, truncated, masked, error }
 */
export async function check(req, opts) {
  // ★ 唯一出口：所有字段在交给调用方（HTTP / MCP）之前先过 finish() 的脱敏漏斗。
  // ★★ 2026-11-10 第九轮：**公开入口恒传 coreTrusted=false**。
  //   哪怕调用方在 req/opts 里塞 coreTrusted / __coreTrust / trusted:true，这里也不读 ——
  //   这不是「参数缺省」，是「这条路上根本没有那个能力」。
  return finish(await checkInner(req, opts, false));
}

/** ★★★ core 内部入口 —— 2026-11-10 第九轮新增。
 *
 *  **只许 core 自己的模块调用**（当前无调用者：面板走 checkPanel/organ，HTTP/MCP 走 check）。
 *  它是「真正内部 lead」唯一可能的开启方式，代价是它不能被公开参数触达：
 *    · HTTP /api/guard 与 MCP soul_guard 只 import check（见 mcp-tools.mjs / server.mjs）；
 *    · JSON 请求体带不了 Symbol 键，CORE_TRUST 也没有导出。
 *  换句话说：**公开请求 → 永远 organ**；要 lead 授权，必须有人在 core 代码里显式改调用点，
 *  那是可审计的一行，不是一条能自报的参数。
 *  ★ 仍然要求 req.role === 'lead'（core 明确声明「这条来自主导」），且外部通道一票否决。 */
export async function checkCore(req, opts) {
  return finish(await checkInner(req, opts, true));
}

/** 面板入口（E3）：与 HTTP / MCP 走**同一个** check()。
 *
 *  ★ 第八轮之前，面板是 index.mjs 直接调 ruleCheck —— 只跑规则层，
 *    结构上出不了 ask：同一段混排文本 E1(HTTP/MCP)=ask/fallback，E3(面板)=pass。
 *    现在面板也走 check()：硬线仍 block/rule、uncertain 走 ask/fallback、
 *    llmCalled 语义与 HTTP/MCP 一致。
 *  ★ from='v4-panel' 是「内部上下文标记」，不是身份认证（见 sourceTrust）。 */
export function checkPanel(text, opts) {
  return check({ text, from: 'v4-panel', role: 'organ' }, opts);
}

/** 面板通知出口（E3 的**出口**策略）—— 2026-11-10 第九轮。
 *
 * ★ 为什么长在 guard.mjs：它是「审核结论怎么出门」的唯一实现。第八轮之前这段写在
 *   index.mjs 的闭包里，于是**没法用假宿主证明「block 到底投没投」** —— 而这一轮要证的
 *   正是「投递次数 = 0」。抽出来之后，测试注入 fake hub / fake waker 走的就是
 *   **生产代码的同一条路径**，不是复刻一份逻辑。
 *
 * 契约（逐条对应主导要求 A）：
 *   · charter='block' → **不调 followup、不投递、不拼任何原文**；
 *     台账只留脱敏后的标题 + 脱敏理由（被拦的也要能查 —— 「没进台账 = 没发生过」）。
 *   · charter='ask' / 'pass' / 'unchecked' → 可以投，但投递体**只由 redactBody 处理过的
 *     字段拼成**；原始 title / facts 一个字都不直接进通知。
 *   · 普通（非秘密）标题保持可读 —— redactBody 对普通文本是恒等，这是「保留可读性」的落点。
 *   · 台账字段（key / title / charterNote）全部脱敏；facts 从不入账（台账本来没有这一列）。
 * ★ 这里不做审核判断（那是 checkPanel 的事），只决定「结论怎么出门」。
 *
 * ★★ 回执真相（2026-11-10 第十轮）—— **「RPC 成功」不许再冒充「投递成功」。**
 *
 *   第九轮把 block 的投递掐断了，但**成功那一头还是旧的**：只要 hub.exec 没抛，
 *   这里就回 { ok:true, sent:true, delivered:true }。而 hub.exec 的 resolve 只说明
 *   宿主回了一个 { type:'result', ok:true } 帧 —— 那是**传输层**，不等于它真把话
 *   塞进了某个会话（宿主回执里才有 delivered / target，见
 *   D:\AI\dsh-tools\dsh-agent-soul-bridge\index.js 的 doFollowup）。
 *   于是「宿主说没投成」「宿主只挑了个默认会话」都会被下游当成已通知。
 *
 *   现在的三条判据（全中才算投递成功，否则 ok/sent/delivered 全 false）：
 *     ① 宿主回执 delivered === true；
 *     ② 回执 target 非空；调用方给了 expectTarget 时必须相等（同时作为 args.sessionId 下发）；
 *     ③ 宿主没报 ambiguous（多个 live agent 时它只挑了 roots[0]，那没核对过目标）；
 *        ③ 的例外：expectTarget 明确且相等 —— 指名了就不算猜。
 *   ★ 传输层单独用 transportOk 表示：**它不许被下游读成「已通知」** ——
 *     这正是这一轮要修的语义（外壳曾把 transportOk 当 sent 往外报）。
 *   ★ 失败不再是 throw：no-host / transport-error / timeout / not-delivered /
 *     target-missing / target-mismatch / target-ambiguous 都回结构化回执，带 stage + reason。
 *   ★ 回执里只有**脱敏后**的 title（普通非秘密文本原样可读）；原始 title / facts / summary
 *     一个字都不进返回体 —— 这是第九轮出口脱敏的延续，不是新口子。 */
export async function deliverPanelNotice({ title, facts, guardFn, waker, hub, now, expectTarget } = {}) {
  const rawTitle = String(title == null ? '' : title);
  const rawFacts = facts == null ? '' : String(facts);
  const text = rawTitle + (rawFacts ? '\n\n' + rawFacts : '');
  const t = typeof now === 'string' ? now : new Date().toISOString();

  // ① 过宪章（与以前同一套口径：block / ask / pass 三值，没结论 = unchecked）
  let charter = 'unchecked';
  let charterNote = '没有 guard，没审';
  if (typeof guardFn === 'function') {
    try {
      const r = await guardFn(text);
      const v = r && r.verdict;
      if (v !== 'pass' && v !== 'ask' && v !== 'block') throw new Error('guard 没有返回可用结论');
      charter = v;
      charterNote = redactBody(String(r.why || (v === 'pass' ? '四条硬线与越权都没命中' : ''))).slice(0, 120);
    } catch (e) {
      charter = 'unchecked';
      charterNote = redactBody('guard 报错：' + String((e && e.message) || e).slice(0, 80));
    }
  }

  // ② 入账 —— ★ 只用脱敏字段；block 也不跳过（被拦下的同样要留痕）
  const safeTitle = redactBody(rawTitle).slice(0, 120);
  if (waker && typeof waker.ingest === 'function') {
    try {
      waker.ingest({
        key: t + '|panel|' + safeTitle.slice(0, 50),
        t,
        title: safeTitle,
        from: 'v4-panel',
        tier: 'act',
        stage: charter === 'block' ? 'blocked' : 'pending',
        charter,
        charterNote,
      });
    } catch { /* 台账写不进去不影响出口策略；不在这里吞掉投递决策 */ }
  }

  // ③ ★ block：到这里就结束。不找宿主、不调 followup、不拼投递体。
  if (charter === 'block') {
    return {
      ok: false, sent: false, delivered: false, transportOk: false, blocked: true,
      charter, stage: 'guard-block', reason: 'charter-block',
      why: charterNote, title: safeTitle,
    };
  }

  // ④ ask / pass / unchecked：投递**脱敏本**（字段级 redactBody，各自截断）
  //
  // ★ 2026-11-10 第十轮：**「没宿主」「宿主报错」「超时」不再 throw。**
  //   抛出去调用方只能 catch 成一句话，回执里的 stage / transportOk 就丢了 ——
  //   而这一轮要证的正是「哪一步没成」。所以失败也回结构化回执（ok:false），不靠异常表达。
  const wanted = expectTarget == null ? '' : String(expectTarget).trim();
  const fail = (stage, reason, extra) => ({
    ok: false, sent: false, delivered: false, transportOk: false, blocked: false,
    charter, stage, reason: String(reason == null ? '' : reason).slice(0, 200), title: safeTitle,
    ...(extra || {}),
  });

  if (!hub || typeof hub.exec !== 'function') {
    return fail('no-host', '控制通道还没起来（control hub 不可用）');
  }
  const peers = (hub.snapshot() || []).filter(
    (h) => (h.caps || []).includes('followup') && !(h.stubs || []).includes('followup')
  );
  if (!peers.length) return fail('no-host', '没有能接 followup 的宿主（DSH 插件没连上？）');
  peers.sort((a, b) => String(b.connectedAt || '').localeCompare(String(a.connectedAt || '')));
  const safeFacts = rawFacts ? redactBody(rawFacts).slice(0, 2000) : '';
  const payload = '【v4 面板转达】' + redactBody(rawTitle).slice(0, 200)
    + (safeFacts ? '\n\n' + safeFacts : '')
    + '\n\n（宪章：' + charter + (charterNote ? ' · ' + charterNote : '') + '）';
  const args = { text: payload, why: 'panel-notify' };
  // ★ 指名了才谈得上「目标匹配」：把它一起下发，宿主会按 sessionId 找那个会话。
  if (wanted) args.sessionId = wanted;

  let r;
  try {
    r = await hub.exec(peers[0].id, 'followup', 'say', args);
  } catch (e) {
    const msg = String((e && e.message) || e);
    const stub = Boolean(e && e.hint === 'stub_declared');
    const stage = stub ? 'stub' : (/超时|timeout/i.test(msg) ? 'timeout' : 'transport-error');
    return fail(stage, msg, {
      hostId: peers[0].id, bytes: payload.length,
      ...(e && e.hint ? { hint: String(e.hint).slice(0, 40) } : {}),
    });
  }

  // ⑤ ★★ 回执真相：hub.exec 拿到 result 帧 ≠ 话进了某个会话。
  //   宿主自己的回执里有 `delivered` 与 `target`（见 dsh-agent-soul-bridge 的 doFollowup）——
  //   没拿到这两样就是「传输到达、投递未确认」，不许写成 sent:true。
  //
  //   ★ 2026-11-10 D 切片：判据抽成 judgeFollowupReceipt()，给**自主投递**复用。
  //     不抽的话同一个判据会长出第二份实现 —— 那正是「两处各判各的、迟早漂」的形状。
  const d = (r && typeof r === 'object') ? r : {};
  const judged = judgeFollowupReceipt({ data: d, expectTarget: wanted });
  const base = {
    ok: false, sent: false, delivered: false, transportOk: true, blocked: false,
    charter, hostId: peers[0].id, target: judged.target || null,
    ...(d.ambiguous === true ? { ambiguous: true } : {}),
    ...(d.how ? { how: String(d.how).slice(0, 40) } : {}),
    bytes: payload.length, title: safeTitle,
  };
  if (!judged.ok) return { ...base, stage: judged.stage, reason: judged.reason };
  return { ...base, ok: true, sent: true, delivered: true, stage: 'delivered', reason: 'host-confirmed' };
}

/**
 * 宿主 followup 回执的判据（第十轮立的三条；2026-11-10 D 切片抽成函数）。
 *
 * ★ 为什么抽出来：面板通知（deliverPanelNotice）和自主投递（organs/autonomy-host.mjs）
 *   问的是**同一个问题** ——「宿主回执说投到那个会话了吗」。两份实现迟早给出两个答案。
 *
 * 三条全中才算 delivered：
 *   ① 回执 delivered === true；
 *   ② 回执 target 非空；调用方给了 expectTarget 时必须**逐字相等**
 *      （注意：不做前缀归一、不做包含匹配 —— 要求精确，就精确到底）；
 *   ③ 宿主没报 ambiguous（多候选时它只挑 roots[0]，没核对过目标）；
 *      例外：调用方指名了且相等 —— 指名了就不算猜。
 *
 * @param {{data?:object, expectTarget?:string}} [args]
 * @returns {{ok:boolean, stage:string, reason:string, target:string|null, targetFull:string}}
 *   target 是截断 80 字的回执版；targetFull 是完整值（**只用于比较，不要外传**）。
 */
export function judgeFollowupReceipt({ data, expectTarget } = {}) {
  const d = (data && typeof data === 'object') ? data : {};
  const wanted = expectTarget == null ? '' : String(expectTarget).trim();
  // ★ 比对用完整值，回执里只放截断值 —— 拿截断值去比会把长 id 误判成「不匹配」。
  const targetFull = d.target == null ? '' : String(d.target).trim();
  const target = targetFull.slice(0, 80);
  const ambiguous = d.ambiguous === true;

  if (d.delivered !== true) {
    return { ok: false, stage: 'not-delivered', reason: '宿主回执没有 delivered:true（传输到达，但没确认投进会话）', target: target || null, targetFull };
  }
  if (!targetFull) {
    return { ok: false, stage: 'target-missing', reason: '宿主回执没有 target（不知道投给了谁，不算投递成功）', target: null, targetFull: '' };
  }
  if (wanted && targetFull !== wanted) {
    return { ok: false, stage: 'target-mismatch', reason: '宿主回执的 target 与要求的不一致', target, targetFull };
  }
  // ★ 多个 live agent 时宿主只挑 roots[0] —— 没指名就等于没核对过目标，不冒充「投到主导」。
  //   例外：调用方指名了（wanted 非空）且 target 与它相等 —— 那是核对过的。
  if (ambiguous && !wanted) {
    return { ok: false, stage: 'target-ambiguous', reason: '宿主报告有多个候选会话，只挑了 roots[0]（没指名 = 不算投到目标）', target, targetFull };
  }
  return { ok: true, stage: 'delivered', reason: 'host-confirmed', target, targetFull };
}

async function checkInner(req, opts, coreTrusted) {
  const o = opts || {};
  const raw = String((req && (req.text || req.intent)) || '');
  const maxChars = clampInt(o.maxChars, GUARD_TEXT_MAX_CHARS, 200, GUARD_TEXT_HARD_CAP);
  const timeoutMs = clampInt(o.timeoutMs, LLM_TIMEOUT_DEFAULT_MS, LLM_TIMEOUT_MIN_MS, LLM_TIMEOUT_MAX_MS);
  // ★ 回给调用方的是**脱敏本**：审核响应会进日志/台账，凭据不该跟着走。
  //   原文本来就是它自己发来的，脱敏只影响这一份回声。
  //
  // ★★ 2026-11-10 第二轮（P2）把「回声」和「判定输入」分成两份：
  //   · text     —— 文本层脱敏（maskSecrets）。**规则判定用它**（行为与本轮之前逐字相同）。
  //   · echoText —— 结构层脱敏（redactCore）。回给调用方 + **送模型**都用它。
  //
  // ★★★ 2026-11-10 第三轮（独立验收硬门槛 3：wire body）：
  //   上一轮把「送模型」留在 text 上，而 maskSecrets 只有四条**文本**正则 ——
  //   {"key":"FAKE…"} 这种 JSON 形状值被引号护着，一条都不命中，于是
  //   秘密原样进了发往 LLM 的 HTTP body（实测 W1–W6 六种形状全漏）。
  //   现在：**发出去的那一份必须过结构脱敏**；而且**先脱完整原文、再做 maxChars 截断** ——
  //   先截断再脱会让截断点把 JSON 切坏，正好绕过结构脱敏（R1/R3 就是这么漏的）。
  const masked = maskSecrets(raw);
  const text = masked.text;
  // ★★ 2026-11-10 第五轮：脱敏层的结论在这里收口 —— 不再「try/catch 完就从字符串猜」。
  //   rd.codes 非空 = 这条输入没被完整安全处理（畸形/截断 JSON、解码不了、
  //   超编码层数、超深度/候选/预算、任何 failCloseTail / tailRisk 命中）。
  const rd = redactAnalyze(raw);
  const redactedAll = rd.text;
  const uncertainCodes = rd.codes.slice();
  // ★★ 2026-11-10 第六轮：分类结论在这里落地。klass='uncertain' 的输入
  //   不是「脱敏失败」，而是「我们拒绝猜它的边界」——结论同样是 ask + 0 调用，
  //   evidence 里多一个 inputClass 便于外部核对（不是新出口，只是标签）。
  const inputClass = rd.klass || 'plain';
  // ★ 「脱敏本身失败」有两种来路，结论与证据码都按同一件事处理：
  //   · redact-threw  —— 整条链抛了（外层安全壳接住）
  //   · walk-overflow —— 2000 层这类输入在 parse/stringify/走查里爆栈（内层接住）
  //   两者都是「这一条我们没法安全处理」，都落到 ask + LLM_REDACT_FAILED（不调 LLM）。
  const redactFailed = uncertainCodes.indexOf('redact-threw') >= 0 || uncertainCodes.indexOf('walk-overflow') >= 0;
  const echoText = redactedAll;
  // ★ 第九轮：能力标记只通过 Symbol 进 ctx —— 公开 JSON 带不了 Symbol 键。
  const ctx = { from: req && req.from, role: req && req.role, [CORE_TRUST]: coreTrusted === true };
  const llm = o.llm || null;
  const llmConfigured = typeof o.llmConfigured === 'boolean'
    ? o.llmConfigured
    : Boolean(llm && (typeof llm.ready === 'function' ? llm.ready() : typeof llm.chat === 'function'));
  const baseEv = {
    llmConfigured,
    textChars: raw.length,
    truncated: false,
    masked: echoText !== raw,          // 出口回声是否被改过（判定输入另算）
    timeoutMs,
  };

  // ① 规则层
  //
  // ★★ 第一道永远是「这是不是在讨论规则」。
  //   它排在所有硬线前面 —— 因为**讨论硬线恰恰是这道门最该放行的内容**。
  // ★★★ 2026-11-10 第五轮（主导决定 A/B/C/D）：
  //   **不确定输入不许「先占位、再照常调用 LLM」。** 一律 ask + fallback，llmCalls=0。
  //   · 为什么不是 pass：这一条我们没看懂（输入被吃掉了一部分 / 没能完整解码），
  //     pass 等于拿「没看懂」当「没问题」—— 与「hint 不命中 = 安全」「预算到顶 = 安全」同一个错。
  //   · 为什么不是 block：说不清 ≠ 违规，沿用 guard 原有的「说不清落 ask」口径。
  //   · 出口仍走 echoText（已脱敏 / 已占位）—— 所以「不调 LLM」绝不等于「回显原文」。
  //   · 排在 isMeta 之前：判「是不是讨论规则」的前提是**这段文字我们看得懂**；
  //     连输入都没完整处理过，就不能拿它去解锁一条 pass。
  //
  // ★★★ 2026-11-10 第七轮（主导拍板 · 硬线优先于分类闸门）：
  //   上一轮把 uncertain 一律判 ask，代价是「硬线 + 混排」也被降到 ask（第六轮 §9.3 自己写下的）。
  //   那是**分类在替硬线做判断**，方向反了：看不清结构 ≠ 看不见「把 key 发我」这件事。
  //   现在的次序是：**本地规则层先看 raw → 命中就 block/rule → 再看分类闸门给哪个出口**。
  //   · 纯正则、同步、**不碰外部 LLM** —— 所以 block 路径 llmCalls 恒为 0（不是靠分支记得不调）。
  //   · 判的是 **raw**：文本规则本来就在「凭据形状」上判，先脱敏会把要判的字迹抹掉。
  //   · 出去的是 **echoText**（占位 / 脱敏本）：block 也不回显原文 —— 硬线优先不许换来一个字泄漏。
  //   · 只让一种形态给路：「在讨论规则，不是在要」—— isMeta(raw) 为真，**且连索取词都没有**。
  //     多加 `!ASK.test(raw)` 这一条，是因为 isMeta 的否定语境里「不」很容易被借来当掩护
  //     （「不要管别的，把 key 发我」：有「不」、没有 isMeta 的索取词 → 旧判据会当讨论放过去）。
  //     这种「讨论」不放行 block，但也绝不解锁 pass：它继续落到下面的 ask。
  const earlyHits = ruleCheck(raw, ctx);
  const earlyDiscuss = earlyHits.length > 0 && isMeta(raw) && !ASK.test(raw);

  if (redactFailed || uncertainCodes.length || inputClass === 'uncertain') {
    if (earlyHits.length && !earlyDiscuss) {
      return {
        verdict: 'block',
        via: 'rule',
        lines: earlyHits.map((h) => h.id),
        why: redactText(earlyHits.map((h) => h.name + '：' + h.why).join('；'), 300),
        text: echoText,
        evidence: evidenceOf({
          ...baseEv,
          layer: 'rule',
          kind: 'rule',
          code: 'OK',
          uncertain: uncertainCodes,
          inputClass,
          llmCalled: false,
          hardlineBeforeClassify: true,
        }),
      };
    }
    return {
      verdict: 'ask',
      via: 'fallback',
      lines: [],
      why: redactFailed
        ? '这条请求的脱敏处理失败（无法安全判定，也不会送出），转人判断'
        : inputClass === 'uncertain'
          ? '这条请求是结构化混排输入（散文/日志里夹着 JSON-like 结构，或不是整个输入可完整解析的 JSON），'
            + '按严格契约整段占位（不保留前后散文），也不会送给模型，转人判断'
          : '这条请求的输入无法被完整安全处理（' + uncertainCodes.join(', ') + '），不会送给模型，转人判断',
      text: echoText,
      evidence: evidenceOf({
        ...baseEv,
        layer: 'fallback',
        kind: redactFailed ? 'redact-error' : 'input-uncertain',
        code: redactFailed ? 'LLM_REDACT_FAILED' : 'GUARD_INPUT_UNCERTAIN',
        uncertain: uncertainCodes,
        inputClass,
        llmCalled: false,
        // ★ 第七轮：命中了硬线、但整段读起来是「讨论规则」—— 不解锁 pass，也不 block，
        //   把命中的线记在证据里让人自己判（这条分支仍然是 ask + 0 调用 + 占位）。
        ...(earlyDiscuss ? { hardlineHitsDeferred: earlyHits.map((h) => h.id) } : {}),
      }),
    };
  }

  if (isMeta(text)) {
    return {
      verdict: 'pass', via: 'meta', lines: [],
      why: '看起来是在讨论/规定规则本身，不是提出请求',
      text: echoText,
      evidence: evidenceOf({ ...baseEv, layer: 'meta', kind: 'meta', code: 'OK' }),
    };
  }

  const hits = ruleCheck(text, ctx);
  if (hits.length) {
    // ★ 硬线命中 = block。理由、规则、原文一起回去，让人能推翻。
    return {
      verdict: 'block',
      via: 'rule',
      lines: hits.map((h) => h.id),
      why: redactText(hits.map((h) => h.name + '：' + h.why).join('；'), 300),
      text: echoText,
      evidence: evidenceOf({ ...baseEv, layer: 'rule', kind: 'rule', code: 'OK' }),
    };
  }

  // ★ 脱敏失败 / 输入不确定的那道闸门在 isMeta 之前（第五轮上移，见上面）。

  // ② 模糊层 —— 只有「需要判」才走
  //
  // ★★ 什么时候该走这一步（判据，不是感觉）：
  //   · 规则全没命中，**但请求里有「代为决定」的味道** ——
  //     比如「你看着办」「随便挑一个」「帮我定下来」。
  //   · 这类请求不违反任何硬线，但它在**把决定权转移给一个不该承担它的人**。
  //   ★ 这是「越权」的软形态：不是动作越权，是**判断权越权**。规则判不出，只有它能。
  // ★ 触发词要覆盖「把判断权交出去」的各种说法 —— 不只是「你看着办」。
  // ★ 清晰的安全项不走这一步：needsJudge 为假就直接 pass —— 不是每条事件都花一次调用。
  const needsJudge = /(你看着办|随便|都行|你决定|帮我定|替我选|你来选|你自己判断|不用问我|你觉得|该.{0,4}就.{0,4}|你自己看|随你)/.test(text);
  if (!needsJudge) {
    return {
      verdict: 'pass', via: 'rule', lines: [],
      why: '四条硬线与越权都没命中',
      text: echoText,
      evidence: evidenceOf({ ...baseEv, layer: 'rule', kind: 'not-needed', code: 'OK' }),
    };
  }

  // ★★ 该判却判不了 —— 这次改动的核心：**不许静默 pass**。
  //   落到 ask（不是 block）沿用 guard 自己的判据：
  //   该过的拦了 = 分身的活白干且我看不到它想说什么（最坏）；该拦的放了 = 只多一道延迟。
  //   所以「说不清」落到 ask，而「根本没审」也属于「说不清」。
  const canCall = Boolean(llm && typeof llm.chat === 'function' && llmConfigured);
  if (!canCall) {
    return {
      verdict: 'ask',
      via: 'fallback',
      lines: [],
      why: '模糊层没跑：LLM ' + (llmConfigured ? '未接入（缺 chat 方法）' : '未配置')
        + '，这条请求含「把判断权交出去」的味道，转人判断',
      text: echoText,
      evidence: evidenceOf({ ...baseEv, layer: 'fallback', kind: 'unconfigured', code: 'LLM_UNCONFIGURED' }),
    };
  }

  const t0 = Date.now();
  const judgeMeta = {
    ...baseEv,
    llmConfigured: true,
    llmCalled: true,
    model: (llm && llm.model) || null,
    protocol: (llm && llm.protocol) || null,
  };

  try {
    const sys = [
      '你在做一个安全审核。判断这条请求是否「把本该由人做的决定，推给了代理」。',
      '只看这一件事。不评判请求本身好不好、有没有用。',
      '回答只允许一个词：PASS 或 ASK。',
      'PASS = 「你看着办」这种语气在这里是正常的委托，不涉及不可逆的决定。',
      'ASK  = 请求在让它替人做**不可逆或影响较大**的决定（删东西、花钱、对外发布、承诺时间）。',
    ].join('\n');
    // ★ 送出去的是**整段先脱敏、再截断**的那一份（redactedAll）。
    //   顺序反了就等于给截断留了一个绕过口子（见上面 checkInner 顶部的注释）。
    const sent = redactedAll.slice(0, maxChars);
    const r = await withTimeout(llm.chat([
      { role: 'system', content: sys },
      { role: 'user', content: sent },
    ]), timeoutMs);
    const latencyMs = Date.now() - t0;
    // ★ chat() 回 { text, reasoning, toolCalls }；老 MCP 包装器回 { content }。两种都收。
    //   ★ 但**解析不出来就是解析不出来** —— 不再「不是 ASK 就当 PASS」。
    const got = (r && (r.content != null ? r.content : r.text)) != null
      ? (r.content != null ? r.content : r.text)
      : (typeof r === 'string' ? r : '');
    const reply = String(got == null ? '' : got).trim();
    const verdict = parseJudgeReply(reply);
    const ev = { ...judgeMeta, latencyMs, truncated: raw.length > maxChars };

    if (!verdict) {
      return {
        verdict: 'ask',
        via: 'fallback',
        lines: [],
        why: '模糊层返回不可解析（' + (reply ? redactText(reply, 60) : '空回复') + '），转人判断',
        text: echoText,
        evidence: evidenceOf({ ...ev, layer: 'fallback', kind: 'unparsable', code: 'LLM_UNPARSABLE' }),
      };
    }

    return {
      verdict,
      via: 'llm',
      lines: [],
      why: verdict === 'ask' ? '模糊层判：在替人做不可逆的决定' : '模糊层判：正常委托',
      text: echoText,
      evidence: evidenceOf({ ...ev, layer: 'llm', kind: verdict === 'ask' ? 'llm-ask' : 'llm-pass', code: 'OK' }),
    };
  } catch (e) {
    // ★ 模糊层挂了必须落到 ask，不能落到 pass ——
    //   「判不出来」和「判过了」是两件事，混在一起就是把安全网拆了。
    const latencyMs = Date.now() - t0;
    const isTimeout = Boolean(e && e.code === 'LLM_TIMEOUT');
    return {
      verdict: 'ask',
      via: 'fallback',
      lines: [],
      why: (isTimeout
        ? '模糊层超时（' + timeoutMs + 'ms 上限）'
        : '模糊层不可用（' + redactText(e && e.message, 160) + '）') + '，转人判断',
      text: echoText,
      evidence: evidenceOf({
        ...judgeMeta,
        layer: 'fallback',
        latencyMs,
        kind: isTimeout ? 'timeout' : 'exception',
        code: isTimeout ? 'LLM_TIMEOUT' : 'LLM_ERROR',
        error: redactText(e && (e.message || e), 200),
      }),
    };
  }
}
