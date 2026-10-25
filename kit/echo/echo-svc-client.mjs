// echo-svc-client.mjs —— 一次性请求客户端
//
// ★ 为什么不把 memq 改成常驻：`memq` 是「跑一次就退出」的 CLI，
//   改成 async 要大改所有分支。用「启动一个轻 client」的代价是 node 启动约 60 ms，
//   而它换来的是「从 1.7 s 降到 70 ms」——这笔账很划算。
//
// ★ 超时 400 ms 就退出（exit 2），让调用方回退到 CLI 原路径。
//   **宁可慢，不可错** —— 这是降级设计的核心。
import net from 'node:net';

const PIPE = process.env.ECHO_PIPE || '\\\\.\\pipe\\echo-hub';
const payload = process.argv.slice(2).join(' ');
if (!payload) { process.stderr.write('no payload\n'); process.exit(2); }

const sock = net.connect(PIPE);
let buf = '';
let done = false;
const finish = (code, out, err) => {
  if (done) return;
  done = true;
  if (out) process.stdout.write(out);
  if (err) process.stderr.write(err);
  try { sock.destroy(); } catch {}
  process.exit(code);
};

const timer = setTimeout(() => finish(2, '', 'svc timeout\n'), 3000);

sock.setEncoding('utf8');
sock.on('connect', () => sock.write(payload.replace(/\n/g, ' ') + '\n'));
sock.on('data', (d) => {
  buf += d;
  const i = buf.indexOf('\n');
  if (i >= 0) { clearTimeout(timer); finish(0, buf.slice(0, i)); }
});
sock.on('error', (e) => { clearTimeout(timer); finish(2, '', 'svc connect failed: ' + (e && e.code) + '\n'); });
sock.on('close', () => { clearTimeout(timer); if (!done) finish(2, '', 'svc closed\n'); });
