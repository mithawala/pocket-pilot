// Tiny offline synth for the video soundtracks: stereo buses, filters, a Freeverb-style reverb,
// a ping-pong delay, loudness (ITU BS.1770) and a lookahead limiter. Deterministic: all noise
// comes from seeded generators.
import fs from 'node:fs';

export const SR = 48000;

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const midi = (m) => 440 * 2 ** ((m - 69) / 12);

/** Equal-power pan, p in [-1, 1]. */
export const pan = (p) => [Math.cos(((p + 1) * Math.PI) / 4), Math.sin(((p + 1) * Math.PI) / 4)];

export class Bus {
  constructor(seconds) {
    this.n = Math.ceil(seconds * SR);
    this.L = new Float32Array(this.n);
    this.R = new Float32Array(this.n);
  }
  add(i, l, r) {
    if (i >= 0 && i < this.n) {
      this.L[i] += l;
      this.R[i] += r;
    }
  }
  mix(other, gain = 1) {
    for (let i = 0; i < this.n; i++) {
      this.L[i] += other.L[i] * gain;
      this.R[i] += other.R[i] * gain;
    }
  }
}

/** Zavalishin TPT state-variable filter; the cutoff may change every sample. */
export class SVF {
  constructor() {
    this.ic1 = 0;
    this.ic2 = 0;
    this.bp = 0;
    this.hp = 0;
  }
  run(x, fc, q) {
    const g = Math.tan((Math.PI * Math.min(Math.max(fc, 10), SR * 0.45)) / SR);
    const k = 1 / q;
    const a1 = 1 / (1 + g * (g + k));
    const a2 = g * a1;
    const a3 = g * a2;
    const v3 = x - this.ic2;
    const v1 = a1 * this.ic1 + a2 * v3;
    const v2 = this.ic2 + a2 * this.ic1 + a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    this.bp = v1;
    this.hp = x - k * v1 - v2;
    return v2;
  }
  lp(x, fc, q = 0.707) { return this.run(x, fc, q); }
  bpf(x, fc, q = 1) { this.run(x, fc, q); return this.bp; }
  hpf(x, fc, q = 0.707) { this.run(x, fc, q); return this.hp; }
}

/** Freeverb (Jezar's tunings, scaled to 48 kHz). Returns the wet signal. */
export function reverb(bus, { room = 0.84, damp = 0.3 } = {}) {
  const s = SR / 44100;
  const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617].map((d) => Math.round(d * s));
  const aps = [556, 441, 341, 225].map((d) => Math.round(d * s));
  const spread = Math.round(23 * s);
  const out = new Bus(bus.n / SR);
  const mono = new Float32Array(bus.n);
  for (let i = 0; i < bus.n; i++) mono[i] = (bus.L[i] + bus.R[i]) * 0.5;
  for (const [chan, off] of [['L', 0], ['R', spread]]) {
    const acc = new Float32Array(bus.n);
    for (const d0 of combs) {
      const d = d0 + off;
      const buf = new Float32Array(d);
      let idx = 0;
      let store = 0;
      for (let i = 0; i < bus.n; i++) {
        const y = buf[idx];
        store = y * (1 - damp) + store * damp;
        buf[idx] = mono[i] * 0.015 + store * room;
        idx = idx + 1 === d ? 0 : idx + 1;
        acc[i] += y;
      }
    }
    for (const d0 of aps) {
      const d = d0 + off;
      const buf = new Float32Array(d);
      let idx = 0;
      for (let i = 0; i < bus.n; i++) {
        const b = buf[idx];
        const y = b - acc[i];
        buf[idx] = acc[i] + b * 0.5;
        idx = idx + 1 === d ? 0 : idx + 1;
        acc[i] = y;
      }
    }
    for (let i = 0; i < bus.n; i++) acc[i] *= 3;
    out[chan] = acc;
  }
  return out;
}

/** Ping-pong delay with a darkening feedback loop. Returns the wet signal. */
export function delay(bus, { time = 0.3, feedback = 0.38, tone = 3500 } = {}) {
  const d = Math.round(time * SR);
  const out = new Bus(bus.n / SR);
  const bl = new Float32Array(d);
  const br = new Float32Array(d);
  const fl = new SVF();
  const fr = new SVF();
  let idx = 0;
  for (let i = 0; i < bus.n; i++) {
    const yl = bl[idx];
    const yr = br[idx];
    out.L[i] = yl;
    out.R[i] = yr;
    bl[idx] = (bus.L[i] + bus.R[i]) * 0.5 + fl.lp(yr, tone) * feedback;
    br[idx] = fr.lp(yl, tone) * feedback;
    idx = idx + 1 === d ? 0 : idx + 1;
  }
  return out;
}

/** High-pass the whole bus (removes rumble below the music). */
export function highpass(bus, fc = 30) {
  for (const ch of ['L', 'R']) {
    const f = new SVF();
    const x = bus[ch];
    for (let i = 0; i < bus.n; i++) x[i] = f.hpf(x[i], fc);
  }
}

/** Integrated loudness in LUFS (ITU-R BS.1770-4 K-weighting at 48 kHz, gated). */
export function lufs(bus) {
  const kw = (x) => {
    const y = Float32Array.from(x);
    const stages = [[1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, 0.73248077421585], [1, -2, 1, -1.99004745483398, 0.99007225036621]];
    for (const [b0, b1, b2, a1, a2] of stages) {
      let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      for (let i = 0; i < y.length; i++) {
        const xi = y[i];
        const yi = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1; x1 = xi; y2 = y1; y1 = yi;
        y[i] = yi;
      }
    }
    return y;
  };
  const L = kw(bus.L);
  const R = kw(bus.R);
  const block = Math.round(0.4 * SR);
  const hop = Math.round(0.1 * SR);
  const powers = [];
  for (let s = 0; s + block <= bus.n; s += hop) {
    let sum = 0;
    for (let i = s; i < s + block; i++) sum += L[i] * L[i] + R[i] * R[i];
    powers.push(sum / block);
  }
  const loud = (p) => -0.691 + 10 * Math.log10(p);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const abs = powers.filter((p) => loud(p) > -70);
  const rel = loud(mean(abs)) - 10;
  return loud(mean(abs.filter((p) => loud(p) > rel)));
}

/** Lookahead peak limiter: the output never exceeds `ceiling` (linear). */
export function limit(bus, ceiling = 0.84, { look = 0.005, release = 0.15 } = {}) {
  const la = Math.round(look * SR);
  const need = new Float32Array(bus.n);
  for (let i = 0; i < bus.n; i++) {
    const p = Math.max(Math.abs(bus.L[i]), Math.abs(bus.R[i]));
    need[i] = p > ceiling ? ceiling / p : 1;
  }
  // sliding-window minimum of `need` over [i, i + la) — a monotonic deque
  const g = new Float32Array(bus.n);
  const dq = new Int32Array(bus.n);
  let head = 0, tail = 0;
  for (let j = 0; j < bus.n + la; j++) {
    if (j < bus.n) {
      while (tail > head && need[dq[tail - 1]] >= need[j]) tail--;
      dq[tail++] = j;
    }
    const i = j - la + 1;
    if (i >= 0) {
      while (dq[head] < i) head++;
      g[i] = need[dq[head]];
    }
  }
  const rel = Math.exp(-1 / (release * SR));
  let cur = 1;
  for (let i = 0; i < bus.n; i++) {
    cur = Math.min(g[i], 1 - (1 - cur) * rel);
    bus.L[i] *= cur;
    bus.R[i] *= cur;
  }
}

export function writeWav(file, bus) {
  const data = Buffer.alloc(bus.n * 4);
  for (let i = 0; i < bus.n; i++) {
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, bus.L[i])) * 32767), i * 4);
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, bus.R[i])) * 32767), i * 4 + 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22);
  h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, data]));
}
