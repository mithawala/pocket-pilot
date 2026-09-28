---
name: pocket-pilot
description: Pair a phone (or a tablet or another computer) with Pocket Pilot so the user can follow and control their GitHub Copilot sessions from it. Use when the user wants to continue on their phone, get notified when the agent needs them, approve tool calls remotely, or asks about Pocket Pilot, remote control, or pairing a phone or device.
---

# Pocket Pilot

Pocket Pilot mirrors the Copilot sessions open on this PC to the user's phone, tablet or another
computer (a web app on mithawala.github.io/pocket-pilot). From there they see the same history, watch
replies stream in, chat, approve or deny tool calls, answer the agent's questions, switch model and
mode, and stop the agent. Traffic is end-to-end encrypted through a free Cloudflare quick tunnel;
devices are approved on the PC and protected by a passkey.

## Pairing

- To pair a device, call the `pocket_pilot` tool with `{"action": "pair"}`. In the GitHub Copilot app
  it opens the Pocket Pilot panel with a QR code next to the chat; in the CLI it opens the same page in
  the browser. Tell the user to scan it with their phone or tablet camera (or open the copied link on
  another computer) and then allow the device there. Never ask the user to share the pairing link or
  the QR code with you.
- The user can also type `/pocket-pilot` themselves (the CLI shows the QR code in the timeline too),
  `/pocket-pilot status` for the status, and `/pocket-pilot off` to close the tunnel.

## Status

Call `pocket_pilot` with `{"action": "status"}` to see whether remote access is on, whether the tunnel
is online, how many sessions the paired devices can see and which devices are paired.

## Good to know

- Sessions appear on the paired devices while they are open in the GitHub Copilot app or CLI. New
  sessions are started on the PC.
- Remote access is not tied to the chat it was turned on from: when that chat is closed or deleted,
  another open chat takes over within seconds at the same address, and devices reconnect by
  themselves. With no chat open, devices wait and reconnect when a chat is opened again.
- If the tunnel itself restarts (for example after a reboot), auto-reconnect needs the GitHub CLI
  signed in (`gh auth login`); otherwise a device is re-paired by scanning a new code.
