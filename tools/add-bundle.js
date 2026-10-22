const fs = require("fs")
const [pkgPath, name] = process.argv.slice(2)
const raw = fs.readFileSync(pkgPath, "utf8").replace(/^﻿/, "")
  // ★ 去 BOM：记事本 / PS 5.1 的 Set-Content -Encoding UTF8 会在开头写 U+FEFF，
  //   而 JSON.parse 不认它（报 Unexpected token）。带 BOM 的 profile package.json
  //   是真实会遇到的，这里吃掉它比让用户对着 SyntaxError 发愣好。
  const j = JSON.parse(raw)
j.dsh = j.dsh || {}
j.dsh.profile = j.dsh.profile || {}
const b = (j.dsh.profile.bundles = j.dsh.profile.bundles || [])
if (b.includes(name)) { console.log("already") }
else {
  b.push(name)
  fs.writeFileSync(pkgPath, JSON.stringify(j, null, 2) + "\n", "utf8")
  console.log("added")
}
