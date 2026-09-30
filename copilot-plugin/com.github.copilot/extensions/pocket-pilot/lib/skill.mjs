// The /pocket-pilot entry in the slash menu of the GitHub Copilot app and CLI. The extension registers
// a /pocket-pilot command, but only once it has joined a chat, so the menu of a new chat never lists
// it; a skill of the same name is listed from the start. Up to 0.7.0 the plugin shipped that skill,
// but VS Code keeps the skills folder of every installed Copilot plugin open, and on Windows the app
// then can't move the plugin's folder to update it. So the extension keeps an equivalent skill in the
// user's own skills folder (the one the runtime says to create skills in) instead. The runtime still
// runs the extension's command for /pocket-pilot whenever it is registered; before that, the skill
// tells the model to use the pocket_pilot tool.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newer } from './update.mjs';

export const SKILL_NAME = 'pocket-pilot';
/** What the slash menu says about /pocket-pilot, for the skill and the extension's command alike. */
export const COMMAND_DESCRIPTION = 'Pocket Pilot: pair your phone or another device to follow and control your Copilot chats from it, see the status, or turn remote access off';
const MARKER = /^<!-- pocket-pilot-plugin (\d+\.\d+\.\d+)\b/m;

/** SKILL.md of the skill in the user's skills folder (COPILOT_HOME, like the runtime). */
export function skillFile(copilotHome = process.env.COPILOT_HOME || path.join(os.homedir(), '.copilot')) {
  return path.join(copilotHome, 'skills', SKILL_NAME, 'SKILL.md');
}

/** The plugin version that wrote a SKILL.md ('' when the plugin didn't write it or the user took it over). */
export function managedVersion(text) {
  return MARKER.exec(String(text || ''))?.[1] || '';
}

export function skillText(version, dir) {
  const frontmatter = {
    name: SKILL_NAME,
    description: COMMAND_DESCRIPTION,
    'argument-hint': '[pair | status | off]',
  };
  return `---
${Object.entries(frontmatter).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n')}
---

<!-- pocket-pilot-plugin ${version}: added by the Pocket Pilot plugin, which keeps this file up to date. To keep your own version instead, delete this line. -->

# Pocket Pilot

Pocket Pilot shows the Copilot chats open on this PC on the user's phone, tablet or another computer,
in a web app (mithawala.github.io/pocket-pilot/app). There they see the same history, watch replies
come in, chat, approve or deny tool calls, answer the agent's questions, switch model and mode, stop
the agent and start new sessions. The connection is end-to-end encrypted through a free Cloudflare
quick tunnel, and every device is approved on this PC and confirmed with a passkey or an
authenticator code.

## What to do

The words after \`/pocket-pilot\` say what the user wants; nothing means pair.

- **pair**: call the \`pocket_pilot\` tool with \`{"action": "pair"}\`. In the GitHub Copilot app it
  opens the Pocket Pilot panel next to the chat, with a QR code; in the CLI it opens the same page in
  the browser. Tell the user to scan the code with their phone or tablet camera (or open the copied
  link on another computer) and then allow the device. Never ask the user to share the pairing link
  or the QR code with you.
- **status**: call \`pocket_pilot\` with \`{"action": "status"}\` and tell the user whether remote
  access is on, whether the tunnel is online and which devices are paired.
- **off**: call \`pocket_pilot\` with \`{"action": "off"}\`. It closes the tunnel; paired devices stay
  paired and reconnect when remote access is turned on again with \`/pocket-pilot\`.

## If there is no pocket_pilot tool

- **In VS Code**, the Pocket Pilot extension for VS Code (\`mithawala.pocket-pilot\`) serves VS Code's
  chats: tell the user to click **Start remote access** in its panel, or to run
  **Pocket Pilot: Pair a Device (Show QR Code)** from the Command Palette.
- **In the GitHub Copilot app or the CLI**, the Pocket Pilot plugin is switched off or was removed.
  Its switch is under **Customize → Extensions** in the app. To install it again:
  \`copilot plugin marketplace add mithawala/pocket-pilot\`, then
  \`copilot plugin install pocket-pilot@pocket-pilot\`. Without the plugin this skill does nothing;
  the user can delete its folder: \`${dir}\`.

## Good to know

- Remote access isn't tied to the chat it was turned on in: when that chat is closed, another open
  chat takes over within seconds at the same address, and devices reconnect by themselves.
- After the tunnel restarts (for example after a reboot), devices reconnect by themselves when the
  GitHub CLI is signed in (\`gh auth login\`); otherwise pair them again with a new code.
`;
}

/**
 * Creates the skill, or brings it up to date. Leaves it alone when the user wrote or took over the file
 * (no marker line) or a newer plugin version wrote it. Never throws.
 * @returns {'created' | 'updated' | 'current' | 'kept' | 'failed'}
 */
export function installSkill({ version, file = skillFile() }) {
  try {
    const text = skillText(version, path.dirname(file));
    let old = null;
    try {
      old = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') return 'failed';
    }
    if (old !== null) {
      const by = managedVersion(old);
      if (!by || newer(by, version)) return 'kept';
      if (old === text) return 'current';
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text);
    try {
      fs.renameSync(tmp, file);
    } catch {
      fs.rmSync(tmp, { force: true });
      fs.writeFileSync(file, text);
    }
    return old === null ? 'created' : 'updated';
  } catch {
    return 'failed';
  }
}
