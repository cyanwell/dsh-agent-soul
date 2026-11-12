// 一键拍三页（子 agent 改完视觉后用它验收）
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT = 'D:/AI/agent-soul/_verify/ui-sub';
const PAGES = [['sphere', '/sphere'], ['chat', '/'], ['dashboard', '/dashboard']];

fs.mkdirSync(OUT, { recursive: true });
const tmp = path.join(process.env.TEMP || 'C:/Windows/Temp', 'shot-' + Date.now());

for (const [name, url] of PAGES) {
  const file = path.join(OUT, name + '.png');
  try { fs.unlinkSync(file); } catch {}
  try {
    execFileSync(EDGE, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--user-data-dir=' + tmp,
      '--window-size=1400,900', '--virtual-time-budget=6000',
      '--screenshot=' + file,
      'http://127.0.0.1:7310' + url,
    ], { stdio: 'ignore', timeout: 60000 });
  } catch (e) { console.log(name, 'FAILED', String(e.message).slice(0, 60)); continue; }
  if (fs.existsSync(file)) console.log(name.padEnd(10), (fs.statSync(file).size / 1024 | 0) + ' KB', file);
  else console.log(name.padEnd(10), 'NOT CREATED');
}
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
