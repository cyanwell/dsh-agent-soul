// src/db/accept.mjs —— P6 验收 helper：一次「旧门牌还能不能用」的抽样检查。
//
// 验收口径（P1a 定点验证 CHANGES 3 定下的三条，缺一条都不算通过）：
//   1. relocatable === true —— 这个门牌的路径是由「当前 source 根 + 相对路径」推出来的；
//   2. canonical hash 一致     —— frame_index.content_hash 与抽样方给的原文/哈希逐位相同；
//   3. 解析出来的 rawPath 在磁盘上真的存在（并且是普通文件）—— 否则「可搬迁」只是纸面上的。
//
// ★ 为什么第 3 条必须由这里做：P1a 的 34 条不变量全在库里成立，库里没有「文件还在不在」的
//   任何信息。缺了它，一次成功的 relocate 可以永远解析出一条不存在的路径而全绿。
// ★ 这个 helper 只读：不写库、不改文件、不解析帧内容（没有解析器就不假装有）。
//   第 2 条的「canonical」指调用方手上那份原文（或它算好的 sha256），本函数只做逐位比较。
//
// ★★ 没有开关能关掉任何一条判据（P1b 返修定案，2026-11-09）：
//   旧版接受一个布尔开关，把第 3 条整个跳过并把 fileExists 记成 null，
//   此时 ok 仍可为 true —— 那是一条验收后门：一次「文件早就不在了」的抽样也能全绿。
//   现在三条判据无条件同时生效，sample 里的多余选项一律被忽略，没有任何取值能绕过
//   「真实存在 + canonical hash + relocatable」。要做负例，只能真的制造负例：
//   删掉文件 / 给错 hash / 用不可搬迁的帧（见自测 T43 与 T53）。

import { existsSync, statSync } from 'node:fs';
import { fail, CODES } from './errors.mjs';
import { assertHash } from './validate.mjs';
import { hashFrame } from './ingest.mjs';

// verifyPtrSample(store, { ptr, contentHash? | canonicalText? })
// 返回 { ok, checks: { relocatable, hashMatch, fileExists }, ... }；三个 checks 恒为布尔值。
export function verifyPtrSample(store, sample) {
  const s = sample || {};
  if (typeof s.ptr !== 'string' || s.ptr.length === 0) {
    fail(CODES.INVALID_INPUT, 'P6 sample must carry a ptr', { sample: s });
  }
  if ((s.contentHash === undefined || s.contentHash === null) && typeof s.canonicalText !== 'string') {
    fail(CODES.INVALID_INPUT, 'P6 sample must carry the canonical text or its hash: comparing a hash against nothing proves nothing', { ptr: s.ptr });
  }
  const expectedHash = typeof s.canonicalText === 'string'
    ? hashFrame(s.canonicalText)
    : assertHash(s.contentHash, 'sample.contentHash');

  const resolved = store.resolvePtr(s.ptr);
  const exists = existsSync(resolved.rawPath);
  let isFile = false;
  if (exists) {
    try { isFile = statSync(resolved.rawPath).isFile(); } catch (_) { isFile = false; }
  }
  const checks = {
    relocatable: resolved.relocatable === true,
    hashMatch: resolved.contentHash === expectedHash,
    fileExists: exists && isFile,
  };
  const ok = checks.relocatable && checks.hashMatch && checks.fileExists;
  return {
    ok,
    ptr: s.ptr,
    rawPath: resolved.rawPath,
    rawPathAtIngest: resolved.rawPathAtIngest,
    rawPathDrift: resolved.rawPathDrift,
    relocation: resolved.relocation,
    relocatable: resolved.relocatable,
    contentHash: resolved.contentHash,
    expectedHash,
    // ★ P1c（P1b 定点验证 O2）：顶层这个字段必须是**同一个判定**，不能是 existsSync 的原始结果。
    //   旧实现回 exists，目录时为 true 而 checks.fileExists 为 false —— 调用方读顶层就会把
    //   一个目录当成「文件还在」。现在两个名字指向同一个布尔值，没有第二种读法。
    fileExists: checks.fileExists,
    frameOrdinal: resolved.frameOrdinal,
    checks,
    reason: ok
      ? null
      : (!checks.relocatable
        ? 'the frame is not relocatable (no raw_rel_path): its path is ingest-time evidence, not a live location'
        : (!checks.hashMatch
          ? 'canonical hash mismatch: the indexed content is not the content the sample came from'
          : 'resolved rawPath does not exist on disk (or is not a regular file)')),
  };
}
