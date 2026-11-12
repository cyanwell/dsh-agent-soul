// 检查更新：读 GitHub 上主分支的 package.json，比版本号。结果缓存 6 小时。

/** 比较 x.y.z：a > b 返回正数。 */
export function compareVersions(a, b) {
  const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0)
  const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0)
  return 0
}

/** 从 repository.url 拿 owner/repo。 */
export function repoOf(pkg) {
  const url = typeof pkg?.repository === 'string' ? pkg.repository : pkg?.repository?.url || ''
  const m = String(url).match(/github\.com[/:]([^/]+)\/([^/.]+)/)
  return m ? `${m[1]}/${m[2]}` : ''
}

/** 更新命令：把安装命令再跑一次就会拉到最新版。 */
export function updateCommand(repo) {
  return `& "$env:LOCALAPPDATA\\Programs\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd" plugin --profile desktop add github:${repo}`
}

export function createUpdateChecker({ pkg, log, fetchImpl = fetch }) {
  let cache = null
  return async function check({ force = false } = {}) {
    const repo = repoOf(pkg)
    if (!repo) return { ok: false, current: pkg.version, message: '不知道从哪检查更新' }
    if (!force && cache && Date.now() - cache.at < 6 * 3600_000) return cache.value
    try {
      // raw.githubusercontent.com 国内常连不上，不行就走 jsDelivr
      let latest = ''
      let lastError = null
      for (const url of [`https://raw.githubusercontent.com/${repo}/main/package.json`, `https://cdn.jsdelivr.net/gh/${repo}@main/package.json`]) {
        try {
          const r = await fetchImpl(url, { signal: AbortSignal.timeout(8000) })
          if (!r.ok) throw new Error('HTTP ' + r.status)
          latest = (await r.json()).version
          if (latest) break
        } catch (error) {
          lastError = error
        }
      }
      if (!latest) throw lastError || new Error('拿不到版本号')
      const value = { ok: true, current: pkg.version, latest, newer: compareVersions(latest, pkg.version) > 0, repo, command: updateCommand(repo) }
      cache = { at: Date.now(), value }
      return value
    } catch (error) {
      log?.debug('检查更新失败：', error.message)
      return { ok: false, current: pkg.version, message: '检查更新失败：' + error.message }
    }
  }
}

/** CHANGELOG.md 里某个版本那一段（「## 0.3.0」到下一个「## 」）。 */
export function changelogSection(text, version) {
  const lines = String(text || '').split(/\r?\n/)
  const start = lines.findIndex((l) => new RegExp(`^##\\s+v?${String(version).replace(/\./g, '\\.')}\\b`).test(l))
  if (start < 0) return ''
  const end = lines.findIndex((l, i) => i > start && /^##\s/.test(l))
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim()
}
