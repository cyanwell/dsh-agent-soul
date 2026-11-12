// 扩展模块「__NAME__」—— 放在 Aurabot 数据目录 modules/__ID__/ 里，插件升级不会动它。
// 保存就生效（几秒内自动重新加载），出错了去面板「扩展」页看原因。
// 能用的接口全在同目录上一层的 API.md 里；不会写就在面板点「复制给 DSH 的话」，让 DSH 帮你改。
//
// 下面是一个能直接跑的例子：关键词自动回复 + 一个命令 + 一个给她用的工具 + 一个定时任务。
// 不要的部分删掉就行。

/** @type {import('../aurabot').AurabotModule} */ // 编辑器的自动补全靠这一行
export default {
  id: '__ID__', // 要和文件夹名一样；和内置模块同名（比如 diary）就是替换掉内置的
  name: '__NAME__',
  version: '0.1.0',
  api: 1, // 按哪一版扩展接口写的，别改
  description: '一个例子：关键词自动回复',

  // 面板里自动生成设置表单；值用 api.settings() 读
  defaults: { replies: '早安=早呀～今天也要元气满满\n晚安=晚安，做个好梦', onlyOwner: false },
  settings: [
    { key: 'replies', label: '关键词=回复', type: 'textarea', hint: '一行一条，收到的消息正好是这个关键词就直接回，不经过模型' },
    { key: 'onlyOwner', label: '只回主人', type: 'switch' },
  ],

  setup(api) {
    const table = () => Object.fromEntries(String(api.settings().replies || '').split('\n').map((l) => l.split('=')).filter((p) => p.length >= 2).map(([k, ...v]) => [k.trim(), v.join('=').trim()]))

    // 1. 收到消息时先问模块：返回 true 就是「这条我处理了」，她不会再回
    api.on('message', async (msg) => {
      if (api.settings().onlyOwner && msg.userId !== api.config().ownerQQ) return false
      const reply = table()[msg.text.trim()]
      if (!reply) return false
      await api.send(msg.chatId, reply)
      return true
    })

    // 2. 主人在 QQ 里发 /__ID__ 时
    api.command({
      name: '__ID__',
      desc: '看看「__NAME__」配了哪些关键词',
      run: () => Object.keys(table()).join('、') || '还没配关键词',
    })

    // 3. 给她用的工具（她自己决定什么时候调用）。where.level：full = 主人私聊，social = 群聊和别人
    //    返回 [] 就是这个会话里不给；where.chat 是当前聊天，where.sessionId 是会话 id
    api.tool((where) => api.defineTool({
      name: '__TOOL___keywords',
      description: '看看自动回复配了哪些关键词',
      properties: {}, // 参数，JSON Schema 写法，比如 { city: { type: 'string', description: '城市' } }
      execute: async () => ({ ok: true, message: Object.keys(table()).join('、') || '没有' }),
    }))

    // 4. 定时任务（毫秒）。模块关掉 / 重新加载时自动停
    api.every(60 * 60_000, () => api.log.info('「__NAME__」还活着'))

    // 返回的东西别的模块能用 api.use('__ID__') 拿到
    return { table }
  },
}
