---
name: pocket-pilot
description: Pair a phone with Pocket Pilot so the user can follow and control their GitHub Copilot sessions from the phone. Use when the user wants to continue on their phone, get notified when the agent needs them, approve tool calls remotely, or asks about Pocket Pilot, remote control, or pairing a phone.
---

# Pocket Pilot

Pocket Pilot mirrors the Copilot sessions open on this PC to the user's phone (a web app on
mithawala.github.io/pocket-pilot). From the phone they see the same history, watch replies stream
in, chat, approve or deny tool calls, answer the agent's questions, switch model and mode, and stop
the agent. Traffic is end-to-end encrypted through a free Cloudflare quick tunnel; phones are
approved on the PC and protected by a passkey.

## Pairing

- To pair a phone, call the `pocket_pilot` tool with `{"action": "pair"}`. It opens a page with a
  QR code in the browser on this PC. Tell the user to scan it with the phone camera and then allow
  the phone on that page. Never ask the user to share the pairing link or the QR code with you.
- The user can also type `/pocket-pilot` themselves (it shows the QR code in the timeline too),
  `/pocket-pilot status` for the status, and `/pocket-pilot off` to close the tunnel.

## Status

Call `pocket_pilot` with `{"action": "status"}` to see whether remote access is on, whether the tunnel
is online, how many sessions the phone can see and which phones are paired.

## Good to know

- Sessions appear on the phone while they are open in the GitHub Copilot app or CLI. New sessions
  are started on the PC.
- Remote access turns itself off 30 minutes after the last Copilot session closes.
- Auto-reconnect after restarts needs the GitHub CLI signed in (`gh auth login`); otherwise the
  phone is re-paired by scanning a new code.
