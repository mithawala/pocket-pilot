// Instruments and sound effects for the soundtracks. Each writes into ctx.dry (and, scaled, into
// the ctx.rev / ctx.dly send buses). Times are in seconds, pitches in MIDI note numbers.
import { SR, SVF, midi, pan } from './dsp.mjs';

function out(ctx, i, v, p = 0, rev = 0, dly = 0) {
  const [gl, gr] = pan(p);
  ctx.dry.add(i, v * gl, v * gr);
  if (rev) ctx.rev.add(i, v * gl * rev, v * gr * rev);
  if (dly) ctx.dly.add(i, v * gl * dly, v * gr * dly);
}

const blep = (t, dt) => {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
};

/** A sustained chord of detuned saws through a low-pass filter. */
export function pad(ctx, t0, dur, notes, { vol = 0.07, attack = 0.9, release = 1.4, cutoff = 1600, cutoffEnd = cutoff, q = 0.7, detune = 7, rev = 0.45, width = 0.7 } = {}) {
  const i0 = Math.round(t0 * SR);
  const len = Math.round((dur + release) * SR);
  notes.forEach((n, ni) => {
    const voices = [-detune, 0, detune].map((c, vi) => ({ dt: (midi(n) * 2 ** (c / 1200)) / SR, ph: ctx.rng(), p: (vi - 1) * width * (ni % 2 ? -1 : 1) }));
    const f = [new SVF(), new SVF()];
    for (let k = 0; k < len; k++) {
      const t = k / SR;
      const env = t < attack ? Math.sin((t / attack) * Math.PI / 2) ** 2 : t < dur ? 1 : Math.max(0, 1 - (t - dur) / release) ** 2;
      if (env <= 0 && t > dur) break;
      const fc = cutoff + (cutoffEnd - cutoff) * Math.min(1, t / Math.max(dur, 0.001));
      let l = 0, r = 0;
      for (const v of voices) {
        const s = 2 * v.ph - 1 - blep(v.ph, v.dt);
        v.ph += v.dt;
        if (v.ph >= 1) v.ph -= 1;
        const [gl, gr] = pan(v.p);
        l += s * gl;
        r += s * gr;
      }
      l = f[0].lp(l, fc, q) * env * vol / notes.length ** 0.5;
      r = f[1].lp(r, fc, q) * env * vol / notes.length ** 0.5;
      ctx.dry.add(i0 + k, l, r);
      ctx.rev.add(i0 + k, l * rev, r * rev);
    }
  });
}

/** Karplus-Strong plucked string. */
export function pluck(ctx, t, n, { vol = 0.2, decay = 0.996, dur = 1.8, p = 0, tone = 5000, rev = 0.25, dly = 0.2 } = {}) {
  const N = Math.max(2, Math.round(SR / midi(n)));
  const buf = new Float32Array(N);
  const f = new SVF();
  for (let k = 0; k < N; k++) buf[k] = f.lp(ctx.rng() * 2 - 1, tone);
  const i0 = Math.round(t * SR);
  let idx = 0;
  for (let k = 0; k < dur * SR; k++) {
    const y = buf[idx];
    const nx = idx + 1 === N ? 0 : idx + 1;
    buf[idx] = (buf[idx] + buf[nx]) * 0.5 * decay;
    idx = nx;
    const fade = k > (dur - 0.05) * SR ? (dur * SR - k) / (0.05 * SR) : 1;
    out(ctx, i0 + k, y * vol * fade, p, rev, dly);
  }
}

/** A Rhodes-like electric piano note (two-operator FM). */
export function ep(ctx, t, n, { vol = 0.16, dur = 2.4, p = 0, rev = 0.3, dly = 0.12 } = {}) {
  const f = midi(n);
  const i0 = Math.round(t * SR);
  let pc = 0, pm = 0, pt = 0;
  for (let k = 0; k < dur * SR; k++) {
    const tt = k / SR;
    const env = Math.min(1, tt / 0.004) * Math.exp(-tt * 1.5) * (tt > dur - 0.08 ? (dur - tt) / 0.08 : 1);
    const idx = 1.3 * Math.exp(-tt * 3);
    const m = Math.sin(2 * Math.PI * pm) * idx;
    const tine = Math.sin(2 * Math.PI * pt) * 0.06 * Math.exp(-tt * 40);
    const y = (Math.sin(2 * Math.PI * pc + m) + tine) * env * vol;
    pc += f / SR; pm += f / SR; pt += (f * 14) / SR;
    out(ctx, i0 + k, y, p, rev, dly);
  }
}

/** An FM bell. */
export function bell(ctx, t, n, { vol = 0.12, dur = 2.4, ratio = 3.5, index = 2.2, p = 0, rev = 0.45, dly = 0 } = {}) {
  const f = midi(n);
  const i0 = Math.round(t * SR);
  let pc = 0, pm = 0;
  for (let k = 0; k < dur * SR; k++) {
    const tt = k / SR;
    const env = Math.min(1, tt / 0.002) * Math.exp((-tt * 4.5) / dur);
    const m = Math.sin(2 * Math.PI * pm) * index * Math.exp(-tt * 5);
    const y = Math.sin(2 * Math.PI * pc + m) * env * vol * (tt > dur - 0.05 ? (dur - tt) / 0.05 : 1);
    pc += f / SR; pm += (f * ratio) / SR;
    out(ctx, i0 + k, y, p, rev, dly);
  }
}

export function bass(ctx, t, dur, n, { vol = 0.22, cutoff = 300, saw = 0.4 } = {}) {
  const f = midi(n);
  const i0 = Math.round(t * SR);
  const flt = new SVF();
  let ph = 0;
  const len = (dur + 0.08) * SR;
  for (let k = 0; k < len; k++) {
    const tt = k / SR;
    const env = Math.min(1, tt / 0.008) * (tt < dur ? 1 : Math.max(0, 1 - (tt - dur) / 0.08));
    const s = Math.sin(2 * Math.PI * ph) + saw * (2 * ph - 1 - blep(ph, f / SR));
    ph += f / SR;
    if (ph >= 1) ph -= 1;
    out(ctx, i0 + k, flt.lp(s, cutoff, 0.8) * env * vol, 0);
  }
}

export function kick(ctx, t, { vol = 0.7, decay = 6.5, click = 0.25 } = {}) {
  const i0 = Math.round(t * SR);
  let ph = 0;
  for (let k = 0; k < 0.6 * SR; k++) {
    const tt = k / SR;
    const f = 44 + 115 * Math.exp(-tt * 30);
    ph += f / SR;
    const y = Math.sin(2 * Math.PI * ph) * Math.exp(-tt * decay) + (ctx.rng() * 2 - 1) * click * Math.exp(-tt * 350);
    out(ctx, i0 + k, y * vol, 0);
  }
}

export function clap(ctx, t, { vol = 0.3, p = 0, rev = 0.18, tone = 1500 } = {}) {
  const i0 = Math.round(t * SR);
  const f = new SVF();
  for (let k = 0; k < 0.35 * SR; k++) {
    const tt = k / SR;
    let env = Math.exp(-Math.max(0, tt - 0.022) * 16) * 0.8;
    for (const o of [0, 0.011, 0.022]) if (tt >= o && tt < o + 0.012) env = Math.max(env, Math.exp(-(tt - o) * 140));
    out(ctx, i0 + k, f.bpf(ctx.rng() * 2 - 1, tone, 1.1) * env * vol * 2.2, p, rev);
  }
}

export function hat(ctx, t, { vol = 0.06, open = false, p = 0.25 } = {}) {
  const i0 = Math.round(t * SR);
  const f = new SVF();
  const d = open ? 11 : 55;
  for (let k = 0; k < (open ? 0.35 : 0.09) * SR; k++) {
    const tt = k / SR;
    out(ctx, i0 + k, f.hpf(ctx.rng() * 2 - 1, 7500) * Math.exp(-tt * d) * vol, p, 0.05);
  }
}

export function shaker(ctx, t, { vol = 0.035, p = 0.35 } = {}) {
  const i0 = Math.round(t * SR);
  const f = new SVF();
  for (let k = 0; k < 0.09 * SR; k++) {
    const tt = k / SR;
    const env = Math.sin(Math.min(1, tt / 0.09) * Math.PI) ** 2;
    out(ctx, i0 + k, f.hpf(ctx.rng() * 2 - 1, 5200) * env * vol, p, 0.05);
  }
}

/** Filtered-noise air movement, sweeping f0 → f1 → f0 while panning across. */
export function whoosh(ctx, t, dur, { vol = 0.18, f0 = 350, f1 = 2600, p0 = -0.6, p1 = 0.6, rev = 0.3, q = 1.4 } = {}) {
  const i0 = Math.round(t * SR);
  const f = new SVF();
  for (let k = 0; k < dur * SR; k++) {
    const x = k / (dur * SR);
    const env = Math.sin(x * Math.PI) ** 2;
    const fc = f0 * (f1 / f0) ** Math.sin(x * Math.PI);
    out(ctx, i0 + k, f.bpf(ctx.rng() * 2 - 1, fc, q) * env * vol * 2.5, p0 + (p1 - p0) * x, rev);
  }
}

export function riser(ctx, t, dur, { vol = 0.16, n = 57, rev = 0.35 } = {}) {
  const i0 = Math.round(t * SR);
  const f = new SVF();
  const g = new SVF();
  let ph = 0;
  for (let k = 0; k < dur * SR; k++) {
    const x = k / (dur * SR);
    const env = x ** 2.2;
    const noise = f.bpf(ctx.rng() * 2 - 1, 400 * (7000 / 400) ** x, 1.2) * 2;
    const fr = midi(n + 12 * x);
    ph += fr / SR;
    if (ph >= 1) ph -= 1;
    const saw = g.lp(2 * ph - 1, 800 + 5000 * x, 1.5) * 0.35;
    out(ctx, i0 + k, (noise + saw) * env * vol, Math.sin(x * 9) * 0.3, rev);
  }
}

export function impact(ctx, t, { vol = 0.85, rev = 0.7 } = {}) {
  const i0 = Math.round(t * SR);
  const f = new SVF();
  let ph = 0;
  for (let k = 0; k < 2.4 * SR; k++) {
    const tt = k / SR;
    ph += (32 + 40 * Math.exp(-tt * 5)) / SR;
    const boom = Math.sin(2 * Math.PI * ph) * Math.exp(-tt * 1.6);
    const crack = f.lp(ctx.rng() * 2 - 1, 1400 * Math.exp(-tt * 3) + 200) * Math.exp(-tt * 7) * 0.9;
    out(ctx, i0 + k, (boom + crack) * vol, 0, rev);
  }
}

/** A finger tap on glass. */
export function tap(ctx, t, { vol = 0.16, p = 0.2 } = {}) {
  const i0 = Math.round(t * SR);
  const f = new SVF();
  let ph = 0;
  for (let k = 0; k < 0.08 * SR; k++) {
    const tt = k / SR;
    ph += (1700 - 600 * tt / 0.08) / SR;
    const y = Math.sin(2 * Math.PI * ph) * Math.exp(-tt * 70) * 0.6 + f.hpf(ctx.rng() * 2 - 1, 3500) * Math.exp(-tt * 500) * 0.5;
    out(ctx, i0 + k, y * vol, p, 0.08);
  }
}

/** A mouse click. */
export function click(ctx, t, { vol = 0.14, p = -0.2 } = {}) {
  const i0 = Math.round(t * SR);
  const f = new SVF();
  for (let k = 0; k < 0.05 * SR; k++) {
    const tt = k / SR;
    const y = f.bpf(ctx.rng() * 2 - 1, 2600, 2) * (Math.exp(-tt * 600) + 0.5 * Math.exp(-Math.max(0, tt - 0.03) * 700) * (tt > 0.03 ? 1 : 0));
    out(ctx, i0 + k, y * vol * 3, p, 0.04);
  }
}

/** A soft key click (typing). */
export function tick(ctx, t, { vol = 0.05, p = 0.25 } = {}) {
  const i0 = Math.round(t * SR);
  const f = new SVF();
  const tone = 2600 + ctx.rng() * 1400;
  for (let k = 0; k < 0.025 * SR; k++) {
    const tt = k / SR;
    out(ctx, i0 + k, f.bpf(ctx.rng() * 2 - 1, tone, 1.6) * Math.exp(-tt * 380) * vol * 3, p, 0.04);
  }
}

export function chime(ctx, t, { vol = 0.13, p = 0.25 } = {}) {
  bell(ctx, t, 88, { vol, dur: 1.6, ratio: 2, index: 1.1, p, rev: 0.35 });
  bell(ctx, t + 0.13, 95, { vol: vol * 0.85, dur: 1.9, ratio: 2, index: 1.1, p, rev: 0.4 });
}

export function ding(ctx, t, { vol = 0.12, p = 0 } = {}) {
  bell(ctx, t, 81, { vol, dur: 1.4, ratio: 3, index: 1.2, p, rev: 0.4 });
  bell(ctx, t + 0.09, 88, { vol: vol * 0.9, dur: 1.9, ratio: 3, index: 1.2, p, rev: 0.45 });
}

/** A phone buzzing on a table. */
export function buzz(ctx, t, { vol = 0.05, p = 0.25 } = {}) {
  const i0 = Math.round(t * SR);
  const f = new SVF();
  let ph = 0;
  for (let k = 0; k < 0.42 * SR; k++) {
    const tt = k / SR;
    const on = (tt % 0.14) < 0.085 ? 1 : 0;
    ph += 175 / SR;
    const sq = Math.sign(Math.sin(2 * Math.PI * ph));
    out(ctx, i0 + k, f.lp(sq * on, 700) * vol, p);
  }
}

export function pop(ctx, t, { vol = 0.12, p = 0, from = 900, to = 520 } = {}) {
  const i0 = Math.round(t * SR);
  let ph = 0;
  for (let k = 0; k < 0.09 * SR; k++) {
    const tt = k / SR;
    ph += (to + (from - to) * Math.exp(-tt * 45)) / SR;
    out(ctx, i0 + k, Math.sin(2 * Math.PI * ph) * Math.min(1, tt / 0.002) * Math.exp(-tt * 42) * vol, p, 0.15);
  }
}

/** A quick rising sweep — something travelling from the phone to the PC. */
export function blip(ctx, t, { vol = 0.07, dur = 0.3, from = 500, to = 2600, p0 = 0.5, p1 = -0.5 } = {}) {
  const i0 = Math.round(t * SR);
  let ph = 0;
  for (let k = 0; k < dur * SR; k++) {
    const x = k / (dur * SR);
    ph += (from * (to / from) ** x) / SR;
    const env = Math.sin(x * Math.PI);
    out(ctx, i0 + k, Math.sin(2 * Math.PI * ph) * env * vol, p0 + (p1 - p0) * x, 0.3, 0.3);
  }
}

/** A short, bright chord stab. */
export function stab(ctx, t, notes, { vol = 0.12, cutoff = 2400, decay = 7, rev = 0.3 } = {}) {
  const i0 = Math.round(t * SR);
  for (const [ni, n] of notes.entries()) {
    const f = new SVF();
    const dt = midi(n) / SR;
    let ph = ctx.rng();
    for (let k = 0; k < 0.5 * SR; k++) {
      const tt = k / SR;
      const s = 2 * ph - 1 - blep(ph, dt);
      ph += dt;
      if (ph >= 1) ph -= 1;
      out(ctx, i0 + k, f.lp(s, cutoff * Math.exp(-tt * 3) + 300, 0.9) * Math.exp(-tt * decay) * vol / notes.length ** 0.5, (ni / Math.max(1, notes.length - 1) - 0.5) * 0.8, rev);
    }
  }
}

export function tom(ctx, t, { vol = 0.4, n = 45 } = {}) {
  const i0 = Math.round(t * SR);
  let ph = 0;
  for (let k = 0; k < 0.5 * SR; k++) {
    const tt = k / SR;
    ph += (midi(n) * (1 + 0.6 * Math.exp(-tt * 25))) / SR;
    out(ctx, i0 + k, Math.sin(2 * Math.PI * ph) * Math.exp(-tt * 8) * vol, 0, 0.2);
  }
}
