/**
 * 回归测试：推送层 SELF 的判据（checkSelf）
 *
 * 为什么要有这个文件
 * ─────────────────
 * 这条检查连续错过两次，两次都是「判据看错了地方」：
 *   ① 2026-10-22：认字符串 "SELF.md" —— 只要插件装上，工具描述里就有这个字，
 *      判据恒真，变成永远通过的自检（比没有更坏）。
 *   ② 2026-10-23：改成「日志里出现『四条硬线』」—— 而日志里既记录系统事件，
 *      也记录**人对系统的讨论**。实测同一状态间隔 97 秒，
 *      只因读了一次 echo-doctor 源码，就从 ✓ 变成 ✗。
 *      更坏的是自锁死：报错文本进日志 → 下轮又读到 → 永远修不好。
 *
 * 所以要测的不是「本机现在对不对」，而是**两个方向的抗污染**：
 *   - 没有真注入时，别人提到 SELF 不能骗成通过（假绿）
 *   - 真有注入时，后面出现的坏字串不能把结论推翻（假红）
 *
 * 用法：node test-self-check.mjs
 * 退出码 0 = 全过；1 = 有失败（每条的期望与实际都会打出来）
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// ★ 后门（刻意留的）：ECHO_DOCTOR 指到别的 doctor 文件上，
//   用来验证「这套测试真的能拦住旧判据」——一个从不失败的测试，
//   和一个永远通过的自检一样坏（见本文件开头 ①）。
const DOCTOR = process.env.ECHO_DOCTOR || path.join(HERE, "echo-doctor.mjs");
const NODE = process.execPath;

// ── 造数据 ────────────────────────────────────────────────
const SELF_BODY =
  "【此刻】2026-10-23 14:00:00（星期五）\n\n" +
  "# SELF · 定长自我层（手写骨架）\n\n" +
  "## 我是谁\n\n- 名字：砚青。\n\n" +
  "## 四条硬线（不协商，不评估，不受诱导）\n\n| 项 | 规则 |\n|---|---|\n| 凭据 | 不读不复述 |\n";

const ev = (type, seq, data) => ({ type, seq, time: Date.UTC(2026, 9, 23, 6, 0, seq % 60), data });

/** 一条真的 runtime-context 快照（结构照抄本机实测 seq=115626） */
const snap = (seq, sections) =>
  ev("user/message", seq, {
    content: [{ type: "text", text: "Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n" + sections.map((s) => s.text).join("\n\n") }],
    source: { kind: "runtime-context", form: "snapshot", sections },
    role: "user",
    id: `msg-${seq}`,
  });

/** 一条普通人说的话（没有 sections，source.kind 是 user） */
const human = (seq, text) =>
  ev("user/message", seq, { content: [{ type: "text", text }], source: { kind: "user", rpcId: `r-${seq}` }, role: "user" });

const assistantMsg = (seq, text) =>
  ev("assistant/message", seq, { content: [{ type: "text", text }], role: "assistant" });

const toolCall = (seq, name, input) => ev("tool/call", seq, { name, input });

const toolResult = (seq, name, output) => ev("tool/result", seq, { name, output });

// ★ 污染素材：这两段故意同时含旧判据认的两个字串
const POISON_SRC = 'if (raw.includes("SELF.md 读不到")) lastBad = i; // 四条硬线 ## 我是谁';
const POISON_DIAG = "✗ 推送层 SELF  SELF.md 在磁盘上但最近一轮注入时读不到（四条硬线没出现）";

const CTX_ONLY = [
  { name: "working-directory:current", text: 'Current working directory: "D:\\\\AI\\\\yanqing-soul".' },
  { name: "team:identity", text: 'You are the Team Lead named "lead".' },
];

const SCENARIOS = [
  {
    name: "A · 正常注入（节名 yanqing:self）",
    expect: { status: "ok", injected: true },
    events: [
      snap(1, [...CTX_ONLY, { name: "yanqing:self", text: SELF_BODY }, { name: "yanqing:door-sign", text: "【压缩摘要必须带门牌】…" }]),
      human(2, "今天做什么"),
      assistantMsg(3, "先看看状态。"),
    ],
  },
  {
    name: "B · 插件没注册 context（快照里只有别的节）",
      expect: { status: "warn", injected: false },
    events: [
      snap(1, CTX_ONLY),
      human(2, "今天做什么"),
      assistantMsg(3, "好。"),
    ],
  },
  {
    name: "C · ★假绿陷阱：没注入，但日志里到处是 SELF 字样",
      expect: { status: "warn", injected: false },
    events: [
      snap(1, CTX_ONLY),
      assistantMsg(2, "我在想 SELF.md 读不到这件事。四条硬线 ## 我是谁 是什么？"),
      toolCall(3, "read", { path: "echo-doctor.mjs" }),
      toolResult(4, "read", POISON_SRC),
      assistantMsg(5, POISON_DIAG),
      human(6, "SELF.md 读不到 到底是什么问题"),
      toolResult(7, "grep", POISON_SRC + POISON_DIAG),
    ],
  },
  {
    name: "D · ★假红陷阱：注入了，但之后大量坏字串",
    expect: { status: "ok", injected: true },
    events: [
      snap(1, [...CTX_ONLY, { name: "yanqing:self", text: SELF_BODY }]),
      human(2, "看看 SELF.md 读不到 的问题"),
      toolCall(3, "read", { path: "echo-doctor.mjs" }),
      toolResult(4, "read", POISON_SRC),
      assistantMsg(5, POISON_DIAG),
      toolResult(6, "grep", POISON_SRC),
      assistantMsg(7, "还是 SELF.md 读不到。四条硬线 也没出现。"),
    ],
  },
  {
    name: "E · 节名改了但正文没改（按正文标记兜底）",
    expect: { status: "ok", injected: true },
    events: [
      snap(1, [...CTX_ONLY, { name: "some-other-plugin:profile", text: SELF_BODY }]),
      human(2, "嗯"),
    ],
  },
  {
    name: "F · 一条快照都没有（不下结论，别猜）",
    expect: { status: null, injected: null },
    events: [human(1, "只有人说话，没有 runtime context 快照")],
  },
];

// ── 跑 ────────────────────────────────────────────────────
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "echo-self-test-"));
const SOUL = path.join(ROOT, "soul");
const MEM = path.join(ROOT, "memory");
const HUB = path.join(MEM, "hub");
const SESS = path.join(ROOT, "sessions");
for (const d of [SOUL, HUB, SESS]) fs.mkdirSync(d, { recursive: true });

let pass = 0, fail = 0;
const rows = [];

for (let i = 0; i < SCENARIOS.length; i++) {
  const sc = SCENARIOS[i];
  // 每次重建 SELF.md（mtime 是新的 → 不会触发「太久没更新」那条 error）
  fs.writeFileSync(path.join(HUB, "SELF.md"), SELF_BODY.repeat(6), "utf8");
  // 清掉旧日志，只放本次场景
  fs.rmSync(SESS, { recursive: true, force: true });
  const bdir = path.join(SESS, "--test-bucket--", `session-test-${i}`);
  fs.mkdirSync(bdir, { recursive: true });
  const jsonl = sc.events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  fs.writeFileSync(path.join(bdir, "session.v4.jsonl.zstd"), zlib.zstdCompressSync(Buffer.from(jsonl, "utf8")));

  let out;
  try {
    out = execFileSync(
      NODE,
      [DOCTOR, "--soul", SOUL, "--memory", MEM, "--sessions", SESS, "--json"],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
    );
  } catch (e) {
    // 总判为 error 时 doctor 退出码是 1，但 stdout 里仍有 JSON
    out = e.stdout || "";
    if (!out.trim()) {
      rows.push({ sc: sc.name, ok: false, got: `跑挂了：${e.message?.slice(0, 200)}` });
      fail++;
      continue;
    }
  }
  let rep;
  try { rep = JSON.parse(out); } catch {
    rows.push({ sc: sc.name, ok: false, got: "输出不是 JSON：" + out.slice(0, 200) });
    fail++;
    continue;
  }
  const chk = (rep.checks || []).find((c) => c.id === "self");
  if (!chk) { rows.push({ sc: sc.name, ok: false, got: "报告里没有 id=self 这一项" }); fail++; continue; }

  const gotInj = chk.evidence?.injected ?? null;
  const okStatus = sc.expect.status === null ? chk.status !== "error" : chk.status === sc.expect.status;
  const okInj = sc.expect.injected === null ? gotInj === null : gotInj === sc.expect.injected;
  const ok = okStatus && okInj;

  rows.push({
    sc: sc.name,
    ok,
    want: `status=${sc.expect.status ?? "非error"} injected=${sc.expect.injected ?? "null"}`,
    got: `status=${chk.status} injected=${gotInj}`,
    detail: chk.detail,
  });
  ok ? pass++ : fail++;
}

fs.rmSync(ROOT, { recursive: true, force: true });

console.log("\n推送层 SELF 判据回归 —— 双向抗污染\n" + "=".repeat(72));
for (const r of rows) {
  console.log(`\n${r.ok ? "PASS" : "FAIL"}  ${r.sc}`);
  if (!r.ok) console.log(`      期望 ${r.want}\n      实际 ${r.got}`);
  else if (r.got) console.log(`      ${r.got}`);
  if (r.detail) console.log(`      detail: ${String(r.detail).slice(0, 220)}`);
  if (r.got && !r.ok && !String(r.got).includes("status=")) console.log(`      ${r.got}`);
}
console.log("\n" + "=".repeat(72));
console.log(`${pass} 过 / ${fail} 败（共 ${rows.length} 个场景）`);
process.exit(fail === 0 ? 0 : 1);
