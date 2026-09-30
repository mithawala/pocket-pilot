// Pocket Pilot for the GitHub Copilot app and CLI — the per-session half. The runtime starts one of
// these for every session; it attaches the session to the shared Pocket Pilot hub (starting the hub
// when remote access is on) so your phone sees the same history, streams replies live, and can chat,
// approve tools, answer questions, switch model or mode and stop the agent.
import * as sdk from '@github/copilot-sdk/extension';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { FILES, PHONE_RUNTIME_ENV, readJson, writeJson, hubAlive, connect, Rpc } from './lib/ipc.mjs';
import { renderQrText } from './lib/qr.mjs';
import { latestVersion, newer, updateInfo, updateText } from './lib/update.mjs';
import { takeExpected } from './lib/phone-runtime.mjs';
import { installSkill, COMMAND_DESCRIPTION } from './lib/skill.mjs';

const { joinSession } = sdk;
const EXT_DIR = path.dirname(fileURLToPath(import.meta.url));
const inside = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
};
// Never keep the plugin folder in use: Windows can't update or uninstall a folder a process runs in.
if (inside(process.cwd(), path.resolve(EXT_DIR, '..', '..', '..'))) process.chdir(os.homedir());

const MAX_TURNS = 60;
const CLIP = 8000;
const HISTORY_TYPES = new Set([
  'session.start', 'user.message', 'assistant.turn_start', 'assistant.reasoning', 'assistant.message', 'assistant.usage',
  'tool.execution_start', 'tool.execution_complete', 'permission.requested', 'permission.completed',
  'user_input.requested', 'user_input.completed', 'elicitation.requested', 'elicitation.completed',
  'exit_plan_mode.requested', 'exit_plan_mode.completed', 'session.idle', 'abort', 'session.error',
  'session.title_changed', 'session.mode_changed', 'session.permissions_changed', 'session.model_change',
]);
const LIVE_TYPES = new Set([...HISTORY_TYPES, 'assistant.intent', 'assistant.message_delta', 'assistant.reasoning_delta', 'tool.execution_partial_result']);
/** Requests for the user (and their answers) reach extensions only through the event log, not `session.on`. */
const UI_TYPES = ['permission.requested', 'permission.completed', 'user_input.requested', 'user_input.completed', 'elicitation.requested', 'elicitation.completed', 'exit_plan_mode.requested', 'exit_plan_mode.completed'];

/**
 * VS Code's agent host (its `copilot-runtime`) loads Copilot plugins too, but it already serves its
 * sessions to Pocket Pilot through the VS Code extension: stay out of the way there.
 */
function insideVsCode() {
  const exe = process.execPath || '';
  if (/[\\/]resources[\\/]app[\\/]/i.test(exe) || /^(code|code - insiders|cursor|windsurf|electron)(\.exe)?$/i.test(path.basename(exe))) return true;
  const ppid = Number(process.env.COPILOT_EXTENSION_PARENT_PID) || process.ppid;
  try {
    const image = process.platform === 'win32'
      ? (/^"([^"]+)"/m.exec(execFileSync('tasklist', ['/FI', `PID eq ${ppid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 5000 })) || [])[1] || ''
      : execFileSync('ps', ['-o', 'comm=', '-p', String(ppid)], { encoding: 'utf8', timeout: 5000 }).trim();
    return /copilot-runtime/i.test(path.basename(image));
  } catch {
    return false;
  }
}

const clip = (s, n = CLIP) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}\n… (truncated)` : s);
const INLINE_PICTURE = 4 * 1024 * 1024;

/** A message's attachments as the phone shows them: files by path, small pasted pictures inline. */
function slimAttachments(list) {
  if (!Array.isArray(list) || !list.length) return undefined;
  return list.filter((a) => a && typeof a === 'object').map((a) => ({
    type: a.type, path: a.path, displayName: a.displayName, title: a.title, mimeType: a.mimeType,
    ...(a.type === 'blob' && /^image\//.test(a.mimeType || '') && typeof a.data === 'string' && a.data.length <= INLINE_PICTURE ? { data: a.data } : {}),
  }));
}

/** Keeps what the phone renders; drops model internals (encrypted reasoning, telemetry, prompts). */
function slim(e) {
  const d = e.data || {};
  let data = d;
  switch (e.type) {
    case 'user.message':
      data = { content: d.content, messageId: d.messageId, source: d.source, delivery: d.delivery, isAutopilotContinuation: d.isAutopilotContinuation, attachments: slimAttachments(d.attachments) };
      break;
    case 'assistant.message':
      data = {
        messageId: d.messageId, content: d.content, parentToolCallId: d.parentToolCallId,
        toolRequests: (d.toolRequests || []).map((t) => ({ toolCallId: t.toolCallId, name: t.name, arguments: t.arguments, toolTitle: t.toolTitle, intentionSummary: t.intentionSummary })),
      };
      break;
    case 'assistant.reasoning':
      data = { reasoningId: d.reasoningId, content: clip(d.content) };
      break;
    case 'assistant.usage':
      data = { inputTokens: d.inputTokens, outputTokens: d.outputTokens };
      break;
    case 'tool.execution_start':
      data = { toolCallId: d.toolCallId, toolName: d.toolName, arguments: d.arguments, parentToolCallId: d.parentToolCallId };
      break;
    case 'tool.execution_complete':
      data = {
        toolCallId: d.toolCallId, success: d.success, parentToolCallId: d.parentToolCallId,
        result: d.result ? { content: clip(d.result.content), detailedContent: clip(d.result.detailedContent) } : undefined,
        error: d.error ? { message: d.error.message, code: d.error.code } : undefined,
      };
      break;
    case 'tool.execution_partial_result':
      data = { toolCallId: d.toolCallId, partialOutput: typeof d.partialOutput === 'string' ? d.partialOutput.slice(-4000) : d.partialOutput };
      break;
    case 'permission.requested':
      data = { requestId: d.requestId, resolvedByHook: d.resolvedByHook, permissionRequest: { ...d.permissionRequest, diff: clip(d.permissionRequest?.diff), newFileContents: undefined } };
      break;
    case 'session.start':
      data = { selectedModel: d.selectedModel, model: d.model };
      break;
    default:
  }
  return { type: e.type, id: e.id, timestamp: e.timestamp, ...(e.agentId ? { agentId: e.agentId } : {}), ...(e.ephemeral ? { ephemeral: true } : {}), data };
}

/** The last MAX_TURNS turns of history, trimmed to what the phone needs. */
function slimHistory(events) {
  const list = events.filter((e) => HISTORY_TYPES.has(e.type));
  const starts = [];
  list.forEach((e, i) => {
    if (e.type === 'user.message' && !e.agentId) starts.push(i);
  });
  const from = starts.length > MAX_TURNS ? starts[starts.length - MAX_TURNS] : 0;
  const head = list.find((e) => e.type === 'session.start');
  const keep = list.slice(from);
  return (head && from > 0 ? [head, ...keep] : keep).map(slim);
}

function openExternal(url) {
  const done = () => {};
  if (process.platform === 'win32') execFile('rundll32', ['url.dll,FileProtocolHandler', url], { windowsHide: true }, done);
  else if (process.platform === 'darwin') execFile('open', [url], done);
  else execFile('xdg-open', [url], done);
}

const settingsFile = () => readJson(FILES.state, {}) || {};
const isEnabled = () => !!settingsFile().enabled;
function setEnabled(enabled) {
  writeJson(FILES.state, { ...settingsFile(), enabled, changedAt: new Date().toISOString() });
}

const VERSION = readJson(fileURLToPath(new URL('./version.json', import.meta.url)), {})?.version || '0.0.0';

/** The Copilot CLI only updates first-party plugins by itself: tell the user when this one is behind. */
async function updateNote() {
  const info = updateInfo(await latestVersion().catch(() => ''), VERSION);
  return info ? `Update available: ${updateText(info)}` : '';
}
const debug = process.env.POCKET_PILOT_DEBUG
  ? (m) => {
    try {
      fs.appendFileSync(path.join(path.dirname(FILES.log), `extension-${process.pid}.log`), `${new Date().toISOString()} ${m}\n`);
    } catch {
      /* ignore */
    }
  }
  : () => {};

// ------------------------------------------------------------------ hub connection

let session;
let rpc = null;
let connecting = null;
let attached = false;
let buffered = null;
let hub = null;
let hubError = null;

/** Hosts the hub in this session's process unless another session already does. */
async function hostHub() {
  if (hub && !hub.stopped) return hub;
  try {
    const { startHub } = await import('./lib/hub.mjs');
    hub = await startHub({ onTurnOn: turnOnFromPage });
    hubError = null;
  } catch (err) {
    hubError = err;
    hub = null;
  }
  return hub;
}

/** "Turn on remote access" on the pairing page: the hub starts again in this process (same page). */
async function turnOnFromPage() {
  setEnabled(true);
  await connectHub({ start: true });
}

let tookOver = false;
// Sessions begun on a paired device run in a runtime the hub started (lib/phone-runtime.mjs): nobody
// sees their UI on the PC, and they end with the hub, so they never ask for confirmations or host it.
const inPhoneRuntime = !!process.env[PHONE_RUNTIME_ENV];
async function connectHub({ start }) {
  if (rpc && !rpc.ch.closed) return rpc;
  if (connecting) return connecting;
  connecting = (async () => {
    const hello = { pid: process.pid, canConfirm: !inPhoneRuntime && !!session.capabilities?.ui?.elicitation };
    let mayStart = start && !inPhoneRuntime;
    for (let attempt = 0; attempt < 40; attempt++) {
      const info = readJson(FILES.hub);
      if (hubAlive(info)) {
        try {
          const ch = await connect(info.port, info.token, hello);
          const r = new Rpc(ch, { cmd: runCommand, confirm: ({ message, title }) => confirm(title, message) });
          // The plugin was updated while the app ran: this chat has the newer version, so it takes the
          // hub over (same tunnel and address; paired devices reconnect by themselves). Older hubs
          // don't know "handover" and simply keep running.
          if (!tookOver && !inPhoneRuntime && isEnabled() && newer(VERSION, info.version || '0')) {
            tookOver = true;
            if (await r.request('handover', {}, 5000).then(() => true, () => false)) {
              ch.close();
              mayStart = true;
              for (let i = 0; i < 50 && hubAlive(readJson(FILES.hub)); i++) await new Promise((res) => setTimeout(res, 100));
              continue;
            }
          }
          rpc = r;
          ch.on('close', () => {
            rpc = null;
            attached = false;
            setTimeout(watchHub, 1000 + Math.random() * 1500);
          });
          await attach();
          return rpc;
        } catch {
          /* the hub is starting or stopping; retry */
        }
      } else if (!mayStart) {
        return null;
      } else {
        await hostHub();
        if (hubError) throw hubError;
      }
      await new Promise((r) => setTimeout(r, 300 + Math.random() * 300));
    }
    throw new Error('Could not reach the Pocket Pilot hub (see ~/.pocket-pilot/copilot/hub.log)');
  })().finally(() => {
    connecting = null;
  });
  return connecting;
}

let watchTimer = null;
/** Attaches this session as soon as remote access is on (the hub may be started by another session). */
function watchHub() {
  clearTimeout(watchTimer);
  watchTimer = setTimeout(async () => {
    if (!rpc && real) {
      const info = readJson(FILES.hub);
      if (hubAlive(info)) await connectHub({ start: false }).catch(() => {});
      else if (isEnabled()) await connectHub({ start: true }).catch(() => {});
    }
    watchHub();
  }, 4000);
  watchTimer.unref?.();
}

// The app also runs short-lived internal sessions (e.g. to discover extensions). Only sessions the user
// actually talks to are shown on the phone, and only they may host the hub.
let real = false;
async function checkReal() {
  try {
    const r = await session.rpc.eventLog.read({ types: ['user.message'], max: 5, direction: 'backward' });
    real = real || (r.events || []).some((e) => !e.agentId);
  } catch {
    /* unknown: wait for a message */
  }
  return real;
}

function markReal() {
  if (real) return;
  real = true;
  if (isEnabled() && !rpc) connectHub({ start: true }).catch(() => watchHub());
}

async function sessionInfo() {
  const [events, processing, snap, name, perm, models, metrics, current] = await Promise.all([
    session.getEvents().catch(() => []),
    session.rpc.metadata.isProcessing().then((r) => !!r?.processing).catch(() => false),
    session.rpc.metadata.snapshot().catch(() => null),
    session.rpc.name.get().then((r) => r?.name || null).catch(() => null),
    session.rpc.permissions.getMode().then((r) => r?.mode).catch(() => null),
    session.rpc.model.list().then((r) => r?.list || []).catch(() => []),
    session.rpc.usage.getMetrics().catch(() => null),
    session.rpc.model.getCurrent().catch(() => null),
  ]);
  const firstUser = events.find((e) => e.type === 'user.message' && !e.agentId)?.data?.content;
  const title = name || snap?.summary || snap?.initialName || (firstUser ? String(firstUser).replace(/\s+/g, ' ').slice(0, 80) : null) || 'New session';
  const cwd = snap?.workingDirectory || process.cwd();
  return {
    sessionId: session.sessionId,
    cwd,
    gitRoot: snap?.workspace?.git_root || undefined,
    title,
    createdAt: snap?.startTime,
    mode: snap?.currentMode || 'interactive',
    autoApprove: perm === 'allow-all' ? 'autoApprove' : perm === 'assisted' ? 'assisted' : 'default',
    model: (current?.modelId || snap?.selectedModel) ? {
      id: current?.modelId || snap.selectedModel,
      reasoningEffort: current?.reasoningEffort || undefined,
      contextTier: current?.contextTier || undefined,
      autoTier: current?.autoTier || undefined,
    } : undefined,
    changes: changesOf(metrics),
    processing,
    history: slimHistory(events),
    models,
  };
}

function changesOf(m) {
  const c = m?.codeChanges;
  return c && (c.linesAdded || c.linesRemoved) ? { additions: c.linesAdded, deletions: c.linesRemoved, files: c.filesModifiedCount } : undefined;
}

async function attach() {
  if (!rpc) return;
  // Live events that arrive while the history is being read are replayed after it, minus duplicates.
  buffered = [];
  const tail = await session.rpc.eventLog.tail().catch(() => null);
  try {
    const { models, ...info } = await sessionInfo();
    // The model list first, so the session's model is attached with its thinking level and context size.
    if (models.length) rpc.notify('models', { list: models });
    await rpc.request('attach', info, 120000);
    const seen = new Set();
    for (const e of info.history) {
      seen.add(e.id);
      remember(e.id);
      if (e.data?.messageId) seen.add(`m:${e.data.messageId}`);
      if (e.data?.reasoningId) seen.add(`r:${e.data.reasoningId}`);
    }
    const late = [];
    for (const e of buffered) {
      if (seen.has(e.id) || (e.data?.messageId && seen.has(`m:${e.data.messageId}`)) || (e.data?.reasoningId && seen.has(`r:${e.data.reasoningId}`))) continue;
      const stream = streamOf(e);
      if (stream && partial.has(stream)) continue;
      if (e.type === 'assistant.message') partial.delete(`m:${e.data?.messageId}`);
      if (e.type === 'assistant.reasoning') partial.delete(`r:${e.data?.reasoningId}`);
      late.push(e);
    }
    attached = true;
    for (const e of late) remember(e.id);
    if (late.length) rpc.notify('events', { list: late.map(slim) });
    if (tail?.cursor) uiEvents(tail.cursor, ++uiLoop);
  } finally {
    buffered = null;
  }
}

const delivered = new Set();
function remember(id) {
  if (!id) return;
  delivered.add(id);
  if (delivered.size > 5000) delivered.delete(delivered.values().next().value);
}

/** Streams whose first chunks were never forwarded: the final message event carries their whole text. */
const partial = new Set();
function streamOf(e) {
  if (e.type === 'assistant.message_delta') return `m:${e.data?.messageId}`;
  if (e.type === 'assistant.reasoning_delta') return `r:${e.data?.reasoningId}`;
  return '';
}

let uiLoop = 0;
/** Long-polls the event log for permission prompts, questions and plan approvals. */
async function uiEvents(cursor, loop) {
  while (rpc && attached && loop === uiLoop) {
    try {
      const r = await session.rpc.eventLog.read({ cursor, waitMs: 20000, types: UI_TYPES, max: 100, includeEphemeral: true });
      if (loop !== uiLoop) return;
      if (r.cursorStatus && r.cursorStatus !== 'ok') {
        cursor = (await session.rpc.eventLog.tail()).cursor;
        continue;
      }
      cursor = r.cursor || cursor;
      for (const e of r.events || []) forward(e);
    } catch (err) {
      debug(`event log read failed: ${err.message}`);
      await new Promise((res) => setTimeout(res, 2000));
    }
  }
}

function forward(e) {
  debug(`event ${e.type}${e.data?.toolCallId ? ` ${e.data.toolCallId}` : ''}${e.data?.requestId ? ` req=${e.data.requestId}` : ''} ${buffered ? '(buffered)' : attached ? '' : '(not attached)'}`);
  if (e.type === 'user.message' && !e.agentId) markReal();
  if (!LIVE_TYPES.has(e.type)) return;
  const stream = streamOf(e);
  if (buffered) return void buffered.push(e);
  if (!rpc || !attached) {
    if (stream) {
      partial.add(stream);
      if (partial.size > 500) partial.delete(partial.values().next().value);
    }
    return;
  }
  if (stream && partial.has(stream)) return;
  if (e.type === 'assistant.message') partial.delete(`m:${e.data?.messageId}`);
  if (e.type === 'assistant.reasoning') partial.delete(`r:${e.data?.reasoningId}`);
  if (e.id) {
    if (delivered.has(e.id)) return;
    remember(e.id);
  }
  rpc.notify('event', { e: slim(e) });
  if (e.type === 'session.idle') {
    session.rpc.usage.getMetrics().then((m) => {
      const changes = changesOf(m);
      if (changes && rpc) rpc.notify('update', { changes });
    }).catch(() => {});
  }
}

// ------------------------------------------------------------------ commands from the phone (via the hub)

/** Applies a model selection ({ id, reasoningEffort, contextTier, autoTier }) unless it is already active. */
async function switchModel(m) {
  if (!m?.id) return;
  const cur = await session.rpc.model.getCurrent().catch(() => null);
  const same = cur?.modelId === m.id
    && (m.reasoningEffort === undefined || cur.reasoningEffort === m.reasoningEffort)
    && (m.contextTier === undefined || (cur.contextTier || 'default') === m.contextTier)
    && (m.autoTier === undefined || cur.autoTier === m.autoTier);
  if (same) return;
  const opts = {};
  if (m.reasoningEffort) opts.reasoningEffort = m.reasoningEffort;
  if (m.contextTier) opts.contextTier = m.contextTier;
  if (m.id === 'auto' && m.autoTier) opts.autoTier = m.autoTier;
  await session.setModel(m.id, Object.keys(opts).length ? opts : undefined);
}

function toPrompt(prompt, attachments) {
  const files = [];
  const notes = [];
  for (const a of attachments || []) {
    const m = /saved on this machine at: (.+)$/m.exec(a?.modelRepresentation || '');
    if (m && fs.existsSync(m[1].trim())) files.push({ type: 'file', path: m[1].trim(), displayName: a.label || path.basename(m[1].trim()) });
    else if (a?.modelRepresentation) notes.push(a.modelRepresentation);
  }
  return { prompt: [prompt, ...notes].filter(Boolean).join('\n\n'), attachments: files };
}

async function runCommand({ op, params = {} }) {
  switch (op) {
    case 'send': {
      await switchModel(params.model).catch(() => {});
      const { prompt, attachments } = toPrompt(params.prompt, params.attachments);
      await session.send({ prompt, ...(attachments.length ? { attachments } : {}), ...(params.mode ? { mode: params.mode } : {}) });
      return true;
    }
    case 'permission':
      return !!(await session.rpc.permissions.handlePendingPermissionRequest({ requestId: params.requestId, result: params.decision }))?.success;
    case 'input':
      return !!(await session.rpc.ui.handlePendingUserInput({ requestId: params.requestId, response: params.response }))?.success;
    case 'elicitation':
      return !!(await session.rpc.ui.handlePendingElicitation({ requestId: params.requestId, result: params.response }))?.success;
    case 'plan':
      return !!(await session.rpc.ui.handlePendingExitPlanMode({ requestId: params.requestId, response: params.response }))?.success;
    case 'abort':
      await session.abort();
      return true;
    case 'model':
      await switchModel(params.model);
      return true;
    case 'mode':
      await session.rpc.mode.set({ mode: params.mode });
      return true;
    case 'approvals':
      await session.rpc.permissions.setMode({ mode: params.mode });
      return true;
    case 'rename':
      await session.rpc.name.set({ name: params.name });
      return true;
    default:
      throw new Error(`Unknown command ${op}`);
  }
}

async function confirm(title, message) {
  if (!session.capabilities?.ui?.elicitation) return null;
  return session.ui.confirm(`${title}\n\n${message}`);
}

// ------------------------------------------------------------------ /pocket-pilot and the tool

function statusText(s) {
  const lines = [
    `Pocket Pilot ${s.version} — ${s.hostName} (${s.fingerprint})`,
    `Tunnel: ${s.tunnel.mode === 'none' ? 'off (local network only)' : s.tunnel.url ? `online${s.tunnel.reachable ? '' : ' (checking reachability)'}` : s.tunnel.error ? `error: ${s.tunnel.error}` : 'starting…'}`,
    `Open sessions on your devices: ${s.sessions}`,
    `Auto-reconnect after restarts: ${s.rendezvous ? 'on (encrypted GitHub gist)' : 'off (sign in with the GitHub CLI: gh auth login)'}`,
    `Paired devices: ${s.devices.length ? s.devices.map((d) => `${d.name}${d.online ? ' (connected)' : ''}`).join(', ') : 'none yet'}`,
  ];
  return lines.join('\n');
}

async function enable({ ask }) {
  real = true;
  if (!isEnabled() && ask && session.capabilities?.ui?.elicitation) {
    const ok = await session.ui.confirm('Turn on Pocket Pilot remote access?\n\nYour phone (or another device you pair) will be able to see and control the GitHub Copilot sessions open on this PC. Pocket Pilot downloads the official Cloudflare tunnel (cloudflared, about 55 MB) once and connects your devices end-to-end encrypted — Cloudflare only relays ciphertext. You approve every device that pairs. If the GitHub CLI is signed in, the changing tunnel address is kept in a secret, encrypted gist so your devices reconnect on their own.');
    if (!ok) return false;
  }
  setEnabled(true);
  await connectHub({ start: true });
  return true;
}

async function pair({ openPage = true } = {}) {
  if (!(await enable({ ask: true }))) return null;
  await session.log('Pocket Pilot: starting the secure tunnel…', { ephemeral: true });
  const s = await rpc.request('pair', {}, 180000);
  if (openPage) s.openedIn = (await openPanel()) ? 'panel' : (openExternal(s.pageUrl), 'browser');
  return s;
}

// ------------------------------------------------------------------ the Pocket Pilot panel (canvas)
// In the GitHub Copilot app the pairing page (QR code, approvals, paired devices) opens as a panel next
// to the chat; the CLI, which has no panels, opens it in the browser instead.

const CANVAS_ID = 'pocket-pilot';
const canCanvas = () => typeof sdk.createCanvas === 'function' && !!session?.capabilities?.ui?.canvases;

async function openPanel() {
  if (!canCanvas()) return false;
  try {
    await session.rpc.canvas.open({ canvasId: CANVAS_ID, instanceId: CANVAS_ID });
    return true;
  } catch (err) {
    debug(`canvas open failed: ${err.message}`);
    return false;
  }
}

function canvases() {
  if (typeof sdk.createCanvas !== 'function') return [];
  return [sdk.createCanvas({
    id: CANVAS_ID,
    displayName: 'Pocket Pilot',
    description: 'Pair a phone, tablet or another computer with this PC to follow and control your Copilot chats from it, and see or remove paired devices.',
    open: async () => {
      const s = await pair({ openPage: false });
      if (!s) throw new sdk.CanvasError('declined', 'Remote access was not turned on.');
      const n = s.devices.length;
      return { url: `${s.pageUrl}&embed=1`, title: 'Pocket Pilot', status: n ? `${n} paired device${n === 1 ? '' : 's'}` : 'Scan the QR code to pair' };
    },
  })];
}

/** A request to the hub, over this session's connection or a short control connection (no attach). */
async function hubRequest(op, params = {}, timeoutMs = 60000) {
  if (rpc && !rpc.ch.closed) return rpc.request(op, params, timeoutMs);
  const info = readJson(FILES.hub);
  if (!hubAlive(info)) return null;
  const ch = await connect(info.port, info.token, { pid: process.pid });
  try {
    return await new Rpc(ch, {}).request(op, params, timeoutMs);
  } finally {
    ch.close();
  }
}

async function turnOff() {
  setEnabled(false);
  const stopped = await hubRequest('stop').catch(() => null);
  // No hub right now (for example every other chat was closed): end the tunnel it left running.
  if (!stopped) await createRequire(import.meta.url)('./vendor/extension/core/tunnel.js').PersistentTunnel.end(FILES.tunnel).catch(() => {});
}

async function onCommand(ctx) {
  const arg = String(ctx?.args || '').trim().toLowerCase();
  try {
    if (arg === 'status') {
      const s = await hubRequest('status').catch(() => null);
      const note = await updateNote();
      await session.log([s ? statusText(s) : 'Pocket Pilot is off. Run /pocket-pilot to pair a device.', note].filter(Boolean).join('\n'));
      return;
    }
    if (arg === 'off' || arg === 'stop') {
      await turnOff();
      await session.log('Pocket Pilot is off: the tunnel is closed and your devices cannot connect until you run /pocket-pilot again.');
      return;
    }
    if (arg && arg !== 'pair' && arg !== 'on') {
      await session.log('Usage: /pocket-pilot [pair | status | off]');
      return;
    }
    const s = await pair();
    if (!s) return;
    if (s.openedIn === 'panel') await session.log(`Pocket Pilot is open in the panel next to this chat: scan the QR code there with your phone or tablet, or copy the link for another computer. Remote access keeps running when you close or delete this chat.\n\nNo panel? Open the same page in your browser: ${s.pageUrl}`, { ephemeral: true });
    else await session.log(`Pocket Pilot: scan this code with your phone or tablet (also on the page that just opened in your browser):\n\n${renderQrText(s.pairing.link)}\n\nOr open this single-use link on the device you want to pair within 10 minutes:\n${s.pairing.link}`, { ephemeral: true });
    const note = await updateNote();
    if (note) await session.log(`Pocket Pilot: ${note}`, { level: 'warning' });
  } catch (err) {
    await session.log(`Pocket Pilot: ${err.message}`, { level: 'error' });
  }
}

const tool = {
  name: 'pocket_pilot',
  description: 'Pocket Pilot lets the user continue and control this Copilot session from their phone, tablet or another computer: the same history, live replies, chat, tool approvals and questions, end-to-end encrypted. Call with action "pair" when the user asks to connect, pair or use their phone or another device (it opens a pairing QR code on this PC for the user to scan; never ask the user to share the link or the code with you), "status" to report whether remote access is on and which devices are paired, or "off" when the user asks to turn remote access off. The user can also type /pocket-pilot, /pocket-pilot status or /pocket-pilot off.',
  parameters: { type: 'object', properties: { action: { type: 'string', enum: ['pair', 'status', 'off'], description: 'pair = show the pairing QR code on this PC; status = report remote-access status; off = turn remote access off (closes the tunnel, devices stay paired)' } }, required: ['action'] },
  handler: async (args) => {
    if (args?.action === 'status') {
      const s = await hubRequest('status').catch(() => null);
      const note = await updateNote();
      return [s ? statusText(s) : 'Pocket Pilot remote access is off. The user can turn it on with the /pocket-pilot command.', note].filter(Boolean).join('\n');
    }
    if (args?.action === 'off') {
      await turnOff();
      return 'Pocket Pilot remote access is off: the tunnel is closed. Paired devices stay paired and reconnect when the user turns it on again with /pocket-pilot.';
    }
    const s = await pair();
    if (!s) return 'The user declined to turn on Pocket Pilot remote access.';
    // Never hand the pairing link to the model: it only needs to know where the user should look.
    const where = s.openedIn === 'panel' ? 'in the Pocket Pilot panel next to this chat' : 'on a page in the browser on this PC';
    return `Opened the Pocket Pilot pairing QR code ${where}. Tell the user to scan it with their phone or tablet camera (or open the copied link on another computer) and then allow the device there. The code is single-use and expires in 10 minutes.`;
  },
};

// ------------------------------------------------------------------ start

const VSCODE_NOTE = 'This session runs in VS Code. Pocket Pilot for VS Code handles it: install the "Pocket Pilot" extension (mithawala.pocket-pilot) and click "Start remote access" in its panel. The /pocket-pilot plugin command is for the GitHub Copilot app and CLI.';
// Keeps /pocket-pilot in the slash menu of new chats (see lib/skill.mjs).
if (!process.env.POCKET_PILOT_DISABLE) debug(`skill: ${installSkill({ version: VERSION })}`);
if (process.env.POCKET_PILOT_DISABLE) {
  await joinSession({});
} else if (insideVsCode()) {
  const s = await joinSession({
    tools: [{ ...tool, handler: async () => VSCODE_NOTE }],
    commands: [{ name: 'pocket-pilot', description: COMMAND_DESCRIPTION, handler: async () => s.log(VSCODE_NOTE) }],
  });
} else {
  session = await joinSession({
    tools: [tool],
    commands: [{ name: 'pocket-pilot', description: COMMAND_DESCRIPTION, handler: onCommand }],
    canvases: canvases(),
  });
  session.on((e) => forward(e));
  checkReal().then((isReal) => {
    // Started from a paired device: on the device at once, before its first message.
    if (!isReal && takeExpected(session.sessionId)) real = true;
    if (real && isEnabled()) connectHub({ start: true }).catch(() => watchHub());
    else watchHub();
  });
}
