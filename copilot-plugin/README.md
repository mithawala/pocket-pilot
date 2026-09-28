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

Type `/pocket-pilot` in a chat (or ask "pair my phone"), confirm, and scan the QR code on the page
that opens (on another computer, open the copied link instead). `/pocket-pilot status` shows the
tunnel and paired devices; `/pocket-pilot off` closes the tunnel. Remove devices on the pairing page.

More: https://mithawala.github.io/pocket-pilot/ · Source: https://github.com/mithawala/pocket-pilot
