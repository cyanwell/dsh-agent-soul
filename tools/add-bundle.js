const fs = require("fs")

// 把 name 加进 <profile>/package.json 的 dsh.profile.bundles。
//
// ★ 这个脚本会被 install.js / install-desktop.ps1 / 用户手工命令同时调用（N10，2026-10-22）。
//   原来是「读 → 改 → 整文件覆盖写」—— 两个进程撞在一起时，
//   后写的会把前一次的 bundles.push 整个盖掉，**静默丢一个插件**。
//   症状是「装上了但没启用」，没有任何报错，很难查。
//
// ★ 修法两层：
//   ① 乐观锁：写前重读一次，比对 size + mtime，变了就重来（最多 3 次）。
//   ② 原子写：先写 .tmp，再 rename 顶替。rename 在同一卷上是原子的，
//      所以读的一方要么看到旧的、要么看到新的，不会看到半截 JSON。
//   不做锁文件 —— 进程崩溃会留下残留锁，那比丢一次更新更难收拾。

const [pkgPath, name] = process.argv.slice(2)
if (!pkgPath || !name) {
  console.error("用法: node add-bundle.js <profile>/package.json <包名>")
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

  if (b.includes(name)) {
    console.log("already")
    done = true
    break
  }
  b.push(name)

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
  console.log("added")
  done = true
}
