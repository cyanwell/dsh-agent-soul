import fs from 'node:fs';
import path from 'node:path';
import { SessionStore } from '../src/session/store.mjs';
import { stripInject, topicsOf, pointerText, staleFix, compactRange, pruneText, MARK } from '../src/organs/compaction.mjs';
import { ROOT } from '../src/config.mjs';

const ok = []; const bad = [];
const push = (n, c, e) => (c ? ok : bad).push((c ? '✓ ' : '✗ ') + n + (e ? '  → ' + e : ''));

// ① stripInject
const injected = 'Current runtime context. This snapshot supersedes earlier.\nImage-gen workbench canvas: not connected.\nCurrent DeepSeek Harness Web GUI URL: "http://x"\n\n他说的真话在这里。';
const stripped = stripInject(injected);
push('★ 剥掉注入块', !stripped.includes('Current runtime context') && stripped.includes('他说的真话'), stripped.trim().slice(0, 30));
const sr = '前文<system-reminder>这是一大段注入</system-reminder>后文';
push('剥掉 system-reminder', !stripInject(sr).includes('这是一大段注入'), '');

// ② staleFix
const fixed = staleFix('推送进行中，下一步是部署', '2026-11-07 02:00');
push('★ 状态词补「截至」', fixed.includes('进行中（截至 2026-11-07 02:00）'), fixed.slice(0, 40));
push('★ 两步都补了', (fixed.match(/截至/g) || []).length === 2, fixed);
push('不改无状态词的文本', staleFix('这是一段普通的话', 'X') === '这是一段普通的话', '');

// ③ pointerText
const pt = pointerText('session-abc', 100, 500, ['第一件', '第二件'], 7, '2026-11-07 02:00');
push('★ 第一行就是门牌', pt.split('\n')[0].includes('log:session-abc#seq=100'), pt.split('\n')[0]);
push('★ 有「这段讲的是」', pt.includes('这段讲的是：') && pt.includes('第一件') && pt.includes('第二件'), '');
push('★ 有「之后的状态以最新对话为准」', pt.includes('之后的状态以最新对话为准'), '');
push('★ 有「做过的，不是打算做的」', pt.includes('7 次工具调用') && pt.includes('做过的'), '');
push('★ 有回取命令', pt.includes('soul_open log:session-abc#seq=100'), '');
const pt0 = pointerText('session-abc', 1, 9, [], 0, 'X');
push('★ 零工具调用时明说「只是讨论」', pt0.includes('没有任何工具调用') && pt0.includes('未执行'), '');
const ptNoSid = pointerText(null, 1, 9, [], 0, 'X');
push('★ 没会话号时降级、不硬写 seq', ptNoSid.includes('会话号取不到') && !ptNoSid.includes('#seq='), ptNoSid.split('\n')[0]);

// ④ 真实会话：topicsOf + compactRange
const DATA = path.join(ROOT, 'data', 'compact-' + Date.now());
const store = new SessionStore(DATA);
store.create(ROOT, null, { id: 'c1' });
store.append('c1', 'user', { text: injected + '\n\n这一段在讲传输层拆分这件事，后面还有很多内容。' });
store.append('c1', 'assistant', { text: '好的，我先把 index.jsonl 的大小问题查一下。再往下说。' });
store.append('c1', 'tool_call', { text: 'run_shell node tools/rebuild-index.mjs' });
store.append('c1', 'tool_result', { text: '重建完成，658MB → 72.7MB。' });
store.append('c1', 'user', { text: '现在索引多大？' });

const { topics, toolCalls } = topicsOf(store, 'c1', 1, 5);
push('★ 抽到话题', topics.length > 0, topics.join(' | '));
push('★ 注入块没被当话题', !topics.some(t => t.startsWith('Current runtime')), '');
// ★ 注意：「现在索引多大？」只有 7 个字，按判据（< 8）不承载话题、被跳过是对的。
//   最后一条应该是 seq 4 的「重建完成」—— 证明是从后往前扫、且跳过了太短的。
push('★ 从后往前扫（最新的在后面）', topics[topics.length - 1] === '重建完成，658MB → 72.7MB', topics.join(' > '));
push('★ 太短的句子被跳过（不承载话题）', !topics.some(t => t.includes('现在索引多大')), '');
push('★ 统计到 1 次工具调用', toolCalls === 1, toolCalls);

const cr = compactRange(store, 'c1', { start: 1, end: 5 });
push('★ compactRange 压成功', cr.ok, cr.ok ? 'seq ' + cr.start + '–' + cr.end : cr.err);
push('★ 返回的门牌带 #seq=', cr.pointer.includes('#seq=1'), cr.pointer.split('\n')[0]);

// 门牌真的进了索引
const hits = store.search('c1', '压缩索引');
push('★ 压缩帧进了索引（能搜到）', hits.length > 0, hits.length + ' 条');
const h2 = store.search('c1', '这段讲的是');
push('★ 「这段讲的是」也可检索', h2.length > 0, h2.length + ' 条');

// meta 里有被压区间
const s = store.load('c1');
const cf = s.frames.find(f => f.meta && f.meta.kind === 'compaction.summary');
push('★ meta 记了被压区间', !!cf && cf.meta.start === 1 && cf.meta.end === 5, cf ? JSON.stringify({ start: cf.meta.start, end: cf.meta.end, toolCalls: cf.meta.toolCalls }) : '没找到');

// ⑤ pruneText
const long = 'a'.repeat(8000) + '中间这一大段会被挖掉' + 'b'.repeat(3000);
const pr = pruneText('c1', 42, long, { head: 100, tail: 50 });
push('★ 裁剪生效', pr.pruned, 'removed=' + pr.removed);
push('★ 头尾都在', pr.text.startsWith('a'.repeat(100)) && pr.text.endsWith('b'.repeat(50)), '');
push('★ ★ 中间标记带门牌', pr.text.includes('log:c1#seq=42'), '');
push('★ 标记说明「原文仍在一手层」', pr.text.includes('一手层'), '');
const short = '不长的文本';
push('短文本不动', pruneText('c1', 1, short, { head: 100, tail: 50 }).pruned === false, '');

store.saveIndexCache?.(); store.closeAll();
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {}

console.log(''); console.log('=== 压缩裁剪器官自检 ==='); console.log('');
console.log(ok.join('\n'));
if (bad.length) { console.log(''); console.log(bad.join('\n')); }
console.log(''); console.log(ok.length + ' 通过 / ' + bad.length + ' 失败'); console.log('');
process.exit(bad.length ? 1 : 0);