import { spawn } from 'node:child_process';
const child = spawn(process.execPath, ['out/server/server.js', '--stdio'], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = Buffer.alloc(0); const pending = new Map(); let id = 1;
child.stdout.on('data', (c) => {
  buf = Buffer.concat([buf, c]);
  for (;;) {
    const h = buf.indexOf('\r\n\r\n'); if (h < 0) break;
    const len = Number(/Content-Length:\s*(\d+)/i.exec(buf.slice(0, h).toString())[1]);
    if (buf.length < h + 4 + len) break;
    const msg = JSON.parse(buf.slice(h + 4, h + 4 + len).toString());
    buf = buf.slice(h + 4 + len);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    else if (msg.id) child.stdin.write(`Content-Length: 40\r\n\r\n${JSON.stringify({jsonrpc:'2.0',id:msg.id,result:null})}`);
  }
});
const send = (m) => child.stdin.write(`Content-Length: ${Buffer.byteLength(JSON.stringify(m))}\r\n\r\n${JSON.stringify(m)}`);
const req = (method, params) => new Promise((r) => { const i = id++; pending.set(i, r); send({ jsonrpc: '2.0', id: i, method, params }); });
await req('initialize', { processId: process.pid, rootUri: 'file:///tmp/x', capabilities: {} });
send({ jsonrpc: '2.0', method: 'initialized', params: {} });
const uri = 'file:///tmp/x/dungeons/t/config.yml';
send({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'yaml', version: 1, text: 'enu\n' } } });
for (const [label, pos] of [['空文档', 0], ['前缀 e', 1], ['前缀 en', 2], ['前缀 enu', 3]]) {
  const res = await req('textDocument/completion', { textDocument: { uri }, position: { line: 0, character: pos } });
  const items = res.result?.items ?? res.result ?? [];
  console.log(label, '→', items.length, items.map(i => i.label).slice(0, 6).join(','));
}
child.kill();
