// Encodes the renders for the web: H.264 (High, yuv420p, faststart) + AAC, plus a poster frame,
// into site/video/. Needs ffmpeg on PATH (or FFMPEG=<path to ffmpeg>).
//   node marketing/video/tools/encode.mjs [walk-away] [kinetic] [in-sync] [kinetic-sync] [--wav]
// --wav takes the sound from assets/audio/<name>.wav instead of the render. Each film's only audio
// is that soundtrack (full length, volume 1), so it's the same mix, and a changed soundtrack doesn't
// need a new render of the picture.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(root, '..', '..', 'site', 'video');
const ffmpeg = process.env.FFMPEG || 'ffmpeg';
// The frame each poster shows: the moment that says the most about the video.
const POSTER = { 'walk-away': 18.9, kinetic: 11.3, 'in-sync': 12.9, 'kinetic-sync': 17.8 };
const args = process.argv.slice(2);
const fromWav = args.includes('--wav');
const names = args.filter((a) => !a.startsWith('--')).length ? args.filter((a) => !a.startsWith('--')) : Object.keys(POSTER);

fs.mkdirSync(out, { recursive: true });
for (const name of names) {
  const src = path.join(root, 'renders', `${name}.mp4`);
  if (!fs.existsSync(src)) throw new Error(`Render ${name} first: renders/${name}.mp4 is missing`);
  const wav = path.join(root, 'assets', 'audio', `${name}.wav`);
  if (fromWav && !fs.existsSync(wav)) throw new Error(`--wav: assets/audio/${name}.wav is missing (run tools/soundtrack.mjs)`);
  const mp4 = path.join(out, `pocket-pilot-${name}.mp4`);
  const jpg = path.join(out, `pocket-pilot-${name}.jpg`);
  const inputs = fromWav ? ['-i', src, '-i', wav, '-map', '0:v:0', '-map', '1:a:0', '-shortest'] : ['-i', src];
  execFileSync(ffmpeg, ['-v', 'error', '-y', ...inputs, '-c:v', 'libx264', '-preset', 'slow', '-crf', '24', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-c:a', 'aac', '-b:a', '128k', mp4], { stdio: 'inherit' });
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-ss', String(POSTER[name]), '-i', src, '-frames:v', '1', '-vf', 'scale=1280:-2', '-q:v', '4', jpg], { stdio: 'inherit' });
  const mb = (f) => (fs.statSync(f).size / 1e6).toFixed(1);
  console.log(`${name}: ${mb(mp4)} MB video, ${mb(jpg)} MB poster -> site/video/`);
}
