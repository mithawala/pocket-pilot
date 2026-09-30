# Changelog

## 0.7.5

- **The chat bar sits at the bottom of the iPhone app.** The band under it came from how the app was drawn: under a translucent status bar, with `viewport-fit=cover`. Since iOS 26.5, a Home Screen web app gets a view as tall as the screen minus the status bar (WebKit bug 301994). Drawn under a translucent status bar, that view starts at the top of the screen and stops a status bar's height short of the bottom. The app now uses an opaque status bar and no `viewport-fit=cover`, so its view starts below the status bar and reaches the bottom of the screen. iOS then keeps it clear of the home indicator, and the chat bar sits right above it. The status bar is solid black now instead of showing the app's top bar through it. After the update, close the app in the app switcher and open it again: iOS applies this when it starts the app.
- The screen test page from 0.7.4 is gone; it isn't needed any more.

## 0.7.4

- **Less empty space at the bottom of the iPhone app.** Since iOS 26.5, iOS leaves a strip as tall as the status bar (62pt on recent iPhones) at the bottom of Home Screen web apps. The strip is outside the page, so the app can't draw there (WebKit bug 301994, which Apple confirmed again in the iOS 27 beta). On top of that strip, the app kept 34pt of empty room for the home indicator, which it no longer reaches. It now checks how far down it really reaches and only keeps the room it needs, so the message box sits 34pt lower. While you type, it sits right on the keyboard, without the home indicator's room above it. Rotating the phone to landscape and back is reported to bring the whole screen back until the app is closed.
- The fix from 0.7.0 was for an older bug (iOS 17 and 18, where the app came back short after the keyboard) and never helped with this one. It now only runs when that older bug happens. It also sizes the app by the screen while it measures again, which is what the known workaround for that bug needs.
- A small Home Screen test page, `mithawala.github.io/pocket-pilot/lab/screen/`, shows whether a web app gets the whole screen. It tests whether the app would get the whole screen without its `apple-*` meta tags.

## 0.7.3

- **A long queued message no longer covers the chat on iPhone.** Queued and steering messages now show two lines. On iPhone they showed in full: Safari ignored the app's line limit, so *Show less* made a message longer instead of shorter, and it could fill the whole chat. **Show all** now opens a message in a box that scrolls by itself and takes at most about a quarter of the screen; **Show less** closes it and goes back to the start. The list of waiting messages scrolls too and never takes more than 40% of the screen, so you can always see what the agent is doing. *Show all* appears whenever a message doesn't fit in two lines, and editing one keeps it and its **Save** button in view.
- Only the phone app changed, and it updates by itself. Nothing changed on the PC.

## 0.7.2

- **Start new sessions from your phone with the GitHub Copilot app too.** **New session** now works when your phone is paired with the Copilot app or CLI: pick a folder on your PC (recent ones, or browse), the model, mode and approvals, and say what to do. The app itself only opens a chat from outside after someone clicks *Allow* on the PC, so Pocket Pilot runs these sessions in the background on your PC instead. It uses a Copilot runtime of its own, the same one the app uses, with your sign-in, models, tools and plugins. You follow and control them from your phone like any chat: replies, approvals, questions, model and mode. They keep going when the chat that runs remote access is closed, and come back after an update. They don't open in the app window.
- With an older Pocket Pilot on the PC, the phone still says to start chats in the app, and that updating Pocket Pilot on the PC lets you start them from the phone.

## 0.7.1

- **Auto in the GitHub Copilot app.** The model list on the phone now starts with **Auto** (Optimize for: Efficiency, Balance or Intelligence), like the app and VS Code. Picking it on the phone switches the chat to Auto, and Auto picked in the app shows as *Auto · Balance* instead of a bare "auto".
- **Updating the Copilot app plugin works while VS Code and the app are open.** On Windows the app's **Update** failed with *Failed to install plugin: Access is denied (os error 5)*. That message comes from the app: Windows wouldn't let it move the plugin's folder because VS Code keeps the `skills` folder of every installed Copilot plugin open. Pocket Pilot no longer has a `skills` folder (its `pocket_pilot` tool and `/pocket-pilot` command do the same job), so the app can update it at any time. Updating from 0.7.0 or older still needs VS Code closed once, or that `skills` folder deleted.
- **A new version takes over by itself.** After an update, the next chat running the new version takes remote access over from the old one on the same tunnel address. Paired devices reconnect within seconds, and the app doesn't need a restart.
- **The Pocket Pilot panel says when there's an update** and how to install it, and so does `/pocket-pilot status`.

## 0.7.0

- **Pictures in chats.** Screenshots pasted into a chat on your PC, in VS Code or the GitHub Copilot app, now show in the conversation on your phone, and so do the photos you send from it. Tap one to see it full screen: pinch or double-tap to zoom, swipe to the next one, and swipe down, tap **×** or press Escape to close. Queued and steering messages show their pictures instead of just "2 attachments", and so does a photo waiting to be sent. A picture the agent links to opens as a picture too. The phone needs Pocket Pilot 0.7 on your PC to read a chat's pictures; with an older version it says so.
- **The app fills the screen on iPhone again.** Once the keyboard had been open, iOS could keep a Home Screen app short of the screen, with a dark band at the bottom, until the app was closed. The app now notices and makes iOS measure the screen again, without losing your place in the list.

## 0.6.7

- **Credits for all third-party code.** The new `THIRD-PARTY-NOTICES.md` lists every bundled library with its license, credits the icon sets the app and the product page use (Feather, Lucide and the GitHub mark from Octicons), and includes their license texts. It ships with the extension, the GitHub Copilot app plugin and the product page. The QR code library now comes with its MIT license file too. Pocket Pilot's own license is unchanged.

## 0.6.6

- **The GitHub Copilot app plugin is ready for the Awesome Copilot marketplace** (the one the Copilot app and CLI include by default). Its manifest now marks it as a canvas plugin and points to a preview image (`assets/preview.png`: the Pocket Pilot panel next to the phone app), which the marketplace shows in its canvas gallery. The license is written the way SPDX expects for licenses outside its list (`LicenseRef-PolyForm-Shield-1.0.0`); nothing about the license itself changed.
- **The plugin's README explains the security model and how Pocket Pilot differs from Copilot's built-in `/remote`.**

## 0.6.5

- **Every sheet in the app says how to leave it.** Sheets now have a header with **Done** (or **Cancel** where closing backs out, like *New session*), and it stays in view while the list scrolls. You can also swipe a sheet down to close it, from the handle or the title at any time, or from the list once it's scrolled to the top; a short pull springs back. Tapping outside still works, and Escape now closes only the top sheet when one opens over another (the model list over *New session*). Sheets with a single choice, like the model list, mode and approvals, still close as soon as you pick.

## 0.6.4

- **Turning remote access off and on in the GitHub Copilot app panel.** After **Turn off remote access**, the panel kept showing *Tunnel online*, the code buttons and the same button. The panel now shows the state at the top (*Remote access on* in green, *Remote access off* in grey, like the Pocket Pilot panel in VS Code). When it's off, a card says so and offers **Turn on remote access**, which starts it again right there; the panel stays open and shows the new QR code, and you can still remove paired devices meanwhile. It also follows along when remote access is turned off or on from a chat (`/pocket-pilot off`, `/pocket-pilot`), and moves to another chat's panel when that chat takes over.

## 0.6.3

- **Choose Face ID or an authenticator app before pairing.** The passkey sheet used to open by itself, and on an iPhone it offers every app that is turned on for passwords, Microsoft Authenticator included, which can only keep passkeys for work accounts and then says it failed. Now the pairing screen asks first: **Face ID or fingerprint** (a passkey, with a note to save it in Passwords) or **A code from an authenticator app** (Microsoft Authenticator, Google Authenticator or similar). The authenticator app is set up before the phone connects, so switching apps can't break the pairing.
- **Clear steps for Microsoft and Google Authenticator.** On a phone you now copy the setup key and add it in the app, with the exact steps (Microsoft Authenticator: **+** → **Other (Google, Facebook, etc.)** → **Or enter code manually**). The *Add to authenticator app* button went: on an iPhone every authenticator link opens Apple Passwords, never Microsoft or Google Authenticator. It's still there as *Or use Apple Passwords*. On a computer, the phone's app scans a QR code. If a passkey still fails, **Use an authenticator app** comes first.
- **The phone app switches to new releases by itself.** It used to keep running the release it had loaded until it was fully closed and opened twice, so on iPhones, which keep apps and tabs suspended, fixes could take days to arrive. Now opening the app (a pairing link included) always starts the newest release, and an open app moves to a new release when it comes back to the screen, never in the middle of pairing, a confirmation or a message you are typing. The version shows on the start and pairing screens.
- If your PC runs Pocket Pilot older than 0.6, the app says that authenticator codes need an update on the PC.

## 0.6.2

- **The README shows where Pocket Pilot is instead of a button.** VS Code's extension page only allows web links, so the *Open Pocket Pilot in VS Code* button had to go through a web page and back to VS Code. It's gone, along with that page on the product site. The top of the README now shows the robot icon in the Activity Bar, on the far left of VS Code. The panel still opens by itself right after you install the extension.

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
