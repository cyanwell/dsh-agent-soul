#!/usr/bin/env node
/**
 * install-kit · 把**插件真正用到的那几个**脚本装进记忆中枢，并记下它们从哪来。
 *
 * ★★ 为什么只装两个文件，而不是整套（2026-10-23 实测，这条是踩出来的）
 *
 *   一开始写的是「复制 kit/echo/*.mjs 全部」。部署前顺手比了一下，发现：
 *
 *     memindex.mjs   HUB 24496 B（今天修了逐帧解码）  kit 23412 B（还是旧的）
 *     self.mjs       HUB 12886 B（今天加了 lastSelfAt）kit 11353 B（还是旧的）
 *     memq.mjs       HUB 23441 B（10-07）            kit 23451 B（10-18）
 *     echo.mjs       HUB 14237 B（10-09）            kit 14704 B（10-18）
 *
 *   —— 两边**各自领先**。整份复制会把 HUB 里今天刚修好的那两个盖回旧版。
 *   而且 HUB 版里有写死的本机绝对路径（`D:/AI/memory/hub` 这种），
 *   直接搬回仓库也不行，得先把它改写成变量。
 *
 *   ★ 所以划一条线：**只有「插件直接 spawn / import 的」才由仓库提供**。
 *     `echo-doctor.mjs` 被面板 spawn，它 import `echo-config.mjs` —— 这两个是一套。
 *     其余（memq / self / memindex / echo）在每台机器上按自己的中枢位置演化，
 *     **不该由仓库覆盖**，它们只会拽回归属。
 *
 *   要整套装也可以，`--all` 会带上并明确警告。
 *
 * ★ 光「复制」还不够，必须**留下来源**。
 *   只复制的话，下次谁也不知道 HUB 里这套是从哪个仓库、哪一版拷来的，
 *   自然也就没法判断「仓库升级了，HUB 是不是该跟」。
 *   所以除了拷文件，还写一份 `.kit-origin.json`：
 *     来源目录 / 拷贝时刻 / 仓库版本 / 每个文件的大小
 *   `echo-doctor` 的「部署一致性」那一项就读它来判断。
 *
 * 用法：
 *   node kit/echo/install-kit.mjs                 # 装到 $ECHO_HUB 或 $DSH_HOME/hub
 *   node kit/echo/install-kit.mjs --hub <目录>    # 指定目标
 *   node kit/echo/install-kit.mjs --check         # 只比对，不写
 *   node kit/echo/install-kit.mjs --all           # 整套（会覆盖中枢里的同名脚本，慎用）
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ORIGIN_NAME = ".kit-origin.json";

/** 插件直接 spawn / import 的脚本 —— 只有这些归仓库管 */
const KIT_SET = ["echo-doctor.mjs", "echo-config.mjs"];

function parseArgs(argv) {
  const out = { hub: "", check: false, all: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") out.check = true;
    else if (a === "--all") out.all = true;
    else if (a === "--hub") out.hub = argv[++i] || "";
    else if (a.startsWith("--hub=")) out.hub = a.slice(6);
  }
  return out;
}

/** 目标中枢：--hub > $ECHO_HUB > $DSH_HOME/hub > ~/.dsh/hub */
function resolveHub(cliHub) {
  if (cliHub) return path.resolve(cliHub);
  if (process.env.ECHO_HUB) return path.resolve(process.env.ECHO_HUB);
  const dshHome = process.env.DSH_HOME || process.env.ECHO_DSH_HOME;
  if (dshHome) return path.join(dshHome, "hub");
  return path.join(os.homedir(), ".dsh", "hub");
}

/** 仓库版本 —— 往上找 package.json，找不到就 null（不是错） */
function repoVersion() {
  let dir = HERE;
  for (let i = 0; i < 6; i++) {
    const p = path.join(dir, "package.json");
    try {
      const pj = JSON.parse(fs.readFileSync(p, "utf8"));
      if (pj && pj.version) return String(pj.version);
    } catch { /* 继续往上 */ }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

function listKit(all) {
  const files = [];
  for (const name of fs.readdirSync(HERE)) {
    if (!name.endsWith(".mjs")) continue;
    if (name === "install-kit.mjs") continue; // 它自己不用装过去
    if (!all && !KIT_SET.includes(name)) continue;
    const st = fs.statSync(path.join(HERE, name));
    files.push({ name, size: st.size });
  }
  files.sort((a, b) => a.name.localeCompare(b.name));
  return files;
}

function readOrigin(hub) {
  try { return JSON.parse(fs.readFileSync(path.join(hub, ORIGIN_NAME), "utf8")) } catch { return null }
}

const args = parseArgs(process.argv.slice(2));
const hub = resolveHub(args.hub);
const kitFiles = listKit(args.all);

if (!kitFiles.length) {
  console.error(`✗ 在 ${HERE} 里没找到要装的 .mjs —— 这个脚本得从 kit/echo/ 里跑`);
  process.exit(2);
}


if (args.check) {
  const origin = readOrigin(hub);
  let drift = 0;
  console.log(`源  ${HERE}`);
  console.log(`目标 ${hub}${fs.existsSync(hub) ? "" : "（不存在）"}`);
  console.log(origin ? `来源记录 ${origin.copiedAt} · 仓库版本 ${origin.version || "未知"}` : "来源记录（无 —— 这套不知道从哪来）");
  console.log("");
  for (const f of kitFiles) {
    const t = path.join(hub, f.name);
    let mark = "·";
    let note = "";
    if (!fs.existsSync(t)) { mark = "✗"; note = "HUB 里没有"; drift++ }
    else {
      const ts = fs.statSync(t).size;
      if (ts !== f.size) { mark = "≠"; note = `HUB ${ts} B vs 源 ${f.size} B`; drift++ }
      else note = "一致";
    }
    console.log(`  ${mark} ${f.name.padEnd(26)} ${note}`);
  }
  console.log("");
  console.log(drift ? `发现 ${drift} 处不一致 —— 目标需要重装` : "全部一致");
  process.exit(drift ? 1 : 0);
}

// ---- 真的装 ----
if (!fs.existsSync(hub)) {
  fs.mkdirSync(hub, { recursive: true });
  console.log(`建了目录 ${hub}`);
}

let copied = 0;
const notes = [];
for (const f of kitFiles) {
  const src = path.join(HERE, f.name);
  const dst = path.join(hub, f.name);
  let before = -1;
  try { before = fs.statSync(dst).size } catch { /* 新文件 */ }
  fs.copyFileSync(src, dst);
  copied++;
  if (before < 0) notes.push(`  + ${f.name}（新增 ${f.size} B）`);
  else if (before !== f.size) notes.push(`  ≠ ${f.name}（${before} B → ${f.size} B）`);
}

const origin = {
  kitDir: HERE,
  copiedAt: new Date().toISOString(),
  version: repoVersion(),
  host: os.hostname(),
  files: Object.fromEntries(kitFiles.map((f) => [f.name, f.size])),
};
fs.writeFileSync(path.join(hub, ORIGIN_NAME), JSON.stringify(origin, null, 2) + "\n", "utf8");

console.log(`装了 ${copied} 个脚本 → ${hub}`);
if (notes.length) {
  console.log("变化：");
  for (const n of notes) console.log(n);
} else {
  console.log("（内容和已装的一致，只更新了来源记录）");
}
console.log(`来源已记入 ${ORIGIN_NAME}（仓库版本 ${origin.version || "未知"}）`);
console.log("");
console.log("★ 下次从仓库拉了新版本，重跑这一条就行：");
console.log(`   node "${path.join(HERE, "install-kit.mjs")}"`);
