// Promise-based wrapper around a browser (or Node >= 22) WebSocket.

export class SocketClosedError extends Error {
  constructor(code, reason) {
    super(reason || `Connection closed (${code})`);
    this.name = 'SocketClosedError';
    this.code = code;
    this.reason = reason;
  }
}

class FrameQueue {
  constructor() {
    this.items = [];
    this.waiters = [];
    this.error = null;
  }
  push(item) {
    const w = this.waiters.shift();
    if (w) w.resolve(item);
    else this.items.push(item);
  }
  fail(err) {
    this.error = err;
    for (const w of this.waiters.splice(0)) w.reject(err);
  }
  shift(timeoutMs = 0) {
    if (this.items.length) return Promise.resolve(this.items.shift());
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => {
      const w = { resolve, reject };
      if (timeoutMs > 0) {
        const t = setTimeout(() => {
          this.waiters = this.waiters.filter((x) => x !== w);
          reject(new Error('Timed out waiting for your PC'));
        }, timeoutMs);
        w.resolve = (v) => { clearTimeout(t); resolve(v); };
        w.reject = (e) => { clearTimeout(t); reject(e); };
      }
      this.waiters.push(w);
    });
  }
}

/**
 * Opens a WebSocket and resolves once it is open.
 * @returns {Promise<{next:(t?:number)=>Promise<{text?:string, bytes?:Uint8Array}>, send:(d:any)=>void, close:(c?:number,r?:string)=>void, onclose:null|((e:SocketClosedError)=>void), bufferedAmount:number}>}
 */
export function openSocket(url, { WebSocketImpl = globalThis.WebSocket, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    let ws;
    try {
      ws = new WebSocketImpl(url);
    } catch (err) {
      reject(err);
      return;
    }
    ws.binaryType = 'arraybuffer';
    const q = new FrameQueue();
    let opened = false;
    const sock = {
      next: (t) => q.shift(t),
      send: (d) => ws.send(d),
      close: (code = 1000, reason = '') => {
        try {
          ws.close(code, reason);
        } catch {
          /* ignore */
        }
      },
      onclose: null,
      get bufferedAmount() {
        return ws.bufferedAmount;
      },
      /** True once the connection is closing or closed (sending then drops data silently). */
      get closed() {
        return ws.readyState >= 2 || !!q.error;
      },
    };
    const timer = setTimeout(() => {
      if (!opened) {
        sock.close();
        reject(new Error('Timed out connecting to your PC'));
      }
    }, timeoutMs);
    ws.onopen = () => {
      opened = true;
      clearTimeout(timer);
      resolve(sock);
    };
    ws.onerror = () => {
      if (!opened) {
        clearTimeout(timer);
        reject(new Error('Could not reach your PC'));
      }
    };
    ws.onmessage = (ev) => {
      q.push(typeof ev.data === 'string' ? { text: ev.data } : { bytes: new Uint8Array(ev.data) });
    };
    ws.onclose = (ev) => {
      clearTimeout(timer);
      const err = new SocketClosedError(ev.code, ev.reason);
      q.fail(err);
      if (!opened) reject(new Error('Could not reach your PC'));
      else sock.onclose?.(err);
    };
  });
}
