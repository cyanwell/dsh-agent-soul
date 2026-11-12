// soul-sync 自检 —— 证明它真的增量、真的不重复、真的能搜到
//
// ★ 为什么要有这个：2026-11-07 凌晨写 soul-sync 时踩过一个会毁数据的 bug ——
//   水位文件不存在时 seen=0，把已迁的 1008 个会话全当新的，要写 16 万重复帧。
//   那个 bug 是 dry run 偶然看见的，不是自检拦住的。
//   **新数据入口没有自检，就是下一次的维护债。**
//
// 用法：node tools/sync-selftest.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SessionStore } from '../src/session/store.mjs';
import { Query } from '../src/tools/query.mjs';
import { readDshSession, toFrames } from '../src/migrate/dsh.mjs';

const NODE = process.execPath;
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-selftest-'));
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  ✓ ' + n + (d ? '  ' + d : '')); } else { fail++; console.log('  ✗ ' + n + (d ? '  ' + d : '')); } };

console.log('=== soul-sync 自检 ===');
console.log('临时库：' + TMP);
console.log('');

// ── 1. 找几个真 DSH 会话文件（小一点的，快）──────
const SRC = 'D:/AI/dsh/home/sessions';
function findFiles(root, depth = 0, out = []) {
  if (depth > 4) return out;
  let ents; try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) findFiles(p, depth + 1, out);
    else if (e.name === 'session.v4.jsonl.zstd') {
      try { const st = fs.statSync(p); if (st.size > 2000 && st.size < 200000) out.push({ p, id: path.basename(path.dirname(p)), size: st.size }); } catch {}
    }
  }
  return out;
}
const files = findFiles(SRC).slice(0, 3);
ok('找到 DSH 会话文件', files.length > 0, files.length + ' 个');

if (!files.length) { console.log('\n没有样本，跳过。'); process.exit(1); }

// 造一个「迷你 SRC」只放这几个，避免同步器扫 1000 个
const MINI = path.join(TMP, 'mini-src');
for (const f of files) {
  const d = path.join(MINI, f.id);
  fs.mkdirSync(d, { recursive: true });
  fs.copyFileSync(f.p, path.join(d, 'session.v4.jsonl.zstd'));
}

// ── 2. 直接解析：帧数与 seq 范围 ─────────────────
let expectTotal = 0;
for (const f of files) {
  const rec = readDshSession(f.p);
  const { frames } = toFrames(rec.records);
  expectTotal += frames.length;
}
ok('能解析出帧', expectTotal > 0, expectTotal + ' 帧（3 个会话合计）');

// ── 3. 起同步器（第一次）───────────────────────
const runSync = (arg = []) => {
  try {
    return execFileSync(NODE, [path.join(ROOT, 'tools', 'soul-sync.mjs'), '--src', MINI, ...arg], {
      cwd: ROOT, encoding: 'utf8', timeout: 120000,
      env: { ...process.env, AGENT_SOUL_DATA: TMP },
    });
  } catch (e) {
    return String(e.stdout || '') + String(e.stderr || '');
  }
};

// ★ 同步器写的是 cfg.dataDir —— 用环境变量指到临时库
// （config.mjs 读 AGENT_SOUL_DATA 吗？这里先探一下）
const cfgSrc = fs.readFileSync(path.join(ROOT, 'src/config.mjs'), 'utf8');
const dataEnvOk = /AGENT_SOUL_DATA/.test(cfgSrc);
ok('config 支持 AGENT_SOUL_DATA 环境变量', dataEnvOk, dataEnvOk ? '' : '★ 不支持 —— 需要加，否则自检会写进真库');

console.log('');
console.log('--- 手动指定数据目录后跑 ---');
const out1 = runSync();
console.log(out1.split('\n').slice(0, 4).map(l => '  ' + l).join('\n'));

// ── 4. 增量：第二次应该 0 帧 ──────────────────
const out2 = runSync();
const wrote2 = Number((out2.match(/写了 (\d+) 帧/) || [])[1] ?? -1);
ok('第二次跑 = 0 帧（增量生效）', wrote2 === 0, '实际 ' + wrote2);

// ── 5. 第三次也是 0（不重复）────────────────────
const out3 = runSync();
const wrote3 = Number((out3.match(/写了 (\d+) 帧/) || [])[1] ?? -1);
ok('第三次跑 = 0 帧（不重复）', wrote3 === 0, '实际 ' + wrote3);

// ── 6. 数据真的进库了，且帧数对得上 ─────────────
// ★ 2026-11-07 修的一个**断言**错（不是代码错）：
//   我原来断言「库里帧数 = 解析帧数」，实测 29 vs 26，差 3。
//   差的是 **store.create() 写的那一个 header 帧**（type:'session', seq=0）——
//   每个会话 1 帧 × 3 个会话 = 3。
//   ★ 这件事本身值得记：**会话仓的第一帧不是内容，是 header。**
//   以后谁写自检，数帧的时候都要减掉它。
const store = new SessionStore(TMP);
let actual = 0, headers = 0;
for (const f of files) {
  const s = store.load(f.id);
  if (!s) continue;
  actual += s.frames.length;
  if (s.frames[0] && s.frames[0].type === 'session') headers++;
}
ok('每个会话都有 header 帧', headers === files.length, headers + ' / ' + files.length);
ok('库里的内容帧 = 解析出的帧数（扣掉 header）', actual - headers === expectTotal,
  (actual - headers) + ' vs ' + expectTotal + '（总 ' + actual + '，header ' + headers + '）');

// ── 7. 索引也建了（写入即索引）──────────────────
const q = new Query(store, null);
let indexed = 0;
for (const f of files) {
  const r = q.search(['的'], { limit: 100 });
  if (r && r.hits) indexed += r.hits.length;
}
ok('能搜到内容（索引不是空的）', indexed > 0, indexed + ' 条命中');

// ── 8. 水位文件写了 ────────────────────────────
const st = path.join(TMP, 'sync-state.json');
const hasState = fs.existsSync(st);
ok('写了水位文件', hasState);
if (hasState) {
  const j = JSON.parse(fs.readFileSync(st, 'utf8'));
  ok('水位里记了这些会话', files.every(f => j.sessions[f.id] !== undefined), Object.keys(j.sessions).length + ' 条');
}

// ── 9. 那个毁数据的 bug：容器已存在但水位丢了，不能重写 ──
fs.unlinkSync(st);   // 模拟「水位文件丢了」
const out4 = runSync();
const wrote4 = Number((out4.match(/写了 (\d+) 帧/) || [])[1] ?? -1);
ok('★ 水位丢了也不重写（从容器推 seq）', wrote4 === 0, '实际 ' + wrote4);

console.log('');
console.log('────────────────────────────────────────────');
console.log('通过 ' + pass + ' 项 · 失败 ' + fail + ' 项');
console.log('临时库 ' + TMP);
if (fail === 0) {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log('\n自检全绿。');
  process.exit(0);
} else {
  console.log('\n有失败项 —— 临时库保留在 ' + TMP);
  process.exit(1);
}
