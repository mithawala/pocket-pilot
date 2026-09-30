---
workflow: general-video
flow: automation
storyboard: no
message: "Your coding agents keep working when you walk away — Pocket Pilot puts the same live sessions on your phone, set up in a minute, private and free."
destination: the product page (mithawala.github.io/pocket-pilot): D right under the hero, A–C under More videos
aspect: "16:9"
language: en
audience: developers who run GitHub Copilot agent sessions in VS Code or the GitHub Copilot app
length: about 60s
---

## Intent

Product videos for the Pocket Pilot landing page. Three 40-second cuts came first (2026-09-30):
A "Walk away" (cinematic story), B "Kinetic" (beat-synced type) and C "In sync" (calm demo and set-up).

### 2026-09-30 — D "Kinetic + In sync" (new version; A–C stay)

The user loved B and C and asked for a new version that combines both "in a nice way"; longer is
fine. From C, keep **the keyboard typing** (typed on the phone, it lands on the PC) and **the
onboarding** (install, scan the QR code, allow on the PC, Face ID). Post it on the same /video page.

## Customizations

- B's energy and type (120 BPM, beat slams) carries the film; C's typing demo and set-up steps are
  restyled into it.
- 2026-09-30: "No cloud copy" is removed from every video (A's chip, B's slam, C's tile) and is not in D.
- 2026-09-30: "No accounts" is removed too, because it creates confusion (you still use your Copilot).
  B and D go straight from "Passkey protected." to "FREE.", which holds two beats.
- 2026-09-30: the videos don't mention Claude. Captions say Copilot only (end cards: "Your coding agents,
  in your pocket."; C's tile: "Free / Works with the Copilot you already have."), and the app screens
  run on GPT-5.6 Sol: tools/capture-ui.mjs picks it in the app's own model picker and fails if a screen
  still mentions Claude.
- 2026-09-30: the phone and VS Code screens must look exactly like the app: tools/check-screens.mjs fails
  if any of the videos' own CSS reaches into them, and tools/check-ui.mjs shows each one next to the real
  app. The app keeps its own font there.

## Notes

- The phone and VS Code screens are the real app, captured from its demo mode
  (`tools/capture-ui.mjs`); never approximate them.
- Soundtracks come from `tools/soundtrack.mjs` (no third-party audio).
