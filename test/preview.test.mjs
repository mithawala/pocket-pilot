import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { createRequire } from 'node:module';
import { localWebUrl } from '../pwa/js/core/links.js';

const require = createRequire(import.meta.url);
const { PreviewManager, waitServed, COOKIE, KEY_MS, SESSION_MS, MAX_SESSIONS } = require('../extension/core/preview.js');

// A page a session runs: notes what reaches it.
async function localPage(host = '127.0.0.1') {
  const seen = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      const { port } = server.address();
      if (req.url === '/redirect') {
        res.writeHead(302, { location: `http://${host === '::1' ? '[::1]' : host}:${port}/landed?x=1` });
        return res.end();
      }
      if (req.url === '/elsewhere') {
        res.writeHead(302, { location: 'https://example.com/' });
        return res.end();
      }
      if (req.url === '/cookie') {
        res.writeHead(200, { 'set-cookie': [`a=1; Domain=${host}; Path=/; HttpOnly`, 'b=2; Path=/; domain=localhost'] });
        return res.end('ok');
      }
      if (req.url === '/video') {
        const data = Buffer.from('0123456789');
        const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
        if (m) {
          const [a, b] = [Number(m[1]), Number(m[2])];
          res.writeHead(206, { 'content-range': `bytes ${a}-${b}/${data.length}`, 'content-length': b - a + 1, 'accept-ranges': 'bytes' });
          return res.end(data.subarray(a, b + 1));
        }
        res.writeHead(200, { 'content-length': data.length });
        return res.end(data);
      }
      if (req.url === '/events') {
        // Server-sent events: an answer that stays open.
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        sockets.add(res.socket);
        res.socket.on('close', () => sockets.delete(res.socket));
        return res.write('data: hello\n\n');
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(req.method === 'POST' ? `got ${body}` : `page ${req.url}`);
    });
  });
  // A WebSocket stand-in: answers the upgrade, then echoes (and ends when the other side does, like `ws`).
  server.on('upgrade', (req, socket) => {
    seen.push({ method: 'UPGRADE', url: req.url, headers: req.headers });
    socket.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n');
    socket.on('data', (d) => socket.write(`echo:${d}`));
    socket.on('end', () => socket.end());
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, resolve);
  });
  return { server, seen, sockets, port: server.address().port, close: () => new Promise((r) => server.close(r)) };
}

// Each page's tunnel, here: its proxy as it is. `o.ready`: whether the tunnel is connected to Cloudflare.
function manager(o = {}) {
  const started = [];
  const stopped = [];
  const m = new PreviewManager({
    startTunnel: async (port) => {
      started.push(port);
      if (o.failTunnel) throw new Error('no tunnel today');
      return { url: `http://127.0.0.1:${port}/`, stop: async () => void stopped.push(port), ready: async () => (o.ready ? o.ready() : true) };
    },
    waitServed: (url, id) => waitServed(url, id, { timeoutMs: 3000 }),
    ...o,
  });
  return { m, started, stopped };
}

function request(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request(url, { method, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    r.on('error', reject);
    r.end(body);
  });
}

/** Opens a page through its one-time link, as a browser would: the cookie it gets back. */
async function enter(link) {
  const r = await request(link);
  assert.equal(r.status, 303);
  const c = [].concat(r.headers['set-cookie'])[0];
  assert.match(c, new RegExp(`^${COOKIE}=[\\w-]{40,}; Path=/; Secure; HttpOnly; SameSite=Lax`));
  return { cookie: c.split(';')[0], location: r.headers.location };
}

function upgrade(url, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const s = net.connect(Number(u.port), u.hostname, () => {
      let raw = `GET ${u.pathname} HTTP/1.1\r\nhost: ${u.host}\r\nconnection: Upgrade\r\nupgrade: websocket\r\n`;
      for (const [k, v] of Object.entries(headers)) raw += `${k}: ${v}\r\n`;
      s.write(`${raw}\r\n`);
    });
    let got = '';
    s.on('data', (d) => {
      got += d;
      if (got.includes('\r\n\r\n')) {
        const status = Number(got.split(' ')[1]);
        if (status !== 101) {
          s.destroy();
          return resolve({ status });
        }
        if (!got.includes('echo:')) {
          if (!s.sent) {
            s.sent = true;
            s.write('hello');
          }
          return undefined;
        }
        s.destroy();
        resolve({ status, echoed: got.slice(got.indexOf('echo:')) });
      }
      return undefined;
    });
    s.on('error', reject);
  });
}

const web = (href) => localWebUrl(href);

/** A WebSocket (stand-in) to the page that stays open: `{ status, socket, closed }`. */
function openSocket(url, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const s = net.connect(Number(u.port), u.hostname, () => {
      let raw = `GET ${u.pathname} HTTP/1.1\r\nhost: ${u.host}\r\nconnection: Upgrade\r\nupgrade: websocket\r\n`;
      for (const [k, v] of Object.entries(headers)) raw += `${k}: ${v}\r\n`;
      s.write(`${raw}\r\n`);
    });
    const closed = new Promise((r) => s.once('close', r));
    let got = '';
    s.on('data', function head(d) {
      got += d;
      if (!got.includes('\r\n\r\n')) return;
      s.off('data', head);
      resolve({ status: Number(got.split(' ')[1]), socket: s, closed });
    });
    s.on('error', reject);
  });
}

/** Writes on an open socket and waits for the page's echo. */
function echo(socket, text) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 2000);
    socket.once('data', (d) => {
      clearTimeout(t);
      resolve(String(d));
    });
    socket.write(text);
  });
}

/** A response that stays open (server-sent events): `{ status, closed }` once its first piece is in. */
function stream(url, cookie) {
  return new Promise((resolve, reject) => {
    const r = http.get(url, { agent: false, headers: { cookie } }, (res) => {
      const closed = new Promise((c) => res.once('close', c));
      res.once('data', () => resolve({ status: res.statusCode, closed }));
    });
    r.on('error', reject);
  });
}

async function waitFor(ok, what, ms = 3000) {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) assert.fail(`Timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('a page opens once for the device that asked, through a link of its own; nothing else gets in', async () => {
  const p = await localPage();
  const { m, started } = manager();
  try {
    const opened = await m.open(web(`http://127.0.0.1:${p.port}/review?take=2`), { deviceId: 'phone' });
    assert.equal(opened.address, `127.0.0.1:${p.port}`);
    assert.equal(opened.expiresIn, KEY_MS / 1000);
    const { origin } = new URL(opened.url);
    assert.equal(started.length, 1);
    assert.deepEqual(m.list().map((x) => x.address), [`127.0.0.1:${p.port}`]);

    // Without the cookie: nothing reaches the page.
    const before = p.seen.length;
    assert.equal((await request(`${origin}/`)).status, 401);
    assert.equal((await request(`${origin}/`, { headers: { cookie: `${COOKIE}=guess` } })).status, 401);
    assert.equal((await request(`${origin}/__pocket-pilot/enter?k=guess&to=/`)).status, 401);
    assert.equal(p.seen.length, before);

    const { cookie, location } = await enter(opened.url);
    assert.equal(location, '/review?take=2', 'to the page the link was to');
    // A key opens once: again, only in the browser that has the cookie.
    assert.equal((await request(opened.url)).status, 401);
    const again = await request(opened.url, { headers: { cookie } });
    assert.equal(again.status, 303);
    assert.equal(again.headers['set-cookie'], undefined);

    const r = await request(`${origin}/review?take=2`, { headers: { cookie: `theme=dark; ${cookie}; lang=sv`, 'cf-connecting-ip': '1.2.3.4', 'x-forwarded-for': '1.2.3.4', 'cdn-loop': 'cloudflare', 'true-client-ip': '1.2.3.4', 'user-agent': 'phone' } });
    assert.equal(r.status, 200);
    assert.equal(r.body, 'page /review?take=2');
    assert.equal(r.headers['x-robots-tag'], 'noindex, nofollow');
    const got = p.seen.at(-1);
    assert.equal(got.headers.host, `127.0.0.1:${p.port}`, 'as from a browser on this computer');
    assert.equal(got.headers.cookie, 'theme=dark; lang=sv', 'the page\'s own cookies, not ours');
    for (const h of ['cf-connecting-ip', 'x-forwarded-for', 'cdn-loop', 'true-client-ip']) assert.equal(got.headers[h], undefined, h);
    assert.equal(got.headers['user-agent'], 'phone');

    // The page's own requests: its address becomes the local one.
    const post = await request(`${origin}/api/review`, { method: 'POST', headers: { cookie, origin, referer: `${origin}/review`, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' }, body: '{"score":5}' });
    assert.equal(post.body, 'got {"score":5}');
    assert.equal(p.seen.at(-1).headers.origin, `http://127.0.0.1:${p.port}`);
    assert.equal(p.seen.at(-1).headers.referer, `http://127.0.0.1:${p.port}/review`);

    // Ranges (a video), redirects and cookies of the page.
    const range = await request(`${origin}/video`, { headers: { cookie, range: 'bytes=2-5' } });
    assert.equal(range.status, 206);
    assert.equal(range.body, '2345');
    assert.equal(range.headers['content-range'], 'bytes 2-5/10');
    const moved = await request(`${origin}/redirect`, { headers: { cookie } });
    assert.equal(moved.headers.location, `${origin}/landed?x=1`, 'its own address, as the device sees it');
    assert.equal((await request(`${origin}/elsewhere`, { headers: { cookie } })).headers.location, 'https://example.com/');
    assert.deepEqual((await request(`${origin}/cookie`, { headers: { cookie } })).headers['set-cookie'], ['a=1; Path=/; HttpOnly', 'b=2; Path=/']);
  } finally {
    await m.closeAll();
    await p.close();
  }
});

test('other sites can link to a page, but not use it from theirs: no posts, frames, scripts or sockets', async () => {
  const p = await localPage();
  const { m } = manager();
  try {
    const opened = await m.open(web(`http://localhost:${p.port}`), { deviceId: 'phone' });
    const { origin } = new URL(opened.url);
    const { cookie } = await enter(opened.url);
    const cross = { cookie, 'sec-fetch-site': 'cross-site' };
    const before = p.seen.length;
    assert.equal((await request(`${origin}/api/review`, { method: 'POST', headers: { cookie, origin: 'https://evil.example' }, body: 'x' })).status, 403, 'a form on another site');
    assert.equal((await request(`${origin}/api/review`, { method: 'POST', headers: { ...cross, 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', origin: 'https://evil.example' }, body: 'x' })).status, 403);
    assert.equal((await request(`${origin}/app.js`, { headers: { ...cross, 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'script' } })).status, 403);
    assert.equal((await request(`${origin}/`, { headers: { ...cross, 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' } })).status, 403);
    assert.equal(p.seen.length, before);
    assert.equal((await request(`${origin}/`, { headers: { ...cross, 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } })).status, 200, 'a link from another site');
    assert.equal((await request(`${origin}/`, { headers: { cookie, 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate' } })).status, 200, 'typed in');

    // Live reload: the page's own socket, as from this computer.
    const ws = await upgrade(`${origin}/hmr`, { cookie, origin });
    assert.equal(ws.status, 101);
    assert.equal(ws.echoed, 'echo:hello');
    await waitFor(() => p.sockets.size === 0, 'the page\'s end of the socket closes with the device\'s');
    const up = p.seen.at(-1);
    assert.equal(up.method, 'UPGRADE');
    assert.equal(up.headers.origin, `http://localhost:${p.port}`);
    assert.equal(up.headers.host, `localhost:${p.port}`);
    assert.equal(up.headers.cookie, undefined);
    assert.equal((await upgrade(`${origin}/hmr`, { origin })).status, 401, 'without the cookie');
    assert.equal((await upgrade(`${origin}/hmr`, { cookie, origin: 'https://evil.example' })).status, 403, 'from another site');
    assert.equal((await upgrade(`${origin}/hmr`, { cookie })).status, 403, 'from nowhere');
  } finally {
    await m.closeAll();
    await p.close();
  }
});

test('where a link starts on the page stays on it', async () => {
  const p = await localPage();
  const { m } = manager();
  try {
    await m.open(web(`http://127.0.0.1:${p.port}/`), { deviceId: 'phone' });
    const pv = [...m.previews.values()][0];
    for (const [to, want] of [['//evil.example/x', '/'], ['/\\evil.example', '/'], ['/.//evil.example', '/'], ['https://evil.example', '/'], ['/a b?c=d#e', '/a%20b?c=d#e'], ['/x\r\nset-cookie: y', '/xset-cookie:%20y']]) {
      const { location } = await enter(pv.enter(to, 'phone'));
      assert.equal(location, want, to);
    }
  } finally {
    await m.closeAll();
    await p.close();
  }
});

test('what can\'t be opened says why: a page that isn\'t running, a debugger, a proxy, a tunnel that won\'t start', async () => {
  const p = await localPage();
  const free = await localPage();
  await free.close();
  const { m } = manager();
  const failing = manager({ failTunnel: true });
  try {
    await assert.rejects(m.open(web(`http://127.0.0.1:${free.port}`)), { code: 'not-running' });
    await assert.rejects(m.open(web('http://127.0.0.1:9229/json')), { code: 'blocked' });
    await assert.rejects(m.open(web('http://localhost:9222')), { code: 'blocked' });
    const opened = await m.open(web(`http://127.0.0.1:${p.port}`));
    const proxy = Number(new URL(opened.url).port);
    assert.ok(m.isBlocked(proxy), 'its own proxy');
    await assert.rejects(m.open(web(`http://127.0.0.1:${proxy}`)), { code: 'blocked' });

    await assert.rejects(failing.m.open(web(`http://127.0.0.1:${p.port}`)), { code: 'tunnel' });
    assert.equal(failing.m.previews.size, 0, 'nothing left half open');
    await assert.rejects(failing.m.open(web(`http://127.0.0.1:${p.port}`)), { code: 'tunnel' });
    assert.equal(failing.started.length, 2, 'tried again');

    // The page's server stops while it's open.
    const { cookie } = await enter(opened.url);
    await p.close();
    const r = await request(`${new URL(opened.url).origin}/`, { headers: { cookie } });
    assert.equal(r.status, 502);
    assert.match(r.body, /isn’t running/);
  } finally {
    await Promise.all([m.closeAll(), failing.m.closeAll()]);
    await p.close().catch(() => {});
  }
});

test('one tunnel per page, however often it is opened; four at most, closed when unused, when a device is removed, and when Pocket Pilot stops', async () => {
  const pages = await Promise.all([0, 1, 2, 3, 4].map(() => localPage()));
  const { m, started, stopped } = manager({ idleMs: 400 });
  try {
    const [a, b] = await Promise.all([m.open(web(`http://127.0.0.1:${pages[0].port}`), { deviceId: 'phone' }), m.open(web(`http://localhost:${pages[0].port}/x`), { deviceId: 'tablet' })]);
    assert.equal(started.length, 1);
    assert.notEqual(a.url, b.url, 'a key each');
    assert.equal(m.list()[0].devices, 2);

    const phone = await enter(a.url);
    const origin = new URL(a.url).origin;
    m.forgetDevice('phone');
    assert.equal((await request(`${origin}/`, { headers: { cookie: phone.cookie } })).status, 401, 'a removed device is out');
    assert.equal((await request(b.url)).status, 303, 'the other device is not');

    for (const pg of pages.slice(1)) await m.open(web(`http://127.0.0.1:${pg.port}`));
    assert.equal(m.list().length, 4);
    assert.equal(stopped.length, 1, 'the one used longest ago closed');
    assert.ok(!m.list().some((x) => x.address === `127.0.0.1:${pages[0].port}`));

    // Unused for a while (idleMs): closed.
    await new Promise((r) => setTimeout(r, 1300));
    assert.equal(m.list().length, 0);
    assert.equal(stopped.length, 5);

    await m.open(web(`http://127.0.0.1:${pages[1].port}`));
    await m.closeAll();
    assert.equal(stopped.length, 6);
    await assert.rejects(m.open(web(`http://127.0.0.1:${pages[1].port}`)), { code: 'closed' });
  } finally {
    await m.closeAll();
    await Promise.all(pages.map((pg) => pg.close()));
  }
});

test('a page on localhost is found where it listens, also on ::1', async (t) => {
  let p;
  try {
    p = await localPage('::1');
  } catch {
    return t.skip('no IPv6 here');
  }
  const { m } = manager();
  try {
    const opened = await m.open(web(`http://localhost:${p.port}/`), { deviceId: 'phone' });
    const { cookie } = await enter(opened.url);
    const r = await request(`${new URL(opened.url).origin}/x`, { headers: { cookie } });
    assert.equal(r.body, 'page /x');
    assert.equal(p.seen.at(-1).headers.host, `localhost:${p.port}`);
  } finally {
    await m.closeAll();
    await p.close();
  }
  return undefined;
});

test('a tunnel that never shows its proxy is not waited for forever', async () => {
  const p = await localPage();
  try {
    const logs = [];
    const t = Date.now();
    assert.equal(await waitServed(`http://127.0.0.1:${p.port}`, 'someone-else', { timeoutMs: 1200, log: (l, msg) => logs.push(msg) }), false);
    assert.ok(Date.now() - t < 4000);
    assert.match(logs[0], /can't reach/);
  } finally {
    await p.close();
  }
});
test('a removed device\'s open connections to the page end at once (its WebSockets and answers still coming), and so do a visit\'s when it runs out', async () => {
  const p = await localPage();
  const { m } = manager();
  try {
    const target = web(`http://127.0.0.1:${p.port}/`);
    const phone = await enter((await m.open(target, { deviceId: 'phone' })).url);
    const tablet = await enter((await m.open(target, { deviceId: 'tablet' })).url);
    const origin = new URL((await m.open(target, { deviceId: 'phone', first: false })).url).origin;
    const phoneWs = await openSocket(`${origin}/kernel`, { cookie: phone.cookie, origin });
    const tabletWs = await openSocket(`${origin}/kernel`, { cookie: tablet.cookie, origin });
    assert.equal(phoneWs.status, 101);
    assert.equal(await echo(phoneWs.socket, 'run'), 'echo:run');
    const events = await stream(`${origin}/events`, phone.cookie);
    assert.equal(events.status, 200);
    assert.equal(p.sockets.size, 3);

    m.forgetDevice('phone');
    await Promise.all([phoneWs.closed, events.closed]);
    await waitFor(() => p.sockets.size === 1, 'the page\'s ends of them close too');
    assert.equal((await request(`${origin}/`, { headers: { cookie: phone.cookie } })).status, 401);
    assert.equal(await echo(tabletWs.socket, 'still'), 'echo:still', 'the other device\'s stay open');

    // A visit that ran out (after 12 hours) ends the same way.
    const pv = [...m.previews.values()][0];
    pv.expire(Date.now() + SESSION_MS + 1000);
    await tabletWs.closed;
    await waitFor(() => p.sockets.size === 0, 'its socket on the page closes');
    assert.equal(pv.sessions.size, 0);
  } finally {
    await m.closeAll();
    await p.close();
  }
});

test('keeping a link ready is not using the page: it still closes when unused, and a closed page is not opened again by it', async () => {
  const p = await localPage();
  const { m, started } = manager({ idleMs: 400 });
  const target = web(`http://127.0.0.1:${p.port}/`);
  try {
    await m.open(target, { deviceId: 'phone' });
    let renewed = 0;
    for (const end = Date.now() + 3000; m.list().length && Date.now() < end;) {
      await m.open(target, { deviceId: 'phone', first: false }).then(() => renewed++, () => {});
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(renewed >= 2, `links were kept ready (${renewed})`);
    assert.equal(m.list().length, 0, 'closed after it was unused, links or not');
    await assert.rejects(m.open(target, { deviceId: 'phone', first: false }), { code: 'gone' });
    assert.equal(started.length, 1, 'and not opened again');

    // Tapping its link opens it again; closed on the computer (the panel's ✕), it stays closed.
    await m.open(target, { deviceId: 'phone' });
    assert.equal(started.length, 2);
    await m.close(target.key);
    await assert.rejects(m.open(target, { deviceId: 'phone', first: false }), { code: 'gone' });
    assert.equal(started.length, 2);

    // Using the page is: letting a browser in, and what it asks for.
    const opened = await m.open(target, { deviceId: 'phone' });
    const pv = m.previews.get(target.key);
    pv.lastUsed = 0;
    const { cookie } = await enter(opened.url);
    assert.ok(Date.now() - pv.lastUsed < 1000, 'the link opened');
    pv.lastUsed = 0;
    await request(`${new URL(opened.url).origin}/`, { headers: { cookie } });
    assert.ok(Date.now() - pv.lastUsed < 1000, 'a request');
  } finally {
    await m.closeAll();
    await p.close();
  }
});

test('a page whose tunnel lost its connection to Cloudflare (the computer slept) gets a new one when its link is tapped', async () => {
  const p = await localPage();
  let connected = true;
  const { m, started, stopped } = manager({ ready: () => connected, healthWaitMs: 300 });
  const target = web(`http://127.0.0.1:${p.port}/`);
  try {
    const a = await m.open(target, { deviceId: 'phone' });
    connected = false;
    await m.open(target, { deviceId: 'phone', first: false });
    assert.equal(started.length, 1, 'a link kept ready doesn\'t look');
    const b = await m.open(target, { deviceId: 'phone' });
    assert.equal(started.length, 2);
    assert.equal(stopped.length, 1, 'the old one ended');
    assert.notEqual(new URL(b.url).origin, new URL(a.url).origin);
    assert.equal((await request(b.url)).status, 303);
    connected = true;
    await m.open(target, { deviceId: 'phone' });
    assert.equal(started.length, 2, 'a connected one is kept');
  } finally {
    await m.closeAll();
    await p.close();
  }
});

test('the same device\'s browser keeps its visit when it opens another link; visits stay bounded, the one used longest ago ending first', async () => {
  const p = await localPage();
  const { m } = manager();
  const target = web(`http://127.0.0.1:${p.port}/`);
  try {
    const { cookie } = await enter((await m.open(target, { deviceId: 'phone' })).url);
    const pv = m.previews.get(target.key);
    const again = await request((await m.open(target, { deviceId: 'phone', first: false })).url, { headers: { cookie } });
    assert.equal(again.status, 303);
    assert.equal(again.headers['set-cookie'], undefined);
    assert.equal(pv.sessions.size, 1);

    const others = [];
    for (let i = 0; i < MAX_SESSIONS + 3; i++) others.push(await enter((await m.open(target, { deviceId: `d${i}`, first: false })).url));
    assert.equal(pv.sessions.size, MAX_SESSIONS);
    const origin = pv.publicOrigin;
    assert.equal((await request(`${origin}/`, { headers: { cookie: others.at(-1).cookie } })).status, 200);
    assert.equal((await request(`${origin}/`, { headers: { cookie } })).status, 401);
  } finally {
    await m.closeAll();
    await p.close();
  }
});
