---
title: "How I put my Copilot agents in my pocket: zero servers, end-to-end encryption and one nasty iOS bug"
published: false
description: "Pocket Pilot puts every GitHub Copilot agent session from your PC on your phone. Here's how it's built: no server, end-to-end encryption, passkeys and Web Push."
tags: showdev, githubcopilot, vscode, security
cover_image: https://raw.githubusercontent.com/mithawala/pocket-pilot/main/docs/blog/pocket-pilot-engineering/cover.png
---

You know the moment. You give your Copilot agent a big job ("refactor the auth module and update the tests"), go make a coffee, and come back twenty minutes later to find it has been sitting at **Run in terminal? Allow / Skip** for nineteen of them.

So I built **Pocket Pilot**: every Copilot agent session on my PC, live on my phone. The same history, replies streaming in as they're written, and the same buttons I'd press at my desk. It works with VS Code and with the GitHub Copilot app and CLI, it's free, and there is no server in the middle. Not a cheap one, not a serverless one. None.

![Typing on the phone, and the message lands in the same chat in VS Code](https://raw.githubusercontent.com/mithawala/pocket-pilot/main/docs/blog/pocket-pilot-engineering/hero.gif)

> **Try it in ten seconds:** the [live demo](https://mithawala.github.io/pocket-pilot/app/?demo) runs in your browser. Nothing to install, nothing to pair.

This post is about how it's built: the protocol, the crypto, the push notifications, the zero-dependency rule, and the bugs that tried to stop me.

## ⚡ TL;DR

- **The real protocol, not screen scraping.** The phone app speaks VS Code's Agent Host Protocol, so it sees exactly what VS Code sees.
- **Your PC is the server.** A static web app on GitHub Pages and a free Cloudflare quick tunnel. $0 a month.
- **End-to-end encrypted.** ECDH P-256, HKDF-SHA-256 and AES-256-GCM, bootstrapped by a QR code that pins your PC's key. Cloudflare only ever relays ciphertext.
- **Two locks.** A device key that can't be exported, plus a passkey or an authenticator code, both checked by your PC.
- **Push notifications straight from your PC.** Standard Web Push, no Firebase.
- **Zero npm dependencies**, down to a home-made WebSocket implementation.
- **132 tests**, plus an end-to-end run against the real Copilot runtime.

## 📱 What it does

![Four real Pocket Pilot screens: sessions sorted by what needs you, a tool approval, a question from the agent, and steering a running agent](https://raw.githubusercontent.com/mithawala/pocket-pilot/main/docs/blog/pocket-pilot-engineering/screens-v2.png)

- **Every session, sorted by what needs you.** Anything waiting for your approval or your answer comes first.
- **The whole conversation**, streaming token by token: thinking, tool calls, code, and even the screenshots you pasted on your PC.
- **Everything you'd do at your desk.** Reply, steer a running agent or queue a message, approve or skip tool calls, answer questions, switch the model (with its thinking level and context size), the mode and the approvals, stop the agent, or start a new session in any folder on your PC.
- **Push notifications** when an agent needs you, finishes or fails.

## 🧭 Rule #1: no server

I set myself one rule before writing any code: **no backend.** Your code and your agent sessions shouldn't pass through someone else's database, and a side project shouldn't come with a hosting bill.

That one rule creates every interesting problem in this project:

| Problem | Answer |
|---|---|
| Who is the server? | Your PC. |
| How does a phone reach a PC behind a router? | A free Cloudflare quick tunnel. `cloudflared` connects out, so no ports are opened. |
| How do I trust a tunnel I don't control? | End-to-end encryption. The tunnel only sees noise. |
| Who sends the push notifications? | Your PC, with standard Web Push. |
| The tunnel address changes after a reboot. Now what? | An encrypted note in a secret gist on your own GitHub account. |

![Architecture: the phone talks to a relay on the PC through a Cloudflare quick tunnel, end-to-end encrypted, and the relay talks to VS Code's agent host and to the GitHub Copilot app](https://raw.githubusercontent.com/mithawala/pocket-pilot/main/docs/blog/pocket-pilot-engineering/architecture-v2.png)

## 🔌 Speak the protocol, don't scrape the UI

VS Code runs agent sessions in a separate **agent host** process, and since 1.133 it publishes a local, token-protected endpoint that speaks the [Agent Host Protocol](https://github.com/microsoft/agent-host-protocol) (AHP): JSON-RPC for sessions, turns, tool calls and approvals, plus a stream of state actions.

Pocket Pilot's phone app is a real AHP client. It even runs Microsoft's own client library (`@microsoft/agent-host-protocol`, MIT-licensed), unchanged. So "the same history as VS Code" isn't an approximation: the phone mirrors the same state VS Code renders, as it changes.

On the PC, the extension connects to the agent host over a named pipe (or a unix socket), and the connection token never leaves the machine. The phone never gets that raw access. Every call it makes goes through an allow-list:

```js
// JSON-RPC methods a phone may send to the agent host. Everything else is refused by the relay.
const ALLOWED_REQUESTS = new Set([
  'initialize', 'reconnect', 'ping', 'subscribe', 'listSessions', 'createSession', 'disposeSession',
  'createChat', 'fetchTurns', 'completions', 'resolveSessionConfig', 'sessionConfigCompletions',
  'resourceList', 'resourceResolve', 'resourceRead',
]);
const ALLOWED_NOTIFICATIONS = new Set(['unsubscribe', 'dispatchAction']);
```

No terminals, no file writes, and `resourceRead` only works inside your session folders.

### The GitHub Copilot app has no agent host, so I wrote one

The GitHub Copilot desktop app and the Copilot CLI run their chats in the Copilot runtime instead. Pocket Pilot plugs in as a plugin whose extension runs in every chat, and the plugin implements **an AHP server**: it translates the runtime's events into AHP actions and keeps its state with the official AHP reducers. The phone can't tell a Copilot app chat from a VS Code session.

Every chat gets its own extension process, though. So who's in charge?

- The first one to take a lock file hosts the **hub**: the relay, the tunnel, pairing and push. The others attach to it over an authenticated channel on `127.0.0.1`.
- Close the chat that hosts the hub, and another one takes over on the same local port, behind the same tunnel. Phones simply reconnect.
- A newer plugin version asks the old hub to step down, so an update applies without restarting the app.
- Sessions you start *from your phone* run in a Copilot runtime of their own on your PC, started through the official Copilot SDK with your sign-in, models, tools and plugins. They run in the background and don't open in the app's window.

![Pairing from the Pocket Pilot panel in VS Code and in the GitHub Copilot app](https://raw.githubusercontent.com/mithawala/pocket-pilot/main/docs/blog/pocket-pilot-engineering/panels-v2.png)

## 🔐 Security: assume the URL leaks

A quick tunnel address is a random `https://….trycloudflare.com` URL, and I treat it as public. So the goal was simple: **knowing the URL must get you nothing, and the network in the middle must learn nothing.**

### The QR code carries the trust

![Anatomy of the pairing link inside the QR code](https://raw.githubusercontent.com/mithawala/pocket-pilot/main/docs/blog/pocket-pilot-engineering/qr-v2.png)

Everything after the `#` is a URL fragment, which browsers never send to any server, not even to GitHub Pages, where the app lives. The app reads it and wipes it from the address bar. It holds the tunnel address, a single-use 128-bit token that expires after 10 minutes, and the fingerprint of the PC's public key.

### One handshake, two runtimes

The same file, `secure-channel.js`, runs in the phone's browser and in Node inside VS Code. It uses nothing but WebCrypto, so there's no crypto library to trust, and its header comment is the whole protocol:

```js
// Handshake (text frames, JSON):
//   C -> S  hello     {t:'hello', v:1, mode:'pair'|'resume', dk, ek, n, tid?, caps}
//   S -> C  challenge {t:'challenge', v:1, hk, ek, n, caps}
// Both sides then derive:
//   ss  = ECDH(device static, host static)      -- mutual authentication
//   ee  = ECDH(client ephemeral, server ephemeral) -- forward secrecy
//   psk = SHA-256('pp-psk1' || pairingToken)     -- only in 'pair' mode (one-time QR token)
//   th  = SHA-256(helloText || '\n' || challengeText)
//   okm = HKDF-SHA-256(ss || ee || psk, salt = th, info = 'pocket-pilot/v1/<mode>', 64)
//   c2s = okm[0..32), s2c = okm[32..64)
// Every later frame is binary: seq(8, BE) || AES-256-GCM(key, iv = 0^4 || seq, plaintext, aad).
// Frames must arrive with strictly increasing seq (no replay, no reordering, no drops).
```

In plain words:

- **`ss`** proves that both sides hold their long-term private keys. The phone's key is created as a non-extractable WebCrypto key and kept in IndexedDB, so not even the app's own JavaScript can read it out. In VS Code, the PC's keys live in VS Code's secret storage, which uses the OS keychain.
- **`ee`** comes from throwaway keys, so a recording of today's traffic stays useless even if a long-term key leaks tomorrow.
- **`psk`** proves the device really scanned the QR code.
- **`th`** binds everything to this exact handshake.

After that, every frame is AES-256-GCM with a strictly increasing sequence number. Large messages are compressed with `CompressionStream('deflate-raw')` and split into 256 KB frames.

My favourite detail: when an *unknown* device connects, the PC still completes the key agreement before it says no, so that the rejection itself is encrypted. A plaintext "go away" could be forged by anyone on the path.

### Two locks on the door

Getting through the tunnel isn't enough. Every device needs:

1. **Its device key**, proven by the handshake above.
2. **A human**: a **passkey** (Face ID, a fingerprint, Windows Hello) or a 6-digit code from an **authenticator app**.

Pairing a new device also takes a click on **Allow** on the PC.

The extension verifies passkeys itself, in about 130 lines of WebAuthn: ES256 or RS256 signatures, user verification required, the origin, the RP ID hash, a fresh challenge every time, and a signature counter that catches cloned authenticators. Authenticator codes follow RFC 6238. Each code works once, a connection gets five tries, and ten wrong codes lock the device for 15 minutes, doubling up to a day. Devices are asked again after 12 hours (in VS Code you can set that down to every connection), and eight failed attempts from one IP address within 10 minutes block it for 10 minutes.

One rule I'm strict about: if a device lost its passkey, setting up a new one takes a click on Allow on the PC. In the words of a code comment, *"the device key alone must never be enough to get past the second factor."*

| If someone has… | They get… |
|---|---|
| Your tunnel URL | Nothing: no device key, no channel. Repeated tries get their IP address blocked. |
| A photo of your QR code | A pairing request that you have to allow on your PC, if the code is unused and less than 10 minutes old. |
| A recording of your traffic | Ciphertext. Forward secrecy keeps it that way. |
| Your unlocked phone | Access, if your last passkey check was less than 12 hours ago. Remove the device in the panel and it's cut off at once. |

## 🔔 Push notifications without Firebase

Only your PC knows when an agent needs you, so your PC sends the notification. Web Push is an open standard: the extension signs a VAPID token (RFC 8292), encrypts the payload (RFC 8291) and POSTs it straight to the browser vendor's push service: Apple, Google, Mozilla or Microsoft. It's about a hundred lines on top of Node's `crypto`, with no SDK.

A push subscription is just a URL, and a malicious one could make your PC send requests anywhere. So an endpoint has to belong to one of those four push services, or it's ignored.

Behind it, the extension runs an AHP client of its own that watches every session and turns status changes (*needs you*, *finished*, *failed*) into notifications. On iPhone, web push needs the app on the Home Screen (iOS 16.4 or later), which is also why the app stays a proper PWA.

## 📍 When the address changes: a dead drop in a secret gist

A quick tunnel keeps its address while `cloudflared` runs, even across VS Code restarts. After a reboot, though, you get a new random URL, and your phone has no idea where your PC went.

The answer is a dead drop. Each PC writes its current address into **one secret gist on your own GitHub account**: one small file per PC, encrypted with a key only that PC's paired devices have. Phones read it without signing in to anything, decrypt it and reconnect by themselves. It's optional, and it's the only part of Pocket Pilot that uses your GitHub account.

## 📦 Zero dependencies (yes, including the WebSocket)

`package.json` has no `dependencies`. None.

- **The phone app** is plain ES modules with no bundler: [Preact](https://preactjs.com) and [htm](https://github.com/developit/htm), [marked](https://marked.js.org) and [DOMPurify](https://github.com/cure53/DOMPurify) for Markdown, highlight.js, jsQR and a QR code generator. Each file is vendored and pinned by its SHA-256 in a lock file that a script verifies.
- **The extension** brings its own RFC 6455 WebSocket client and server (about 300 lines, over TCP, named pipes and unix sockets), its own Web Push, WebAuthn and TOTP, and the shared secure channel.
- **`cloudflared`** is downloaded once from Cloudflare's official GitHub release and checked against the SHA-256 digest GitHub publishes for it.

Why go to that trouble? This code holds the keys to your coding agents, and every dependency is someone else's code running with those keys. Everything that touches them is code you can read.

## 🐛 War stories

### 1. The 62-point hole at the bottom of my iPhone

On my iPhone, the chat bar floated above a black band at the bottom of the Home Screen app. I measured insets, wrote a JavaScript guard for it and shipped a release. The band stayed, because it wasn't part of the page at all.

![WebKit bug 301994: before and after](https://raw.githubusercontent.com/mithawala/pocket-pilot/main/docs/blog/pocket-pilot-engineering/ios-v2.png)

It's [WebKit bug 301994](https://bugs.webkit.org/show_bug.cgi?id=301994). Since iOS 26.5, a Home Screen web app gets a view as tall as the screen *minus the status bar*. With the classic full-screen setup, a `black-translucent` status bar and `viewport-fit=cover`, that shorter view is pinned to the top of the screen, so it stops 62 points short of the bottom. Apple has reproduced it in the iOS 27 beta.

The fix was to stop fighting it: an opaque status bar and no `viewport-fit=cover`. The view now starts below the status bar and reaches the bottom of the screen. The price is a solid black status bar, and a regression test pins those two meta tags so nobody "fixes" them back.

### 2. "Show less" made the message longer

Queued messages are clamped to two lines, with a *Show all* toggle. On iPhone, Safari ignored the line clamp on them, so pressing *Show less* made a message longer instead of shorter, and one long queued message could cover the whole chat. Now an expanded message gets its own scroll box of about a quarter of the screen, and the queue never takes more than 40% of it.

### 3. Windows wouldn't let me update my own plugin

This one took three fixes.

1. **The bug.** Clicking *Update* in the GitHub Copilot app failed with *Access is denied (os error 5)*. Sysinternals Handle showed why: VS Code keeps the `skills/` folder of every installed Copilot plugin open, so Windows wouldn't let the app move the plugin's folder.
2. **Fix 1: no `skills/` folder.** Updates worked again, but `/pocket-pilot` vanished from the slash menu. A new chat's menu lists skills, while a plugin's own commands only appear once it has loaded in that chat.
3. **Fix 2: write the skill to the user's own skills folder** (`~/.copilot/skills/pocket-pilot`), with a marker line, so Pocket Pilot keeps its own file up to date but never touches one you've edited. `/pocket-pilot` was back… and said *"Skill /pocket-pilot is not ready to run."*
4. **Fix 3.** The app only runs skills and built-in commands from its menu, and Pocket Pilot also registered a command with the same name, which hid the skill. Now the skill owns `/pocket-pilot`.

Every fix pushed the bug one layer up, and every layer now has a test.

## 🧪 Testing against the real thing

There are 132 tests, run with Node's built-in `node:test`, so there's no test framework either. The one I trust most is the end-to-end test. It starts the **real Copilot runtime** with the plugin and a small real model, then plays the phone by running the phone app's own modules in Node, which the shared crypto makes possible. An excerpt from a real run:

```text
  14.2s  hub running (pid 20360)
  14.4s  phone sees "Reply with just the word ready." in pp-e2e-ws-jFGAKg · models: 29
  32.5s  phone shows approval: "Run command?" ["Allow once","Deny"]
  32.5s  phone approved
  36.0s  (the harness UI never answered: the phone did)
  51.0s  PC picture on the phone: screenshot.png (image/png, 70 bytes read through the relay)
  66.8s  session started on the phone: fe76eb43 in pp-e2e-ws-jFGAKg answered "Reply with just the word fresh." -> fresh (15.8s)
  77.1s  phone shows question: "Which do you prefer for indentation: Tabs or Spaces?" ["Tabs","Spaces"]
  79.8s  mode switched from the phone: interactive -> plan -> interactive
 144.5s  deleted the chat that started remote access: chat 73f01e53 took over (hub 20360 -> 45084, same port 63066); the phone reconnected in 13.6s without pairing again
 150.2s  plugin updated while running: the newer version took over (hub 45084 -> 25972, same port) and the phone followed in 5.7s
 168.4s  E2E OK
```

## 🎬 Even the launch video is code

The product video on the [Pocket Pilot page](https://mithawala.github.io/pocket-pilot/) is HTML and GSAP, rendered frame by frame to MP4 with [HyperFrames](https://github.com/heygen-com/hyperframes). The phones in it show the real app, not a mock-up. That gave me one more bug: the video kit had a `.screen` class, and so does the app, so the video painted the app's screen black. A check script now fails if any of the video's styles reach the app.

## 🤔 Pocket Pilot or `/remote`?

GitHub Copilot has its own remote control: `/remote on` streams a Copilot CLI session to GitHub.com and GitHub Mobile. It's official and supported, and if your organization turns it on, it's a great option. Pocket Pilot makes different trade-offs:

- **Straight to your PC**, end-to-end encrypted, with no copy of your sessions in a cloud.
- **Every session shows up**, without turning it on session by session.
- **New sessions start on your own PC**, rather than as cloud agents.
- **One app for VS Code's agent sessions and the GitHub Copilot app.**

They work side by side. There's a [full comparison](https://mithawala.github.io/pocket-pilot/#compare) on the product page.

## 🚀 Try it

**VS Code:** install [Pocket Pilot from the Marketplace](https://marketplace.visualstudio.com/items?itemName=mithawala.pocket-pilot) (or run `code --install-extension mithawala.pocket-pilot`), then click **Start remote access** in the Pocket Pilot panel.

**GitHub Copilot app and CLI:** run these, then type `/pocket-pilot` in a chat.

```bash
copilot plugin marketplace add mithawala/pocket-pilot
copilot plugin install pocket-pilot@pocket-pilot
```

**Your phone:** open [mithawala.github.io/pocket-pilot/app](https://mithawala.github.io/pocket-pilot/app/), add it to your Home Screen and scan the QR code.

**Just looking?** The [demo](https://mithawala.github.io/pocket-pilot/app/?demo) runs in your browser.

It's free to use, including at work, and the source is on GitHub under the PolyForm Shield license:

{% github mithawala/pocket-pilot no-readme %}

What would you want your agents to be able to do from your phone? Tell me in the comments. And if you find a hole in the security model, I *really* want to hear about it.
