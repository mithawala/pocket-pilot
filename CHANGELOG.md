# Changelog

## 0.6.1

- **A passkey that stopped working no longer locks a device out.** If the passkey was saved in an app you have since turned off or removed (Microsoft Authenticator, 1Password…), the phone can't find it anymore and used to stay stuck until you paired it again. Now *Confirm it's you* explains what happened and offers **Set up this device again**: click **Allow** on your PC, then save a new passkey or use an authenticator app. The device stays paired. The code prompt offers the same when the authenticator app is gone. Setting up again always needs a yes on the PC, even when pairing doesn't.
- **Face ID after a tap when the browser needs one.** iPhones before iOS 17.4 only show the passkey sheet right after a tap, so the automatic Face ID prompt could fail without a word. The app now falls back to a **Use Face ID or fingerprint** button, and to **Save a passkey** while pairing.
- **Chrome and Edge on iPhone.** Edge on iPhone was taken for Safari; the app now names the browser correctly in its advice and in your list of paired devices. Home Screen apps added from Chrome or Edge work like ones added from Safari, and the product page and README say so.

## 0.6.0

- **Authenticator apps as an alternative to passkeys.** A device can now confirm it's you with 6-digit codes from Google Authenticator, Microsoft Authenticator, the Passwords app, 1Password or any other authenticator app, instead of Face ID or a fingerprint. Pick it when pairing (*No Face ID or passkey? Use an authenticator app*), or when saving the passkey fails. The phone makes the setup key and sends it end-to-end encrypted; add it to your app by link, QR code or by hand, and enter a code to confirm. Your PC then asks for a code every 12 hours by default. A code works only once, and wrong codes lock the device for 15 minutes, doubling up to a day. The setting *Pocket Pilot › Security: Authenticator App* turns it off (passkeys only). The GitHub Copilot app plugin supports it too.
- **When a passkey can't be saved, pairing keeps going.** Microsoft Authenticator only keeps passkeys for Microsoft work and school accounts, and Google Authenticator keeps none, so picking one of them made pairing fail and used up the QR code. Now the app explains what happened and where passkeys can go (the Passwords app, Google Password Manager, 1Password, Bitwarden), and offers **Try again** in the same pairing or **Use an authenticator app instead**. If a pairing does fail, the app says whether a new QR code is needed and opens the scanner.
- **Easier to find in VS Code.** The extension page starts with an **Open Pocket Pilot in VS Code** button (through a small page on the product site, because extension pages only allow web links) and shows where the robot icon sits in the Activity Bar. The Pocket Pilot panel also opens by itself the first time the extension runs.

## 0.5.1

- **The "Get notified" card can be closed.** The card at the top of the sessions list (in a phone browser it explains the Home Screen app, elsewhere it offers *Enable notifications*) now has a close button, for everyone happy to use Pocket Pilot in the browser. Once closed it stays hidden on that device, and Settings still has notifications.

## 0.5.0

- **New license: PolyForm Shield 1.0.0.** Pocket Pilot stays free for everyone, including at work, and its source code stays public on GitHub to read, audit and improve. What changes: nobody may offer a product that competes with it, such as a copy, a rebrand or a paid version. The product page now says *source-available* instead of *open source*. Versions up to 0.4.3 remain under the MIT License.
- **The app keeps its full height on iPhone.** After the on-screen keyboard closed, iOS sometimes didn't tell the page, which left the chat and the input box high on the screen with an empty band below until a reload. The app now takes the whole screen whenever nothing is being typed, and measures again when focus moves, the app comes back from the background or Safari restores the page. Editing a queued message no longer zooms the page in.
- **"Waiting for you" only while the agent really waits for you.**
  - While a request is open (an approval, a question, or an MCP server that needs a sign-in on your PC), the chat no longer shows *Working…* under it. The sign-in card names the server and says what to do: *Sign in to github-mcp-server on your PC. The agent is paused until you do.*
  - The latest signal wins: once the agent writes or thinks again after a request, or tools of the same MCP server run again after a sign-in, the request counts as done even if the PC never said so. The banner, the *Needs you* label and the card go away.
- **iPhone and iPad: add Pocket Pilot to the Home Screen before pairing.** iOS keeps the Home Screen app apart from Safari, so a pairing made in Safari didn't carry over to the app added afterwards. A pairing link (or the app) opened in Safari now starts with *Add Pocket Pilot to your Home Screen first* and three steps; pairing in Safari is still possible. The Home Screen app explains how to pair it if you paired in Safari first, and your PC lists the two apart (*iPhone (Safari)* and *iPhone · Home Screen app*). The Pocket Pilot panels, the product page and the README say to add the app to the Home Screen first.

## 0.4.3

- **Pairing steps talk about your device, not an iPhone.** The Pocket Pilot panel in VS Code and in the GitHub Copilot app now reads *On your device, open mithawala.github.io/pocket-pilot/app — add it to your Home Screen first to get notifications*, and you confirm *with Face ID, your fingerprint or Windows Hello*. On an iPhone, the app itself still shows the exact *Share → Add to Home Screen* steps.

## 0.4.2

- **The Pocket Pilot panel tells you where the app is**, in VS Code and in the GitHub Copilot app. Pairing is now three numbered steps: open **mithawala.github.io/pocket-pilot/app** on your device (with a tip to add it to the iPhone Home Screen first), scan the QR code in the app or with the camera, and click **Allow** on the PC.
- **Open in browser** (formerly *Open app here*) opens the app in this PC's browser with a one-time pairing link, so a computer pairs like any other device (you approve it in VS Code). Pairing links that a browser or VS Code percent-encoded (`#pair%3D…`) now work too.
- **App settings:** *Developed by Asif Mithawala* and a link to the product page and help; the note about removing a device now points to the Pocket Pilot panel in VS Code or the GitHub Copilot app.
- **Product page:**
  - a **Try the live demo** button in the hero;
  - VS Code and the GitHub Copilot app are equal choices all the way down (menu, final buttons, comparison and FAQ answers);
  - a friendlier security headline (*Private by design*);
  - the FAQ in two columns;
  - no pricing section (Pocket Pilot is free and open source, as the page already says);
  - *Developed by Asif Mithawala* in the footer.

## 0.4.1

- **The tunnel keeps its address when VS Code restarts.** `cloudflared` now keeps running when a window reloads, VS Code quits or another window takes over, and the next start listens on the same local port, so the address stays the same and paired devices reconnect within seconds. It changes only after a reboot, **New tunnel** or **Stop** (Stop ends it). The panel shows the tunnel as *Online ✓* instead of its address, which is only the PC's end of the connection: devices always open the app at `mithawala.github.io/pocket-pilot/app/`.
- **One auto-reconnect gist for all your PCs.** Instead of a gist per PC, one secret gist (*Pocket Pilot · encrypted addresses of your PCs*) holds a small encrypted file per PC; each PC only writes its own file, so two PCs never overwrite each other. A PC's old gist is deleted once every paired device has learned the new place, and resetting a PC's identity removes its file. The test tools never publish to your GitHub account any more.
- **Pairing links always open the hosted app.** An old *Pwa Url* setting pointing at the product page made the extension believe the app wasn't published and serve it through the tunnel instead (with the warning *"re-pair after VS Code restarts"*). The product page's address, and one without a trailing slash, now mean the app, and the hosted app is never replaced by the tunnel copy.

## 0.4.0

- **GitHub Copilot app: closing or deleting a chat no longer matters.** Remote access used to live in the chat you ran `/pocket-pilot` in: when that chat closed, another chat took over with a *new* tunnel address, so phones without auto-reconnect lost the PC. Now the Cloudflare tunnel runs on its own and the chat that takes over listens on the same local port, so the address stays the same and devices reconnect by themselves within seconds (tested end to end: the chat is deleted, another chat takes over, the phone reconnects without pairing again). It also survives app restarts. `/pocket-pilot off` (or **Turn off** in the panel) ends the tunnel, even when no chat is open.
- **Pocket Pilot panel in the GitHub Copilot app.** `/pocket-pilot` opens the pairing page as a panel (canvas) next to the chat — QR code, pending approvals, paired devices with **Remove**, and a new **Turn off remote access** button — instead of a browser tab. The CLI still opens the browser and prints the QR code.
- **Why the plugin couldn't be uninstalled or updated, and what to do.** On Windows, VS Code's agent host watches every installed Copilot plugin's folder while it runs, and the Copilot CLI and app move a plugin's folder to update or uninstall it, which Windows then refuses (*Access is denied, os error 5*) — for any plugin, not just Pocket Pilot. Quit VS Code and the app first; the README, the product page and the `/pocket-pilot` update note say so. Pocket Pilot's own processes (its extension, the hub and `cloudflared`) never keep one of the plugin's folders in use.
- **Queued and steering messages** show in full (wrapped, clamped to three lines with *Show all*), and like in VS Code you can **Edit** them in place (tap the text), **Send Immediately** or **Remove** them.
- **Paste screenshots**: Ctrl+V / ⌘V of an image in the chat input attaches it (as *Pasted image*), and files dropped on the input are attached too.
- **Working sessions no longer show "Error"** in the app even with an older PC extension: the app corrects the status of sessions it has open itself (the 0.3 extension already corrects every session on the PC).
- **Product page:** the GitHub Copilot app is a first-class choice — two equal *Get it for* cards in the hero, a hero that switches between VS Code and the Copilot app (with the new panel), *Get started* tabs for VS Code and the Copilot app, and FAQ answers about closing chats, the *Extensions* listing and uninstalling.
- `scripts/publish.ps1 -SiteOnly` publishes just the product page and the app.

## 0.3.0

- **Model, thinking level and context size stay in sync with the PC — both ways.** The phone's selection is the chat's shared draft (`chat/draftChanged`), the same state VS Code's model picker uses: pick a model on the phone and VS Code's picker follows; change it in VS Code and the phone follows. With the GitHub Copilot app plugin the phone switches the runtime's model (the app's picker follows) and model changes made in the app show on the phone. The list of models always comes live from the PC (VS Code's agent host, or the Copilot runtime).
- **Fewer failed model switches.** The phone no longer asks for a different model than the one the PC is on, which could make the agent host switch models (and time out: "session.setModel timed out"). Failed turns now offer **Try again**.
- **Model picker like VS Code's.** Tapping a model selects it right away; a separate chip (e.g. "Max 1M") holds the model's thinking level and context size, with the defaults marked and a note that changing them mid-session resets the prompt cache. Mode and tool approvals moved under the input box, like VS Code ("Interactive · Manual permissions").
- **Steer by default, queue on demand.** While the agent works, Send (Enter) steers it; the ▾ menu next to Send offers **Add to Queue** (Alt+Enter) and **Stop and Send** — the same choices as VS Code. Stop and Send works like VS Code's: it stops the agent, then sends your message as a new turn (VS Code's agent host doesn't start queued messages after a stop).
- **Dictation.** A microphone button in the input uses your browser's speech recognition (Chrome, Edge, Safari). Sending while it listens no longer puts the words back into the input.
- **Correct session status.** A session that is working no longer shows "Error" because an older sub-agent failed: the extension reports the main chat's real state to the phone (and uses it for notifications, so "finished" notifications arrive again for such sessions).
- **No more GitHub sign-in prompts.** Pocket Pilot no longer pushes a GitHub token to VS Code's agent host. The agent host's sign-in is shared by every client, so a token from Pocket Pilot (another account, say) replaced VS Code's own and VS Code then asked you to sign in to GitHub again. VS Code keeps the agent host signed in by itself; starting remote access no longer asks for your GitHub account at all (only the optional auto-reconnect gist does). The live test no longer injects a test token into the running VS Code either.
- **Pair any device.** "Pair another device" and "Paired devices": tablets and other computers pair like phones (scan the QR code, or open the copied pairing link on a computer), and computers show a 💻 icon.
- **Every VS Code window shows remote access.** Windows that don't run Pocket Pilot mirror the one that does — QR code, tunnel, sessions, paired devices — and their buttons (new code, new tunnel, stop, auto-reconnect) act on it. A device's pairing request is shown in the window you're using. Stopping in any window stops it everywhere (it no longer restarts in another window), and **Move it to this window** hands over directly, so no third window can grab it in between.
- **Updates.** Installs from a VSIX (which VS Code never updates) check GitHub for new releases and offer a one-click **Update**; *Pocket Pilot: Check for Updates* checks on demand. Marketplace installs are updated by VS Code. The Copilot app plugin tells you in `/pocket-pilot` when `copilot plugin update pocket-pilot@pocket-pilot` has a newer version.
- Agent replies show the Pocket Pilot robot. Favicons and icons are versioned so browsers pick up new icons. The publisher is Asif Mithawala.
- Copilot app plugin: the models get the same thinking level, context size and Auto "Optimize for" options as in VS Code (also for the chat you ran `/pocket-pilot` in); steering messages from the app or the phone stay in the running turn.

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
