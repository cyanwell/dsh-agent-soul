/**
 * scaffold.mjs —— 一键搭出你的记忆架构骨架
 *
 * 它做三件事：建目录、放模板、报还缺什么。
 *
 * ★ 三条纪律：
 *   1. **幂等**：已经存在的文件一律不碰。重复跑多少次都一样安全。
 *   2. **绝不覆盖**：没有 --force 这个选项，是故意的。
 *      一个会吃掉用户内容的脚手架，本身就是个陷阱 ——
 *      用户改过 AGENTS.md 之后误跑一次，自己写的东西就没了。
 *      要重建某个文件：**手动删掉它，再跑一次**。这样"删"是一个有意识的动作。
 *   3. **先干跑后动手**：默认 `--dry-run`，看清要建什么再执行。
 *
 * 用法：
 *   node scaffold.mjs          # 干跑，只报计划
 *   node scaffold.mjs --apply  # 真建（只建缺的）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as CFG from './echo-config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TPL = path.join(HERE, '..', 'templates');

const APPLY = process.argv.includes('--apply');

// ★ 没有 --force。见文件头：会吃掉用户内容的选项不该存在。

// ══ 目录：编号 + 这个目录**放什么**（一句话，用户照着就知道该往里丢什么）══
//   ★ 原实现里有两个 60- 和两个 70-（60-工具/60-声音、70-收到/70-形象），
//     那是编号排到一半又加东西留下的，**你不需要继承它**。
const DIRS = [
  ['10-宪章', '长期不变的原则：你是谁、你怎么做事、你的边界。这里的东西改动最少。'],
  ['20-档案', '关于你的用户、你的项目、外部资料。会越来越厚，但很少删。'],
  ['30-状态', '当下是什么情况：交接给下一代、施工中、待办。这一层是给「下一个我」看的。'],
  ['40-产物索引', '做过的东西在哪。不是产物本身，是**指向产物**的目录。'],
  ['50-日记', '想写才写。不是任务，不用报备，写得散也没关系。'],
  ['60-工具', '你自己写的脚本。放这里，别散落在系统各处。'],
  ['65-声音', '你说话的样子：语气、口头禅、不肯说的话。'],
  ['70-收到', '别人给你的东西：用户给的、外面捡回来的。未经消化的原始材料。'],
  ['75-形象', '你的视觉形象：立绘、表情包、配色。'],
  ['80-科普', '你写给别人看的解释：什么是 X、为什么这样做。'],
  ['90-历代根会话', '旧的主导会话退场时留下的记录。不删，是沿革。'],
];

// ══ 根文件：名字 + 模板内容（null = 建空文件）══
const EMPTY_LEDGER = null;

const AGENTS_MD = `# 工作区指令（最小骨架）

> 这一份是你**项目层**的指令。全局约定写在你的 \`AGENTS.md\`（用户级），这里不重复。
>
> ★ 它和 \`SELF.md\` 的分工：指令层有预算上限，**满了会静默丢，而且最宽泛的先丢**；
> 所以最不能丢的东西（硬线、身份判据）放在 \`SELF.md\`，让它走推送层。

## 想不起事的时候，先跑这一条

\`\`\`
node [hub]/memq.mjs now            # 现在几点 / 距上轮多久 / 当前 lead / 未结
node [hub]/memq.mjs [词]           # 一扇门搜全库：只回指针 + 逐字片段
node [hub]/memq.mjs open [指针]    # 指针 → 原文
\`\`\`

## 三条不许忘的判断

- ★ **摘要只是索引，不是记忆本体。** 一手层永远优先于任何转述。
- ★ **不连续不是缺陷，是还没设计。** 你不是「想起来」，你是「翻回去」—— 所以门要好开。
- ★ **瓶颈不是检索精度，是触发。**「取回」不是问题，「知道要取」才是问题。

## 这个工作区是什么

\`[soul]/\` = 你的书房。\`02-墨.jsonl\` 是**只追加**的账本（承诺 / 事实 / 搁置 / 得 / 失 / 人格 / 容器）。
**谁是当前主导 = 《墨》里最后一条 lead 的署名者。**

<!-- 填法：把 [hub] 和 [soul] 换成你的实际路径。这一份是最小的，够跑起来就行 ——
     等你真的撞到一条规矩，再加进来。不要一上来写一大堆你不会遵守的话。 -->
`;

const GLOSSARY_MD = `# 术语表

> 这一份解释**只有你和你的用户之间才懂**的词。外部资料里的术语不要放这里。

| 词 | 意思 | 出处 |
|---|---|---|
| 墨 | 只追加的账本。承诺、事实、搁置、得、失都记在它里面 | \`02-墨.jsonl\` |
| 脑 / 器官 | 能替用户做承诺的会话 / 只能记事实的会话 | 见 \`SELF.md\` 身份判据 |
| 门 | 检索入口。只回指针和逐字片段，不做转述 | \`memq.mjs\` |
| 门牌 | 压缩产物里那个能回取原文的指针 | \`log:[会话]#seq=[n]\` |

<!-- 填法：每加一个只有你们俩懂的词，加一行。这个词表本身就是你们关系的一部分。 -->
`;

const FILES = [
  ['02-墨.jsonl', EMPTY_LEDGER, '只追加的账本（空文件，你自己往里写）'],
  ['AGENTS.md', AGENTS_MD, '工作区指令 · 最小骨架'],
  ['GLOSSARY.md', GLOSSARY_MD, '术语表'],
];

function tpl(name) {
  const p = path.join(TPL, name);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

function main() {
  console.log('');
  console.log('回声 · 搭骨架' + (APPLY ? '（执行）' : '（干跑 —— 加 --apply 才真建）'));
  console.log('─'.repeat(72));

  const r = CFG.checkConfig({ allowMissingSessions: true });
  if (!r.ok) {
    console.log('  没法开始，配置不全：');
    for (const p of r.problems) console.log(`    ✗ ${p}`);
    console.log('');
    for (const h of r.hints) console.log(h);
    console.log('');
    process.exit(2);
  }

  console.log(`  书房  ${CFG.SOUL}`);
  console.log(`  中枢  ${CFG.MEM}`);
  console.log('');

  let made = 0, skipped = 0;

  // ── 目录 ──
  console.log('  目录：');
  for (const [name, desc] of DIRS) {
    const p = path.join(CFG.SOUL, name);
    if (fs.existsSync(p)) {
      console.log(`    · ${name.padEnd(16)} 已存在，跳过`);
      skipped++;
      continue;
    }
    console.log(`    + ${name.padEnd(16)} ${desc.slice(0, 40)}…`);
    if (APPLY) fs.mkdirSync(p, { recursive: true });
    made++;
  }
  for (const d of [CFG.MEM, CFG.HUB, CFG.INDEX]) {
    const p = d.replace(/\//g, path.sep);
    if (!fs.existsSync(p)) {
      console.log(`    + ${path.basename(p).padEnd(16)} ${d}`);
      if (APPLY) fs.mkdirSync(p, { recursive: true });
      made++;
    }
  }

  // ── 根文件 ──
  console.log('');
  console.log('  根文件：');
  for (const [name, content, desc] of FILES) {
    const p = path.join(CFG.SOUL, name);
    if (fs.existsSync(p)) {
      const size = fs.statSync(p).size;
      const tag = name === '02-墨.jsonl'
        ? '★ 账本已存在 —— 不碰'
        : `已存在（${size} B），不碰`;
      console.log(`    · ${name.padEnd(16)} ${tag}`);
      skipped++;
      continue;
    }
    console.log(`    + ${name.padEnd(16)} ${desc}`);
    if (APPLY) {
      if (content === null) fs.writeFileSync(p, '');
      else fs.writeFileSync(p, content, 'utf8');
    }
    made++;
  }

  // ── SELF 模板 ──
  const selfSrc = path.join(CFG.HUB.replace(/\//g, path.sep), 'SELF.src.md');
  console.log('');
  console.log('  自我层：');
  if (fs.existsSync(selfSrc)) {
    console.log(`    · SELF.src.md      已存在，不碰（你要改就改它）`);
    skipped++;
  } else {
    const t = tpl('SELF.src.md');
    const p = selfSrc;
    console.log(`    + SELF.src.md      ${t ? '模板已就位（含 2 处待填占位符）' : '★ 模板文件丢了'}`);
    if (APPLY && t) fs.writeFileSync(p, t, 'utf8');
    made++;
  }

  // ── VITAL 模板 ──
  //   ★ 放在 30-状态/ 而不是 hub/ —— 稳态是「当下的情况」，和交接、待办是一类东西。
  const vitalSrc = path.join(CFG.SOUL.replace(/\//g, path.sep), '30-状态', 'VITAL.md');
  console.log('');
  console.log('  稳态层：');
  if (fs.existsSync(vitalSrc)) {
    console.log(`    · 30-状态/VITAL.md  已存在，不碰`);
    skipped++;
  } else {
    const t = tpl('VITAL.src.md');
    console.log(`    + 30-状态/VITAL.md  ${t ? '模板已就位（三种资源 × 三件套，全部待填）' : '★ 模板文件丢了'}`);
    if (APPLY && t) {
      fs.mkdirSync(path.dirname(vitalSrc), { recursive: true });
      fs.writeFileSync(vitalSrc, t, 'utf8');
    }
    made++;
  }

  console.log('');
  console.log('─'.repeat(72));
  console.log(`  ${APPLY ? '建了' : '将建'} ${made} 项，跳过 ${skipped} 项`);
  console.log('');

  if (!APPLY) {
    console.log('  这是干跑。确认没问题就加 --apply 真建：');
    console.log(`    node ${path.join(HERE, 'scaffold.mjs')} --apply`);
    console.log('');
  } else {
    console.log('  下一步：');
    console.log(`    1. 改 ${selfSrc.replace(/\\/g, '/')} 里的占位符，然后跑：`);
    console.log(`         node ${path.join(HERE, 'self.mjs').replace(/\\/g, '/')}`);
    console.log(`    2. ★ 让推送层真的读到它 —— 在 profile 的 cordis.patch.yml 里给 dsh-agent-memory 配：`);
    console.log(`         config:`);
    console.log(`           selfPath: '<${path.join(CFG.HUB, 'SELF.md').replace(/\\/g, '/')}>'`);
    console.log(`       ★ 这一步不做，SELF.md 就是个摆设：文件在磁盘上，但每轮注入时读不到。`);
    console.log(`         echo-doctor 的「推送层 SELF」会一直红，而删掉这一项检查它就永远绿 —— 那才是假绿。`);
    console.log(`    3. 填 ${vitalSrc.replace(/\\/g, '/')} —— 四张表，全空着；`);
    console.log(`       ★ 只挑你真撞过的那一个资源填满，其余留空。编出来的阈值会跟着你很久。`);
    console.log(`    4. node ${path.join(HERE, 'memindex.mjs').replace(/\\/g, '/')} build`);
    console.log(`    5. node ${path.join(HERE, 'echo.mjs').replace(/\\/g, '/')} --dom-stat`);
    console.log('');
    console.log('  这五步全过，六层 + 稳态就立起来了 —— 而且「全过」是能验的，不是感觉。');
    console.log('');
  }
}

main();
