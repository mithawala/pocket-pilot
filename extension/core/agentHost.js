'use strict';
// Discovers the Agent Host Protocol endpoint that VS Code (>= 1.133) publishes for local clients
// and opens authenticated WebSocket connections to it (named pipe on Windows, unix socket or TCP).
const fs = require('fs');
const path = require('path');
const ws = require('./wslite');

function isAlive(pid) {
  if (!pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function cmpVersion(a = '0', b = '0') {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** `<userData>/User/globalStorage/<ext>` -> `<userData>` */
function userDataFromGlobalStorage(globalStoragePath) {
  const p = path.resolve(globalStoragePath, '..', '..', '..');
  return p;
}

function endpointDir(userDataPath) {
  return path.join(userDataPath, 'agent-host', 'local-endpoint', 'entries');
}

/** Lists live endpoints, editor-owned first, newest protocol first. */
function listEndpoints(userDataPath) {
  const dir = endpointDir(userDataPath);
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    try {
      const e = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (!e || !e.endpoint || typeof e.connectionToken !== 'string') continue;
      if (!isAlive(e.pid)) continue;
      out.push(e);
    } catch {
      /* partially written or foreign file */
    }
  }
  out.sort((a, b) => (a.type === 'editor' ? 0 : 1) - (b.type === 'editor' ? 0 : 1) || cmpVersion(b.protocolVersion, a.protocolVersion));
  return out;
}

function selectEndpoint(userDataPath, { types = ['editor'], minProtocol = '0.5.1' } = {}) {
  return listEndpoints(userDataPath).find((e) => types.includes(e.type) && cmpVersion(e.protocolVersion, minProtocol) >= 0) || null;
}

function describeEndpoint(e) {
  if (!e) return 'none';
  const where = e.endpoint.type === 'tcp' ? `${e.endpoint.host || '127.0.0.1'}:${e.endpoint.port}` : e.endpoint.path;
  return `${e.type} agent host pid ${e.pid} (protocol ${e.protocolVersion}) at ${where}`;
}

/** Opens a WebSocket to the agent host. The connection token never leaves this machine. */
function openConnection(endpoint, { timeoutMs = 10000, maxPayload = 512 * 1024 * 1024 } = {}) {
  const reqPath = `/?tkn=${encodeURIComponent(endpoint.connectionToken)}`;
  const ep = endpoint.endpoint;
  if (ep.type === 'socket' || ep.type === 'pipe') return ws.connect({ socketPath: ep.path, path: reqPath, timeoutMs, maxPayload });
  if (ep.type === 'tcp') return ws.connect({ host: ep.host || '127.0.0.1', port: ep.port, path: reqPath, timeoutMs, maxPayload });
  return Promise.reject(new Error(`Unsupported agent host endpoint type: ${ep.type}`));
}

/** Adapts a WsConnection to the AHP client's AhpTransport interface. */
function transportFor(conn) {
  const queue = [];
  const waiters = [];
  let closed = false;
  const push = (frame) => {
    const w = waiters.shift();
    if (w) w(frame);
    else queue.push(frame);
  };
  conn.on('message', (data, isBinary) => push(isBinary ? { kind: 'binary', data: new Uint8Array(data) } : { kind: 'text', text: data }));
  conn.on('close', () => {
    closed = true;
    while (waiters.length) waiters.shift()(null);
  });
  conn.on('error', () => {});
  return {
    send(message) {
      conn.send(typeof message === 'string' ? message : JSON.stringify(message));
    },
    recv() {
      if (queue.length) return Promise.resolve(queue.shift());
      if (closed) return Promise.resolve(null);
      return new Promise((resolve) => waiters.push(resolve));
    },
    close() {
      conn.close();
    },
  };
}

module.exports = { listEndpoints, selectEndpoint, describeEndpoint, openConnection, transportFor, userDataFromGlobalStorage, endpointDir, cmpVersion };
