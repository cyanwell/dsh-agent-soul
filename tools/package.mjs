// 打包器 —— 把 exe + 应用数据打成单文件
//
// ★ 用 config.release.json 而不是 config.json：
//   开发那份里 dataDir 是 D:/AI/agent-soul/data（我的机器），
//   发布版必须走相对路径，落在 %LOCALAPPDATA%\\agent-soul\\data。
//   打错这一份，用户的数据就会跑到一个不存在的 D 盘目录去。

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

function crc32(buf) {
  let c, table = [];
  for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function makeZip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const e of entries) {
    const comp = zlib.deflateRawSync(e.data, { level: 6 });
    const crc = crc32(e.data);
    const nb = Buffer.from(e.name, 'utf8');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(e.data.length, 22); lh.writeUInt16LE(nb.length, 26);
    locals.push(lh, nb, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(e.data.length, 24); ch.writeUInt16LE(nb.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nb);
    offset += 30 + nb.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const entries = [];
const addDir = (absDir, relBase) => {
  for (const e of fs.readdirSync(absDir)) {
    if (e === 'node_modules' || e === 'data' || e === 'build' || e.startsWith('.')) continue;
    const a = path.join(absDir, e);
    const r = relBase ? relBase + '/' + e : e;
    if (fs.statSync(a).isDirectory()) addDir(a, r);
    else if (/\.(mjs|html|json|md|txt)$/.test(e)) entries.push({ name: r, data: fs.readFileSync(a) });
  }
};

const NODE = process.env.AGENT_SOUL_NODE
  || 'C:/Users/pc/AppData/Local/Programs/DeepSeek Harness/resources/runtime/primary-runtime/dependencies/node/bin/node.exe';
if (!fs.existsSync(NODE)) { console.error('找不到 node.exe: ' + NODE); process.exit(1); }
entries.push({ name: 'runtime/node.exe', data: fs.readFileSync(NODE) });
addDir(path.join(ROOT, 'src'), 'src');
if (fs.existsSync(path.join(ROOT, 'docs'))) addDir(path.join(ROOT, 'docs'), 'docs');
for (const f of ['package.json', 'README.md']) {
  const p = path.join(ROOT, f);
  if (fs.existsSync(p)) entries.push({ name: f, data: fs.readFileSync(p) });
}

// ★ 配置：发布版
const rel = path.join(ROOT, 'config.release.json');
const dev = path.join(ROOT, 'config.json');
const cfgSrc = fs.existsSync(rel) ? rel : dev;
entries.push({ name: 'config.json', data: fs.readFileSync(cfgSrc) });
console.log('配置来源: ' + path.basename(cfgSrc));

const zip = makeZip(entries);
const MAGIC = Buffer.from('AGENTSOULPKG01', 'ascii');
const sizeBuf = Buffer.alloc(8);
sizeBuf.writeBigUInt64LE(BigInt(zip.length), 0);

// ★ 打包用的是 agent-soul-dev.exe，**不是 launcher.exe**。
//   2026-11-07 踩过：我在 launcher.exe 里改了启动器（Job Object / AGENT_SOUL_PARENT），
//   打包出来跑的却是 02:38 的旧 dev —— **改了 A，跑的是 B**。
//   两个 exe 名字不同、都能编译通过，所以谁也不会报错。
//   改完 Launcher.cs 之后，csc 的输出必须写成 agent-soul-dev.exe（或在这里复制一次）。
const exeDev = path.join(ROOT, 'build', 'agent-soul-dev.exe');
const out = path.join(ROOT, 'build', 'agent-soul.exe');
fs.writeFileSync(out, Buffer.concat([fs.readFileSync(exeDev), MAGIC, sizeBuf, zip]));
console.log('');
console.log('  打包完成');
console.log('  文件  ' + entries.length + ' 个');
console.log('  产物  ' + out);
console.log('  大小  ' + Math.round(fs.statSync(out).size / 1048576) + ' MB');
