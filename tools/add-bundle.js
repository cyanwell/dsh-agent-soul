const fs = require("fs")
const [pkgPath, name] = process.argv.slice(2)
const j = JSON.parse(fs.readFileSync(pkgPath, "utf8"))
j.dsh = j.dsh || {}
j.dsh.profile = j.dsh.profile || {}
const b = (j.dsh.profile.bundles = j.dsh.profile.bundles || [])
if (b.includes(name)) { console.log("already") }
else {
  b.push(name)
  fs.writeFileSync(pkgPath, JSON.stringify(j, null, 2) + "\n", "utf8")
  console.log("added")
}
