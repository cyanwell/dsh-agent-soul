// 本地接口 · 生图：用你电脑上的画图服务（SD WebUI / Forge / ComfyUI ……）画图（替换面板里填的在线生图服务）。
// 约定见同目录的「README-本地接口.md」。改完保存就生效，不用重启 DSH；面板「本地接口」页可以点「试一下」。
//
// 输入：{ prompt, size, outDir, log }
//   prompt 要画什么（已经带上了面板里的「固定风格」）
//   size   面板里选的尺寸，比如 "1024x1024"
// 输出：图片的 Buffer，或 { buffer } / { file: 路径 } / { base64 } / { url }
// 出错就 throw，插件会告诉她没画成。

// ↓↓↓ 示例：Stable Diffusion WebUI / Forge 的 API（启动参数加 --api，默认 http://127.0.0.1:7860）
const API = 'http://127.0.0.1:7860/sdapi/v1/txt2img'

export default async function image({ prompt, size, log }) {
  const [width, height] = String(size || '1024x1024').split('x').map(Number)
  const r = await fetch(API, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt, negative_prompt: 'lowres, bad anatomy, text, watermark', width, height, steps: 25, cfg_scale: 6 }),
    signal: AbortSignal.timeout(300000),
  })
  if (!r.ok) throw new Error(`SD WebUI 返回 ${r.status}：${(await r.text()).slice(0, 200)}`)
  const j = await r.json()
  if (!j.images?.[0]) throw new Error('SD WebUI 没返回图片')
  log.info(`本地画好了：${prompt.slice(0, 30)}`)
  return { base64: j.images[0] }
}
