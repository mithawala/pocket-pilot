# Changelog

## 0.1.0

- First release: VS Code extension (relay, Cloudflare quick tunnel, session monitor, Web Push, encrypted gist rendezvous, sidebar with QR pairing and device management) and the Pocket Pilot PWA (sessions, live chat, tool approvals, questions, new sessions, attachments, notifications, passkeys).
- Model picker with each model's own options (thinking level, context size), per session and for new sessions; mode (Interactive / Plan / Autopilot) and approval switches.
- Product page at https://mithawala.github.io/pocket-pilot/ with a live demo (`/app/?demo`); the phone app moved to `/app/`.
- VS Code look and feel: Atom One Dark theme by default (One Light and System optional), VS Code-style chat input (text on top; attach, mode, model and approvals pickers underneath; send/stop at the right), agent-sessions list with status icons and time groups, compact tool progress rows, VS Code confirmation buttons, question cards with options, syntax highlighting (highlight.js) for code blocks and file previews.
- The chat input is pinned to the bottom of the screen and stays above the on-screen keyboard (visual viewport sizing); the conversation follows new output unless you scroll up.
- Desktop layout: on wide windows the sessions list is a VS Code-style sidebar and the chat fills the main area; pickers and dialogs open as centred quick picks, and the chat input is focused when a session opens.
- The extension page and Marketplace listing render the README correctly: images are PNG/JPEG with absolute URLs (the packager rewrites relative links like `vsce`), and the text diagram is now an image. Marked as Preview, with gallery banner colours.
- New icon: the visor bot climbing out of a jeans pocket (app, Home Screen, maskable and favicon variants, notification badge, Marketplace icon, sidebar logo and a matching outline glyph for the activity bar). `scripts/make-icons.mjs` renders every size from one SVG design with headless Edge/Chrome.
