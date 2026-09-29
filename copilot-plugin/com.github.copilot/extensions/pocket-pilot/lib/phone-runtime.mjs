// Sessions started from a paired device. The GitHub Copilot app opens a chat from outside only after
// someone clicks "Allow" on the PC, so the hub runs these in a Copilot runtime of its own: the same
// runtime the app uses (its bundled SDK and executable), with the user's sign-in, models, tools and
// plugins. Pocket Pilot's extension loads in each session and attaches it to the hub like any chat;
// requests for the user (approvals, questions, plans) wait for the phone to answer them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FILES, PHONE_RUNTIME_ENV, readJson, writeJson } from './ipc.mjs';

/** Sessions used within this long are resumed when the hub starts again (after it moved or restarted). */
const RESUME_WITHIN_MS = 12 * 3600 * 1000;
const MAX_RESUME = 6;
const MAX_KEPT = 50;
const EXPECT_MS = 10 * 60 * 1000;

// Answered from the phone, through the session's extension (handlePending* RPCs).
const waitForPhone = () => new Promise(() => {});
const HANDLERS = { onPermissionRequest: waitForPhone, onUserInputRequest: waitForPhone, onElicitationRequest: waitForPhone, onExitPlanModeRequest: waitForPhone };

/** Marks a session that should appear on the phone before it has a message (see extension.mjs). */
export function expectSession(sessionId) {
  fs.mkdirSync(FILES.expect, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(FILES.expect, sessionIdFile(sessionId)), String(Date.now()), { mode: 0o600 });
}

/** Whether a session was started from a device and is waiting to appear there. Consumes the marker. */
export function takeExpected(sessionId) {
  const file = path.join(FILES.expect, sessionIdFile(sessionId));
  try {
    const at = Number(fs.readFileSync(file, 'utf8'));
    fs.rmSync(file, { force: true });
    return Date.now() - at < EXPECT_MS;
  } catch {
    return false;
  }
}

function sessionIdFile(sessionId) {
  const id = String(sessionId || '');
  if (!/^[\w-]{8,64}$/.test(id)) throw new Error('Invalid session id');
  return id;
}

/** The runtime executable the extension itself runs in (the app's or the CLI's copilot), if it is one. */
export function runtimePath(execPath = process.execPath) {
  return /^copilot(\.exe)?$/i.test(path.basename(execPath || '')) ? execPath : undefined;
}

/** Whether a plugin folder is an installed plugin (the runtime loads those by itself). */
export function isInstalledPlugin(pluginDir, copilotHome = process.env.COPILOT_HOME || path.join(os.homedir(), '.copilot')) {
  const rel = path.relative(path.join(copilotHome, 'installed-plugins'), pluginDir);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export class PhoneRuntime {
  /**
   * @param {{ log?: (level: string, msg: string) => void, pluginDir?: string,
   *   loadSdk?: () => Promise<{ CopilotClient: Function, RuntimeConnection: object }>, cliPath?: string }} [o]
   */
  constructor(o = {}) {
    this.log = o.log || (() => {});
    this.pluginDir = o.pluginDir;
    this.loadSdk = o.loadSdk || (() => import('@github/copilot-sdk'));
    this.cliPath = o.cliPath === undefined ? runtimePath() : o.cliPath;
    this.client = null;
    this.starting = null;
    this.sessions = new Map();
    this.stopped = false;
  }

  get size() {
    return this.sessions.size;
  }

  has(sessionId) {
    return this.sessions.has(sessionId);
  }

  async _client() {
    if (this.stopped) throw new Error('Remote access is turning off');
    if (this.client) return this.client;
    this.starting ??= (async () => {
      const { CopilotClient, RuntimeConnection } = await this.loadSdk();
      // A clean environment for the runtime: not this extension process's session variables.
      const env = { ...process.env, [PHONE_RUNTIME_ENV]: '1' };
      for (const k of Object.keys(env)) if (/^(SESSION_ID|EXTENSION_PATH|COPILOT_EXTENSION_\w+)$/.test(k)) delete env[k];
      const client = new CopilotClient({
        connection: RuntimeConnection.forStdio({ ...(this.cliPath ? { path: this.cliPath } : {}), env }),
        workingDirectory: os.homedir(),
        // During development the plugin runs from a folder of its own; an installed one loads anyway.
        ...(this.pluginDir && !isInstalledPlugin(this.pluginDir) ? { builtinPluginDirectories: [this.pluginDir] } : {}),
      });
      await client.start();
      this.log('info', `Started a Copilot runtime for sessions begun on a device${this.cliPath ? ` (${this.cliPath})` : ''}`);
      this.client = client;
      return client;
    })().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  /**
   * Starts a session in a folder on this PC. `config` holds the device's choices (mode, autoApprove) and
   * `model` the model with its options, as runtime setModel arguments.
   */
  async create({ sessionId, cwd, config = {}, model }) {
    const st = fs.statSync(cwd, { throwIfNoEntry: false });
    if (!st?.isDirectory()) throw new Error(`That folder doesn't exist on your PC: ${cwd}`);
    expectSession(sessionId);
    const client = await this._client();
    const session = await client.createSession({
      sessionId,
      workingDirectory: cwd,
      streaming: true,
      requestExtensions: true,
      ...(model?.id ? { model: model.id, ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}), ...(model.contextTier ? { contextTier: model.contextTier } : {}) } : {}),
      ...HANDLERS,
    });
    this.sessions.set(sessionId, session);
    this._remember(sessionId, cwd);
    await this._apply(session, config).catch((err) => this.log('warn', `New session ${sessionId}: ${err.message}`));
    this.log('info', `Started session ${sessionId} in ${cwd} for a device`);
    return session;
  }

  async _apply(session, { mode, autoApprove } = {}) {
    if (mode && mode !== 'interactive') await session.rpc.mode.set({ mode });
    if (autoApprove && autoApprove !== 'default') await session.rpc.permissions.setMode({ mode: autoApprove === 'autoApprove' ? 'allow-all' : 'assisted' });
  }

  _remember(sessionId, cwd, at = Date.now()) {
    const list = (readJson(FILES.phoneSessions, []) || []).filter((s) => s && s.id !== sessionId);
    list.unshift({ id: sessionId, cwd, lastActiveAt: at });
    writeJson(FILES.phoneSessions, list.slice(0, MAX_KEPT));
  }

  /** Resumes the sessions used recently, so they are on the phone again after the hub moved or restarted. */
  async resumeRecent({ now = Date.now() } = {}) {
    const recent = (readJson(FILES.phoneSessions, []) || []).filter((s) => s?.id && now - (s.lastActiveAt || 0) < RESUME_WITHIN_MS).slice(0, MAX_RESUME);
    if (!recent.length) return 0;
    let resumed = 0;
    const client = await this._client();
    for (const s of recent) {
      if (this.sessions.has(s.id)) continue;
      try {
        this.sessions.set(s.id, await client.resumeSession(s.id, { streaming: true, requestExtensions: true, ...HANDLERS }));
        resumed++;
      } catch (err) {
        this.log('info', `Session ${s.id} was not resumed: ${err.message}`);
      }
    }
    if (resumed) this.log('info', `Resumed ${resumed} session(s) begun on a device`);
    return resumed;
  }

  /** Ends the runtime; the sessions stay saved (and are resumed by the next hub if recent). */
  async stop() {
    this.stopped = true;
    if (this.sessions.size) {
      const now = Date.now();
      const list = readJson(FILES.phoneSessions, []) || [];
      for (const s of list) if (this.sessions.has(s.id)) s.lastActiveAt = now;
      writeJson(FILES.phoneSessions, list);
    }
    const client = this.client || (await this.starting?.catch(() => null));
    this.client = null;
    this.sessions.clear();
    if (client) await client.stop().catch(() => {});
  }

  /** When this process is ending right now: no runtime left behind that keeps the sessions locked. */
  kill() {
    try {
      this.client?.cliProcess?.kill?.();
    } catch {
      /* already gone */
    }
  }
}
