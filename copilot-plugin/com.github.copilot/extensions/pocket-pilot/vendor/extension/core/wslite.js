'use strict';
// Minimal RFC 6455 WebSocket implementation (client + server), no dependencies.
const crypto = require('crypto');
const net = require('net');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP_CONT = 0x0, OP_TEXT = 0x1, OP_BIN = 0x2, OP_CLOSE = 0x8, OP_PING = 0x9, OP_PONG = 0xa;

class WsConnection extends EventEmitter {
  constructor(socket, { isClient, maxPayload = 512 * 1024 * 1024, head } = {}) {
    super();
    this.socket = socket;
    this.isClient = !!isClient;
    this.maxPayload = maxPayload;
    this.readyState = 1; // OPEN
    this._chunks = [];
    this._buffered = 0;
    this._fragments = null;
    this._fragOpcode = 0;
    this._fragSize = 0;
    socket.setNoDelay?.(true);
    socket.on('data', (d) => this._onData(d));
    socket.on('error', (e) => this.emit('error', e));
    socket.on('close', () => this._onSocketClose());
    if (head && head.length) this._onData(head);
  }

  send(data) {
    if (this.readyState !== 1) return false;
    if (typeof data === 'string') return this._sendFrame(OP_TEXT, Buffer.from(data, 'utf8'));
    return this._sendFrame(OP_BIN, Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  }

  ping(data = Buffer.alloc(0)) {
    if (this.readyState === 1) this._sendFrame(OP_PING, data);
  }

  close(code = 1000, reason = '') {
    if (this.readyState !== 1) return;
    this.readyState = 2; // CLOSING
    const r = Buffer.from(String(reason).slice(0, 120), 'utf8');
    const payload = Buffer.alloc(2 + r.length);
    payload.writeUInt16BE(code, 0);
    r.copy(payload, 2);
    this._sendFrame(OP_CLOSE, payload);
    this._closeTimer = setTimeout(() => this.socket.destroy(), 3000);
    this._closeTimer.unref?.();
  }

  terminate() {
    this.readyState = 3;
    this.socket.destroy();
  }

  get bufferedAmount() {
    return this.socket.writableLength || 0;
  }

  _sendFrame(opcode, payload) {
    const len = payload.length;
    let header;
    const maskBit = this.isClient ? 0x80 : 0;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = maskBit | len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = maskBit | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = maskBit | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode;
    if (this.isClient) {
      const mask = crypto.randomBytes(4);
      const masked = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
      this.socket.write(Buffer.concat([header, mask]));
      return this.socket.write(masked);
    }
    this.socket.write(header);
    return this.socket.write(payload);
  }

  _onData(data) {
    this._chunks.push(data);
    this._buffered += data.length;
    try {
      while (this._parseFrame()) { /* keep parsing */ }
    } catch (err) {
      this.emit('error', err);
      this._fail(1002, err.message);
    }
  }

  _peek(n) {
    if (this._buffered < n) return null;
    if (this._chunks[0].length >= n) return this._chunks[0];
    const merged = Buffer.concat(this._chunks);
    this._chunks = [merged];
    return merged;
  }

  _consume(n) {
    const buf = this._peek(n);
    const out = buf.subarray(0, n);
    const rest = buf.subarray(n);
    this._chunks = rest.length ? [rest, ...this._chunks.slice(1)] : this._chunks.slice(1);
    this._buffered -= n;
    return out;
  }

  _parseFrame() {
    const h = this._peek(2);
    if (!h) return false;
    const fin = (h[0] & 0x80) !== 0;
    const opcode = h[0] & 0x0f;
    const masked = (h[1] & 0x80) !== 0;
    let len = h[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      const b = this._peek(4);
      if (!b) return false;
      len = b.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      const b = this._peek(10);
      if (!b) return false;
      const big = b.readBigUInt64BE(2);
      if (big > BigInt(this.maxPayload)) throw new Error('Frame too large');
      len = Number(big);
      offset = 10;
    }
    if (len > this.maxPayload) throw new Error('Frame too large');
    const total = offset + (masked ? 4 : 0) + len;
    if (this._buffered < total) return false;
    const frame = this._consume(total);
    let payload = frame.subarray(offset + (masked ? 4 : 0));
    if (masked) {
      const mask = frame.subarray(offset, offset + 4);
      const unmasked = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) unmasked[i] = payload[i] ^ mask[i & 3];
      payload = unmasked;
    } else {
      payload = Buffer.from(payload);
    }
    this._handleFrame(fin, opcode, payload);
    return true;
  }

  _handleFrame(fin, opcode, payload) {
    if (opcode >= 0x8) {
      if (opcode === OP_CLOSE) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
        if (this.readyState === 1) {
          this.readyState = 2;
          this._sendFrame(OP_CLOSE, payload.subarray(0, 2));
        }
        this._closeInfo = { code, reason };
        this.socket.end();
      } else if (opcode === OP_PING) {
        this._sendFrame(OP_PONG, payload);
      } else if (opcode === OP_PONG) {
        this.emit('pong', payload);
      }
      return;
    }
    if (opcode === OP_CONT) {
      if (!this._fragments) throw new Error('Unexpected continuation frame');
      this._fragments.push(payload);
      this._fragSize += payload.length;
      if (this._fragSize > this.maxPayload) throw new Error('Message too large');
      if (fin) {
        const all = Buffer.concat(this._fragments);
        const op = this._fragOpcode;
        this._fragments = null;
        this._deliver(op, all);
      }
      return;
    }
    if (this._fragments) throw new Error('Expected continuation frame');
    if (!fin) {
      this._fragments = [payload];
      this._fragOpcode = opcode;
      this._fragSize = payload.length;
      return;
    }
    this._deliver(opcode, payload);
  }

  _deliver(opcode, payload) {
    if (opcode === OP_TEXT) this.emit('message', payload.toString('utf8'), false);
    else if (opcode === OP_BIN) this.emit('message', payload, true);
  }

  _fail(code, reason) {
    if (this.readyState === 1) this.close(code, reason);
    else this.socket.destroy();
  }

  _onSocketClose() {
    clearTimeout(this._closeTimer);
    const prev = this.readyState;
    this.readyState = 3;
    if (prev !== 3 || !this._closedEmitted) {
      this._closedEmitted = true;
      const info = this._closeInfo || { code: 1006, reason: '' };
      this.emit('close', info.code, info.reason);
    }
  }
}

/** Client: connect to ws endpoint over TCP or a named pipe / unix socket. */
function connect({ socketPath, host = '127.0.0.1', port, path = '/', headers = {}, timeoutMs = 10000, maxPayload } = {}) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const socket = socketPath ? net.connect(socketPath) : net.connect(port, host);
    let settled = false;
    const timer = setTimeout(() => fail(new Error('WebSocket connect timeout')), timeoutMs);
    function fail(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(err);
    }
    socket.once('error', fail);
    socket.once('connect', () => {
      const lines = [
        `GET ${path} HTTP/1.1`,
        `Host: ${socketPath ? 'localhost' : `${host}:${port}`}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
      ];
      for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
      socket.write(lines.join('\r\n') + '\r\n\r\n');
    });
    let buf = Buffer.alloc(0);
    function onData(d) {
      buf = Buffer.concat([buf, d]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx === -1) {
        if (buf.length > 16384) fail(new Error('Handshake response too large'));
        return;
      }
      socket.removeListener('data', onData);
      const head = buf.subarray(idx + 4);
      const text = buf.subarray(0, idx).toString('latin1');
      const [statusLine, ...hdrLines] = text.split('\r\n');
      const status = Number(statusLine.split(' ')[1]);
      const hdrs = {};
      for (const l of hdrLines) {
        const i = l.indexOf(':');
        if (i > 0) hdrs[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
      }
      if (status !== 101) return fail(Object.assign(new Error(`WebSocket upgrade failed: ${statusLine}`), { status }));
      const expected = crypto.createHash('sha1').update(key + GUID).digest('base64');
      if (hdrs['sec-websocket-accept'] !== expected) return fail(new Error('Invalid Sec-WebSocket-Accept'));
      settled = true;
      clearTimeout(timer);
      socket.removeListener('error', fail);
      resolve(new WsConnection(socket, { isClient: true, head, maxPayload }));
    }
    socket.on('data', onData);
  });
}

/** Server: complete an HTTP upgrade. Returns a WsConnection or null (after responding with an error). */
function acceptUpgrade(req, socket, head, { maxPayload } = {}) {
  const key = req.headers['sec-websocket-key'];
  const upgrade = String(req.headers.upgrade || '').toLowerCase();
  if (upgrade !== 'websocket' || !key || req.headers['sec-websocket-version'] !== '13') {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return null;
  }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  return new WsConnection(socket, { isClient: false, head, maxPayload });
}

module.exports = { WsConnection, connect, acceptUpgrade };
