# Pocket Pilot for the GitHub Copilot app and CLI

Control the chats you run in the GitHub Copilot app and the Copilot CLI from your phone: the same
history, live replies, chat, tool approvals, questions, plan approval, model / mode / approval
switches and push notifications — end-to-end encrypted through a free Cloudflare quick tunnel, with
pairing you approve on your PC and a passkey or authenticator code on the phone.

## Install

```bash
copilot plugin marketplace add mithawala/pocket-pilot
copilot plugin install pocket-pilot@pocket-pilot
```

The GitHub Copilot app uses the same plugins; restart it after installing.

## Use

Type `/pocket-pilot` in a chat (or ask "pair my phone") and confirm. In the GitHub Copilot app the
Pocket Pilot panel opens next to the chat; the CLI opens it in your browser and prints the QR code.
Scan it (on another computer, open the copied link). `/pocket-pilot status` shows the tunnel and
paired devices; `/pocket-pilot off` or **Turn off remote access** in the panel closes the tunnel, and **Turn on remote access** there opens it again. Remove devices in
the panel.

Remote access isn't tied to that chat: close or delete it and another open chat takes over within
seconds, at the same address. On Windows, quit VS Code and the app before updating or uninstalling
the plugin (VS Code keeps every plugin folder in use while it runs).

## Security

- **Off until you turn it on.** `/pocket-pilot` asks before it starts; **Turn off remote access** (or
  `/pocket-pilot off`) closes the tunnel.
- **Pairing you approve.** The QR code works once, expires after 10 minutes and pins this PC's key.
  Every new device needs your OK on the PC.
- **A second factor on every device:** a passkey (Face ID, fingerprint or Windows Hello) or a
  6-digit code from an authenticator app.
- **End-to-end encrypted** between the phone and this PC (ECDH P-256 with forward secrecy,
  HKDF-SHA-256, AES-256-GCM). Cloudflare only relays ciphertext and nothing is stored in a cloud.
  Nothing listens on your network: the relay binds to 127.0.0.1 and cloudflared connects out.
- **Nothing is approved for you.** Tool calls wait for your **Allow**, on the phone or the PC.

## Compared with Copilot's built-in remote control

Copilot's `/remote` streams a CLI session to GitHub.com and GitHub Mobile: you turn it on per
session, and new work started from the phone runs as a cloud agent. Pocket Pilot connects your phone
straight to this PC instead: every open chat shows up without turning it on chat by chat, new chats
start on your PC, and no copy of your sessions is stored in a cloud. The same phone app also works
with VS Code through the Pocket Pilot extension. Full comparison:
https://mithawala.github.io/pocket-pilot/#compare

Free to use, including at work. Source-available under the
[PolyForm Shield License 1.0.0](LICENSE).

More: https://mithawala.github.io/pocket-pilot/ · Source: https://github.com/mithawala/pocket-pilot
