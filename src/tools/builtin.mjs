// 内置工具 —— 最小集：读写文件 / 列目录 / 跑命令
//
// ★ 所有文件操作限制在 workspace 根内（守卫做，不靠自觉）。

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

export function registerBuiltins(registry, { workspace, shellTimeoutMs = 30000 }) {
  const WS = path.resolve(workspace);

  /** 把用户给的相对路径解析成工作区内的绝对路径；越界直接抛 */
  function inside(p) {
    const abs = path.resolve(WS, String(p || '.'));
    const rel = path.relative(WS, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('路径越界: ' + p);
    return abs;
  }

  registry.register({
    name: 'read_file',
    description: '读一个文本文件（相对工作区）。可选 offset/limit 按行取。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对工作区的路径' },
        offset: { type: 'integer', description: '起始行（1 基）' },
        limit: { type: 'integer', description: '最多读多少行' },
      },
      required: ['path'],
    },
    handler: ({ path: p, offset, limit }) => {
      const abs = inside(p);
      const text = fs.readFileSync(abs, 'utf8');
      if (offset == null && limit == null) return text;
      const lines = text.split('\n');
      const start = Math.max(0, (offset || 1) - 1);
      const end = limit ? start + limit : lines.length;
      return lines.slice(start, end).map((l, i) => String(start + i + 1).padStart(5) + ' | ' + l).join('\n');
    },
  });

  registry.register({
    name: 'write_file',
    description: '写一个文本文件（相对工作区）。目录会自动创建。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
    handler: ({ path: p, content }) => {
      const abs = inside(p);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, String(content ?? ''), 'utf8');
      return '已写入 ' + abs + '（' + Buffer.byteLength(String(content ?? '')) + ' 字节）';
    },
  });

  registry.register({
    name: 'list_dir',
    description: '列一个目录（相对工作区）。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '默认 .' } },
    },
    handler: ({ path: p }) => {
      const abs = inside(p || '.');
      const items = fs.readdirSync(abs, { withFileTypes: true }).map(e => {
        if (e.isDirectory()) return e.name + '/';
        try { return e.name + '  (' + fs.statSync(path.join(abs, e.name)).size + 'B)'; }
        catch { return e.name; }
      });
      return items.join('\n');
    },
  });

  registry.register({
    name: 'run_shell',
    description: '在工作区里跑一条命令（cmd /c）。有超时，输出会被截断。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeoutMs: { type: 'integer', description: '默认 30000' },
      },
      required: ['command'],
    },
    handler: ({ command, timeoutMs }) => new Promise((resolve, reject) => {
      execFile('cmd.exe', ['/c', String(command)], {
        cwd: WS,
        timeout: Math.min(Number(timeoutMs) || shellTimeoutMs, 300000),
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      }, (err, stdout, stderr) => {
        const out = String(stdout || '');
        const errText = String(stderr || '');
        if (err && err.killed) return reject(new Error('命令超时'));
        const body = (out + (errText ? '\n[stderr]\n' + errText : '')).slice(0, 20000);
        resolve(body + '\n[exit ' + (err ? (err.code ?? '?') : 0) + ']');
      });
    }),
  });

  return { workspace: WS };
}
