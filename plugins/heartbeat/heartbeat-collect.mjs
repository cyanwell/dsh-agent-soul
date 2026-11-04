#!/usr/bin/env node
// heartbeat-collect.mjs —— 巡视的「素材收集」
// 只做只读收集，不做判断、不改任何东西。产物是一份 markdown 简报，
// 由【主导会话下一次在场时】读它并决定做什么。

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { resolveAll } from '../../lib/paths.mjs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

// ★ 2026-11-04 修死路径：从 DSH_HOME 推导，可用环境变量覆盖。
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const _p = resolveAll();
const AI_ROOT = _p.memory.path ? dirname(_p.memory.path) : dirname(dirname(DSH_HOME));
const SOUL = process.env.YQ_SOUL || join(AI_ROOT, 'yanqing-soul');
const HUB = process.env.YQ_HUB || join(AI_ROOT, 'memory', 'hub');
const HERE = process.env.YQ_HB_DIR || join(AI_ROOT, 'dsh-tools', 'dsh-yanqing-heartbeat');
const NODE = process.execPath;
const OUT = HERE + "/last-collect.md";
const now = new Date();
const sections = [];
const push = (t, b) => sections.push('## ' + t + '\n\n' + b + '\n');
const run = (args) => {
  try { return execFileSync(NODE, args, { encoding: "utf8", timeout: 60000 }).trim(); }
  catch (e) { return "[收集失败] " + String(e.message || "").split("\n")[0]; }
};
const FENCE = String.fromCharCode(96).repeat(3);

// 1) 《墨》未结承诺
const MO = join(AI_ROOT, 'memory', 'tools', 'mo.mjs');
if (existsSync(MO)) {
  const raw = run([MO, "list", "--type", "promise", "--limit", "8"]);
  // ★ 简报不该倾倒原文：每条压到一行 + 100 字，完整内容让他按 ref 自己去取
  const slim = raw
    .split("\n")
    .map(l => l.trim())
    .filter(l => /^\d{4}-\d{2}-\d{2}/.test(l))
    .map(l => "  " + l.slice(0, 130) + (l.length > 130 ? "…" : ""))
    .join("\n");
  const head = raw.split("\n")[0] || "";
  push("未结承诺（压缩版 · 全文用 ref 取）", head + "\n" + FENCE + "\n" + (slim || "(无)") + "\n" + FENCE);
}

// 2) v3 执行进度
const PLAN = join(SOUL, '20-档案', 'agent soul v3升级方案', '执行清单.md');
if (existsSync(PLAN)) {
  const txt = readFileSync(PLAN, "utf8");
  const i = txt.indexOf("## 六、实际进度");
  push("v3 执行进度", i >= 0 ? txt.slice(i, i + 900) : "(还没写进度段)");
}

// 3) 方案目录文件清单
const DOCDIR = join(SOUL, '20-档案', 'agent soul v3升级方案');
if (existsSync(DOCDIR)) {
  const list = readdirSync(DOCDIR).sort().map(f => "  - " + f).join("\n");
  push("方案目录文件", list);
}

// 4) 心跳最近记录
const LOG = join(HERE, "heartbeat.log.jsonl");
if (existsSync(LOG)) {
  const arr = readFileSync(LOG, "utf8").trim().split("\n");
  push("心跳最近 5 次", FENCE + "\n" + arr.slice(-5).join("\n") + "\n" + FENCE);
}

const header = [
  "# 巡视素材 · " + now.toISOString(),
  "",
  "> 由 heartbeat-collect.mjs 自动收集。**只读，不做判断。**",
  "> 用途：主导会话下一次在场时读它，决定要不要做什么。",
  "> ★ 如果这里没有值得做的事 —— 那就什么都不做。**健康的自主是不产出消息的自主。**",
  "",
].join("\n");
const footer = "\n---\n*收集于 " + now.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) + "*\n";
writeFileSync(OUT, header + sections.join("\n") + footer, "utf8");
console.log("✓ 巡视素材: " + OUT + "  (" + sections.length + " 个板块)");