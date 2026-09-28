'use strict';
const vscode = require('vscode');
const crypto = require('crypto');
const qrcode = require('../media/vendor/qrcode.js');

/** Renders a QR code as a compact, crisp SVG (one path, quiet zone included). */
function renderQrSvg(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  const m = 3;
  let d = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + m} ${r + m}h1v1h-1z`;
  }
  const size = n + m * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="Pairing QR code"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

class SidebarProvider {
  constructor(service, extensionUri) {
    this.service = service;
    this.extensionUri = extensionUri;
    this.view = null;
    service.onDidChange(() => this.post());
  }

  resolveWebviewView(view) {
    this.view = view;
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const nonce = crypto.randomBytes(16).toString('base64');
    const css = view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'sidebar.css'));
    const js = view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'sidebar.js'));
    const logo = view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'logo.svg'));
    view.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${view.webview.cspSource} data:; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>Pocket Pilot</title>
</head>
<body>
<div id="root" data-logo="${logo}"></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
    view.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
    view.onDidChangeVisibility(() => {
      if (view.visible) this.onVisible();
    });
    this.onVisible();
  }

  onVisible() {
    const s = this.service;
    if (s.state === 'running' && (!s.pairing || s.pairing.expiresAt - Date.now() < 60000)) s.newPairingCode();
    this.post();
  }

  post() {
    if (!this.view) return;
    this.view.webview.postMessage({ type: 'state', state: this.service.viewState(), now: Date.now() });
  }

  async onMessage(msg) {
    const run = (cmd, ...args) => vscode.commands.executeCommand(cmd, ...args);
    switch (msg?.type) {
      case 'ready':
        return this.post();
      case 'start':
        return run('pocketPilot.start');
      case 'stop':
        return run('pocketPilot.stop');
      case 'newCode':
        return this.service.newPairingCode();
      case 'copyLink':
        return run('pocketPilot.copyPairingLink');
      case 'restartTunnel':
        return run('pocketPilot.restartTunnel');
      case 'removeDevice':
        return run('pocketPilot.removeDevice', String(msg.id || ''));
      case 'takeOver':
        return run('pocketPilot.takeOver');
      case 'signInRendezvous':
        return run('pocketPilot.signInRendezvous');
      case 'openLocal':
        return run('pocketPilot.openLocalPwa');
      case 'settings':
        return run('pocketPilot.openSettings');
      case 'logs':
        return run('pocketPilot.showLogs');
      case 'installUpdate':
        return run('pocketPilot.installUpdate');
      case 'updateNotes':
        if (/^https:\/\/github\.com\//.test(String(this.service.update?.notes))) return vscode.env.openExternal(vscode.Uri.parse(this.service.update.notes));
        return undefined;
      case 'openUrl':
        if (/^https:\/\//.test(String(msg.url))) return vscode.env.openExternal(vscode.Uri.parse(msg.url));
        return undefined;
      default:
        return undefined;
    }
  }
}

module.exports = { SidebarProvider, renderQrSvg };
