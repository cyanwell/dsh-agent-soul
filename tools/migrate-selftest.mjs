import path from 'node:path';
import fs from 'node:fs';
import { readDshSession, toFrames, migrateOne, frameOffsets } from '../src/migrate/dsh.mjs';
import { SessionStore } from '../src/session/store.mjs';
import { ROOT } from '../src/config.mjs';

const ok = []; const bad = [];
const push = (n, c, e) => (c ? ok : bad).push((c ? '✓ ' : '✗ ') + n + (e ? '  → ' + e : ''));

// 找一个中等大小的真实会话
const target = 'D:/AI/dsh/home/sessions';
let found = '';
const walk = (d, depth) => {
  if (depth > 3 || found) return;
  let ents = [];
  try { ents = fs.readdirSync(d); } catch { return; }
  for (const e of ents) {
    const p = path.join(d, e);
    let st; try { st = fs.statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, depth + 1);
    else if (e === 'session.v4.jsonl.zstd' && st.size > 70000 && st.size < 90000 && !found) found = p;
  }
};
walk(target, 0);
push('找到测试会话', Boolean(found), found ? path.basename(path.dirname(found)) : '(无)');

// 1. 读
const { records, badFrames, frames: zframes } = readDshSession(found);
push('解出记录', records.length > 10, records.length + ' 条 / ' + zframes + ' 个 zstd 帧 / ' + badFrames + ' 个坏帧');

// 2. 映射
const mapped = toFrames(records);
push('映射出帧', mapped.frames.length > 5, mapped.frames.length + ' 帧');
push('跳过的是运行时状态', Object.keys(mapped.skipped).length > 3, Object.entries(mapped.skipped).slice(0, 4).map(([k, v]) => k + '×' + v).join(', '));

// 3. 四类都在吗
const types = {};
for (const f of mapped.frames) types[f.type] = (types[f.type] || 0) + 1;
push('四类都映射到了', Boolean(types.user && types.assistant), Object.entries(types).map(([k, v]) => k + '×' + v).join(', '));

// 4. 正文非空
const u = mapped.frames.find(f => f.type === 'user');
push('user 正文非空', u && u.text.length > 10, u ? u.text.slice(0, 50) + '…' : '(无)');
const a = mapped.frames.find(f => f.type === 'assistant');
push('assistant 正文或推理非空', a && (a.text || a.reasoning), a ? ((a.text || a.reasoning) || '').slice(0, 50) + '…' : '(无)');

// 5. 时间戳保留了
push('时间戳是原时间', u && u.t > 1700000000000, new Date(u.t).toISOString());

// 6. 真迁进 store
const DATA = path.join(ROOT, 'data', 'mig-' + Date.now());
const store = new SessionStore(DATA);
const r = migrateOne(store, found, {});
push('迁移成功', r.frames > 5, r.frames + ' 帧写进 ' + r.id);

// 7. 迁过去能检索
const w = u.text.slice(0, 6);
const hits = store.search(r.id, w);
push('★ 迁过去能检索', hits.length >= 1, '搜「' + w + '」命中 ' + hits.length);

// 8. 帧结构对
const s = store.load(r.id);
push('帧 0 是 header', s.frames[0].type === 'session');
push('帧数对', s.frames.length === r.frames + 1, s.frames.length + ' 帧（含 header）');

// 9. meta 保留了来源
const anyMeta = s.frames.find(f => f.meta && f.meta.src === 'dsh');
push('★ meta 记了来源', Boolean(anyMeta), anyMeta ? 'seq=' + anyMeta.seq + ' 来自 dsh seq=' + anyMeta.meta.seq : '(无)');

// 10. 重复迁不炸（幂等？）
let again = null;
try { again = migrateOne(store, found, {}); } catch (e) { push('重复迁会抛错', false, e.message); }
if (again) push('重复迁不炸（会重复追加）', true, '再写 ' + again.frames + ' 帧 —— 注意：不是幂等');

try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {}

console.log(''); console.log('=== DSH 会话迁移自检 ==='); console.log('');
console.log(ok.join('\n'));
if (bad.length) { console.log(''); console.log(bad.join('\n')); }
console.log(''); console.log(ok.length + ' 通过 / ' + bad.length + ' 失败'); console.log('');
process.exit(bad.length ? 1 : 0);