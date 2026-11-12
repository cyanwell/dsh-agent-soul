// minimal fake core: answers /api/health with its own pid so the shell identity check passes
import http from 'node:http';
const port = Number(process.env.AGENT_SOUL_PORT || 7310);
const pid = process.pid;
const srv = http.createServer((req, res) => {
  if (req.url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, service: 'agent-soul-core', pid, port, fake: true }));
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<html><body>dev-layout fixture</body></html>');
});
srv.listen(port, '127.0.0.1', () => console.log('fake-core listening ' + port));
process.on('SIGTERM', () => process.exit(0));
