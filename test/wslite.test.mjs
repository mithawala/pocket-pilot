import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ws = require('../extension/core/wslite.js');

function startEchoServer(listenArg) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => res.end('plain'));
    const conns = [];
    server.on('upgrade', (req, socket, head) => {
      const c = ws.acceptUpgrade(req, socket, head);
      if (!c) return;
      conns.push(c);
      c.on('message', (data, isBinary) => {
        if (!isBinary && data === 'close-me') return c.close(4000, 'bye');
        c.send(isBinary ? data : `echo:${data}`);
      });
    });
    server.listen(listenArg, () => resolve({ server, conns }));
  });
}

function nextMessage(conn) {
  return new Promise((resolve) => conn.once('message', (d, b) => resolve({ d, b })));
}

test('text, binary and large messages round-trip over TCP', async () => {
  const { server } = await startEchoServer(0);
  const { port } = server.address();
  const c = await ws.connect({ port, path: '/x?tkn=abc' });
  c.send('hi');
  assert.deepEqual(await nextMessage(c), { d: 'echo:hi', b: false });
  const bin = crypto.randomBytes(70000);
  c.send(bin);
  const r = await nextMessage(c);
  assert.equal(r.b, true);
  assert.ok(Buffer.compare(r.d, bin) === 0);
  const big = 'y'.repeat(3 * 1024 * 1024);
  c.send(big);
  assert.equal((await nextMessage(c)).d, `echo:${big}`);
  c.close();
  server.close();
});

test('works over a Windows named pipe / unix socket', { skip: process.platform !== 'win32' && process.platform !== 'linux' && process.platform !== 'darwin' }, async () => {
  const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\pp-test-${crypto.randomUUID()}` : `/tmp/pp-test-${crypto.randomUUID()}.sock`;
  const { server } = await startEchoServer(pipe);
  const c = await ws.connect({ socketPath: pipe, path: '/?tkn=t' });
  c.send('pipe');
  assert.equal((await nextMessage(c)).d, 'echo:pipe');
  c.close();
  server.close();
});

test('server-initiated close is delivered with code and reason', async () => {
  const { server } = await startEchoServer(0);
  const c = await ws.connect({ port: server.address().port });
  const closed = new Promise((resolve) => c.on('close', (code, reason) => resolve({ code, reason })));
  c.send('close-me');
  assert.deepEqual(await closed, { code: 4000, reason: 'bye' });
  server.close();
});

test('fragmented frames from a peer are reassembled', async () => {
  const { server, conns } = await startEchoServer(0);
  const c = await ws.connect({ port: server.address().port });
  await new Promise((r) => setTimeout(r, 20));
  const serverSide = conns[0];
  const got = nextMessage(c);
  // Hand-craft two unmasked server frames: TEXT(fin=0) "hel" + CONT(fin=1) "lo".
  serverSide.socket.write(Buffer.from([0x01, 3, ...Buffer.from('hel')]));
  serverSide.socket.write(Buffer.from([0x80, 2, ...Buffer.from('lo')]));
  assert.deepEqual(await got, { d: 'hello', b: false });
  c.close();
  server.close();
});

test('upgrade failures reject the client promise', async () => {
  const server = http.createServer((req, res) => { res.statusCode = 403; res.end(); });
  server.on('upgrade', (req, socket) => socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'));
  await new Promise((r) => server.listen(0, r));
  await assert.rejects(ws.connect({ port: server.address().port }), (e) => e.status === 403);
  server.close();
});

test('oversized frames close the connection', async () => {
  const { server } = await startEchoServer(0);
  const c = await ws.connect({ port: server.address().port, maxPayload: 1024 });
  const closed = new Promise((resolve) => c.on('close', resolve));
  c.on('error', () => {});
  c.send('z'.repeat(5000)); // echo comes back larger than the client's limit
  await closed;
  server.close();
});
