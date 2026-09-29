// The three scores. Every cue time below matches an event in the composition of the same name
// (see compositions/*.html), so sound and picture line up frame for frame.
const range = (n) => [...Array(n).keys()];

export function walkAway(c, I) {
  const P = (t, dur, notes, o) => I.pad(c, t, dur, notes, o);
  // 0 – 4.4 · the agent works: warm Dmaj7, a busy little arpeggio
  P(0, 4.6, [50, 57, 61, 66], { vol: 0.075, attack: 1.6, cutoff: 800, cutoffEnd: 1500 });
  const arpA = [74, 69, 78, 73, 76, 69, 81, 73];
  for (const k of range(18)) I.pluck(c, 0.8 + k * 0.2, arpA[k % 8], { vol: 0.07 * Math.min(1, (k + 2) / 6), p: k % 2 ? 0.35 : -0.35, dur: 0.9, decay: 0.993 });
  I.whoosh(c, 0.05, 1.8, { vol: 0.06, f0: 200, f1: 900, rev: 0.4 });
  for (const k of range(4)) I.tick(c, 0.9 + k * 0.28, { vol: 0.07, p: 0.4 });
  // 4.4 – 8.2 · it needs you, and waits
  P(4.4, 3.9, [47, 54, 61, 62], { vol: 0.07, attack: 0.7, cutoff: 1200, cutoffEnd: 800 });
  P(4.4, 3.8, [35, 42], { vol: 0.05, attack: 1.2, cutoff: 380 });
  I.bell(c, 4.35, 81, { vol: 0.08, dur: 1.6, ratio: 2, index: 1 });
  I.bell(c, 4.5, 86, { vol: 0.065, dur: 1.8, ratio: 2, index: 1 });
  I.whoosh(c, 4.5, 1.5, { vol: 0.07, f0: 250, f1: 1200, p0: 0.2, p1: 0.4 });
  for (const k of range(7)) I.pop(c, 5.4 + k * 0.4, k % 2 ? { vol: 0.035, from: 1100, to: 980 } : { vol: 0.045, from: 1500, to: 1350 });
  // 8.2 – 10.6 · not at your desk
  P(8.2, 2.6, [43, 55, 59, 66], { vol: 0.07, attack: 0.9, cutoff: 900 });
  I.whoosh(c, 8.15, 1.6, { vol: 0.16, f0: 300, f1: 1800, p0: 0.3, p1: -0.8 });
  I.whoosh(c, 9.85, 0.9, { vol: 0.12, f0: 500, f1: 3000, p0: 0.6, p1: 0.4 });
  // 10.6 – 16.9 · the phone: a pulse builds
  P(10.6, 3.2, [45, 57, 62, 64], { vol: 0.06, attack: 0.8, cutoff: 1000, cutoffEnd: 1600 });
  P(13.7, 3.3, [45, 57, 61, 64], { vol: 0.065, attack: 0.5, cutoff: 1500, cutoffEnd: 2800 });
  for (const k of range(15)) I.pluck(c, 10.9 + k * 0.4, [69, 76, 81, 76][k % 4], { vol: 0.05, p: 0.3, dur: 1.2 });
  for (const k of range(16)) I.bass(c, 13.7 + k * 0.2, 0.16, 33, { vol: 0.13 + k * 0.006, cutoff: 200 + k * 45 });
  I.chime(c, 11.5);
  I.buzz(c, 11.5);
  I.tap(c, 13.7);
  I.whoosh(c, 14.0, 0.5, { vol: 0.08, f0: 900, f1: 3500 });
  I.riser(c, 15.2, 1.7, { vol: 0.12, n: 57 });
  I.tap(c, 16.3);
  I.blip(c, 16.4, { vol: 0.06, dur: 0.45 });
  I.ding(c, 16.95, { vol: 0.11 });
  // 16.9 – 29.7 · approved, and everything moves: the groove (150 BPM, half time)
  const prog = [[50, 57, 62, 66], [45, 57, 61, 64], [47, 54, 62, 66], [43, 55, 59, 62]];
  const roots = [38, 33, 35, 31];
  for (const bar of range(8)) {
    const t = 16.9 + bar * 1.6;
    const ch = prog[bar % 4];
    P(t, 1.6, ch, { vol: 0.045, attack: 0.04, release: 0.5, cutoff: 2200 });
    I.kick(c, t, { vol: 0.62 });
    I.kick(c, t + 0.8, { vol: 0.5 });
    I.clap(c, t + 0.4, { vol: 0.2 });
    I.clap(c, t + 1.2, { vol: 0.22 });
    for (const e of range(8)) I.hat(c, t + e * 0.2, { vol: e % 2 ? 0.03 : 0.045, open: e === 7 });
    const pat = [0, 0, 12, 0, 0, 0, 12, 7];
    for (const e of range(8)) I.bass(c, t + e * 0.2, 0.16, roots[bar % 4] + pat[e], { vol: 0.19 });
    const arp = [ch[1] + 12, ch[2] + 12, ch[3] + 12, ch[2] + 12, ch[1] + 24, ch[3] + 12, ch[2] + 12, ch[3]];
    for (const e of range(8)) I.pluck(c, t + e * 0.2, arp[e], { vol: 0.05, p: e % 2 ? 0.35 : -0.35, dur: 0.8 });
  }
  I.whoosh(c, 20.45, 0.9, { vol: 0.12, f0: 300, f1: 1600, p0: 0, p1: -0.9 });
  for (const [k, t] of [21.7, 23.3, 24.9, 26.5, 28.1].entries()) I.whoosh(c, t - 0.08, 0.45, { vol: 0.09, f0: 700, f1: 3200, p0: k % 2 ? -0.5 : 0.5, p1: k % 2 ? 0.2 : -0.2 });
  // 29.7 – 34.4 · private by design: a breather
  P(29.6, 1.7, [40, 52, 59, 62, 67], { vol: 0.075, attack: 0.3, cutoff: 1400 });
  P(31.3, 1.6, [43, 55, 62, 67], { vol: 0.075, attack: 0.3, cutoff: 1500 });
  P(32.9, 1.6, [45, 57, 61, 64], { vol: 0.08, attack: 0.3, cutoff: 1700, cutoffEnd: 3000 });
  for (const k of range(11)) I.pluck(c, 29.8 + k * 0.4, [71, 74, 79, 74][k % 4], { vol: 0.055, dur: 1.2 });
  for (const k of range(23)) I.hat(c, 29.7 + k * 0.2, { vol: 0.03 });
  I.whoosh(c, 29.35, 0.9, { vol: 0.08 });
  I.click(c, 30.2, { vol: 0.12, p: 0 });
  for (const t of [30.6, 30.95, 31.3]) I.pop(c, t, { vol: 0.08 });
  I.riser(c, 33.2, 1.3, { vol: 0.13, n: 62 });
  // 34.4 – 40 · the end card
  I.impact(c, 34.5, { vol: 0.75 });
  P(34.5, 4.6, [38, 50, 57, 62, 64, 66], { vol: 0.08, attack: 0.06, release: 1.4, cutoff: 2600, cutoffEnd: 1300 });
  I.bass(c, 34.5, 4.6, 38, { vol: 0.16, cutoff: 220 });
  for (const [k, n] of [86, 90, 93, 98].entries()) I.bell(c, 34.65 + k * 0.17, n, { vol: 0.05, dur: 2.6, ratio: 2, index: 0.9 });
  I.pop(c, 35.9, { vol: 0.05 });
}

export function kinetic(c, I) {
  const B = 0.5;
  const hit = (t, notes, big = false) => {
    I.kick(c, t, { vol: big ? 0.85 : 0.7 });
    I.stab(c, t, notes, { vol: big ? 0.15 : 0.11 });
    I.clap(c, t, { vol: big ? 0.2 : 0.14, rev: 0.25 });
    if (big) I.impact(c, t, { vol: 0.45 });
  };
  // 0 – 2 · YOUR / AI AGENT / NEEDS / YOU.
  hit(0, [57, 60, 64]); hit(0.5, [57, 60, 64]); hit(1.0, [55, 59, 62]); hit(1.5, [53, 57, 60, 65], true);
  I.riser(c, 0.6, 0.9, { vol: 0.07, n: 57 });
  // 2 – 4 · the notification
  I.chime(c, 2.05, { vol: 0.15, p: 0 });
  I.buzz(c, 2.35, { vol: 0.07, p: 0 });
  I.pad(c, 2.0, 2.0, [33, 45], { vol: 0.06, attack: 0.2, release: 0.3, cutoff: 320 });
  I.riser(c, 2.5, 1.5, { vol: 0.09, n: 52 });
  I.pop(c, 3.0, { vol: 0.07 });
  // 4 – 6 · away from your desk? answer from your phone.
  [[57, 60, 64], [57, 60, 64], [53, 57, 60], [55, 59, 62]].forEach((ch, i) => { hit(4 + i * B, ch); I.whoosh(c, 4 + i * B - 0.1, 0.2, { vol: 0.07, f0: 1500, f1: 5000, p0: i % 2 ? 0.6 : -0.6, p1: 0 }); });
  I.riser(c, 5.0, 1.0, { vol: 0.13, n: 57 });
  // 6 – 10 · Pocket Pilot
  I.impact(c, 6.0, { vol: 0.9 });
  I.pad(c, 6.0, 4.0, [45, 52, 59, 60, 64], { vol: 0.065, attack: 0.05, release: 0.6, cutoff: 1100, cutoffEnd: 3400 });
  I.bass(c, 6.0, 3.9, 33, { vol: 0.15, cutoff: 200 });
  I.pop(c, 6.5, { vol: 0.08 }); I.pop(c, 7.0, { vol: 0.08 });
  for (const [k, n] of [76, 81, 84, 88].entries()) I.bell(c, 8.0 + k * 0.12, n, { vol: 0.05, dur: 2, ratio: 2, index: 0.9 });
  const arpA = [69, 72, 76, 79, 83, 79, 76, 72];
  for (const k of range(16)) I.pluck(c, 6.0 + k * 0.25, arpA[k % 8], { vol: 0.05, p: k % 2 ? 0.4 : -0.4, dur: 0.8 });
  for (const k of range(8)) I.hat(c, 8.0 + k * 0.25, { vol: 0.04 });
  I.riser(c, 9.0, 1.0, { vol: 0.13, n: 57 });
  // 10 – 30 · the groove, one feature per bar (120 BPM)
  const prog = [[57, 60, 64, 69], [53, 57, 60, 65], [48, 55, 60, 64], [55, 59, 62, 67]];
  const roots = [33, 29, 36, 31];
  for (const bar of range(10)) {
    const t = 10 + bar * 2;
    const ch = prog[bar % 4];
    I.pad(c, t, 2, ch, { vol: 0.04, attack: 0.02, release: 0.3, cutoff: 2600 });
    for (const b of range(4)) I.kick(c, t + b * B, { vol: 0.62 });
    I.clap(c, t + B, { vol: 0.2 }); I.clap(c, t + 3 * B, { vol: 0.22 });
    for (const s of range(16)) I.hat(c, t + s * 0.125, { vol: s % 4 === 2 ? 0.05 : s % 2 ? 0.022 : 0.034, open: s === 14 });
    const pat = [0, 0, 12, 0, 0, 12, 0, 12];
    for (const e of range(8)) I.bass(c, t + e * 0.25, 0.2, roots[bar % 4] + pat[e], { vol: 0.19 });
    const arp = [ch[0] + 12, ch[1] + 12, ch[2] + 12, ch[3] + 12, ch[2] + 12, ch[1] + 12, ch[3] + 12, ch[2] + 12];
    for (const e of range(8)) I.pluck(c, t + e * 0.25, arp[e], { vol: 0.045, p: e % 2 ? 0.4 : -0.4, dur: 0.7 });
    if (bar > 0) I.whoosh(c, t - 0.25, 0.4, { vol: 0.08, f0: 700, f1: 3800, p0: bar % 2 ? 0.6 : -0.6, p1: bar % 2 ? -0.6 : 0.6 });
    if ([0, 1, 3, 4].includes(bar)) I.tap(c, t + 1.0, { vol: 0.15 });
  }
  I.chime(c, 26.2, { vol: 0.1 }); I.buzz(c, 26.2);
  I.chime(c, 27.0, { vol: 0.09 }); I.buzz(c, 27.0);
  // 30 – 32 · works with
  I.kick(c, 30.0, { vol: 0.75 }); I.stab(c, 30.0, [53, 57, 60, 65], { vol: 0.12 });
  I.pad(c, 30.0, 1.0, [53, 57, 60, 65], { vol: 0.04, attack: 0.02, cutoff: 2000 });
  I.pad(c, 31.0, 1.0, [55, 59, 62, 67], { vol: 0.045, attack: 0.02, cutoff: 2400 });
  for (const t of [30.5, 31.0, 31.5]) { I.tom(c, t, { vol: 0.35, n: 45 + (t - 30.5) * 6 }); I.clap(c, t, { vol: 0.12 }); }
  for (const s of range(16)) I.hat(c, 30 + s * 0.125, { vol: s % 2 ? 0.02 : 0.032 });
  I.riser(c, 31.2, 0.8, { vol: 0.1, n: 57 });
  // 32 – 36 · end-to-end encrypted. passkey protected. no accounts. no cloud copy. FREE.
  const slams = [[57, 60, 64], [57, 60, 64], [53, 57, 60], [53, 57, 60], [55, 59, 62], [55, 59, 62]];
  slams.forEach((ch, i) => hit(32 + i * B, ch));
  for (const e of range(12)) I.bass(c, 32 + e * 0.25, 0.2, 33 + (e % 2 ? 12 : 0), { vol: 0.16 });
  I.riser(c, 34.0, 1.0, { vol: 0.14, n: 60 });
  hit(35.0, [48, 55, 60, 64, 67], true);
  // 36 – 40 · the end card
  I.pad(c, 35.0, 4.4, [36, 48, 55, 60, 62, 64, 67], { vol: 0.075, attack: 0.05, release: 1.2, cutoff: 2600, cutoffEnd: 1200 });
  I.bass(c, 35.0, 4.2, 36, { vol: 0.14, cutoff: 200 });
  I.pop(c, 36.0, { vol: 0.08 });
  for (const [k, n] of [72, 76, 79, 84].entries()) I.bell(c, 36.5 + k * 0.15, n, { vol: 0.05, dur: 2.4, ratio: 2, index: 0.9 });
}

export function inSync(c, I) {
  const chords = [[53, 57, 60, 64], [48, 55, 60, 64], [50, 53, 57, 62], [46, 53, 58, 62]];
  const roots = [41, 36, 38, 34];
  // 0 – 3.8 · the title
  I.pad(c, 0, 4.2, [41, 53, 60, 64, 67], { vol: 0.05, attack: 1.4, cutoff: 900, cutoffEnd: 1600 });
  for (const [k, n] of [72, 76, 79, 84].entries()) I.bell(c, 0.25 + k * 0.32, n, { vol: 0.045, dur: 2.4, ratio: 2, index: 0.8 });
  I.whoosh(c, 3.2, 1.0, { vol: 0.08, f0: 300, f1: 1500 });
  // 3.8 – 33.8 · twelve bars of a light groove (96 BPM)
  const BAR = 2.5;
  const b = BAR / 4;
  for (const bar of range(12)) {
    const t = 3.8 + bar * BAR;
    const ch = chords[bar % 4];
    for (const n of ch) I.ep(c, t, n, { vol: 0.06, dur: 2.4, p: (n - 55) / 20 });
    for (const n of ch.slice(1)) I.ep(c, t + b * 2.5, n + 12, { vol: 0.03, dur: 1.2, p: (n - 55) / 20 });
    I.pad(c, t, BAR, ch, { vol: 0.025, attack: 0.3, release: 0.6, cutoff: 1100 });
    I.bass(c, t, b * 1.8, roots[bar % 4], { vol: 0.16, cutoff: 260 });
    I.bass(c, t + b * 2.5, b * 1.3, roots[bar % 4] + 7, { vol: 0.12, cutoff: 260 });
    const soft = bar >= 5 && bar <= 8 ? 0.8 : 1; // a little quieter under the set-up steps
    I.kick(c, t, { vol: 0.42 * soft, decay: 8 });
    I.kick(c, t + b * 2.5, { vol: 0.3 * soft, decay: 8 });
    I.clap(c, t + b, { vol: 0.09 * soft, tone: 2200 });
    I.clap(c, t + b * 3, { vol: 0.1 * soft, tone: 2200 });
    for (const e of range(8)) I.shaker(c, t + e * (b / 2), { vol: (e % 2 ? 0.02 : 0.03) * soft });
  }
  // the sync demo
  I.whoosh(c, 5.45, 0.4, { vol: 0.05, f0: 800, f1: 2500, p0: 0.4, p1: 0.5 });
  for (const k of range(46)) I.tick(c, 5.95 + k * 0.046, { vol: 0.045, p: 0.45 });
  I.tap(c, 8.35, { vol: 0.12, p: 0.45 });
  I.whoosh(c, 8.35, 0.35, { vol: 0.08, f0: 900, f1: 4200, p0: 0.5, p1: 0.2 });
  I.blip(c, 8.55, { vol: 0.05, dur: 0.35, p0: 0.5, p1: -0.3 });
  I.bell(c, 8.95, 84, { vol: 0.07, dur: 1.4, ratio: 2, index: 0.8, p: -0.3 });
  for (const t of [10.5, 10.75]) I.pop(c, t, { vol: 0.05, p: -0.4 });
  I.tick(c, 10.9, { vol: 0.05, p: 0 });
  I.whoosh(c, 15.45, 0.8, { vol: 0.09, f0: 300, f1: 1500, p0: 0, p1: -0.8 });
  // set up in a minute
  for (const t of [16.2, 19.5, 23.3]) I.pop(c, t, { vol: 0.07, p: -0.5 });
  I.click(c, 17.75);
  I.ding(c, 18.5, { vol: 0.08, p: -0.3 });
  I.whoosh(c, 19.05, 0.5, { vol: 0.06, p0: 0, p1: -0.7 });
  I.tap(c, 20.4, { vol: 0.12, p: 0.45 });
  I.whoosh(c, 20.55, 0.4, { vol: 0.05, f0: 600, f1: 2200, p0: 0.5, p1: 0.5 });
  I.bell(c, 21.95, 91, { vol: 0.06, dur: 0.7, ratio: 1, index: 0.3, p: 0.45 });
  I.bell(c, 22.05, 98, { vol: 0.05, dur: 0.9, ratio: 1, index: 0.3, p: 0.45 });
  I.whoosh(c, 22.85, 0.5, { vol: 0.06, p0: 0, p1: -0.7 });
  I.pop(c, 23.4, { vol: 0.05, from: 700, to: 450, p: -0.3 });
  I.click(c, 24.55);
  I.whoosh(c, 24.75, 0.45, { vol: 0.06, f0: 500, f1: 1800, p0: 0.5, p1: 0.5 });
  I.tap(c, 25.55, { vol: 0.12, p: 0.45 });
  I.ding(c, 26.45, { vol: 0.09, p: 0.4 });
  // notified
  I.whoosh(c, 27.35, 0.8, { vol: 0.08, f0: 400, f1: 1600, p0: 0.6, p1: 0 });
  I.chime(c, 28.5, { vol: 0.12, p: 0 }); I.buzz(c, 28.5, { vol: 0.05, p: 0 });
  I.chime(c, 29.9, { vol: 0.1, p: 0 }); I.buzz(c, 29.9, { vol: 0.05, p: 0 });
  I.whoosh(c, 31.55, 0.7, { vol: 0.08, f0: 300, f1: 1300, p0: 0, p1: 0 });
  // 33.8 – 36 · private by design
  I.pad(c, 33.8, 2.2, [46, 53, 58, 62, 65], { vol: 0.05, attack: 0.3, cutoff: 1300 });
  for (const t of [32.7, 33.0, 33.3]) I.pop(c, t, { vol: 0.06 });
  I.riser(c, 35.0, 1.1, { vol: 0.08, n: 60 });
  // 36 – 40 · the end card
  I.impact(c, 36.1, { vol: 0.45 });
  I.pad(c, 36.1, 3.4, [41, 53, 60, 64, 67, 69], { vol: 0.07, attack: 0.08, release: 1.2, cutoff: 2200, cutoffEnd: 1200 });
  I.bass(c, 36.1, 3.3, 41, { vol: 0.14, cutoff: 220 });
  for (const [k, n] of [77, 81, 84, 89].entries()) I.bell(c, 36.25 + k * 0.17, n, { vol: 0.045, dur: 2.4, ratio: 2, index: 0.8 });
}

export const SCORES = {
  'walk-away': { score: walkAway, delay: { time: 0.3, feedback: 0.35 }, reverb: { room: 0.86, damp: 0.35 }, wet: 1.0 },
  kinetic: { score: kinetic, delay: { time: 0.375, feedback: 0.3 }, reverb: { room: 0.8, damp: 0.4 }, wet: 0.8 },
  'in-sync': { score: inSync, delay: { time: 0.46875, feedback: 0.32 }, reverb: { room: 0.84, damp: 0.4 }, wet: 0.9 },
};
