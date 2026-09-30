---
format: 1920x1080
duration: 60s
message: "Your coding agents keep working when you walk away — Pocket Pilot puts the same live sessions on your phone, set up in a minute, private and free."
arc: Hook → Name → Demo (in sync) → Features → Set-up → Trust → CTA
audience: developers who run GitHub Copilot or Claude agent sessions
mode: autonomous
---

# D — Kinetic + In sync (2026-09-30)

One 120 BPM grid (a beat is 0.5 s, a bar 2 s) for picture and sound. Root: `compositions/kinetic-sync.html`
(background, five scene hosts, music). Every scene is a sub-composition in `compositions/kinetic-sync/`.

## Frame 1 — Hook and name

- scene: YOUR / AI AGENT / NEEDS / YOU. — a notification slams in — "Away from your desk? Answer from your phone." — the logo and "Pocket Pilot"
- duration: 10s
- transition_in: cut
- status: animated
- src: compositions/kinetic-sync/hook.html
- blueprint: kinetic-type-beats → logo-assemble-lockup
- rules: kinetic-beat-slam, spring-pop-entrance

B's opening, unchanged: the problem in four slams, the notification, the promise, the name.

## Frame 2 — In sync

- scene: VS Code and the phone side by side; the phone's keyboard types a steering message, it lands in VS Code at once, and the answer streams to both
- duration: 10s
- transition_in: cut
- status: animated
- src: compositions/kinetic-sync/sync.html
- blueprint: prompt-type-submit-generate, panel-edit-live-sync
- rules: kinetic-beat-slam, cursor-click-ripple

C's typing demo with B's type: "TYPE ON / YOUR PHONE." → "IT'S ON YOUR PC. / INSTANTLY." → "SAME CHAT. / LIVE ON BOTH."
The phone ends on the features' first pose, so the cut to Frame 3 doesn't move it.

## Frame 3 — Everything else, from your phone

- scene: one feature per bar, the phone swapping sides — approve, answer, switch models, start new work, see screenshots, every session, full history, get notified
- duration: 16s
- transition_in: cut (the phone holds its pose)
- status: animated
- src: compositions/kinetic-sync/features.html
- blueprint: device-surface-showcase (cursorless stepwise flow)
- rules: kinetic-beat-slam, cursor-click-ripple

B's feature run minus steer and live (Frame 2 showed them): eight features, "01 / 08".

## Frame 4 — Works with, and set up in a minute

- scene: WORKS WITH VS Code · GitHub Copilot app · Copilot CLI — then 1 install, 2 scan the QR code, 3 allow it on your PC, then Face ID
- duration: 14s
- transition_in: cut
- status: animated
- src: compositions/kinetic-sync/setup.html
- blueprint: fixed-anchor-cycle → cursor-ui-demo, device-surface-showcase
- rules: kinetic-beat-slam, cursor-click-ripple

C's onboarding in B's type: the Marketplace card and a click on Install, the phone scanning the QR code
in the Pocket Pilot panel, the Allow dialog on the PC, the passkey sheet and Face ID, then the session list.

## Frame 5 — Private, free, and the name

- scene: END-TO-END ENCRYPTED. PASSKEY PROTECTED. FREE. — the logo, the name, the address
- duration: 10s
- transition_in: cut
- status: animated
- src: compositions/kinetic-sync/close.html
- blueprint: kinetic-type-beats → logo-assemble-lockup
- rules: kinetic-beat-slam, spring-pop-entrance

B's close without "No cloud copy" and "No accounts" (2026-09-30): "FREE." holds two beats. The end card holds the address for five seconds, then fades.
