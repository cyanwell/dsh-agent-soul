import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const source = fileURLToPath(new URL('../', import.meta.url));
export async function buildExtension(target = join(source, '.build')) {
  mkdirSync(target, { recursive: true });
  const result = await build({ entryPoints: [join(source, 'index.mjs')], bundle: true, write: false, format: 'esm', platform: 'node', target: 'node22', charset: 'utf8', legalComments: 'eof' });
  for (const name of ['browser.cjs', 'session.cjs', 'login.cjs', 'panel.js', 'README.md', 'LICENSE']) copyFileSync(join(source, name), join(target, name));
  const pkg = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  writeFileSync(join(target, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, private: true, type: 'module', scripts: { 'install:browser': pkg.scripts['install:browser'] } }, null, 2));
  // A single bundled entry prevents live dependency-resolution races during installation.
  writeFileSync(join(target, 'index.mjs.next'), result.outputFiles[0].contents);
  renameSync(join(target, 'index.mjs.next'), join(target, 'index.mjs'));
  return target;
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) console.log('运行包已生成：' + await buildExtension());
