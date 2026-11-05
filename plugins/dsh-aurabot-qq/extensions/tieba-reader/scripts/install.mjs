import { mkdirSync, copyFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { buildExtension } from './build.mjs';

const source = fileURLToPath(new URL('../', import.meta.url));
const dataRoot = process.env.AURABOT_DATA_DIR || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'plugins-data', 'aurabot');
const target = resolve(process.argv[2] || join(dataRoot, 'modules', 'tieba-reader'));
if (resolve(source).toLowerCase() === target.toLowerCase()) throw new Error('当前目录已是安装目录；更新请从 repo 中运行此命令。');
const built = await buildExtension();
mkdirSync(target, { recursive: true });
for (const name of ['browser.cjs', 'session.cjs', 'login.cjs', 'panel.js', 'package.json', 'README.md', 'LICENSE']) copyFileSync(join(built, name), join(target, name));
// Activate the new entry only after all supporting files exist; no npm mutations in a live module.
copyFileSync(join(built, 'index.mjs'), join(target, 'index.mjs.next'));
renameSync(join(target, 'index.mjs.next'), join(target, 'index.mjs'));
console.log(`贴吧扩展已安装到 ${target}。在 Aurabot 扩展面板重新加载即可。`);
