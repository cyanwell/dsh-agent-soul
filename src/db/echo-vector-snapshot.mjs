// 向量矩阵的二进制快照 —— 冷启动加速层（v12，2026-11-18）
//
// ★★★ 为什么值得单独做一个文件（实测，不是推测）
//   从 SQLite 取同一份数据 vs 从裸文件取：
//     JOIN 取 211,640 行 / 413MB（node:sqlite）...... 7,408 ms
//     另取小字段（word_ord/window_ord/char_*）.......... 3,347 ms
//     裸读 413MB（fs.readFileSync）.....................   394 ms
//   19 倍的差距。原因不是磁盘，是 **node:sqlite 每行构造一个 JS 对象、
//   每个 BLOB 再构造一个 Uint8Array** —— 21 万次分配，再快的 SSD 也救不了。
//   所以：把矩阵一次性摊成连续内存、顺序读回来，绕开这个开销。
//
// ★★★ 它只是**加速层**，不是真相来源（这一点决定它能否安全存在）
//   真相永远是 meta.sqlite 里的向量行。快照头部写着它的指纹
//   （行数 + MAX(word_ord) + 模型键 + 源 id），加载前先核对：
//     对得上 → 用；对不上 → 丢掉、回库里重建、重写快照。
//   任何一步出错（文件截断 / 头损坏 / 版本不认识 / 空间不够）都**静默回落**到
//   从库里建 —— 慢一点，但绝不会拿一份对不上的数据当结果。
//
// ★ 格式（全部 little-endian；本机与目标平台都是 x86-64）
//     magic      8 字节  "ASVCACHE"
//     version    u32     1
//     headerLen  u32
//     header     JSON（utf8）—— 含 kind/modelKey/echoSourceId/fingerprint/n/dim
//     然后各段依次按 8 字节对齐铺开（见下面 SECTIONS 的顺序）
//   ★ 读的时候先把整个文件读进一个**自己分配的 ArrayBuffer**（byteOffset=0），
//     这样 float32/float64 视图一定对齐 —— 直接拿 Buffer.buffer 会掉进
//     Buffer 池的偏移里，视图会抛 RangeError。

import fs from 'node:fs';
import path from 'node:path';

export const SNAPSHOT_VERSION = 1;
const MAGIC = 'ASVCACHE';
const HEADER_PROBE = 4096;

/** 快照放哪：和 meta.sqlite 同级目录下的 vector-cache/。 */
const dirCache = new Map();
function snapshotDir(db) {
  let dir = dirCache.get(db);
  if (dir !== undefined) return dir;
  dir = null;
  try {
    const rows = db.prepare('PRAGMA database_list').all();
    const main = rows.find((r) => r.name === 'main') || rows[0];
    const file = main && main.file;
    if (file && String(file).trim()) dir = path.join(path.dirname(String(file)), 'vector-cache');
  } catch { dir = null; }
  dirCache.set(db, dir);
  return dir;
}

function snapshotDisabled() {
  const raw = String(process.env.AGENT_SOUL_ECHO_VECTOR_SNAPSHOT || '').toLowerCase();
  return raw === 'off' || raw === '0' || raw === 'false';
}

function fileFor(db, kind, echoSourceId, modelKey) {
  const dir = snapshotDir(db);
  if (!dir) return null;
  // 文件名带源与模型键，天然按「一套向量」分文件；脏写不会互相影响。
  const safe = (s) => String(s).replace(/[^0-9a-zA-Z._-]/g, '_').slice(0, 64);
  return path.join(dir, kind + '-' + safe(echoSourceId) + '-' + safe(modelKey).slice(0, 16) + '.bin');
}

/**
 * 读快照。返回 null = 没有 / 不可用 / 对不上（调用方一律回库重建）。
 * @param {object} expect { kind, echoSourceId, modelKey, fingerprint }
 * @param {(header:object, sections:Array, ab:ArrayBuffer, payloadStart:number)=>object} decode
 *        把段还原成矩阵对象。★ payloadStart 必须加在段偏移上（段偏移是相对载荷的）。
 */
export function readSnapshot(db, expect, decode) {
  if (snapshotDisabled()) return null;
  const file = fileFor(db, expect.kind, expect.echoSourceId, expect.modelKey);
  if (!file) return null;
  let fd = null;
  try {
    if (!fs.existsSync(file)) return null;
    fd = fs.openSync(file, 'r');
    // ① 先只读头，核对身份 —— 免得为了一个过期的快照白读 400MB。
    const probe = Buffer.alloc(HEADER_PROBE);
    const got = fs.readSync(fd, probe, 0, HEADER_PROBE, 0);
    if (got < 16 || probe.toString('ascii', 0, 8) !== MAGIC) return null;
    const version = probe.readUInt32LE(8);
    if (version !== SNAPSHOT_VERSION) return null;
    const headerLen = probe.readUInt32LE(12);
    if (headerLen <= 0 || 16 + headerLen > got) return null;
    let header;
    try { header = JSON.parse(probe.toString('utf8', 16, 16 + headerLen)); } catch { return null; }
    if (header.kind !== expect.kind) return null;
    if (String(header.echoSourceId) !== String(expect.echoSourceId)) return null;
    if (String(header.modelKey) !== String(expect.modelKey)) return null;
    if (String(header.fingerprint) !== String(expect.fingerprint)) return null;
    // ② 身份对上了，才整份读进来。
    //   ★ header.totalBytes 是**载荷**长度，不是文件长度 ——
    //     我第一版拿它跟 stat.size 直接比，于是文件永远「尺寸不符」、
    //     快照永远落回从库建（实测撞到：写得出、读不回）。
    //     文件总长 = 载荷起点 + 载荷长度。
    const payloadBytes = Number(header.totalBytes);
    if (!Number.isSafeInteger(payloadBytes) || payloadBytes <= 0) return null;
    const payloadBase = 16 + headerLen + (((16 + headerLen) % 8 === 0) ? 0 : 8 - ((16 + headerLen) % 8));
    const total = payloadBase + payloadBytes;
    const stat = fs.fstatSync(fd);
    if (stat.size !== total) return null;
    const ab = new ArrayBuffer(total);
    const u8 = new Uint8Array(ab);
    let read = 0;
    while (read < total) {
      const n = fs.readSync(fd, u8, read, total - read, read);
      if (n <= 0) break;
      read += n;
    }
    if (read !== total) return null;
    // ★ 段偏移是**相对载荷起点**算的（layout() 从 0 起排），
    //   而这里拿到的是整个文件的 ArrayBuffer —— 必须把载荷起点加回去。
    //   载荷起点被 pad 过，保证是 8 的倍数，所以 float64 视图也一定对齐。
    const sections = header.sections;
    const view = decode(header, sections, ab, payloadBase);
    if (!view) return null;
    view.fromSnapshot = true;
    view.fingerprint = header.fingerprint;
    view.checkedAt = Date.now();
    view.buildMs = 0;
    return view;
  } catch {
    return null;   // 任何异常都回落到从库建，绝不把坏快照当数据
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* 忽略 */ } }
  }
}

/**
 * 写快照（尽力而为：写不成就算了，绝不让它影响检索）。
 * ★ 先写 .tmp 再 rename —— 原子替换，不会留下半个文件被别人读走。
 */
export function writeSnapshot(db, expect, encode) {
  if (snapshotDisabled()) return false;
  const file = fileFor(db, expect.kind, expect.echoSourceId, expect.modelKey);
  if (!file) return false;
  let tmp = null;
  try {
    const built = encode();
    if (!built || !built.sections || !built.totalBytes) return false;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const header = Object.assign({}, built.header, {
      kind: expect.kind,
      echoSourceId: String(expect.echoSourceId),
      modelKey: String(expect.modelKey),
      fingerprint: String(expect.fingerprint),
      sections: built.sections,
      totalBytes: built.totalBytes,
    });
    const headerBuf = Buffer.from(JSON.stringify(header), 'utf8');
    const head = Buffer.alloc(16);
    head.write(MAGIC, 0, 'ascii');
    head.writeUInt32LE(SNAPSHOT_VERSION, 8);
    head.writeUInt32LE(headerBuf.length, 12);
    const pad = (16 + headerBuf.length) % 8 === 0 ? 0 : 8 - ((16 + headerBuf.length) % 8);
    tmp = file + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, head);
      fs.writeSync(fd, headerBuf);
      if (pad) fs.writeSync(fd, Buffer.alloc(pad));
      for (const seg of built.segments) fs.writeSync(fd, seg);
      // ★ 尾部补齐到 header 声明的 totalBytes。
      //   为什么会差几个字节：段偏移按 8 对齐排布，最后一个段之后还剩 align8 的余量；
      //   写侧原来没补，于是 header 写 440,257,608、文件实际 440,257,602 ——
      //   读侧一句「尺寸不符」就判废，症状是**写得出来、永远读不回去**（实测撞到）。
      //   这里以 header 的 totalBytes 为唯一真源补齐：少则补零，多则报错。
      const payloadWritten = built.segments.reduce((a, s) => a + s.length, 0);
      if (payloadWritten > built.totalBytes) throw new Error('snapshot payload exceeds declared size');
      const tail = built.totalBytes - payloadWritten;
      if (tail > 0) fs.writeSync(fd, Buffer.alloc(tail));
    } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
    return true;
  } catch {
    if (tmp) { try { fs.rmSync(tmp, { force: true }); } catch { /* 忽略 */ } }
    return false;
  }
}

/** 向量变了就把快照丢掉，别让它被下一次读走。 */
export function dropSnapshots(db, echoSourceId, modelKey) {
  const dir = snapshotDir(db);
  if (!dir) return 0;
  let removed = 0;
  let names;
  try { names = fs.readdirSync(dir); } catch { return 0; }
  for (const name of names) {
    if (!name.endsWith('.bin') && !name.endsWith('.tmp')) continue;
    if (echoSourceId !== undefined && !name.includes(String(echoSourceId).replace(/[^0-9a-zA-Z._-]/g, '_'))) continue;
    if (modelKey !== undefined && !name.includes(String(modelKey).slice(0, 16).replace(/[^0-9a-zA-Z._-]/g, '_'))) continue;
    try { fs.rmSync(path.join(dir, name), { force: true }); removed += 1; } catch { /* 忽略 */ }
  }
  return removed;
}
