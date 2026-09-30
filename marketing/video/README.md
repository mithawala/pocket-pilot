# Product videos

The sources of the product videos in [`site/video/`](../../site/video/) (review page:
<https://mithawala.github.io/pocket-pilot/video/>). They're HTML + [GSAP](https://gsap.com), rendered
frame by frame to MP4 with [HyperFrames](https://github.com/heygen-com/hyperframes). What each film is
for and how it's put together: [`BRIEF.md`](BRIEF.md) and [`STORYBOARD.md`](STORYBOARD.md).

| Composition | Length | Idea |
|---|---|---|
| `compositions/walk-away.html` | 40 s | A story: the agent waits for an approval while you're away; you give it from your phone. |
| `compositions/kinetic.html` | 40 s | Beat-synced type: the hook, the name, ten features, trust and price. |
| `compositions/in-sync.html` | 40 s | A calm demo: phone and PC in sync, then set-up in three steps. |
| `compositions/kinetic-sync.html` | 60 s | B and C combined: B's type and beat, C's typing demo and set-up. |

A, B and C are single files. D (`kinetic-sync`) is modular: the root holds only the background, five
scene hosts and the music, and each scene is a sub-composition in `compositions/kinetic-sync/` with its
own timeline starting at 0. The phone leaves the typing scene exactly where the feature scene starts,
so the cut between them doesn't move it.

The phone and VS Code screens are the real app: `tools/capture-ui.mjs` drives the demo mode of the
phone app in a headless browser and saves each screen's DOM to `assets/ui/fragments.js` (with its CSS
scoped to `.pp-app` in `assets/ui/app.scoped.css`). `assets/lib/` holds the shared parts — iPhone,
VS Code window, lock screen, keyboard, taps, kinetic type — and the soundtracks come from a small
synthesizer (`tools/soundtrack.mjs`, no third-party audio), cued to the same times as the pictures.
Captured and rebuilt interfaces carry `data-layout-ignore`, so `hyperframes check` audits the film's
own type and layout, not the app's.

## Build

Node 20+, ffmpeg and the HyperFrames CLI (`npm i -g hyperframes`), from this folder:

```sh
node tools/capture-ui.mjs            # only when the app's UI changed (also saves renders/ui-real/*.png)
node tools/check-screens.mjs         # fails if the videos' CSS reaches into the app screens, or they mention Claude
node tools/check-ui.mjs              # renders/ui-check.png: each screen as the videos show it, next to the real app
node tools/soundtrack.mjs            # assets/audio/*.wav (generated, not committed)
node tools/select.mjs kinetic-sync   # copies a composition to index.html for lint / check / snapshot / preview
hyperframes check .
hyperframes snapshot . --at 5,15,25,40,55
hyperframes render . -o renders/kinetic-sync.mp4 --quality delivery   # index.html; D needs this form
hyperframes render . -c compositions/walk-away.html -o renders/walk-away.mp4 --quality delivery
node tools/encode.mjs kinetic-sync   # -> site/video/pocket-pilot-kinetic-sync.mp4 + poster
node tools/encode.mjs kinetic-sync --wav   # the same, with the sound taken from assets/audio (no re-render for a new mix)
```

For the single-file films, `node tools/probe.mjs <name> --at 1,2.5,9 --sheet` renders a quick contact
sheet in Edge or Chrome, and `--verify` checks that the timeline gives the same picture whatever order
frames are rendered in (HyperFrames renders with several workers that each seek on their own). The
probe doesn't mount sub-compositions; use `hyperframes snapshot` for D.

## Rules for the app screens

- They must look exactly like the app, in its own font. The videos' own class names never match the
  app's (the phone parts are `dev-*`, the pills `vchip`); a rule meant for the app says `.pp-app` in its
  selector. `tools/check-screens.mjs` enforces both.
- The videos don't mention Claude: the capture runs the chats on GPT-5.6 Sol, picked in the app's own
  model picker, and fails if a screen still mentions Claude.

## Rules for the timelines

- Every element's state at time 0 comes from CSS (or `PP.words()`, which hides the words it wraps).
- `PP.timeline()` sets `immediateRender: false`: tweens never apply ahead of their start, so each
  `fromTo` must give explicit end values for everything it sets.
- No `Date.now()`, unseeded randomness or infinite repeats: use `PP.rng(seed)`.
- In a sub-composition, query inside the scene's root and prefix ids with the scene (`#ks-sync-…`):
  every scene shares one page when it renders.
