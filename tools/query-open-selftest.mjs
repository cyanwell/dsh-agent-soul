// query-open 自测（2026-11-11）—— log 门牌：宿主原帧（meta.seq）优先，容器 seq 回退
//
// ★ 这个切片修的是一个**会静默取错原文**的 bug：
//   cleanup 回执 / 压缩门牌给的是**宿主 seq**（DSH 的帧号，落在 frames[i].meta.seq），
//   而 Query.open 原来只按**容器 seq**（本软件 append 分配的 1,2,3…）查。
//   同一会话里两者都在递增，同一个数字经常指向两帧不同内容 ——
//   于是门牌能打开、返回 200、内容却是别人的。
//
// 本自测只打靶「门牌解析 + 完整原文」，不顺带验证别的层（那些有自己的套件）。
// 数据根一定在 os.tmpdir() 下：realpath 断言 + 与生产 data/ 的包含关系双判。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionStore } from '../src/session/store.mjs';
import { Query, resolveLogFrame, frameFullText } from '../src/tools/query.mjs';
import { pointerOf, judgeCleanupReceipt } from '../src/organs/cleanup.mjs';
import { pruneText } from '../src/organs/compaction.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let pass = 0, fail = 0;
const ok = (n, c, d) => {
  if (c) { pass++; console.log('  ✓ ' + n + (d ? '  ' + d : '')); }
  else { fail++; console.log('  ✗ ' + n + (d ? '  ' + d : '')); }
};

// ── 写盘位置：系统 tmp（显式 + realpath 断言）──────────────────────────
const TMP_ROOT = fs.realpathSync(os.tmpdir());
const DATA = fs.mkdtempSync(path.join(TMP_ROOT, 'agent-soul-queryopen-'));
{
  const real = fs.realpathSync(DATA);
  const prod = (() => { try { return fs.realpathSync(path.join(ROOT, 'data')); } catch { return path.join(ROOT, 'data'); } })();
  if (!(real === TMP_ROOT || real.startsWith(TMP_ROOT + path.sep)) || real === prod || real.startsWith(prod + path.sep)) {
    throw new Error('临时目录不在 os.tmpdir() 下（或落进了生产 data/）：' + real);
  }
  if (!path.isAbsolute(DATA) || !fs.statSync(DATA).isDirectory()) throw new Error('临时目录不成立：' + DATA);
}
console.log('临时数据 ' + DATA + '\n');

const store = new SessionStore(DATA);
const q = new Query(store, null);

const idxLines = (sid) => {
  try { return fs.readFileSync(path.join(DATA, 'sessions', sid, 'index.jsonl'), 'utf8').split('\n').filter(Boolean).length; }
  catch { return 0; }
};
const idxTextOf = (sid, seq) => {
  const rows = fs.readFileSync(path.join(DATA, 'sessions', sid, 'index.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const hit = rows.find((r) => r.seq === seq);
  return hit ? String(hit.text || '') : '';
};

console.log('=== ① 冲突：cleanup 门牌是宿主 seq，同号容器帧另有内容 ===');
{
  const sid = 'sess-conflict';
  store.create(ROOT, null, { id: sid });
  const f1 = store.append(sid, 'user', { text: 'HOST-901 宿主原帧（容器 seq=1）', meta: { src: 'dsh', seq: 901 } });
  const f2 = store.append(sid, 'assistant', { text: 'HOST-1 宿主原帧（容器 seq=2）', meta: { src: 'dsh', seq: 1 } });
  const f3 = store.append(sid, 'user', { text: 'HOST-902 宿主原帧（容器 seq=3）', meta: { src: 'dsh', seq: 902 } });
  ok('构造：容器 seq 1/2/3 ↔ 宿主 seq 901/1/902', f1.seq === 1 && f2.seq === 2 && f3.seq === 3,
    '容器 ' + [f1.seq, f2.seq, f3.seq].join(',') + ' · 宿主 ' + [f1.meta.seq, f2.meta.seq, f3.meta.seq].join(','));

  // 旧口径会取到的那一帧（同号容器帧）—— 只用来做对照，不参与断言
  const oldPick = store.load(sid).frames.find((f) => f.seq === 1);

  const opened = q.open('log:' + sid + '#seq=1');
  ok('①a 门牌 seq=1 取的是宿主原帧', opened.ok === true && opened.matchedBy === 'host-meta' && opened.containerSeq === 2,
    opened.ok ? 'matchedBy=' + opened.matchedBy + ' containerSeq=' + opened.containerSeq + ' hostSeq=' + opened.hostSeq : opened.code);
  ok('①b 正文是宿主 seq=1 那条，不是同号容器帧', /HOST-1 宿主原帧/.test(opened.text || '') && !/HOST-901/.test(opened.text || ''),
    JSON.stringify(String(opened.text || '').slice(0, 40)));
  ok('①c 对照：旧口径（按容器 seq）取到的是另一帧', oldPick && /HOST-901/.test(oldPick.text || ''),
    JSON.stringify(String(oldPick && oldPick.text || '').slice(0, 40)));
  ok('①d 两个候选原文确实不同（这就是会取错的证据）',
    String(oldPick.text) !== String(opened.text), '同号不同内容');

  const byHostOnly = q.open('log:' + sid + '#seq=901');
  ok('①e 纯宿主号（901）也能取到', byHostOnly.ok && byHostOnly.matchedBy === 'host-meta' && byHostOnly.containerSeq === 1,
    byHostOnly.ok ? 'containerSeq=' + byHostOnly.containerSeq : byHostOnly.code);

  const fallback = q.open('log:' + sid + '#seq=3');
  ok('①f 宿主号 3 不存在 → 回退容器 seq=3（诚实标注 matchedBy）',
    fallback.ok && fallback.matchedBy === 'container-seq' && fallback.containerSeq === 3 && fallback.hostSeq === 902,
    fallback.ok ? 'matchedBy=' + fallback.matchedBy + ' hostSeq=' + fallback.hostSeq : fallback.code);

  // ── cleanup 回执门牌 → 回取（端到端，不用手拼字符串）──
  const judged = judgeCleanupReceipt({
    data: { targetSession: sid, opId: 'op-selftest-1', startSeq: 1, endSeq: 1, framesAffected: 1 },
    request: { sessionId: sid, opId: 'op-selftest-1', startSeq: 1, endSeq: 1 },
  });
  ok('①g 回执核对通过并给出门牌', judged.ok === true && judged.receipt.pointer === 'log:' + sid + '#seq=1',
    judged.ok ? judged.receipt.pointer : judged.reason);
  const fromReceipt = q.open(judged.receipt.pointer);
  ok('①h cleanup 门牌取到宿主原帧（不是同号容器帧）',
    fromReceipt.ok && fromReceipt.matchedBy === 'host-meta' && fromReceipt.containerSeq === 2 && /HOST-1/.test(fromReceipt.text || ''),
    fromReceipt.ok ? 'matchedBy=' + fromReceipt.matchedBy + ' containerSeq=' + fromReceipt.containerSeq : fromReceipt.code);

  // 失败回执的门牌也走同一条路（failure 里也写 pointer）
  const p = pointerOf(sid, 1, 1);
  ok('①i pointerOf 与回执门牌同形', p && p.pointer === judged.receipt.pointer, p && p.pointer);

  console.log('\n  ── 冲突案例原文 / 回取对照 ──');
  console.log('  门牌        log:' + sid + '#seq=1');
  console.log('  旧口径命中  容器 seq=' + oldPick.seq + ' type=' + oldPick.type + ' text=' + JSON.stringify(String(oldPick.text).slice(0, 48)));
  console.log('  新口径命中  宿主 meta.seq=' + fromReceipt.hostSeq + ' / 容器 seq=' + fromReceipt.containerSeq +
    ' type=' + fromReceipt.type + ' text=' + JSON.stringify(String(fromReceipt.text).slice(0, 48)));
}

console.log('\n=== ② 普通内部帧：没有 meta.seq → 容器 seq 回退（旧行为不变）===');
{
  const sid = 'sess-plain';
  store.create(ROOT, null, { id: sid });
  for (let i = 1; i <= 3; i++) store.append(sid, i % 2 ? 'user' : 'assistant', { text: '内部第 ' + i + ' 帧：没有宿主号' });
  const r = q.open('log:' + sid + '#seq=2');
  ok('②a 内部 seq=2 仍可回取', r.ok && r.matchedBy === 'container-seq' && r.containerSeq === 2 && r.hostSeq === null,
    r.ok ? 'matchedBy=' + r.matchedBy + ' hostSeq=' + r.hostSeq : r.code);
  ok('②b 取到的是那一帧的原文', /内部第 2 帧/.test(r.text || ''), JSON.stringify(String(r.text || '').slice(0, 30)));
  ok('②c 指针里的 n 原样回显（旧字段兼容）', r.seq === 2, 'seq=' + r.seq);
}

console.log('\n=== ③ 不猜：未知 sid / 未知 seq / 歧义 ===');
{
  const noSid = q.open('log:sess-does-not-exist#seq=1');
  ok('③a 未知会话 → NO_SUCH_FRAME（不抛、不返回别人）', noSid.ok === false && noSid.code === 'NO_SUCH_FRAME', noSid.code);

  const noSeq = q.open('log:sess-plain#seq=99');
  ok('③b 未知 seq → NO_SUCH_FRAME + 帧数可核对', noSeq.ok === false && noSeq.code === 'NO_SUCH_FRAME' && noSeq.frames === 4,
    noSeq.code + ' frames=' + noSeq.frames);

  // 重复 meta.seq，但内容相同（历史上实测有过 392 条重复）→ 是同一段原文，仍可回取
  const dup = 'sess-dup';
  store.create(ROOT, null, { id: dup });
  store.append(dup, 'user', { text: 'DUP-SAME 同一帧被重复回放', meta: { src: 'dsh', seq: 7 } });
  store.append(dup, 'user', { text: 'DUP-SAME 同一帧被重复回放', meta: { src: 'dsh', seq: 7 } });
  const dupOpen = q.open('log:' + dup + '#seq=7');
  ok('③c 重复 meta.seq + 内容相同 → 仍回取，且报出命中数', dupOpen.ok && dupOpen.hostMatches === 2 && /DUP-SAME/.test(dupOpen.text || ''),
    dupOpen.ok ? 'hostMatches=' + dupOpen.hostMatches + ' containerSeqs=' + JSON.stringify(dupOpen.containerSeqs) : dupOpen.code);

  // 重复 meta.seq，内容不同 → 取哪个都会取错 → 报歧义 + 列候选
  const amb = 'sess-amb';
  store.create(ROOT, null, { id: amb });
  store.append(amb, 'user', { text: 'AMB-A 第一版原文', meta: { src: 'dsh', seq: 8 } });
  store.append(amb, 'user', { text: 'AMB-B 第二版原文', meta: { src: 'dsh', seq: 8 } });
  const ambOpen = q.open('log:' + amb + '#seq=8');
  ok('③d 重复 meta.seq + 内容不同 → AMBIGUOUS_LOG_PTR', ambOpen.ok === false && ambOpen.code === 'AMBIGUOUS_LOG_PTR', ambOpen.code);
  ok('③e 列出候选（容器 seq / 宿主 seq / 摘要），不返回正文',
    Array.isArray(ambOpen.candidates) && ambOpen.candidates.length === 2 && ambOpen.text === undefined
      && ambOpen.candidates.every((c) => c.hostSeq === 8 && Number.isInteger(c.containerSeq)),
    JSON.stringify((ambOpen.candidates || []).map((c) => c.containerSeq + ':' + c.snippet.slice(0, 8))));
  ok('③f 歧义时给的是「怎么精确取」而不是一个猜的答案', /soul_frame/.test(ambOpen.hint || '') && /containerSeq/.test(ambOpen.hint || ''),
    JSON.stringify(String(ambOpen.hint || '').slice(0, 60)));
}

console.log('\n=== ④ prune 替换后：原帧仍在原位、门牌仍可回取 ===');
{
  const sid = 'sess-prune';
  store.create(ROOT, null, { id: sid });
  const long = 'PRUNE-HEAD ' + 'x'.repeat(8000) + ' PRUNE-TAIL';
  const fr = store.append(sid, 'user', { text: long, meta: { src: 'dsh', seq: 11 } });
  const replaced = pruneText(sid, fr.seq, long, { head: 100, tail: 60 });
  ok('④a pruneText 真的裁了（不是 no-op）', replaced.pruned === true && replaced.text.length < long.length,
    long.length + ' → ' + replaced.text.length + '（removed ' + replaced.removed + '）');
  ok('④b 替换标记里带门牌', replaced.text.includes('log:' + sid + '#seq='), '');

  // 模拟宿主 pruner：重写 frames.jsonl，保留容器 seq 与 meta.seq，只换 text
  store.closeSession(sid);
  const fpath = path.join(DATA, 'sessions', sid, 'frames.jsonl');
  const rows = fs.readFileSync(fpath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const at = rows.findIndex((r) => r.seq === fr.seq);
  rows[at].text = replaced.text;
  fs.writeFileSync(fpath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

  const after = q.open('log:' + sid + '#seq=11');
  ok('④c 替换后按宿主号 11 仍取到那一帧', after.ok && after.matchedBy === 'host-meta' && after.containerSeq === fr.seq,
    after.ok ? 'matchedBy=' + after.matchedBy + ' containerSeq=' + after.containerSeq : after.code);
  ok('④d 正文是替换后的那一版（含裁剪标记），不是旧全文',
    /被裁掉了/.test(after.text || '') && /PRUNE-HEAD/.test(after.text || '') && !/x{100}/.test(after.text || ''),
    'len=' + String(after.text || '').length);
  ok('④e 替换帧不进索引（index 行数不变）—— 如实记录', idxLines(sid) === 1, 'index 行数=' + idxLines(sid));
}

console.log('\n=== ⑤ 完整原文：不用索引里那条截断 text ===');
{
  const sid = 'sess-long';
  store.create(ROOT, null, { id: sid });
  const userText = 'LONG-HEAD ' + '甲'.repeat(3000) + ' USER-TAIL-MARK';
  const u = store.append(sid, 'user', { text: userText, meta: { src: 'dsh', seq: 21 } });
  const idxUser = idxTextOf(sid, u.seq);
  ok('⑤a 索引里的确是截断版（500 字上限）', idxUser.length === 500 && !/USER-TAIL-MARK/.test(idxUser), 'index len=' + idxUser.length);

  const openedUser = q.open('log:' + sid + '#seq=21');
  ok('⑤b open 返回完整原文（长度=写入长度）', openedUser.ok && String(openedUser.text).length === userText.length,
    'open len=' + String(openedUser.text || '').length + ' / 写入 ' + userText.length);
  ok('⑤c 尾部标记在（截断版里没有）', /USER-TAIL-MARK/.test(openedUser.text || ''), '');

  // tool_result：正文在 content 里，text 只是 500 字摘要（migrate 的形状）
  const resBody = 'RES-HEAD ' + '乙'.repeat(3000) + ' RESULT-TAIL-MARK';
  const tr = store.append(sid, 'tool_result', { content: resBody, text: '[结果] ' + resBody.slice(0, 500), callId: 'c1', meta: { src: 'dsh', seq: 22 } });
  const openedRes = q.open('log:' + sid + '#seq=22');
  ok('⑤d tool_result 取 content 全文，不是 text 摘要',
    openedRes.ok && /RESULT-TAIL-MARK/.test(openedRes.text || '') && String(openedRes.text).length > 3000,
    'open len=' + String(openedRes.text || '').length + ' / index len=' + idxTextOf(sid, tr.seq).length);
  ok('⑤e 索引里那条仍然更短（证明 open 没走索引）', idxTextOf(sid, tr.seq).length < String(openedRes.text).length,
    idxTextOf(sid, tr.seq).length + ' < ' + String(openedRes.text).length);
}

console.log('\n=== ⑥ 自动索引与压缩解绑（本次不改，只记录事实）===');
{
  const sid = 'sess-live';
  store.create(ROOT, null, { id: sid });
  store.buildIndex();   // 先建库，之后 append 走 #ixPush（内存立即可见）
  ok('⑥a 新会话初始 index 0 行', idxLines(sid) === 0, 'index=' + idxLines(sid));

  store.append(sid, 'user', { text: 'LIVE-ONE 写入即索引' });
  ok('⑥b append 后 index.jsonl 立即 +1（未跑任何 compaction）', idxLines(sid) === 1, 'index=' + idxLines(sid));
  ok('⑥c 内存索引立即可见（store.ix）', (store.ix.get(sid) || []).length === 1, 'ix=' + (store.ix.get(sid) || []).length);
  ok('⑥d 检索立即命中（search）', store.search(sid, '写入即索引').length >= 1, '');
  ok('⑥e 跨会话检索立即命中（searchAll）', store.searchAll('LIVE-ONE', 20).some((h) => h.sessionId === sid), '');

  store.append(sid, 'assistant', { text: 'LIVE-TWO 第二帧' });
  ok('⑥f 再写一帧 → index 只增不减（2 行）', idxLines(sid) === 2 && (store.ix.get(sid) || []).length === 2,
    'index=' + idxLines(sid) + ' ix=' + (store.ix.get(sid) || []).length);

  // 索引条目的 text 是写入时截断的 —— 与 open 的完整原文不是一回事，如实记录
  const longText = 'Z'.repeat(900);
  store.append(sid, 'user', { text: longText });
  ok('⑥g 索引条目截断（500），open 才给全文', idxLines(sid) === 3 && idxTextOf(sid, 3).length === 500,
    'index len=' + idxTextOf(sid, 3).length + ' / 写入 ' + longText.length);
}

console.log('\n=== ⑦ soul_open 与 Query.open 共用同一条路（静态断言）===');
{
  const mt = fs.readFileSync(path.join(ROOT, 'src', 'adapters', 'mcp-tools.mjs'), 'utf8');
  ok('⑦a soul_query 的 open 直接调 q.open（没有自己的解析）', /const r = q\.open\(String\(a\.open\)\)/.test(mt), '');
  ok('⑦b soul_query 不自己 load+find 帧（按 seq 找只有 soul_frame 一处）',
    !/name === 'soul_query'[\s\S]{0,4000}?\.frames\.find\(/.test(mt), '');

  // 全仓 src：解析 #seq= 的地方只应该有 query.mjs 一处
  const hits = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && p.endsWith('.mjs')) {
        const t = fs.readFileSync(p, 'utf8');
        if (/#seq=\(\\d\+\)|#seq=\(\\d\+\)\$/.test(t) || /#seq=\(\\\\d\+\)/.test(t)) hits.push(path.relative(ROOT, p));
      }
    }
  };
  walk(path.join(ROOT, 'src'));
  ok('⑦c 门牌解析只有一处（query.mjs）', hits.length === 1 && /query\.mjs$/.test(hits[0]), JSON.stringify(hits));
  ok('⑦d 解析函数是导出的（可被单测，不会在别处复制一份）',
    typeof resolveLogFrame === 'function' && typeof frameFullText === 'function', '');
}

console.log('\n=== ⑧ 纯函数层面：resolveLogFrame 的边界 ===');
{
  const frames = [
    { seq: 0, t: 1, type: 'session' },
    { seq: 1, t: 2, type: 'user', text: 'A', meta: { seq: 5 } },
    { seq: 5, t: 3, type: 'user', text: 'B' },
  ];
  const host = resolveLogFrame(frames, 5);
  ok('⑧a meta 命中优先于同号容器帧', host.ok && host.matchedBy === 'host-meta' && host.frame.text === 'A', host.ok ? host.matchedBy : host.code);
  const cont = resolveLogFrame(frames, 1);
  ok('⑧b 容器回退只在没有 meta 命中时发生', cont.ok && cont.matchedBy === 'container-seq' && cont.frame.text === 'A', cont.ok ? cont.matchedBy : cont.code);
  const none = resolveLogFrame(frames, 6);
  ok('⑧c 都没有 → NO_SUCH_FRAME，并给宿主号范围', none.ok === false && none.code === 'NO_SUCH_FRAME'
    && none.hostSeqRange && none.hostSeqRange.min === 5 && none.hostSeqRange.max === 5, JSON.stringify(none.hostSeqRange));
  const bad = resolveLogFrame(null, 1);
  ok('⑧d 空 frames 不抛', bad.ok === false && bad.code === 'NO_SUCH_FRAME', bad.code);
}

try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {}
console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
