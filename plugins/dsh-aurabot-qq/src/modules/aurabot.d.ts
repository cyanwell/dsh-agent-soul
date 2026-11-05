// Aurabot 扩展模块的类型提示（插件每次启动会更新这个文件，别改它）。
// 用法：在模块入口文件 export default 的上一行写
//   /** @type {import('../aurabot').AurabotModule} */
// VS Code 等编辑器就会给 api.* 补全和参数说明。完整说明见同目录的 API.md。

export type ChatId = `private:${string}` | `group:${string}` | `system:${string}`

export interface Chat {
  chatId: ChatId
  kind: 'private' | 'group' | 'system'
  userId?: string
  groupId?: string
  title?: string
}

/** 收到的一条消息（已解析）。 */
export interface Message {
  kind: 'private' | 'group'
  chatId: ChatId
  userId: string
  groupId: string
  nickname: string
  /** 在群里的身份：owner / admin / member，私聊是空串 */
  role: string
  messageId: string
  text: string
  /** @ 了她 */
  mentioned: boolean
  /** 引用的那条消息 id */
  replyId: string
  images: any[]
  stickers: any[]
  records: any[]
  forwards: any[]
  /** 原始 OneBot 事件 */
  raw: any
}

/** 拆好的一条回复。 */
export interface ReplyItem {
  kind: 'text' | 'voice' | 'sticker' | 'poke' | 'image'
  value: any
  /** 群里引用回复的编号 */
  replyTo?: string
}

/** OneBot v11 消息段，比如 { type: 'text', data: { text: '你好' } } */
export interface Segment { type: string; data: Record<string, any> }

export interface GroupDecision {
  reply: boolean
  /** must 被叫到必须回 / engaged 正在参与话题 / interject 插话 */
  mode?: 'must' | 'engaged' | 'interject'
  reason?: string
}

export interface ModelSelection { provider: string; model: string; reasoningEffort?: string }

/** 工具生成函数拿到的「在哪儿」。 */
export interface Where {
  chat: Chat
  /** full 主人私聊 / social 群聊和别人 */
  level: 'full' | 'social' | 'chat'
  sessionId: string
}

export interface Tool {
  name: string
  description: string
  parameters: any
  output: any
  execute(args: any, exec?: any): Promise<any>
}

export interface ToolSpec {
  name: string
  description: string
  /** 参数（JSON Schema 的 properties） */
  properties?: Record<string, any>
  required?: string[]
  /** 返回 { ok, message }：message 是给她看的结果 */
  execute(args: any, exec?: any): any | Promise<any>
}

export interface Command {
  name: string
  aliases?: string[]
  desc?: string
  /** 返回的文字直接回给主人 */
  run(arg: string, msg: Message): string | void | Promise<string | void>
}

export interface Logger {
  debug(...a: any[]): void
  info(...a: any[]): void
  warn(...a: any[]): void
  error(...a: any[]): void
}

export type Off = () => void

/** 事件 → 监听函数的样子。返回值的意义见 API.md「事件」。 */
export interface Events {
  /** 返回 true = 接管这条消息，她不再处理 */
  message: (msg: Message) => boolean | void | Promise<boolean | void>
  /** 她要说的整段话：返回新文字改写，null 不发 */
  reply: (text: string, info: { chatId: ChatId; userText: string }) => string | null | void | Promise<string | null | void>
  /** 拆好的每一条（已经决定了哪条发语音、配不配表情）：返回新数组改写，null 不发 */
  'reply/items': (items: ReplyItem[], info: { chatId: ChatId; text: string; userText: string }) => ReplyItem[] | null | void | Promise<ReplyItem[] | null | void>
  /** 最终发给 QQ 的消息段（所有发送都经过这里，包括命令回复、模块发的）：返回新数组改写，null 不发 */
  send: (message: Segment[], info: { chatId: ChatId; note: string; force: boolean }) => Segment[] | null | void | Promise<Segment[] | null | void>
  /** 群里这条消息她回不回：返回对象覆盖决定，比如 { reply: true, mode: 'must' }（返回 null 无效，等于不改） */
  'group/decide': (decision: GroupDecision, info: { msg: Message; policy: any; recentTexts: string[]; memScore: number }) => Partial<GroupDecision> | void | Promise<Partial<GroupDecision> | void>
  /** 交给她的内容（[{ type: 'text', text }, { type: 'image', ... }]）：返回新数组改写，null 这次不交给她 */
  prompt: (content: any[], info: { chat: Chat; senderId: string; queryText?: string }) => any[] | null | void | Promise<any[] | null | void>
  /** 这个聊天用哪个模型（同步）：返回 { provider, model, reasoningEffort } */
  model: (selection: ModelSelection | null, chat: Chat) => ModelSelection | void
  /** 她的人格全文（同步）：返回新文字改写 */
  persona: (text: string) => string | void
  /** 她的规则全文（同步）：返回新文字改写 */
  rules: (text: string, kind: 'private' | 'social') => string | void
  /** 有人戳她：返回 true = 接管 */
  poke: (event: any) => boolean | void | Promise<boolean | void>
  /** 收到的消息 / 她发出去的话（只看） */
  activity: (a: { kind: 'in' | 'out'; chatId: ChatId; userId?: string; nickname?: string; text?: string; reply?: string; direct?: boolean; owner?: boolean }) => void
  /** 所有原始 OneBot 事件（只看，不管白名单） */
  onebot: (event: any) => void
  'onebot/state': (state: string) => void
  config: (cfg: any, before: any) => void
  'module/start': (id: string) => void
  'module/stop': (id: string) => void
  'song/sung': (info: { title: string; chatId: ChatId }) => void
  [custom: string]: (...args: any[]) => any
}

export interface Api {
  id: string
  source: 'builtin' | 'user'
  /** 模块自己的文件夹（读自带的数据文件用；import.meta.url 指向加载快照） */
  dir: string
  apiVersion: number
  /** 插件版本 */
  version: string
  log: Logger

  // ---- 配置 ----
  config(): any
  setConfig(patch: any | ((cfg: any) => any)): any
  settings(): Record<string, any>
  saveSettings(patch: Record<string, any>): Record<string, any>
  dataDir(...parts: string[]): string

  // ---- 发消息 ----
  send(chatId: ChatId | string, text: string): Promise<any>
  sendText(chatId: ChatId | string, text: string): Promise<any>
  /** 回某一条消息：群里以「引用回复」发出（对方能看到在回他），私聊直接发 */
  reply(msg: Message, text: string): Promise<any>
  /** 这个 QQ 号是不是主人 */
  isOwner(userId: string | number): boolean
  sendImage(chatId: ChatId | string, src: string): Promise<any>
  /** 发文件：本机绝对路径，或网关能取到的网址 / base64://（网关看不到本机路径时，小文件会自动改用 base64） */
  sendFile(chatId: ChatId | string, file: string, name?: string): Promise<any>
  /** 把本机音频文件当语音条发出去 */
  sendVoiceFile(chatId: ChatId | string, file: string, note?: string): Promise<any>
  sendSegments(chatId: ChatId | string, segments: Segment[], note?: string): Promise<any>
  onebot(action: string, params?: any, opts?: { timeoutMs?: number }): Promise<any>

  // ---- 模型 ----
  ask(opts: string | { system?: string; text: string; maxTokens?: number }): Promise<string>
  think(prompt: string, opts?: { title?: string; timeoutMs?: number }): Promise<string>

  // ---- 往插件里加东西（都返回撤掉函数）----
  on<K extends keyof Events>(event: K, fn: Events[K]): Off
  emit(event: string, ...args: any[]): void
  tool(builder: Tool | Tool[] | ((where: Where) => Tool | Tool[] | null | undefined)): Off
  defineTool(spec: ToolSpec): Tool
  context(fn: (args: { chat: Chat; sessionId: string }) => string | void): Off
  rule(fn: string | ((kind: 'private' | 'social', cfg: any) => string | string[] | void)): Off
  command(c: Command): Off
  every(ms: number, fn: () => any, label?: string): Off
  later(ms: number, fn: () => any): Off
  route(path: string, handler: (req: any, res: any) => any): Off
  onDispose(fn: () => void): Off

  // ---- 别的模块和插件内部 ----
  use<T = any>(id: string): T | null
  lazy<T = any>(id: string): Partial<T>
  has(id: string): boolean
  core: {
    hub: any
    onebot: { call(action: string, params?: any, opts?: any): Promise<any>; state: string }
    snowluma: any
    local: any
    groupRoles: any
    mutes: { muted(chatId: string): boolean; set(chatId: string, minutes: number): void; clear(chatId: string): void }
    logger: any
    ask(opts: any): Promise<string>
    listModels(): Promise<{ provider: string; model: string; name: string }[]>
    defaultModel(): ModelSelection | null
    http: { body(req: any): Promise<any>; raw(req: any, max: number): Promise<Buffer>; query(req: any): Record<string, string>; send(res: any, code: number, body: any, type?: string): void }
    personas: any
    modules: any
    root: string
    getConfig(): any
    setConfig(cfg: any): any
  }
  /** DSH 给插件的 ctx：dsh.get('服务名') 拿 DSH 的任何服务 */
  dsh: any
  /** 插件内部任何一个源码文件导出的东西：lib('features/memory.js') */
  lib(path: string): any
}

export interface Setting {
  key: string
  label?: string
  type?: 'text' | 'number' | 'switch' | 'select' | 'textarea' | 'password'
  hint?: string
  placeholder?: string
  min?: number
  max?: number
  step?: number
  options?: (string | { value: any; label: string })[]
}

export interface AurabotModule {
  /** 小写字母开头，小写字母 / 数字 / -；和文件夹名一样。和内置模块同名 = 替换它 */
  id: string
  name?: string
  version?: string
  /** 按哪一版扩展接口写的 */
  api?: number
  description?: string
  defaults?: Record<string, any>
  settings?: Setting[]
  /** 自己画面板：模块文件夹里的文件名（默认 panel.js） */
  panel?: string | boolean
  /** 设置和面板放进哪个内置标签页（比如 'song'），不写就单独一页 */
  tab?: string
  setup(api: Api): any
}
