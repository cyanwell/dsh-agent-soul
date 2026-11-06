#!/usr/bin/env node
// 从 frames.jsonl 重建 index.jsonl（截断到 500 字符）
//
// ★ 为什么需要：第一版索引存了完整正文，15.9 万帧 → 658MB。
//   索引是门牌，不是原文 —— 要看全文用 soul_frame 按 seq 取。

import fs from 'node:fs';
import path from 'node:path';
import { extractText } from '../src/session/frame.mjs';

const DATA = process.argv[2] || 'D:/AI/agent-soul/data/sessions';
const MAX = 500;

let totalIn = 0, totalOut = 0, totalRows = 0, bad = 0;
const t0 = Date.now();

for (const name of fs.readdirSync(DATA)) {
  const dir = path.join(DATA, name);
  const fr = path.join(dir, 'frames.jsonl');
  const ix = path.join(dir, 'index.jsonl');
  if (!fs.existsSync(fr)) continue;
  totalIn += fs.existsSync(ix) ? fs.statSync(ix).size : 0;

  const out = [];
  const lines = fs.readFileSync(fr, 'utf8').split('\n');
  for (const line of lines) {
    if (!line) continue;
    let f;
    try { f = JSON.parse(line); } catch { bad++; continue; }
    const full = extractText(f);
    if (!full) continue;
    const text = full.length > MAX ? full.slice(0, MAX) : full;
    out.push(JSON.stringify({ seq: f.seq, t: f.t, type: f.type, text }));
    totalRows++;
  }
  const body = out.length ? out.join('\n') + '\n' : '';
  fs.writeFileSync(ix, body, 'utf8');
  totalOut += Buffer.byteLength(body, 'utf8');
}

const sec = ((Date.now() - t0) / 1000).toFixed(1);
console.log('重建完成 ' + sec + 's');
console.log('  索引行: ' + totalRows + '（坏帧 ' + bad + '）');
console.log('  体积: ' + (totalIn / 1048576).toFixed(1) + 'MB → ' + (totalOut / 1048576).toFixed(1) + 'MB');