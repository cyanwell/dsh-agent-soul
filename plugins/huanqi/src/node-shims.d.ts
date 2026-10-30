/**
 * 最小的 node 内置模块声明 —— 只够本插件用的那几个符号。
 *
 * ## 为什么不用 `@types/node`
 *
 * 这个包刻意保持**零运行时依赖**（见 `package.json`：`dependencies` 只有一个
 * `@deepseek-ai/schemastery`，那是宿主本来就有的）。而 `@types/node` 是几千个文件的
 * 类型树 —— 为了 5 个函数把它整个拉进来，代价和收益不成比例。
 *
 * 手写声明的另一个好处是**明确**：一眼能看出这个插件到底碰了系统的哪几样东西。
 * 现在的答案是：读一个文件、写一个文件、建一个目录、看它存不存在、取环境变量。
 * **就这些。**
 *
 * ## 什么时候该改用 `@types/node`
 *
 * 如果哪天这里需要加**第五个以上的模块**（比如 `node:os`、`node:crypto`、`node:child_process`），
 * 就别往这个文件里继续堆了 —— 那时候装 `@types/node` 才是对的选择。
 * 一个手写声明文件长到二十行，它就从"明确"变成了"负债"。
 *
 * ## 一个必须记住的边界
 *
 * 这些声明**只影响类型检查**。真正跑的代码里，`node:fs` 是 node 自己提供的，
 * 声明写错不会让运行时报错、只会让类型检查说谎 —— 所以**改这里之后必须真的跑一次**，
 * 不能只看 tsc 过了就算数。
 */

declare module 'node:fs' {
  /** 路径存在吗（文件或目录都算）。 */
  export function existsSync(path: string): boolean
  /** 建目录。`{ recursive: true }` 时父目录不存在也一起建，且已存在不报错。 */
  export function mkdirSync(path: string, options?: { recursive?: boolean }): string | undefined
  /** 读整个文件为字符串。 */
  export function readFileSync(path: string, encoding: 'utf8'): string
  /** 把字符串整个写进文件（覆盖）。 */
  export function writeFileSync(path: string, data: string, encoding: 'utf8'): void
  /**
   * 往文件尾部追加（文件不存在则创建）。
   *
   * ★ 2026-10-28 补：`lib/index.js` 里那段手工代码（压缩层诊断）用的就是它。
   *   `src` 里其余地方仍然走 read + write —— 那条约定没变，这里只是把
   *   **产物已经在用** 的符号补上声明，免得「能跑但 tsc 报 TS2305」。
   */
  export function appendFileSync(path: string, data: string, encoding?: 'utf8'): void
}

declare module 'node:path' {
  /** 取父目录（`/a/b/c` → `/a/b`）。 */
  export function dirname(p: string): string
  /** 拼路径，中间自动补分隔符。 */
  export function join(...parts: string[]): string
}

/**
 * 只声明我们真正读的那一个字段。
 *
 * ★ 不用 `declare global` 包一层 —— 在 `.d.ts` 的顶层写 `declare const` 本来就是全局声明，
 * 而且这个文件不含 `import`/`export`，所以它整个是全局脚本作用域。
 */
declare const process: {
  readonly env: Record<string, string | undefined>
}

/* ══════════════════════════════════════════════════════════════════════════
 * ★ 2026-10-28 补：`lib/index.js` 里那段手工代码（压缩层 + 测试触发口）用到、
 *   而 `lib: ["ES2022"]` 里没有的运行时符号。
 *
 *   为什么必须补：这份 tsconfig 只开 ES2022 —— `setTimeout` / `setInterval` /
 *   `AbortController` / `console` 全是 DOM 或 @types/node 才有的名字。而那段
 *   产物代码**已经在用它们**（tsc 从不检查 lib/），于是「能跑，但 src 一编译就
 *   TS2304」。补声明是让源和产物对齐的最小代价，比为一个符号引入整棵
 *   @types/node 类型树更诚实（同本文件头部那段「什么时候该改用 @types/node」）。
 *
 *   ★ 边界照旧：**这些声明只影响类型检查**。改完必须真的跑一次。
 * ══════════════════════════════════════════════════════════════════════════ */

/** 延时一次。参数放宽成任意回调 —— 压缩层传的就是 `resolve`（带一个 value 参数），
 *  严格写成 `() => void` 会让 `(value: unknown) => void` 传不进去（strictFunctionTypes）。 */
declare function setTimeout(fn: (...args: any[]) => void, ms: number): unknown
/** 周期触发（测试触发口每 3 秒看一眼 trigger 文件）。 */
declare function setInterval(fn: () => void, ms: number): unknown
/** 中止控制器：`commands.execute(...)` 每次都要一个新的 signal。 */
declare const AbortController: {
  new (): { readonly signal: unknown; abort(): void }
}
/** 只有 `console.error` —— 压缩层用它报取服务失败（写文件之外的唯一出口）。 */
declare const console: {
  error(...args: unknown[]): void
}

/**
 * `@deepseek-ai/dsh-compaction` 的类型入口。
 *
 * ★ 2026-10-28 补：这个包**不在本包的 dependencies 里**（本包刻意零运行时依赖），
 *   但它是**宿主自带的** —— 实测存在于
 *   `D:\AI\dsh\home\profiles\node_modules\@deepseek-ai\dsh-compaction`，
 *   `dsh-compaction-basic` 正是它的一员。所以运行时 import 解析得到；
 *   这里只补一份声明给 tsc 看。
 *
 * ★ 只声明真正用到的那一个：签名照抄真实 `.d.ts`
 *   （`tool-pairing.d.ts`，`(session: Session, seq: SessionSeq) => boolean`）。
 *   `Session` / `SessionSeq` 不在这里 import（会把整条 dsh-session 类型链拖进来），
 *   退成 `unknown` / `number` —— 与本项目「不够就放宽、够用就写死」的一贯做法一致。
 */
declare module '@deepseek-ai/dsh-compaction' {
  export function toolPairingBalancedBefore(session: unknown, seq: number): boolean
}
