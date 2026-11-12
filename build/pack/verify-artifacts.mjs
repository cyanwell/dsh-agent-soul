// verify-artifacts.mjs -- 复算 R2 的三条硬事实（不依赖任何第三方库）
//
//   1) portable zip 解压后与 dist 树逐文件 hash 相同（缺 0 / 异 0 / 多 0）
//   2) htmlpatch 只含 .html/.css/.js（浏览器侧），且每个文件与 dist 同名文件 hash 相同
//      —— R2 的核心断言：**不得含 server.mjs 或任何服务端 .mjs**
//   3) setup.exe 内嵌的就是那份 portable zip（用字节子串定位，报 offset）
//
// 用法：node build\pack\verify-artifacts.mjs [-Version 1.0.1]
// 退出码：0 = 全过；1 = 有断言失败。

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const argV = process.argv.indexOf('-Version');
const VERSION = argV > 0 ? process.argv[argV + 1] : '1.0.1';

const dist = path.join(REPO, 'dist');
const tree = path.join(dist, 'AgentSoul');
const portable = path.join(dist, 'AgentSoul-' + VERSION + '-portable.zip');
const patch = path.join(dist, 'AgentSoul-' + VERSION + '-htmlpatch.zip');
const setup = path.join(dist, 'AgentSoul-Setup-' + VERSION + '.exe');

const rows = [];
const t = (name, ok, detail) => rows.push({ name, ok: !!ok, detail: detail === undefined ? null : String(detail) });
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex').toUpperCase();

// ---------- minimal zip reader (central directory + local headers) ----------
function readZip(buf) {
  let eocd = -1;
  const stop = Math.max(0, buf.length - 22 - 65536);
  for (let i = buf.length - 22; i >= stop; i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('EOCD not found');
  const count = buf.readUInt16LE(eocd + 10);
  const cdOff = buf.readUInt32LE(eocd + 16);
  const out = [];
  let p = cdOff;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central dir signature at ' + p);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen).replace(/\\/g, '/');
    out.push({ name, method, crc, csize, usize, localOff });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function unzipEntry(buf, e) {
  const lh = e.localOff;
  if (buf.readUInt32LE(lh) !== 0x04034b50) throw new Error('bad local header for ' + e.name);
  const nameLen = buf.readUInt16LE(lh + 26);
  const extraLen = buf.readUInt16LE(lh + 28);
  const start = lh + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + e.csize);
  let raw;
  if (e.method === 0) raw = Buffer.from(data);
  else if (e.method === 8) raw = zlib.inflateRawSync(data);
  else throw new Error('unsupported compression method ' + e.method + ' for ' + e.name);
  return raw;
}

// ---------- 0. files exist ----------
for (const f of [portable, patch, setup]) t('artifact exists: ' + path.basename(f), fs.existsSync(f), path.basename(f));

// ---------- 1. portable vs dist tree ----------
const distMap = new Map();
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else distMap.set(path.relative(tree, p).split(path.sep).join('/'), sha(fs.readFileSync(p)));
  }
})(tree);

if (fs.existsSync(portable)) {
  const buf = fs.readFileSync(portable);
  const entries = readZip(buf).filter((e) => !e.name.endsWith('/'));
  let okCount = 0, mismatch = 0, missing = 0;
  const bad = [];
  for (const e of entries) {
    const want = distMap.get(e.name);
    if (!want) { missing++; bad.push('missing-in-tree: ' + e.name); continue; }
    const got = sha(unzipEntry(buf, e));
    if (got === want) okCount++; else { mismatch++; bad.push('hash: ' + e.name); }
  }
  const extra = [...distMap.keys()].filter((k) => !entries.find((e) => e.name === k));
  t('portable entries == dist files', entries.length === distMap.size, 'entries=' + entries.length + ' dist=' + distMap.size);
  t('portable hashes match dist', mismatch === 0 && missing === 0, 'ok=' + okCount + ' mismatch=' + mismatch + ' missing=' + missing);
  t('portable has no extra dist files', extra.length === 0, 'extra=' + extra.length + (extra.length ? ' ' + extra.slice(0, 3).join(',') : ''));
  if (bad.length) bad.slice(0, 5).forEach((b) => console.log('   [bad] ' + b));
}

// ---------- 2. htmlpatch: pages only ----------
if (fs.existsSync(patch)) {
  const buf = fs.readFileSync(patch);
  const entries = readZip(buf).filter((e) => !e.name.endsWith('/'));
  const allowed = new Set(['.html', '.css', '.js']);
  const badExt = entries.filter((e) => !allowed.has(path.extname(e.name).toLowerCase()));
  const mjs = entries.filter((e) => /\.mjs$/i.test(e.name) || /server\.mjs$/i.test(e.name));
  let okHash = 0;
  for (const e of entries) {
    const rel = e.name.replace(/^app\/[^/]+\//, 'app/' + VERSION + '/');
    const want = distMap.get(rel) || distMap.get(e.name);
    if (want && sha(unzipEntry(buf, e)) === want) okHash++;
  }
  t('htmlpatch contains only .html/.css/.js', badExt.length === 0, 'entries=' + entries.length + ' bad=' + badExt.map((x) => x.name).join(','));
  t('htmlpatch contains NO server .mjs', mjs.length === 0, 'mjs=' + mjs.length);
  t('htmlpatch files byte-identical to dist copies', okHash === entries.length, 'ok=' + okHash + '/' + entries.length);
  t('htmlpatch < 1 MB', buf.length < 1024 * 1024, 'bytes=' + buf.length);
  console.log('   [patch] ' + entries.map((e) => e.name + ' (' + e.usize + 'B)').join('\n   [patch] '));
}

// ---------- 3. setup embeds the portable zip ----------
if (fs.existsSync(setup) && fs.existsSync(portable)) {
  const s = fs.readFileSync(setup);
  const p = fs.readFileSync(portable);
  const off = s.indexOf(p);
  t('setup embeds the portable zip byte for byte', off >= 0, 'offset=' + off + ' shell-bytes=' + (off >= 0 ? s.length - p.length : '?'));
  if (off >= 0) console.log('   [setup] MZ=' + s.subarray(0, 2).toString('hex') + ' embedded-offset=' + off + ' embedded-sha=' + sha(s.subarray(off, off + p.length)).slice(0, 16) + '...');
}

// ---------- 4. config fixture ----------
const relCfg = path.join(REPO, 'config.release.json');
const dstCfg = path.join(tree, 'config.json');
if (fs.existsSync(relCfg) && fs.existsSync(dstCfg)) {
  t('dist config.json == config.release.json', sha(fs.readFileSync(relCfg)) === sha(fs.readFileSync(dstCfg)), 'sha=' + sha(fs.readFileSync(dstCfg)).slice(0, 16) + '...');
}

// ---------- report ----------
const bad = rows.filter((r) => !r.ok);
for (const r of rows) console.log((r.ok ? 'PASS  ' : 'FAIL  ') + r.name + (r.detail ? '  ::  ' + r.detail : ''));
console.log('---');
console.log('version=' + VERSION + ' total=' + rows.length + ' failed=' + bad.length);
process.exit(bad.length ? 1 : 0);
