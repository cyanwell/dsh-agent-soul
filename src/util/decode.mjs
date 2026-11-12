// src/util/decode.mjs —— 子进程输出的解码（中文 Windows 的必修课）。
//
// ★ 为什么要有这一个：2026-11-11 实测，v4 起 ping -n 3 127.0.0.1 拿回来的是
//   「???? Ping 127.0.0.1 ???? 32 ????????」—— 中文 Windows 的 cmd 输出是 **GBK**，
//   而 node 默认按 utf8 解。满屏乱码不是「难看」，是**不能用**：
//   模型看到的就是乱码，它会以为命令失败了，然后开始瞎猜。
//
// ★ 判据（先 UTF-8，坏了再 GBK）：
//   1. 先按 utf8 解；**没有替换字符 U+FFFD** 就认它 —— 纯 ASCII 与真 UTF-8 输出都走这条，
//      而绝大多数现代工具（node / git / python3）输出就是 UTF-8。
//   2. 出现 U+FFFD 说明这串字节不是合法 UTF-8，再按 GBK 解一次；GBK 干净就用 GBK。
//   3. 两个都不干净 → 回退 utf8 的结果（宁可留替换字符，也不假装干净）。
//
// ★ 不用 chcp 65001 硬改代码页：那会把「程序自己写 UTF-8」的情况弄坏，
//   而且对已经编译死的程序无效（ping / dir 这类不认识代码页）。

let _gbkOk = null;

function toText(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input == null ? '' : input), 'utf8');
  if (!buf.length) return '';
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;
  if (_gbkOk === null) {
    try { new TextDecoder('gbk'); _gbkOk = true; } catch { _gbkOk = false; }
  }
  if (!_gbkOk) return utf8;
  try {
    const gbk = new TextDecoder('gbk').decode(buf);
    return gbk.includes('\uFFFD') ? utf8 : gbk;
  } catch { return utf8; }
}

export function decodeOutput(input) { return toText(input); }
