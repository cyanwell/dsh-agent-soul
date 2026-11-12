// 内置模块：心情。聊天让她开心或低落，心情影响她发表情、发语音的频率和回复快慢，也会写进她的上下文。
// 导出 createMood 的返回值：nudge(变化, 原因)、label()、state()、effects()、contextLine()、observe()、judge()。

import { createMood } from '../../features/companion.js'

export default {
  id: 'mood',
  name: '心情',
  version: '1.0.0',
  description: '她的心情：会随聊天起伏，影响表情 / 语音频率和回复快慢',
  tab: 'mood',
  files: ['features/companion.js'],
  setup(api) {
    const mood = createMood({ getConfig: api.config, dsh: api.dsh })
    api.context(({ chat }) => (chat.kind === 'system' ? '' : mood.contextLine()))
    api.on('activity', (a) => {
      const cfg = api.config()
      if (a.kind === 'in' && a.text) mood.observe(a.text, a.nickname, { direct: a.direct, owner: a.owner })
      // 模型判心情（开了才判）：系统提醒开头的是她自己主动找人
      if (a.kind === 'out' && a.reply && !String(a.chatId).startsWith('system:')) {
        const speakUp = String(a.userText).startsWith('【系统提醒')
        mood.judge({ userText: a.userText, reply: a.reply, who: String(a.chatId).startsWith('group:') ? '群里的人' : String(a.chatId) === `private:${cfg.ownerQQ}` ? cfg.ownerName || '主人' : '对方', origin: speakUp ? 'speak-up' : 'user' }).catch(() => {})
      }
    })
    return mood
  },
}
