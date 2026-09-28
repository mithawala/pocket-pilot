# Changelog

## 0.2.0

- **GitHub Copilot app & CLI plugin.** Pocket Pilot now also works with the GitHub Copilot desktop app and the Copilot CLI: `copilot plugin marketplace add mithawala/pocket-pilot`, `copilot plugin install pocket-pilot@pocket-pilot`, then `/pocket-pilot` in a chat. The phone sees every chat with its full history and live replies, and can chat, queue and steer, approve or deny tool calls, answer questions, approve plans, switch model, mode and approvals, stop the agent and send files — with the same end-to-end encryption, quick tunnel, pairing approval, passkeys, push notifications and encrypted auto-reconnect as the VS Code extension. The plugin's extension runs in each session; one session hosts a hub that translates the runtime's events into the Agent Host Protocol. Pairing opens a local page with the QR code, approvals and paired phones (with Remove). `node scripts/e2e-copilot.mjs` tests it end to end against the real Copilot runtime.
- **Group sessions by folder.** The sessions list has Recent and Folders tabs; Folders groups sessions under their project folder like VS Code's Agents window, with collapsible headers, needs-input / working badges and `+added −removed` line counts on each session (also shown in Recent).
- The phone app knows whether a PC runs VS Code or the GitHub Copilot app, and words its hints accordingly; pairing screens now cover both.
- Messages that mentioned VS Code during pairing now say "on your PC".
- The relay answers malformed request targets with `400 Bad Request` instead of throwing.

## 0.1.0

- First release: VS Code extension (relay, Cloudflare quick tunnel, session monitor, Web Push, encrypted gist rendezvous, sidebar with QR pairing and device management) and the Pocket Pilot PWA (sessions, live chat, tool approvals, questions, new sessions, attachments, notifications, passkeys).
- Model picker with each model's own options (thinking level, context size), per session and for new sessions; mode (Interactive / Plan / Autopilot) and approval switches.
- Product page at https://mithawala.github.io/pocket-pilot/ with a live demo (`/app/?demo`); the phone app moved to `/app/`.
- VS Code look and feel: Atom One Dark theme by default (One Light and System optional), VS Code-style chat input (text on top; attach, mode, model and approvals pickers underneath; send/stop at the right), agent-sessions list with status icons and time groups, compact tool progress rows, VS Code confirmation buttons, question cards with options, syntax highlighting (highlight.js) for code blocks and file previews.
- The chat input is pinned to the bottom of the screen and stays above the on-screen keyboard (visual viewport sizing); the conversation follows new output unless you scroll up.
- Desktop layout: on wide windows the sessions list is a VS Code-style sidebar and the chat fills the main area; pickers and dialogs open as centred quick picks, and the chat input is focused when a session opens.
- The extension page and Marketplace listing render the README correctly: images are PNG/JPEG with absolute URLs (the packager rewrites relative links like `vsce`), and the text diagram is now an image. Marked as Preview, with gallery banner colours.
- New icon: the visor bot climbing out of a jeans pocket (app, Home Screen, maskable and favicon variants, notification badge, Marketplace icon, sidebar logo and a matching outline glyph for the activity bar). `scripts/make-icons.mjs` renders every size from one SVG design with headless Edge/Chrome.
- Product page and README: FAQ entry and a side-by-side comparison with Copilot's built-in remote control (`/remote`), with sources.
