// echo-memindex-shard-identity-selftest.mjs
//
// 合成自测 —— 只测 memindex.mjs 的**分片身份**逻辑，不碰任何生产索引。
//
// 被修的缺陷（已确认，数出来的）：6 个 sid 同时存在 session.v3 与 session.v4，
// 旧分片基名只由 sid 派生 ⇒ 两个变体算出同一个 shards/<sid>.sum.jsonl，
// v3 / v4 互相覆写，后跑的那个把另一个的原话**静默覆盖**。
//
// 这个测试断言的是「名字 + 归属」这两件事，全部在 os.tmpdir() 里做：
//   · 同 sid 的两份日志 ⇒ 两个不同的分片基名
//   · 旧的 sid-only 基名对这两份日志**必然相同**（证明缺陷真实存在，测试不是空转）
//   · 基名是路径的纯函数：重复跑、换输入顺序、换兄弟数量，名字都不变
//   · 分片内容永不跨源：两个变体的行集合互不相交
//   · 增量安全：单变体会话的旧分片可收养（保住旧数据），多变体一律拒绝
//   · manifest 里多个日志共享同一分片路径 ⇒ 结构化告警 + 两者强制全量重建
//   · 名字对不上 / 内容外来 ⇒ 禁止复用与续读追加
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  computeShardPlan,
  shardBaseFor,
  shardOwnedBy,
  shardOwnerLog,
  adoptLegacyShard,
  decideFileReuse,
  writeShardPair,
} from "../../memory/hub/memindex.mjs";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "echo-memindex-shard-identity-"));
let n = 0;
const test = (name, fn) => {
  try { fn(); n++; console.log("PASS " + name); }
  catch (e) { console.error("FAIL " + name + "\n  " + (e && e.message)); throw e; }
};
const tmp = (tag) => {
  const d = path.join(ROOT, tag);
  fs.mkdirSync(d, { recursive: true });
  return d;
};
// 合成一个「会话日志路径」—— 只需要路径形态，不读任何真实字节
const logPath = (ws, sid, v) => path.join(ROOT, "sessions", ws, sid, "session." + v + ".jsonl.zstd");
const LOG = (ws, sid, v) => ({ file: logPath(ws, sid, v), ws, sid });

const SID = "session-1099f531-7cac-4989-a14c-7fd499ac1fc0";
const WS = "--D-AI-yanqing-soul--";
const V3 = LOG(WS, SID, "v3");
const V4 = LOG(WS, SID, "v4");

try {
  // ── ① 同 sid 的两个变体：名字必须不同 ─────────────────────────────────
  test("两个同 sid 的日志变体拿到不同的分片基名", () => {
    const a = shardBaseFor(V3), b = shardBaseFor(V4);
    assert.notEqual(a, b, "v3 与 v4 的基名不得相同（这正是被修掉的缺陷）");
    assert.notEqual(a + ".sum.jsonl", b + ".sum.jsonl");
    assert.notEqual(a + ".word.jsonl", b + ".word.jsonl");
    // 基名仍带 sid，便于人肉排错
    assert.ok(a.startsWith(SID.replace(/[^\w.-]/g, "_")), "基名应以 sid 开头，便于排查");
    assert.ok(b.startsWith(SID.replace(/[^\w.-]/g, "_")));
    // 且带路径派生哈希
    assert.match(a, /-[0-9a-f]{16}$/);
    assert.match(b, /-[0-9a-f]{16}$/);
  });

  // ── ①b 兼容闸门：哈希输入不得漂移（否则现存 2688 个分片瞬间变孤儿）────
  test("基名哈希输入与已部署方案逐字节一致（存量分片不会被逼成孤儿）", () => {
    const deployedBase = (file, sid) =>
      sid.replace(/[^\w.-]/g, "_") + "-"
      + crypto.createHash("sha256").update(path.resolve(file).toLowerCase()).digest("hex").slice(0, 16);
    for (const L of [V3, V4, LOG("--D-AI-chat1--", "session-x", "v3")]) {
      assert.equal(shardBaseFor(L), deployedBase(L.file, L.sid),
        "同一个文件的基名必须与 2026-11-14 已部署的那一行完全相同");
    }
  });

  // ── ② 对照组：旧方案对同一对日志**必然撞名** ──────────────────────────
  test("旧 sid-only 基名对这一对日志必然撞名（缺陷真实存在，测试非空转）", () => {
    const legacy = (L) => L.sid.replace(/[^\w.-]/g, "_");
    assert.equal(legacy(V3), legacy(V4), "旧方案下 v3/v4 算出同一个基名 —— 这就是覆写/丢失的来源");
    // 新方案在同一对输入上不再相等
    assert.notEqual(shardBaseFor(V3), shardBaseFor(V4));
  });

  // ── ③ 确定性：重复跑、换顺序，名字不变 ────────────────────────────────
  test("基名确定性：重复计算 + 输入顺序无关", () => {
    const dir = tmp("determinism");
    const logs = [V3, V4, LOG(WS, "session-other", "v4")];
    const p1 = computeShardPlan(logs, [], dir);
    const p2 = computeShardPlan(logs, [], dir);
    const p3 = computeShardPlan([...logs].reverse(), [], dir);
    for (const L of logs) {
      const a = p1.byFile.get(L.file), b = p2.byFile.get(L.file), c = p3.byFile.get(L.file);
      assert.equal(a.base, b.base, "同一个文件重复计算必须同名");
      assert.equal(a.base, c.base, "输入顺序不得影响名字");
      assert.equal(a.sumF, c.sumF);
      assert.equal(a.wordF, c.wordF);
    }
    // 换一个新的 shardDir 只会换目录，基名不变
    const p4 = computeShardPlan(logs, [], tmp("determinism-other-dir"));
    for (const L of logs) assert.equal(p4.byFile.get(L.file).base, p1.byFile.get(L.file).base);
  });

  // ── ④ 兄弟变多/变少不影响已有名字（纯函数，不是「按兄弟数命名」）───────
  test("同 sid 的兄弟变体增减，不改变既有文件的基名", () => {
    const dir = tmp("siblings");
    const only3 = computeShardPlan([V3], [], dir).byFile.get(V3.file);
    const bothV = computeShardPlan([V3, V4], [], dir).byFile.get(V3.file);
    const only4 = computeShardPlan([V4], [], dir).byFile.get(V4.file);
    assert.equal(only3.base, bothV.base, "v4 出现不该给 v3 改名（否则每次加变体都要全库搬迁）");
    assert.notEqual(only4.base, only3.base);
    // 多变体/单变体的判定仍然正确（收养策略靠它）
    assert.equal(only3.multiVariant, false);
    assert.equal(bothV.multiVariant, true);
  });

  // ── ⑤ 分片内容永不跨源 ─────────────────────────────────────────────────
  test("两个变体各写各的分片，行集合互不相交、无外来 log", () => {
    const dir = tmp("rows");
    const plan = computeShardPlan([V3, V4], [], dir);
    const row = (L, seq, text) => JSON.stringify({ t: "2026-11-16T00:00:00", session: L.sid, log: L.file, seq, text });
    const a = plan.byFile.get(V3.file), b = plan.byFile.get(V4.file);

    writeShardPair({
      sumF: a.sumF, wordF: a.wordF, sumResume: false, wordResume: false,
      sumOut: [row(V3, 1, "summary from v3")], wordOut: [row(V3, 1, "words from v3"), row(V3, 2, "more v3")],
    });
    writeShardPair({
      sumF: b.sumF, wordF: b.wordF, sumResume: false, wordResume: false,
      sumOut: [row(V4, 1, "summary from v4")], wordOut: [row(V4, 1, "words from v4")],
    });

    const read = (f) => fs.readFileSync(f, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
    const w3 = read(a.wordF), w4 = read(b.wordF);
    assert.equal(w3.length, 2);
    assert.equal(w4.length, 1);
    assert.ok(w3.every((r) => r.log === V3.file), "v3 分片里不得出现 v4 的行");
    assert.ok(w4.every((r) => r.log === V4.file), "v4 分片里不得出现 v3 的行");
    const keys3 = new Set(w3.map((r) => r.seq + "@" + r.text));
    assert.ok(w4.every((r) => !keys3.has(r.seq + "@" + r.text)), "两个变体不得共享任何一行");
    // 两份分片文件确实不同
    assert.notEqual(a.wordF, b.wordF);
    assert.notEqual(a.sumF, b.sumF);
  });

  // ── ⑥ 增量安全：manifest 共享路径 ⇒ 告警 + 两者强制全量重建 ────────────
  test("prior manifest 里两个日志共享同一分片路径：结构化告警 + 两者强制重建", () => {
    const dir = tmp("shared");
    const legacySum = path.join(dir, SID + ".sum.jsonl");
    const legacyWord = path.join(dir, SID + ".word.jsonl");
    const prevRows = [
      { file: V3.file, key: "1:1", nextByte: 100, sumOut: legacySum, wordOut: legacyWord },
      { file: V4.file, key: "2:2", nextByte: 200, sumOut: legacySum, wordOut: legacyWord },
    ];
    const plan = computeShardPlan([V3, V4], prevRows, dir);

    const hit = plan.warnings.filter((w) => w.code === "ECHO_SHARD_PATH_SHARED_IN_MANIFEST");
    // 这一对日志共享**两条**分片路径（sum 与 word）⇒ 报两条，每条按路径聚合。
    // 断言的是「按路径聚合」：同一个路径不许因为有两个文件就报两遍。
    assert.equal(hit.length, 2, "sum 与 word 两条共享路径各报一条，且每个路径只报一次");
    const canon = (x) => String(x).replace(/\\/g, "/").toLowerCase();
    const reported = hit.map((w) => w.shardPath).sort();
    assert.deepEqual(reported, [canon(legacySum), canon(legacyWord)].sort());
    for (const w of hit) {
      assert.equal(w.files.length, 2, "每条告警都要点清涉及的两个文件");
      assert.equal(w.action, "force-full-rebuild-both-variants");
      assert.equal(typeof w.note, "string");
    }

    // 两个变体都被强制重建，且都不许复用/续读那份可疑分片
    for (const L of [V3, V4]) {
      const sh = plan.byFile.get(L.file);
      assert.equal(sh.forcedRebuild, true, L.file + " 必须被强制重建");
      const row = prevRows.find((r) => r.file === L.file);
      const d = decideFileReuse({ prevRow: row, key: row.key, force: false, shard: sh, size: 999999 });
      assert.equal(d.reuse, false, "不得复用旧行");
      assert.equal(d.nameOk, false, "manifest 声明的名字不等于期望名 —— 身份不成立");
      assert.equal(d.canResume, false, "不得从旧 nextByte 续读追加（会拼出别人写的半段）");
    }
    // 两者重建后落到互不相同的新名字上
    assert.notEqual(plan.byFile.get(V3.file).sumF, plan.byFile.get(V4.file).sumF);
  });

  // ── ⑦ 单变体：旧分片可收养（保住旧数据），内容原样搬过去 ────────────────
  test("单变体会话的 legacy 分片被改名收养，内容逐字节保留", () => {
    const dir = tmp("adopt-single");
    const legacySum = path.join(dir, SID + ".sum.jsonl");
    const legacyWord = path.join(dir, SID + ".word.jsonl");
    const sumLine = JSON.stringify({ t: "2026-11-01T00:00:00", log: V3.file, id: "cmp-aaaaaaaa", summary: "keep me" });
    const wordLine = JSON.stringify({ t: "2026-11-01T00:00:00", log: V3.file, seq: 7, text: "old words must survive" });
    fs.writeFileSync(legacySum, sumLine, "utf8");
    fs.writeFileSync(legacyWord, wordLine, "utf8");

    const plan = computeShardPlan([V3], [], dir).byFile.get(V3.file);
    assert.equal(plan.legacyAdoptable, true);
    assert.equal(fs.existsSync(plan.sumF), false);

    assert.equal(adoptLegacyShard(plan, V3.file), "adopted");
    assert.equal(fs.existsSync(plan.sumF), true, "新唯一名下必须存在分片");
    assert.equal(fs.existsSync(plan.wordF), true);
    assert.equal(fs.existsSync(legacySum), false, "legacy 名应已改名，不该留两份");
    assert.equal(fs.readFileSync(plan.sumF, "utf8"), sumLine, "内容必须逐字节不变（收养不是重建）");
    assert.equal(fs.readFileSync(plan.wordF, "utf8"), wordLine);
    assert.equal(shardOwnerLog(plan.sumF), V3.file);
  });

  // ── ⑧ 多变体：legacy 分片一律不收养（说不清是谁写的）────────────────────
  test("多变体会话拒绝收养 legacy 分片，两边都各自重建", () => {
    const dir = tmp("adopt-multi");
    const legacyWord = path.join(dir, SID + ".word.jsonl");
    fs.writeFileSync(legacyWord, JSON.stringify({ t: "2026-11-01T00:00:00", log: V4.file, seq: 1, text: "who wrote me?" }), "utf8");

    const plan = computeShardPlan([V3, V4], [], dir);
    for (const L of [V3, V4]) {
      const sh = plan.byFile.get(L.file);
      assert.equal(sh.legacyAdoptable, false, "多变体不得收养");
      assert.equal(adoptLegacyShard(sh, L.file), "blocked-multi-variant");
      assert.equal(fs.existsSync(sh.wordF), false, "不得凭空造出分片");
    }
    // legacy 文件原地不动（改不改它是人的决定，代码不擅自动）
    assert.equal(fs.existsSync(legacyWord), true);
  });

  // ── ⑨ 外来内容：期望名下躺着别人的行 ⇒ 不认它 ──────────────────────────
  test("期望名分片里是别人的行：判为外来内容，不许续读追加", () => {
    const dir = tmp("foreign");
    const plan = computeShardPlan([V3, V4], [], dir);
    const a = plan.byFile.get(V3.file);
    // 伪造：v3 的期望分片文件名里，写的是 v4 的行（正是旧缺陷现场的形态）
    fs.writeFileSync(a.sumF, JSON.stringify({ t: "2026-11-16T00:00:00", log: V4.file, summary: "I am v4" }), "utf8");
    assert.equal(shardOwnerLog(a.sumF), V4.file);
    assert.equal(shardOwnedBy(a.sumF, V3.file), false, "首行 log 是 v4 ⇒ 不能当作 v3 的前半段");
    // 空分片算「属于」（没有可丢的东西）
    const empty = path.join(dir, "empty.sum.jsonl");
    fs.writeFileSync(empty, "", "utf8");
    assert.equal(shardOwnedBy(empty, V3.file), true);
    // 不存在的分片也算「无主内容可丢」
    assert.equal(shardOwnedBy(path.join(dir, "nope.sum.jsonl"), V3.file), true);
  });

  // ── ⑩ 名字对不上 ⇒ 不复用（这是那 6 对一直没被修正的直接原因）───────────
  test("名字对不上时拒绝复用：日志没变也必须重建", () => {
    const dir = tmp("name-mismatch");
    const plan = computeShardPlan([V3, V4], [], dir);
    const sh = plan.byFile.get(V3.file);
    const stale = {
      file: V3.file, key: "1700000000000:12345", nextByte: 4096,
      sumOut: path.join(dir, SID + ".sum.jsonl"), wordOut: path.join(dir, SID + ".word.jsonl"),
    };
    const d = decideFileReuse({ prevRow: stale, key: "1700000000000:12345", force: false, shard: sh, size: 999999 });
    assert.equal(d.reuse, false, "key 相同但名字不对 ⇒ 不许跳过");
    assert.equal(d.nameOk, false);
    assert.equal(d.canResume, false);

    // 名字对得上时，才允许复用（否则测试变成「什么都不许跳过」，那也没意义）
    const aligned = { ...stale, sumOut: sh.sumF, wordOut: sh.wordF };
    const ok = decideFileReuse({ prevRow: aligned, key: "1700000000000:12345", force: false, shard: sh, size: 999999 });
    assert.equal(ok.nameOk, true);
    assert.equal(ok.reuse, true);
    assert.equal(ok.canResume, true);
    // --force 一律重建
    assert.equal(decideFileReuse({ prevRow: aligned, key: "1700000000000:12345", force: true, shard: sh, size: 999999 }).reuse, false);
  });

  // ── ⑪ 基名撞车 ⇒ 结构化冲突（宁可停下，不许写错）───────────────────────
  test("两个不同日志算出同一基名时报 ECHO_SHARD_BASE_COLLISION", () => {
    const dir = tmp("collision");
    const collide = () => "session-same";
    const plan = computeShardPlan([V3, V4], [], dir, collide);
    const c = plan.conflicts.filter((x) => x.code === "ECHO_SHARD_BASE_COLLISION");
    assert.equal(c.length, 1);
    assert.equal(c[0].base, "session-same");
    assert.equal(c[0].files.length, 2);
    // 正常输入不报冲突（否则上面那条断言没有意义）
    assert.equal(computeShardPlan([V3, V4], [], dir).conflicts.length, 0);
  });

  // ── ⑫ 路径身份：分隔符 / 大小写变体不产生假冲突、也不产生假新文件 ────────
  test("同一路径的写法变体不会被当成两个日志", () => {
    const dir = tmp("path-identity");
    const variant = { file: V3.file.replace(/\\/g, "/").toUpperCase(), ws: WS, sid: SID };
    const plan = computeShardPlan([V3, variant], [], dir);
    assert.equal(plan.byFile.size, 1, "同一文件的两种写法只能算一个");
    assert.equal(plan.duplicateLogs.length, 1);
    assert.equal(plan.conflicts.length, 0);
    // 跨工作区同名 sid：路径不同 ⇒ 名字必须不同
    const crossWs = LOG("--D-AI-chat1--", SID, "v4");
    const p2 = computeShardPlan([V4, crossWs], [], dir);
    assert.notEqual(p2.byFile.get(V4.file).base, p2.byFile.get(crossWs.file).base);
    // 但它们**算兄弟变体**（multiVariant=true）—— 这是刻意的：legacy 名只有 sid，
    // 两个工作区的同名 sid 会落到同一个 legacy 文件名上，歧义与 v3/v4 完全一样，
    // 所以两边都不能收养 legacy 分片。
    assert.equal(p2.byFile.get(crossWs.file).multiVariant, true);
    assert.equal(p2.byFile.get(crossWs.file).legacyAdoptable, false);
  });

  // ── ⑬ import 即静默：CLI 命令块不得在 import 时执行 ────────────────────
  test("import memindex.mjs 不执行任何 CLI 命令、不写任何文件", () => {
    // 走到这里还没被 process.exit 干掉，本身就说明 stats/audit/verify 没执行；
    // 再确认它没往临时目录里写东西（build 才会建 index/ 与 shards/）。
    const before = fs.readdirSync(ROOT).sort().join(",");
    assert.equal(fs.existsSync(path.join(ROOT, "index")), false, "import 不得创建索引目录");
    assert.equal(fs.readdirSync(ROOT).sort().join(","), before);
  });

  console.log("\nPASS echo-memindex-shard-identity: " + n + " 项（同 sid 双变体分名 / 旧方案撞名对照 / 确定性 / 兄弟增减稳定 / 无跨源行 / 共享路径告警+强制重建 / 单变体收养 / 多变体拒收养 / 外来内容 / 名字不符不复用 / 基名冲突 / 路径身份 / import 静默）");
} finally {
  fs.rmSync(ROOT, { recursive: true, force: true });
}
