import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Cipher, SecureMessenger, StringTrimmer, HandshakeError } from '../pwa/js/core/secure-channel.js';
import { HostConnection, TOO_LARGE } from '../pwa/js/net/host-connection.js';
import { SocketClosedError } from '../pwa/js/net/socket.js';

const utf8 = new TextEncoder();
const NOTE = /^([\s\S]*)\n… \(trimmed: \d+(?:\.\d)? [KM]B more on your computer\)$/;
const escapedBytes = (s) => Buffer.byteLength(JSON.stringify(s)) - 2;

function seeded(seed) {
  let x = seed;
  return () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x / 2147483648;
  };
}

function randomValue(rnd, depth = 0) {
  const pick = rnd();
  if (depth > 3 || pick < 0.45) {
    const alphabet = ['a', 'b', ' ', '"', '\\', '\n', '\t', 'é', '😀', '中', '/', '\u0001'];
    const len = rnd() < 0.3 ? Math.floor(rnd() * 400) : Math.floor(rnd() * 40);
    let s = '';
    for (let i = 0; i < len; i++) s += alphabet[Math.floor(rnd() * alphabet.length)];
    return s;
  }
  if (pick < 0.55) return Math.floor(rnd() * 1e6) / 7;
  if (pick < 0.6) return rnd() < 0.5;
  if (pick < 0.65) return null;
  if (pick < 0.8) return Array.from({ length: Math.floor(rnd() * 5) }, () => randomValue(rnd, depth + 1));
  const o = {};
  for (let i = 0; i < Math.floor(rnd() * 5); i++) o[`k${i}`] = randomValue(rnd, depth + 1);
  return o;
}

/** Every string must be the original, or a clean prefix of it with the trimming note. */
function assertTrimmed(orig, out, max, at = '$') {
  if (typeof orig === 'string') {
    if (out === orig) {
      assert.ok(escapedBytes(orig) <= max + 8, `${at}: a long string was not trimmed`);
      return;
    }
    const m = NOTE.exec(out);
    assert.ok(m, `${at}: trimmed string without the note: ${JSON.stringify(out).slice(0, 80)}`);
    assert.ok(orig.startsWith(m[1]), `${at}: kept part is not a prefix of the original`);
    assert.ok(escapedBytes(m[1]) <= max + 8, `${at}: kept too much`);
    assert.ok(escapedBytes(m[1]) >= max - 4 || escapedBytes(orig) > max, `${at}: cut although short`);
    return;
  }
  if (Array.isArray(orig)) {
    assert.ok(Array.isArray(out) && out.length === orig.length, `${at}: array changed`);
    orig.forEach((v, i) => assertTrimmed(v, out[i], max, `${at}[${i}]`));
    return;
  }
  if (orig && typeof orig === 'object') {
    assert.deepEqual(Object.keys(out), Object.keys(orig), `${at}: keys changed`);
    for (const k of Object.keys(orig)) assertTrimmed(orig[k], out[k], max, `${at}.${k}`);
    return;
  }
  assert.equal(out, orig, `${at}: value changed`);
}

function trim(text, max, chunk) {
  const bytes = utf8.encode(text);
  const t = new StringTrimmer(max);
  for (let i = 0; i < bytes.length;) {
    const n = chunk();
    t.push(bytes.subarray(i, i + n));
    i += n;
  }
  return new TextDecoder().decode(t.bytes());
}

test('the trimmer keeps JSON valid and cuts only long strings, at any chunk boundary', () => {
  for (let seed = 1; seed <= 2000; seed++) {
    const rnd = seeded(seed);
    const value = { id: seed, result: randomValue(rnd) };
    const text = JSON.stringify(value);
    const max = 8 + Math.floor(rnd() * 120);
    const out = trim(text, max, () => 1 + Math.floor(rnd() * 40));
    let parsed;
    try {
      parsed = JSON.parse(out);
    } catch (err) {
      assert.fail(`seed ${seed}: output is not JSON (${err.message})`);
    }
    assertTrimmed(value, parsed, max, `seed ${seed}`);
  }
});

test('the trimmer cuts screenshots and long output but keeps short strings byte for byte', () => {
  const blob = crypto.randomBytes(300000).toString('base64');
  const value = { jsonrpc: '2.0', id: 3, result: { snapshot: { state: { turns: [{ id: 't1', message: { text: 'Fix the tests "please" \\ é 😀' }, responseParts: [{ kind: 'markdown', content: 'Done.' }, { kind: 'toolCall', toolCall: { toolCallId: 'c1', content: [{ type: 'embeddedResource', data: blob }, { type: 'text', text: 'x\n'.repeat(50000) }] } }] }] } } } };
  const text = JSON.stringify(value);
  const out = trim(text, 64 * 1024, () => 65536);
  const parsed = JSON.parse(out);
  const turn = parsed.result.snapshot.state.turns[0];
  assert.equal(turn.message.text, value.result.snapshot.state.turns[0].message.text);
  assert.equal(turn.responseParts[0].content, 'Done.');
  const [data, txt] = turn.responseParts[1].toolCall.content;
  assert.ok(NOTE.test(data.data) && blob.startsWith(NOTE.exec(data.data)[1]));
  assert.match(data.data, /trimmed: 327 KB more/);
  assert.ok(NOTE.test(txt.text));
  assert.ok(out.length < 140000, `trimmed to ${out.length}`);
});

async function channel({ compress = true, slim, maxMessageBytes, onProgress } = {}) {
  const key = crypto.randomBytes(32);
  const frames = [];
  const sender = new SecureMessenger(await Cipher.create(key, key, 'x', 'x'), (f) => frames.push(f), { compress });
  const phone = new SecureMessenger(await Cipher.create(key, key, 'x', 'x'), () => {}, { compress: true, slim, maxMessageBytes, onProgress });
  return {
    async roundTrip(text) {
      frames.length = 0;
      await sender.send(text);
      const n = frames.length;
      let out = null;
      for (const f of frames.splice(0)) {
        const r = await phone.receive(f);
        if (r !== null) out = r;
      }
      return { out, frames: n };
    },
  };
}

const SLIM = { above: 16 * 1024, stringMax: 256 };
const bigReply = (id) => `A${JSON.stringify({ jsonrpc: '2.0', id, result: { parts: Array.from({ length: 40 }, (_, i) => ({ i, data: crypto.randomBytes(15000).toString('base64') })) } })}`;
const manyStrings = (id) => `A${JSON.stringify({ jsonrpc: '2.0', id, result: { items: Array.from({ length: 30000 }, (_, i) => `${i}-${crypto.randomBytes(6).toString('hex')}`) } })}`;

for (const compress of [true, false]) {
  test(`a slim messenger trims an oversized message while its frames arrive (${compress ? 'compressed' : 'plain'})`, async () => {
    const progress = [];
    const ch = await channel({ compress, slim: SLIM, maxMessageBytes: 64 * 1024, onProgress: (n) => progress.push(n) });
    const small = `A${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { text: 'y'.repeat(10000) } })}`;
    assert.equal((await ch.roundTrip(small)).out, small, 'messages under the threshold arrive untouched');
    const { out, frames } = await ch.roundTrip(bigReply(2));
    assert.ok(frames > 1, 'spans several frames');
    const parsed = JSON.parse(out.slice(1));
    assert.equal(parsed.id, 2);
    assert.equal(parsed.result.parts.length, 40);
    for (const p of parsed.result.parts) assert.ok(NOTE.test(p.data));
    assert.ok(out.length < 64 * 1024);
    assert.ok(progress.some((n) => n > 0) && progress.at(-1) === 0, 'reports progress, then done');
  });

  test(`a message too large even trimmed fails alone and the channel carries on (${compress ? 'compressed' : 'plain'})`, async () => {
    const ch = await channel({ compress, slim: SLIM, maxMessageBytes: 64 * 1024 });
    await assert.rejects(ch.roundTrip(manyStrings(7)), (err) => {
      assert.ok(err instanceof HandshakeError);
      assert.equal(err.code, 'too-large');
      assert.equal(err.inSync, true);
      assert.match(err.head, /^A\{"jsonrpc":"2\.0","id":7,"result"/);
      return true;
    });
    const next = `A${JSON.stringify({ jsonrpc: '2.0', id: 8, result: { ok: true } })}`;
    assert.equal((await ch.roundTrip(next)).out, next);
  });
}

test('without slim options an oversized message still fails as before', async () => {
  const ch = await channel({ maxMessageBytes: 64 * 1024 });
  await assert.rejects(ch.roundTrip(bigReply(3)), (err) => err.code === 'too-large' && !err.inSync);
});

function pumpHarness(steps) {
  const conn = new HostConnection({ url: 'https://x.example', hostId: 'h' });
  const closes = [];
  conn.sock = { close: (code) => closes.push(code) };
  const delivered = [];
  let ended = false;
  const transport = { _deliver: (t) => delivered.push(t), _end: () => { ended = true; } };
  const ch = {
    async recv() {
      const s = steps.shift();
      if (!s) throw new SocketClosedError();
      if (s instanceof Error) throw s;
      return s;
    },
  };
  return { done: conn._pump(ch, transport), delivered, closes, isEnded: () => ended };
}

const tooLargeError = (head) => Object.assign(new HandshakeError('too-large', 'Message too large'), { inSync: true, head, size: 200e6 });

test('a reply too large for the phone fails its own request instead of the connection', async () => {
  const action = '{"jsonrpc":"2.0","method":"action","params":{}}';
  const h = pumpHarness([tooLargeError('A{"jsonrpc":"2.0","id":7,"result":{"snapshot":{'), `A${action}`, tooLargeError('A{"jsonrpc":"2.0","method":"action","params":{"id":3')]);
  await h.done;
  assert.equal(h.delivered.length, 2, 'an error for request 7, then the next message; a notification is just dropped');
  const err = JSON.parse(h.delivered[0]);
  assert.equal(err.id, 7);
  assert.equal(err.error.code, TOO_LARGE);
  assert.match(err.error.message, /too large to load on your phone/);
  assert.equal(h.delivered[1], action);
  assert.deepEqual(h.closes, [], 'the connection stays open');
  assert.ok(h.isEnded(), 'until the socket really closes');
});

test('any other receive error still closes the connection', async () => {
  const h = pumpHarness([new HandshakeError('bad-mac', 'Frame authentication failed')]);
  await h.done;
  assert.deepEqual(h.closes, [4000]);
  assert.ok(h.isEnded());
});
