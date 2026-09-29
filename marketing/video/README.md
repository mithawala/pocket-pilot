# Product videos

The sources of the 40-second product videos in [`site/video/`](../../site/video/) (review page:
<https://mithawala.github.io/pocket-pilot/video/>). They're HTML + [GSAP](https://gsap.com), rendered
frame by frame to MP4 with [HyperFrames](https://github.com/heygen-com/hyperframes).

| Composition | Idea |
|---|---|
| `compositions/walk-away.html` | A story: the agent waits for an approval while you're away; you give it from your phone. |
| `compositions/kinetic.html` | Beat-synced type: the hook, the name, ten features, trust and price. |
| `compositions/in-sync.html` | A calm demo: phone and PC in sync, then set-up in three steps. |

The phone and VS Code screens are the real app: `tools/capture-ui.mjs` drives the demo mode of the
phone app in a headless browser and saves each screen's DOM to `assets/ui/fragments.js` (with its CSS
scoped to `.pp-app` in `assets/ui/app.scoped.css`). `assets/lib/` holds the shared parts — iPhone,
VS Code window, lock screen, keyboard, taps — and the soundtracks come from a small synthesizer
(`tools/soundtrack.mjs`, no third-party audio), cued to the same times as the pictures.

## Build

Node 20+, ffmpeg and the HyperFrames CLI (`npm i -g hyperframes`), from this folder:

```sh
node tools/capture-ui.mjs          # only when the app's UI changed
node tools/soundtrack.mjs          # assets/audio/*.wav (generated, not committed)
node tools/select.mjs walk-away    # copies a composition to index.html for lint / snapshot / preview
hyperframes lint .
hyperframes preview .
hyperframes render . -c compositions/walk-away.html -o renders/walk-away.mp4 --quality delivery
node tools/encode.mjs walk-away    # -> site/video/pocket-pilot-walk-away.mp4 + poster
```

`node tools/probe.mjs <name> --at 1,2.5,9 --sheet` renders a quick contact sheet in Edge or Chrome,
and `--verify` checks that the timeline gives the same picture whatever order frames are rendered
in (HyperFrames renders with several workers that each seek on their own).

## Rules for the timelines

- Every element's state at time 0 comes from CSS (or `PP.words()`, which hides the words it wraps).
- `PP.timeline()` sets `immediateRender: false`: tweens never apply ahead of their start, so each
  `fromTo` must give explicit end values for everything it sets.
- No `Date.now()`, unseeded randomness or infinite repeats: use `PP.rng(seed)`.
