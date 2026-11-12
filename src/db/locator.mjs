// src/db/locator.mjs —— 帧定位的唯一算法：当前 source 根 + 相对路径 + frame_ordinal。
//
// ★ 门牌（ptr）解析认的是「现在」：sources.raw_path 是当前值，frame_index.raw_rel_path 是
//   入库时算出的、相对于 source 根的路径。两者拼出来的才是可回取的路径。
// ★ frame_index.raw_path 只保留入库当时的原始证据，不再参与定位 —— 否则 source 改名/搬目录后，
//   老门牌会永远指向那条死路径（独立验证 C1 / I18 实测）。
//
// ★★ 归一化只有这一份实现（v4-P1a 二次验证 D1）：
//   ingest 与迁移回填（v3 的 after 钩子）都调用 relToSource()，分隔符统一成 posix 再比较。
//   Windows 反斜杠、'.'、'..'、重复分隔符都在这里处理，别在调用点再写一套前缀判断。
//   历史上 v2 的回填是纯 SQL 前缀判断（只认 '/'），对本机真实的反斜杠路径会静默得到 NULL；
//   v3 用本函数重算所有行，两份规则从此只有一份。

export function toPosix(value) {
  return String(value).replace(/\\/g, '/');
}

function isAbsolutePath(p) {
  return p.charAt(0) === '/' || /^[A-Za-z]:\//.test(p);
}

// 相对段的规范化：去掉空段与 '.'；'..' 越过根本身即视为越界（null）。
function normalizeRelative(rel) {
  const out = [];
  for (const part of rel.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join('/');
}

// 入库/迁移时把 frame.rawPath 折算成「相对 source 根」的 posix 路径：
//   - 等于 source 根            → ''
//   - 在 source 根之下          → 去掉前缀（含反斜杠、'.'、'..' 归一）
//   - 本身是相对路径            → 相对 source 根，归一后返回（'..' 越界 → null）
//   - 绝对路径但不在 source 根下 → null（不可搬迁；ingest 会直接拒帧，见 D2）
export function relToSource(sourceRawPath, frameRawPath) {
  const root = toPosix(sourceRawPath).replace(/\/+$/, '');
  const p = toPosix(frameRawPath);
  if (p === root || p === root + '/') return '';
  if (root.length > 0 && p.startsWith(root + '/')) {
    return normalizeRelative(p.slice(root.length + 1));
  }
  if (isAbsolutePath(p)) return null;
  return normalizeRelative(p);
}

export function joinSourcePath(sourceRawPath, relPath) {
  const root = String(sourceRawPath);
  const rel = String(relPath === null || relPath === undefined ? '' : relPath);
  if (rel === '') return root;
  const sep = root.indexOf('\\') !== -1 && root.indexOf('/') === -1 ? '\\' : '/';
  const clean = root.replace(/[\\/]+$/, '');
  return clean + sep + (sep === '\\' ? rel.replace(/\//g, '\\') : rel);
}

// 读侧统一入口：有相对路径就用「当前 source 根」重算；没有（不可搬迁）就退回入库证据。
//
// ★ rawPathDrift 的语义（D2）：true = 当前解析结果不是由当前 source 根推导出来的。
//   可搬迁帧只有在路径真的变了时才为 true；不可搬迁帧（relocatable:false）恒为 true ——
//   它是一个失败态，不是「没漂移」。拿这个字段做 P6 抽样时，必须同时要求 relocatable:true。
export function resolveFramePath(sourceRawPath, rawRelPath, ingestRawPath) {
  if (rawRelPath === null || rawRelPath === undefined) {
    return {
      rawPath: ingestRawPath,
      rawRelPath: null,
      relocatable: false,
      relocation: 'none',
      rawPathDrift: true,
    };
  }
  const rawPath = joinSourcePath(sourceRawPath, rawRelPath);
  return {
    rawPath,
    rawRelPath,
    relocatable: true,
    relocation: 'source-root',
    // 只比较路径形状，不把分隔符风格（\\ vs /）当成一次搬家。
    rawPathDrift: toPosix(rawPath) !== toPosix(ingestRawPath),
  };
}
