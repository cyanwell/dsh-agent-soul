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
