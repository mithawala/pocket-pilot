// Writes the procedural soundtracks to assets/audio/<name>.wav (48 kHz, 16-bit stereo),
// mixed to -16 LUFS with a -1.5 dBFS peak ceiling and faded out with the picture.
//   node marketing/video/tools/soundtrack.mjs [walk-away] [kinetic] [in-sync]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bus, SR, mulberry32, reverb, delay, highpass, lufs, limit, writeWav } from './audio/dsp.mjs';
import * as I from './audio/instruments.mjs';
import { SCORES } from './audio/scores.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DURATION = 40;
const TARGET = -16;
const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SCORES);

for (const name of names) {
  const spec = SCORES[name];
  if (!spec) throw new Error(`No score called ${name}`);
  const started = performance.now();
  const seed = [...name].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7);
  const ctx = { dry: new Bus(DURATION), rev: new Bus(DURATION), dly: new Bus(DURATION), rng: mulberry32(seed) };
  spec.score(ctx, I);

  const master = new Bus(DURATION);
  master.mix(ctx.dry);
  const echoes = delay(ctx.dly, spec.delay);
  master.mix(echoes, 0.7);
  ctx.rev.mix(echoes, 0.3);
  master.mix(reverb(ctx.rev, spec.reverb), spec.wet);
  highpass(master, 28);

  // Fade in over the first frames, out with the picture's fade to black (39.4 – 40 s).
  const fadeIn = Math.round(0.02 * SR);
  const fadeOutFrom = Math.round(39.35 * SR);
  for (let i = 0; i < master.n; i++) {
    let g = 1;
    if (i < fadeIn) g = i / fadeIn;
    if (i >= fadeOutFrom) g = Math.max(0, Math.cos(((i - fadeOutFrom) / (master.n - fadeOutFrom)) * Math.PI / 2));
    master.L[i] *= g;
    master.R[i] *= g;
  }

  const gain = 10 ** ((TARGET - lufs(master)) / 20);
  for (let i = 0; i < master.n; i++) {
    master.L[i] *= gain;
    master.R[i] *= gain;
  }
  limit(master, 10 ** (-1.5 / 20));
  let peak = 0;
  for (let i = 0; i < master.n; i++) peak = Math.max(peak, Math.abs(master.L[i]), Math.abs(master.R[i]));
  const file = path.join(root, 'assets', 'audio', `${name}.wav`);
  writeWav(file, master);
  console.log(`${name}: ${lufs(master).toFixed(1)} LUFS, peak ${(20 * Math.log10(peak)).toFixed(1)} dBFS, gain ${(20 * Math.log10(gain)).toFixed(1)} dB, ${((performance.now() - started) / 1000).toFixed(1)} s -> assets/audio/${name}.wav`);
}
