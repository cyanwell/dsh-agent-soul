// dsh-agent-mobile-adapt · 宿主半
//
// 这个插件只做浏览器端的事（注入手机适配 CSS + 给桌面浮层打标）。
// 宿主半目前是空的：没有工具、没有路由、没有配置。
//
// ★ 之所以仍然做成"真包"而不是动态插件：动态插件的 Client 半投递不到浏览器
//   （实测 window.__DSH_BOOT__ 里根本没有它），手机适配必须走真包的 client.js。

export const name = 'dsh-agent-mobile-adapt'

/** 不依赖任何宿主服务。 */
export const inject = []

export function apply() {
  // 有意为空：全部逻辑在 client.js。
}
