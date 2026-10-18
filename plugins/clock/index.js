/**
 * dsh-agent-clock — 宿主半（真 Node ESM）。
 *
 * 这个插件没有宿主侧能力：时钟完全在浏览器里用 `new Date()` 算，
 * 不注册路由、不注册工具、不读盘 —— 所以 `inject = []`。
 *
 * ★ 它仍然必须存在，而且是**真包**的理由：
 *   只有磁盘上的真包才会被写进 `window.__DSH_BOOT__.entries`，
 *   客户端半才投递得到浏览器，才能活过 DSH 重启。
 *   （动态 Cordis 插件的 client 半实测投递不到浏览器。）
 *
 * ★ 判据（第三点五节判决表）：这是**新增包 / 新增槽位** ⇒ 改完必须重启 DSH。
 */
export const name = 'dsh-agent-clock'

/** 不依赖任何宿主服务。 */
export const inject = []

/** 无宿主侧副作用。保留这个函数是因为包的形状要求它存在。 */
export function apply(ctx) {}
