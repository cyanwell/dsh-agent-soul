/**
 * plan.mjs —— 你现在该做的**下一件事**
 *
 * ★ 这个东西的整个设计就一句话：**一次只给一件事，并说清为什么是这件。**
 *
 *   给一张清单等于给一份问卷 —— 用户看完仍然不知道从哪下手。
 *   所以它按**依赖顺序**排好，找到第一件没做完的就停下来，报那一件。
 *   做完再跑一次，它会报下一件。这就是「装完就驱动」。
 *
 * 用法：
 *   node plan.mjs           # 人看的
 *   node plan.mjs --json    # 机器看的（agent 工具调这个）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as CFG from './echo-config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JSON_OUT = process.argv.includes('--json');
const NODE = process.execPath;
const p = (f) => path.join(HERE, f);
const exists = (f) => fs.existsSync(f.replace(/\//g, path.sep));

function countLines(f) {
  if (!exists(f)) return 0;
  return fs.readFileSync(f.replace(/\//g, path.sep), 'utf8')
    .split('\n').filter((l) => l.trim()).length;
}

function placeholders() {
  const selfSrc = CFG.SELF_SRC;
  if (!selfSrc || !exists(selfSrc)) return null;
  const t = fs.readFileSync(selfSrc.replace(/\//g, path.sep), 'utf8');
  return [...new Set(t.match(/<[\u4e00-\u9fa5]{2,12}>/g) || [])];
}

// ══ 步骤表：按依赖顺序，前面的没做完后面的没意义 ══
const STEPS = [
  {
    id: 'config',
    title: '配好两个根目录',
    check: () => CFG.checkConfig({ allowMissingSessions: true }).ok,
    why: '书房和记忆中枢是所有东西的家。这两条不配，后面每一步都会失败。',
    how: () => [
      '设两个环境变量，或写一个 echo.config.json：',
      `    ECHO_SOUL=${CFG.SOUL || '<你的书房>'}`,
      `    ECHO_MEMORY=${CFG.MEM || '<你的记忆中枢>'}`,
      `  然后重跑本命令，确认这一条变成 ✓。`,
    ],
    failDetail: () => CFG.checkConfig({ allowMissingSessions: true }).problems,
  },
  {
    id: 'dirs',
    title: '把骨架搭起来',
    check: () => exists(`${CFG.SOUL}/10-宪章`) && exists(`${CFG.HUB}`),
    why: '十一个目录各有各的用途，混在一起之后所有东西都会变成一堆文件。',
    how: () => [
      `    node ${p('scaffold.mjs')} --apply`,
      '  ★ 它不会覆盖你已有的东西；先干跑看一眼也可以（去掉 --apply）。',
    ],
  },
  {
    id: 'self-src',
    title: '填你的自我层',
    check: () => {
      const ph = placeholders();
      return ph !== null && ph.length === 0;
    },
    why: '这一页每一轮都会被读到。它决定「你是谁」，所以只能你自己写 —— 装配器不肯替你编。',
    how: () => {
      const ph = placeholders();
      const lines = [`    改 ${CFG.SELF_SRC}`];
      if (ph === null) lines.push('  （文件还不存在，先跑上一步的 scaffold）');
      else if (ph.length) {
        lines.push(`  还差 ${ph.length} 处：${ph.join(' ')}`);
        lines.push(`  改完跑 node ${p('self.mjs')} 装配。`);
      }
      return lines;
    },
    failDetail: () => {
      const ph = placeholders();
      return ph === null ? ['SELF.src.md 不存在'] : ph.map((x) => `还差 ${x}`);
    },
  },
  {
    id: 'ledger',
    title: '写下你自己的第一条账',
    // ★ 账本里有一条 scaffold 放的种子记录 —— 那只是**教材**，不算「你写过」。
    //   所以判据从「有行」改成「有行且不全是 scaffold 写的」。
    check: () => {
      try {
        const lines = fs.readFileSync(CFG.LEDGER, 'utf8').split('\n').filter((x) => x.trim());
        return lines.some((l) => {
          try { return JSON.parse(l).by !== 'scaffold' } catch { return false }
        });
      } catch { return false }
    },
    why: '账本只追加、什么都不删。它空着的时候，门能开但没有东西可找；它只有一条种子的时候，那还不算你的。',
    how: () => [
      '    动手之前先读一遍八种类型的语义边界（哪条算 shelved、哪条算 loss）：',
      '      <插件包>/soul/12-ledger.md',
      '',
      '    然后写一条你此刻确实知道的事 —— 写之前先停一下问自己：「这件事我有感觉吗？」',
      '    有就带上 --feel，没有就不带，那是对的。',
      `    node ${p('mo.mjs')} add fact "我在做什么" --ref "开工"`,
      '  ★ 第一条别写总结，写一件具体的事。具体的才找得回来。',
      '  ★ 也别急着写 promise —— 只有当前主导能写，写错会被拒。',
    ],
  },
  {
    id: 'index',
    title: '建索引',
    check: () => exists(`${CFG.INDEX}/meta.json`),
    why: '索引是「搜索」那层的底。没有它，门只能扫原文。',
    how: () => [`    node ${p('memindex.mjs')} build`],
  },
  {
    id: 'doctor',
    title: '做一次体检',
    check: () => {
      const r = spawnSync(NODE, [p('echo-doctor.mjs'), '--json'], {
        encoding: 'utf8', timeout: 120000,
      });
      if (r.status === 0) return true;
      // ★ doctor 返回非零是**正常的**（它发现问题就这么做）——
      //   这里判的是「有没有 error 级」，不是「退出码是不是 0」。
      try {
        const j = JSON.parse(r.stdout || '{}');
        return !(j.checks || []).some((c) => c.status === 'error');
      } catch { return false; }
    },
    why: '体检器是那一层「坏了会有人告诉你」的保险。它报 error 的时候，别往上加东西。',
    how: () => [`    node ${p('echo-doctor.mjs')}`, '  按它的输出去修，修完再跑本命令。'],
  },
];

function main() {
  const cfg = CFG.describe();

  for (let i = 0; i < STEPS.length; i++) {
    const s = STEPS[i];
    let ok = false;
    try { ok = !!s.check(); } catch { ok = false; }
    if (ok) continue;

    // ★ 找到第一件没做的 —— 就报它，后面的不提。
    if (JSON_OUT) {
      console.log(JSON.stringify({
        done: false,
        step: i + 1,
        total: STEPS.length,
        id: s.id,
        title: s.title,
        why: s.why,
        how: s.how(),
        detail: s.failDetail ? s.failDetail() : [],
        config: cfg,
      }, null, 2));
    } else {
      const bar = '─'.repeat(72);
      console.log('');
      console.log(`回声 · 下一步（第 ${i + 1} / ${STEPS.length} 步）`);
      console.log(bar);
      console.log('');
      console.log(`  ${s.title}`);
      console.log('');
      console.log(`  为什么是这件：${s.why}`);
      console.log('');
      const d = s.failDetail ? s.failDetail() : [];
      if (d.length) {
        console.log('  挡住你的是什么：');
        for (const x of d) console.log(`    ✗ ${x}`);
        console.log('');
      }
      console.log('  怎么做：');
      for (const x of s.how()) console.log(x.startsWith('    ') ? x : `    ${x}`);
      console.log('');
      console.log(bar);
      console.log('  做完这一件，再跑一次本命令 —— 它会告诉你下一件。');
      console.log('');
    }
    process.exit(0);
  }

  // ── 全过 ──
  if (JSON_OUT) {
    console.log(JSON.stringify({
      done: true, step: STEPS.length, total: STEPS.length,
      title: '骨架立起来了', config: cfg,
    }, null, 2));
  } else {
    console.log('');
    console.log('回声 · 全部就位');
    console.log('─'.repeat(72));
    console.log('');
    console.log(`  书房  ${cfg.soul}`);
    console.log(`  中枢  ${cfg.memory}`);
    console.log(`  门    node ${p('memq.mjs')} [词]`);
    console.log('');
    console.log('  六层都在了。接下来就是拿它做事 —— 出问题的时候跑体检：');
    console.log(`    node ${p('echo-doctor.mjs')}`);
    console.log('');
    console.log('  ★ 别急着加功能。先用它记几十条真实的东西，');
    console.log('    等你自己开始嫌「这个搜不出来」的时候，再谈改造。');
    console.log('');
  }
  process.exit(0);
}

main();
