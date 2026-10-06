// Protocol versions: VS Code 1.141 speaks 0.10.0 and accepts only 0.10.x; the phone app and the
// extension's notification monitor offered 0.9.0 and older, and couldn't load sessions at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { InMemoryTransport } from '../pwa/vendor/ahp/client/index.js';
import { chatReducer, SUPPORTED_PROTOCOL_VERSIONS } from '../pwa/vendor/ahp/types/index.js';
import { PROTOCOL_VERSIONS } from '../pwa/js/core/protocol.js';
import { HostStore } from '../pwa/js/model/host-store.js';

const { SessionMonitor } = createRequire(import.meta.url)('../extension/core/monitor.js');

/** VS Code's own negotiation (src/vs/platform/agentHost/common/state/protocol/version/negotiation.ts). */
function vscodeNegotiate(offered, current) {
  const parse = (v) => v.split('.').map(Number);
  const cmp = (p, q) => {
    const [a, b, c] = parse(p);
    const [x, y, z] = parse(q);
    return a - x || b - y || c - z;
  };
  // isCompatibleProtocolVersion: same major, same minor below 1.0.0, and no newer than the server.
  const compatible = (v) => {
    const [a, b] = parse(v);
    const [x, y] = parse(current);
    return a === x && (a !== 0 || b === y) && cmp(v, current) <= 0;
  };
  let best;
  for (const v of offered) if (compatible(v) && (best === undefined || cmp(v, best) > 0)) best = v;
  return best;
}

test('the versions offered: every release of VS Code finds its own, most preferred first', () => {
  assert.deepEqual([...PROTOCOL_VERSIONS], ['1.0.0', '0.10.0', '0.9.0', '0.8.0', '0.7.0', '0.6.0', '0.5.2', '0.5.1']);
  for (const v of SUPPORTED_PROTOCOL_VERSIONS) assert.ok(PROTOCOL_VERSIONS.includes(v), `the library's ${v}`);
  assert.equal(vscodeNegotiate(PROTOCOL_VERSIONS, '0.10.0'), '0.10.0', 'VS Code 1.141');
  assert.equal(vscodeNegotiate(PROTOCOL_VERSIONS, '0.9.0'), '0.9.0', 'VS Code 1.140 and earlier');
  assert.equal(vscodeNegotiate(PROTOCOL_VERSIONS, '0.7.0'), '0.7.0');
  assert.equal(vscodeNegotiate(PROTOCOL_VERSIONS, '1.0.0'), '1.0.0', 'VS Code on the 1.0.0 release');
  assert.equal(vscodeNegotiate(PROTOCOL_VERSIONS, '1.1.0'), '1.0.0', 'and later 1.x releases');
  assert.equal(vscodeNegotiate(['0.9.0', '0.8.0', '0.7.0', '0.6.0', '0.5.2', '0.5.1'], '0.10.0'), undefined, 'what the app offered before: rejected');
});

/** An agent host that negotiates like VS Code 1.141, with its error for clients it doesn't accept. */
function vscode141(transport, offeredLog) {
  (async () => {
    for (;;) {
      const f = await transport.recv();
      if (!f) return;
      const m = JSON.parse(f.text);
      const reply = (result) => transport.send({ jsonrpc: '2.0', id: m.id, result });
      if (m.method === 'initialize') {
        offeredLog.push(m.params.protocolVersions);
        const v = vscodeNegotiate(m.params.protocolVersions, '0.10.0');
        if (!v) {
          transport.send({ jsonrpc: '2.0', id: m.id, error: { code: -32005, message: `Client offered protocol versions [${m.params.protocolVersions.join(', ')}], none of which are compatible with this server's version 0.10.0 (server accepts ^0.10.0).`, data: { supportedVersions: ['^0.10.0'] } } });
          continue;
        }
        reply({ protocolVersion: v, serverSeq: 7, snapshots: [{ resource: 'ahp-root://', fromSeq: 7, state: { agents: [{ provider: 'copilotcli', displayName: 'Copilot', description: '', models: [] }] } }] });
      } else if (m.method === 'listSessions') {
        reply({ items: [{ resource: 'copilotcli:/s1', provider: 'copilotcli', title: 'Fix the tests', status: 33, createdAt: '', modifiedAt: '2026-10-06T12:00:00Z', workingDirectories: ['file:///c%3A/work'] }] });
      } else if (m.id !== undefined) {
        reply({});
      }
    }
  })();
}

test('the phone loads the sessions of VS Code 1.141', async () => {
  const [client, server] = InMemoryTransport.pair();
  const offered = [];
  vscode141(server, offered);
  const conn = new EventTarget();
  conn.state = 'online';
  const store = new HostStore(conn);
  conn.dispatchEvent(new CustomEvent('ready', { detail: { transport: client } }));
  try {
    for (let i = 0; i < 400 && !store.sessions.size; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(store.sessions.get('copilotcli:/s1')?.title, 'Fix the tests');
    assert.equal(store.errors.length, 0, store.errors.map((e) => e.message).join('; '));
    assert.deepEqual(offered[0], [...PROTOCOL_VERSIONS]);
  } finally {
    store.dispose();
  }
});

test('the notification monitor connects to VS Code 1.141 too', async () => {
  const conn = new EventEmitter();
  const offered = [];
  conn.send = (text) => {
    const m = JSON.parse(text);
    const out = [];
    if (m.method === 'initialize') {
      offered.push(m.params.protocolVersions);
      const v = vscodeNegotiate(m.params.protocolVersions, '0.10.0');
      out.push(v ? { jsonrpc: '2.0', id: m.id, result: { protocolVersion: v, serverSeq: 1, snapshots: [{ resource: 'ahp-root://', fromSeq: 1, state: { agents: [] } }] } } : { jsonrpc: '2.0', id: m.id, error: { code: -32005, message: 'unsupported' } });
    } else if (m.method === 'listSessions') out.push({ jsonrpc: '2.0', id: m.id, result: { items: [] } });
    else if (m.id !== undefined) out.push({ jsonrpc: '2.0', id: m.id, result: {} });
    queueMicrotask(() => out.forEach((f) => conn.emit('message', JSON.stringify(f), false)));
  };
  conn.close = () => conn.emit('close');
  const monitor = new SessionMonitor({ getEndpoint: () => ({ type: 'editor', protocolVersion: '0.10.0' }), openConnection: async () => conn });
  monitor.start();
  try {
    for (let i = 0; i < 400 && !offered.length; i++) await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(offered[0], [...PROTOCOL_VERSIONS]);
    assert.equal(vscodeNegotiate(offered[0], '0.10.0'), '0.10.0');
  } finally {
    monitor.stop();
  }
});

test('actions new in 0.10.0 are understood, not just skipped', () => {
  const chat = { resource: 'ahp-chat://default/s1', title: '', status: 1, modifiedAt: '', turns: [] };
  const warnings = [];
  const read = chatReducer(chat, { type: 'chat/isReadChanged', isRead: true }, (m) => warnings.push(m));
  assert.deepEqual(warnings, []);
  assert.notEqual(read, chat);
  const canvases = chatReducer(chat, { type: 'chat/canvasesChanged', canvases: [] }, (m) => warnings.push(m));
  assert.deepEqual(warnings, []);
  assert.deepEqual(canvases.canvases, []);
});
