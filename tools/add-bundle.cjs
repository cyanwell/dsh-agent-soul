const fs = require("fs")

// 把 name 加进 <profile>/package.json 的 dsh.profile.bundles；
// 可选地同时登记进 dependencies。
//
// 用法：
//   node add-bundle.cjs <profile>/package.json <包名>
//   node add-bundle.cjs <profile>/package.json <包名> <depValue>
//
// ★ 第三个参数是 2026-10-22 加的（外部验证报告 v3 的 N1）。不传就只写 bundles，
//   保持旧行为；传了就顺手把 dependencies[name] 也写上。
//
// ★★★ 为什么必须一起写（N1 的病根）
//
//   桌面脚本是「把文件拷进 node_modules → 再把名字加进 bundles」，
//   它**不写 dependencies**。而装配计划的下一步就是 `dsh plugin add` 装零件，
//   pnpm 在那一轮会把「没写进 dependencies 的 node_modules 子目录」当作 extraneous 清掉。
//   于是出现这个非常难查的序列：
//
//     ① 装本体 → 启动正常、客户端半加载 → 看起来成了
//     ② 装下一个零件（dsh plugin add）→ pnpm 顺手删掉本体
//     ③ 再启动 → dsh: skipping profile bundle "dsh-agent-soul": cannot resolve profile bundle
//
//   **装完就被剪掉，而且要等到下次启动才发现。**
//   报告的原话是「桌面（Electron）是否同路径未实测，但风险相同」——
//   机制上一样，所以按一样处理。
//
// ★ 为什么 depValue 由调用方给、不在这里猜：
//   `file:` 后面的路径该怎么写，取决于包实际被拷到哪。写死了换一种安装方式就错。
//   调用方（install-desktop.ps1）知道路径，让它说；这个脚本只负责写进去。
//
// ★★ 桌面脚本传的是 `file:node_modules/dsh-agent-soul` —— **一个自引用路径**。
//    报告 v4 观察项 2 指出：正常 `dsh plugin add` 不会剪掉本体（已验），
//    但 `rm -rf node_modules && pnpm install` 时，源就是那个被删掉的目录本身，恢复不了。
//
//    这是这种装法的**必然结果** —— 桌面脚本本来就是把文件拷进 node_modules，
//    源只有那一份。改成「拷到别处再 link」要重做整条安装路径，风险远大于收益。
//    所以这里不改机制，只把边界说清：
//
//      **删 node_modules 之前，先确认手里有仓库或 tarball。**
//      删了之后想恢复，重新跑一遍 install-desktop.ps1 就行（它会重新拷一遍）。
//
// ★ 保留原有的并发保护（N10，2026-10-22）：
//   ① 乐观锁：写前重读一次，比对 size + mtime，变了就重来（最多 3 次）。
//   ② 原子写：先写 .tmp，再 rename 顶替。rename 在同一卷上是原子的，
//      所以读的一方要么看到旧的、要么看到新的，不会看到半截 JSON。
//   不做锁文件 —— 进程崩溃会留下残留锁，那比丢一次更新更难收拾。

const [pkgPath, name, depValue] = process.argv.slice(2)
if (!pkgPath || !name) {
  console.error("用法: node add-bundle.cjs <profile>/package.json <包名> [depValue]")
  process.exit(2)
}

const sig = () => {
  const s = fs.statSync(pkgPath)
  return `${s.size}:${s.mtimeMs}`
}

function readJson() {
  // ★ 去 BOM：记事本 / PS 5.1 的 Set-Content -Encoding UTF8 会在开头写 U+FEFF，
  //   而 JSON.parse 不认它（报 Unexpected token）。带 BOM 的 profile package.json
  //   是真实会遇到的，这里吃掉它比让用户对着 SyntaxError 发愣好。
  const raw = fs.readFileSync(pkgPath, "utf8").replace(/^\uFEFF/, "")
  return JSON.parse(raw)
}

let done = false
for (let attempt = 1; attempt <= 3 && !done; attempt++) {
  const before = sig()
  const j = readJson()

  j.dsh = j.dsh || {}
  j.dsh.profile = j.dsh.profile || {}
  const b = (j.dsh.profile.bundles = j.dsh.profile.bundles || [])

  const inBundles = b.includes(name)

  // dependencies 这边单独算 —— 两者可能一个有一个没有（旧版脚本留下的就是这个状态）。
  let needDep = false
  if (depValue) {
    j.dependencies = j.dependencies || {}
    needDep = j.dependencies[name] !== depValue
  }

  if (inBundles && !needDep) {
    // ★ 用 already 这个词，因为 install-desktop.ps1 靠它匹配来决定说「跳过」还是「已加」。
    console.log("already")
    done = true
    break
  }

  if (!inBundles) b.push(name)
  if (depValue) j.dependencies[name] = depValue

  // 乐观锁：从「读」到「写」之间要是有人动过这个文件，就重来。
  if (sig() !== before) {
    if (attempt < 3) continue
    console.error(
      `✗ ${pkgPath} 在读写之间被别的进程改了 ${attempt} 次，放弃。\n` +
        `  这不是你的错 —— 通常是同时开了两个安装。等它跑完再试一次；\n` +
        `  bundles 现在是：${JSON.stringify(j.dsh.profile.bundles)}`,
    )
    process.exit(3)
  }

  const tmp = `${pkgPath}.tmp-add-bundle-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(j, null, 2) + "\n", "utf8")
  try {
    fs.renameSync(tmp, pkgPath)
  } catch (e) {
    try { fs.unlinkSync(tmp) } catch { /* 清不掉就算了，别盖住真正的错 */ }
    throw e
  }

  // ★ 输出说清到底改了哪一样 —— 「added」这个词太笼统，
  //   而 bundles 与 dependencies 是两件事，混在一起说会让人以为都好了。
  if (!inBundles && needDep) console.log("added")
  else if (!inBundles) console.log("added")
  else console.log("added-deps") // bundles 本来就有，只补了 dependencies
  done = true
}
