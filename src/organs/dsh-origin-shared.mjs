// dsh-origin-shared.mjs —— 心跳地址发现**共用的那两把小尺子**（2026-11-16 · 架构收敛第 3 批）
//
// ★ 为什么要单独一个文件：config.mjs 的注释直接点名了它（「分发版没有它 → dshOriginFileOf()
//   回 null」），而 dshOriginFileOf() 原来住在 organs/dsh-origin.mjs 里。
//   删 dsh-origin.mjs（整份心跳地址自动发现）之前必须先把这两个 helper 摘出来，
//   否则注释所承诺的东西会跟着文件一起消失 —— 那种丢失不报错，只是「没有」。
//
// ★ 这里只放**两个纯函数**：显式配置优先（resolvePath），否则开发机默认（目录/文件**存在才用**）。
//   一行网络、一行 lead 判定都没有 —— 判据仍只有一处（《墨》最后一条 lead）。
//
// ★ 跟第 3 批的关系：runtime-status 不再调 discoverDshOrigin()（那 3 条自动发现链
//   —— 启动日志 / dsh-origin.txt —— 依赖的正是要收掉的 DSH 心跳插件）。
//   这两把尺子留下，是因为它们回答的是「本机默认路径在哪」，与「向谁问心跳」无关。

import path from 'node:path';
import { devPathOr, devFileOr, isDirPath, resolvePath } from '../config.mjs';

/** 启动日志目录：显式配置 > 环境变量 DSH_HOME > 开发机默认（**目录存在才用**）。 */
export function dshLogDirOf(cfg) {
  const it = (cfg && cfg.integrations) || {};
  const own = String(it.dshLogDir == null ? '' : it.dshLogDir).trim();
  if (own) return resolvePath(own);
  const envHome = String(process.env.DSH_HOME || '').trim();
  if (envHome) {
    const d = path.join(envHome, 'guard', 'logs');
    if (isDirPath(d)) return d;
  }
  const devHome = devPathOr('dshHome', null);
  if (devHome) {
    const d = path.join(devHome, 'guard', 'logs');
    if (isDirPath(d)) return d;
  }
  return null;
}

/** 心跳插件的 origin 文件：显式配置 > 开发机默认（**文件存在才用**）。 */
export function dshOriginFileOf(cfg) {
  const it = (cfg && cfg.integrations) || {};
  const own = String(it.dshOriginFile == null ? '' : it.dshOriginFile).trim();
  if (own) return resolvePath(own);
  return devFileOr('dshOriginFile', null);
}
