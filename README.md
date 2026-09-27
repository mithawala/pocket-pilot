# Pocket Pilot

**Your VS Code agents, in your pocket.** Chat with your GitHub Copilot and Claude agent sessions, approve their tool calls and get notified when they need you — from your phone, anywhere. Free, end-to-end encrypted, passkey-protected, no servers.

<p align="center"><img src="media/icon.png" width="96" alt="Pocket Pilot"></p>

- **Same sessions, same history.** The phone app is a real client of VS Code's *Agent Host Protocol*: you see exactly the sessions and full history VS Code shows, live, token by token.
- **Everything you can do at your desk.** Send messages, queue follow-ups, steer a running agent, stop it, approve or skip tool calls (with the same options VS Code offers), answer the agent's questions, change mode / approvals / model, start new sessions in any folder, send photos and files.
- **Push notifications** when an agent needs approval, asks a question, finishes or fails — sent directly from your PC with standard Web Push (no Firebase, no account).
- **Secure by design:** QR pairing with approval in VS Code, per-device keys that can't be exported, Face ID / fingerprint (passkeys), end-to-end encryption through the tunnel, instant revocation.
- **Free:** Cloudflare quick tunnel (no account) + a static PWA on GitHub Pages. Your GitHub token never leaves your PC.

## How it works

```
 Phone (PWA on GitHub Pages)                      Your PC
┌──────────────────────────┐                ┌──────────────────────────────────────────────┐
│ AHP client (official     │   wss, E2E     │ Pocket Pilot extension                       │
│ reducers) + secure       │◄──encrypted───►│  relay ──AHP (named pipe)──► VS Code agent   │
│ channel + passkey        │   via Cloudflare│  ▲ auth tokens injected     host (Copilot CLI,│
│ + Web Push               │   quick tunnel │  │ here, never sent out      Claude sessions)│
└──────────────────────────┘                │  └ monitor ──Web Push──► push service ──► phone│
                                             └──────────────────────────────────────────────┘
```

1. VS Code (1.133+) runs agent sessions in its **agent host** and publishes a local, token-protected endpoint for the [Agent Host Protocol](https://github.com/microsoft/agent-host-protocol) (AHP).
2. The extension runs a small **relay** on `127.0.0.1` and exposes it through a free **Cloudflare quick tunnel** (`cloudflared` is downloaded once from the official GitHub release and checksum-verified).
3. The **PWA** (static, hosted on GitHub Pages) pairs with the relay by scanning a QR code, then speaks AHP to the agent host *inside* an end-to-end encrypted channel. The relay only forwards an allow-listed set of AHP methods and pushes your GitHub token to the agent host itself.
4. The extension's **monitor** watches session status and sends **Web Push** notifications ("needs you", "finished", "error") straight to the browser vendor's push service.
5. Quick-tunnel URLs change when VS Code restarts: the extension keeps the current URL in a **secret GitHub gist, encrypted** with a key only paired phones know, so phones reconnect automatically.

## Security model

| Layer | What it does |
|---|---|
| Pairing | The QR code carries a single-use 128-bit token (expires in 10 min) and the PC's key fingerprint. The token only lives in the URL fragment (never sent to any server) and is removed from the address bar immediately. VS Code asks you to **approve** every new phone. |
| Device identity | Each phone generates an ECDH P-256 key pair; the private key is **non-extractable** (WebCrypto) and stored in IndexedDB. The PC stores only public keys. |
| Handshake | `ECDH(device, PC)` + ephemeral `ECDH` (forward secrecy) + pairing token → HKDF-SHA-256 → per-direction AES-256-GCM keys. Mutual authentication: a party without the right private key cannot produce a single valid frame. The phone pins the PC's key (fingerprint shown during pairing). |
| Transport | Every frame is AES-256-GCM encrypted with a strict sequence number (no replay, reordering or drops). Cloudflare only sees ciphertext. |
| Biometrics | Phones register a **passkey** (Face ID / Touch ID / fingerprint / screen lock) at pairing. The extension verifies WebAuthn assertions itself (ES256/RS256, user-verification required, origin/rpId/challenge/counter checks) and asks again after the grace period (default 12 h). |
| Least privilege | The relay allow-lists AHP methods (no file writes, no terminals, no `authenticate` from the phone); file reads are limited to your session folders. The agent host connection token and your GitHub token never leave the PC. |
| Control | See and remove paired phones in the VS Code sidebar (they're disconnected instantly). *Reset identity* invalidates every pairing. Failed attempts are rate-limited per IP. |
| Push | Web Push payloads are encrypted for the device (RFC 8291) and signed with VAPID (RFC 8292); only real push services are accepted as endpoints. |

## Get started

1. **Install the extension**: `code --install-extension pocket-pilot-0.1.0.vsix` (or *Extensions → … → Install from VSIX*).
2. Open the **Pocket Pilot** view in the activity bar and click **Start remote access**. The first time, VS Code asks to:
   - let Pocket Pilot use your GitHub account (so phone requests are authenticated to the agent host),
   - download `cloudflared` (~55 MB, verified),
   - optionally enable auto-reconnect (secret gist).
3. **Scan the QR code** with your phone's camera. Check that the fingerprint matches, tap **Pair securely**, click **Allow** in VS Code and confirm with Face ID / fingerprint.
4. Tap **Enable notifications**.
   - **iPhone:** notifications require the app on your Home Screen — in Safari tap **Share → Add to Home Screen**, then open Pocket Pilot from there and enable notifications.
   - **Android:** tap **Install** (or Chrome menu → *Add to Home screen*) for an app-like experience; notifications work in the browser too.

The phone app lives at **https://mithawala.github.io/pocket-pilot/**.

## Settings

| Setting | Default | Description |
|---|---|---|
| `pocketPilot.autoStart` | `true` | Start remote access when VS Code starts (after you started it once). |
| `pocketPilot.pwaUrl` | GitHub Pages URL | Where the phone app is hosted (the QR code opens it). |
| `pocketPilot.tunnel.mode` | `quick` | `quick` (Cloudflare, free), `custom` (your own HTTPS URL: named Cloudflare tunnel, dev tunnel, Tailscale Funnel…), `none`. |
| `pocketPilot.tunnel.customUrl` | | Public URL for `custom` mode (set `pocketPilot.port` too). |
| `pocketPilot.security.requireApproval` | `true` | Confirm new phones in VS Code. |
| `pocketPilot.security.passkey` | `required` | `required`, `optional` or `off`. |
| `pocketPilot.security.passkeyGraceHours` | `12` | Re-verify Face ID / fingerprint after this long (0 = every connection). |
| `pocketPilot.security.pairingCodeMinutes` | `10` | QR code lifetime (single use). |
| `pocketPilot.rendezvous.enabled` | `true` | Encrypted secret gist for automatic reconnection. |
| `pocketPilot.notifications.*` | `true` | `inputNeeded`, `finished`, `errors`, `skipWhileActive`. |
| `pocketPilot.uploads.folder` | `.pocket-pilot/uploads` | Where files sent from the phone are saved (git-ignored). |

## FAQ

- **Which sessions show up?** Every session hosted by VS Code's agent host — Copilot CLI and Claude agent sessions, across all VS Code windows. (Classic, non-agent-host chat panel sessions are not part of the protocol.)
- **Does my PC have to stay on?** Yes — VS Code must be running and the PC awake.
- **Tunnel doesn't start on a corporate network?** Quick tunnels need outbound TCP/UDP 7844. Use `tunnel.mode: custom` with a tunnel your network allows.
- **Multiple VS Code windows?** One window hosts the relay; if it closes, another takes over automatically (phones reconnect).
- **Lost phone?** Remove it in the Pocket Pilot panel (instant), or run *Pocket Pilot: Reset Identity*.

## Self-hosting the phone app

The PWA is a static site in [`pwa/`](pwa/) with no build step. `scripts/publish.ps1` creates the repo, publishes `pwa/` to the `gh-pages` branch (`git subtree split --prefix pwa`) and enables GitHub Pages — it only needs the normal `repo` permission. Fork, run it with your account, then set `pocketPilot.pwaUrl` to your URL. Any static host works (the app needs HTTPS for WebCrypto, passkeys and push). Optional GitHub Actions workflows (CI, Pages via Actions) are in [`docs/github-actions/`](docs/github-actions/) — copy them to `.github/workflows/` if your token has the `workflow` scope.

## Development

No npm install is required — everything uses Node built-ins and vendored, hash-pinned browser libraries.

```bash
node scripts/vendor.mjs          # verify (or --update) vendored libs from jsDelivr against scripts/vendor-lock.json
node --test "test/*.test.mjs"    # unit + integration tests (live tests run when a VS Code agent host is found)
node scripts/dev-relay.mjs       # standalone relay + PWA on http://localhost:8787 (prints a pairing link)
node scripts/live-check.mjs      # read-only end-to-end check against your VS Code agent host
node scripts/make-icons.mjs      # regenerate icons
node scripts/package-vsix.mjs    # build pocket-pilot-<version>.vsix
pwsh scripts/publish.ps1         # push to GitHub and (re)publish the phone app on GitHub Pages
```

Project layout: `extension/` (VS Code extension, `core/` is VS Code-independent), `pwa/` (phone app; `pwa/js/core/` is shared with the extension), `media/` (sidebar), `scripts/`, `test/`.

Third-party code: [Agent Host Protocol client](https://github.com/microsoft/agent-host-protocol) (MIT), [Preact](https://preactjs.com) (MIT), [htm](https://github.com/developit/htm) (Apache-2.0), [marked](https://marked.js.org) (MIT), [DOMPurify](https://github.com/cure53/DOMPurify) (Apache-2.0/MPL-2.0), [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) (MIT). Inspired by the idea behind *Copilot Remote Control*; this is an independent implementation.

## License

MIT
