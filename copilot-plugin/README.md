# Pocket Pilot for the GitHub Copilot app and CLI

Control the chats you run in the GitHub Copilot app and the Copilot CLI from your phone: the same
history, live replies, chat, tool approvals, questions, plan approval, model / mode / approval
switches and push notifications — end-to-end encrypted through a free Cloudflare quick tunnel, with
pairing you approve on your PC and a passkey on the phone.

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

More: https://mithawala.github.io/pocket-pilot/ · Source: https://github.com/mithawala/pocket-pilot
