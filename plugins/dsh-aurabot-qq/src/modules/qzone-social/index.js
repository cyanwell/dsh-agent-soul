// 内置模块：空间互动。逛好友动态点赞评论，回复自己说说下的新评论。

import { createQzoneSocial } from '../../features/qzone-social.js'

export default {
  id: 'qzone-social',
  name: '空间互动',
  version: '1.0.0',
  description: '逛好友的 QQ 空间点赞评论，回复自己说说下的评论',
  tab: 'diary',
  files: ['features/qzone-social.js'],
  setup(api) {
    const { hub, onebot } = api.core
    const social = createQzoneSocial({ getConfig: api.config, onebot, hub, memory: api.lazy('memory'), log: api.log })
    api.every(60_000, () => social.tick(), '空间互动')
    api.route('/qzone/social/run', async () => social.run({ force: true }))
    api.route('/qzone/social/state', async () => ({ ok: true, ...social.state() }))
    return social
  },
}
