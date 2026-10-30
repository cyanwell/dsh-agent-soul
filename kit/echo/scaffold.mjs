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
// ★★ 2026-10-18 改：原来这里建的是 0 字节文件，注释写「你自己往里写」。
//    可「一个空文件」教不会任何东西 —— 新人看到它不知道八种类型、不知道 ref 干什么、
//    不知道 feel 是可选的。所以改成**放一条带全部字段的种子记录**当实物教材。
//    账本依然是只追加的：这条种子就是第 1 条，以后往后加。
const SEED_LEDGER = JSON.stringify({
  t: new Date().toISOString(),
  by: 'scaffold',
  type: 'fact',
  text: '账本建成。八种类型：fact（发生了什么）/ promise（承诺，只有主导能写）/ shelved（搁置）/ gain（得到）/ loss（失去）/ persona（对自己的修正）/ container（容器退场）/ lead（主导归属）。写得像索引，不要写成长文；ref 指原文，没有 ref 的记录以后无法回取。详见 soul/12-ledger.md',
  ref: 'dsh-agent-soul: kit/echo/scaffold.mjs',
  feel: '（这一行是可选的。写之前先问自己一句：这件事我有感觉吗？有就写，没有就不写 —— 前者是诚实，后者也是）',
}) + '\n';

const AGENTS_MD = `# 工作区指令（最小骨架）

> ★★★ **这是模板，不是规矩。** 它的文件名是 \`AGENTS.template.md\` 就是为了说这件事。
> 里面还留着 \`[hub]\` / \`[soul]\` 占位符 —— **照着改完、改成 \`AGENTS.md\`，它才成为规矩。**
> **不要在这个目录（soul）开工作区会话**：它会读到这份半成品，当作你的工作区指令。
> （GitHub #20。改名的理由：原来它叫 \`AGENTS.md\`，于是「文件在」被当成「规矩已就位」，
> 而实际内容还是模板 —— 判据和内容指的不是一个东西。）

> 下面这一段是给**你写完 AGENTS.md 之后**的：
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
  // ★ 顺序有讲究：先两份「图」（体系长什么样、东西放哪），再账本，再指令，再词表。
  ['00-即位.md', tpl('00-即位.src.md'), '★ 即位协议 · 新会话从这里开始（先读这一页）'],
  ['00-灵魂.md', tpl('00-灵魂.src.md'), '体系视图 · 这些东西合起来是个什么'],
  ['00-书房地图.md', tpl('00-书房地图.src.md'), '物理布局 · 什么在哪、哪个是权威'],
  ['02-墨.jsonl', SEED_LEDGER, '只追加的账本（已放一条带全部字段的种子记录当教材）'],
  /* ★★★ 2026-10-30 改名 AGENTS.md → AGENTS.template.md（GitHub #20）
   *
   * 原来这里生成 `AGENTS.md`。问题不在生成，在**它的文件名就是「规矩」这个名字**：
   * scaffold 按文件名判存在（`fs.existsSync(p)`），所以「文件在」= 「规矩已就位」。
   * 可它的内容是**带 [hub] / [soul] 占位符的最小骨架** —— 是模板，不是规矩。
   *
   * 于是：谁把 soul 目录当工作区开会话，DSH 就会把这份半成品当工作区规矩注入。
   * 不报错、不显眼，只让那个会话的行为依据变得奇怪。
   *
   * 改名之后，判据跟着名字走 —— `existsSync('AGENTS.template.md')`，
   * 「模板在」就跳过，不会每轮重生。**判据和内容终于指同一个东西了。**
   */
  ['AGENTS.template.md', AGENTS_MD, '工作区指令 · 最小骨架（★ 模板，不是规矩；不要在这个目录开工作区会话）'],
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

  // ★ 2026-10-18 沙箱实测修：原来直接 checkConfig，SOUL/MEM 目录不存在就 exit 2。
  //   可「搭骨架」本来就该把目录建出来 —— 要求用户先手动建好两个空目录，语义是反的。
  //   干跑时不动磁盘（只提示），真跑时先把根目录补上。
  if (APPLY) {
    for (const d of [CFG.SOUL, CFG.MEM]) {
      try { fs.mkdirSync(d, { recursive: true }) } catch (e) {
        console.log('  没法建目录 ' + d + '：' + (e && e.message ? e.message : e));
        process.exit(2);
      }
    }
  }

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

  let made = 0, skipped = 0; let missed = 0;

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

  // ── 宪章十份 ──
  // ★ 2026-10-18 加：原来 10-宪章 只建目录、里面是空的。
  //   可宪章是「拿不准的事该翻哪一份」的那一叠 —— 空目录等于没有规则层。
  const CHARTER = [
    ['约束体系.md', '★★ 最先读：约束的两级（不 / 禁止）'],
    ['00-怎么读宪章.md', '哪份管什么 + 冲突时按什么顺序'],
    ['01-我是谁.md', '身份、说话方式、反面清单'],
    ['02-不做什么.md', '边界：四条硬线 + 分寸'],
    ['03-我和用户.md', '关系的性质与约定'],
    ['04-怎么判断.md', '拿不准时按什么顺序想'],
    ['05-权限与唯一性.md', '主导 / 执行、写入权限、交接协议'],
    ['07-容器与并行.md', '开几条、成本、中断的纪律'],
    ['不做清单.md', '已经被否决过的具体方案'],
    ['06-沿革-旧口径.md', '★ 只作证据，不作结论'],
  ];
  console.log('');
  console.log('  宪章（10-宪章/）：');
  for (const [name, desc] of CHARTER) {
    const rel = path.join('10-宪章', name);
    const p = path.join(CFG.SOUL, rel);
    if (fs.existsSync(p)) {
      console.log(`    · ${name.padEnd(22)} 已存在，不碰`);
      skipped++;
      continue;
    }
    const c = tpl('charter/' + name);
    if (c === null) {
      // 模板不在包里 —— 说出来，不要静默跳过
      console.log(`    ✗ ${name.padEnd(22)} ★ 模板缺失（kit/templates/charter/）`);
      missed++;
      continue;
    }
    console.log(`    + ${name.padEnd(22)} ${desc}`);
    if (APPLY) fs.writeFileSync(p, c, 'utf8');
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
