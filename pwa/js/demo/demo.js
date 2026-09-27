// Demo mode (app/?demo): the real app UI and reducers driven by a scripted, fictional agent host.
// Used by the landing page ("Try the demo") and for screenshots — no network, no pairing.
import { HostStore } from '../model/host-store.js';
import { S, uuid } from '../lib/format.js';

const now = Date.now();
const ago = (min) => new Date(now - min * 60000).toISOString();
const md = (markdown) => ({ markdown });

const CONFIG = {
  schema: {
    type: 'object',
    properties: {
      mode: { type: 'string', title: 'Mode', enum: ['interactive', 'plan', 'autopilot'], enumLabels: ['Interactive', 'Plan', 'Autopilot'], default: 'interactive', sessionMutable: true },
      autoApprove: { type: 'string', title: 'Approvals', enum: ['default', 'assisted', 'autoApprove'], enumLabels: ['Manual permissions', 'Assisted permissions', 'Allow all'], default: 'default', sessionMutable: true },
    },
  },
};

const thinking = (levels, def) => ({ type: 'string', title: 'Thinking Level', enum: levels, enumLabels: levels.map((l) => ({ none: 'None', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra High', max: 'Max' })[l]), default: def });
const context = (sizes, labels, def) => ({ type: 'number', title: 'Context Size', enum: sizes, enumLabels: labels, default: def });
const MODELS = [
  { id: 'auto', name: 'Auto', provider: 'copilotcli', configSchema: { type: 'object', properties: { tier: { type: 'string', title: 'Optimize for', enum: ['efficiency', 'balance', 'intelligence'], enumLabels: ['Efficiency', 'Balance', 'Intelligence'], default: 'balance' } } } },
  { id: 'claude-opus-5.5', name: 'Claude Opus 5.5', provider: 'copilotcli', maxContextWindow: 1000000, supportsVision: true, configSchema: { type: 'object', properties: { thinkingLevel: thinking(['low', 'medium', 'high', 'xhigh', 'max'], 'high'), contextSize: context([200000, 1000000], ['200K', '1M'], 1000000) } } },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', provider: 'copilotcli', maxContextWindow: 1050000, supportsVision: true, configSchema: { type: 'object', properties: { thinkingLevel: thinking(['none', 'low', 'medium', 'high', 'xhigh', 'max'], 'medium'), contextSize: context([272000, 922000], ['272K', '1M'], 272000) } } },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', provider: 'copilotcli', maxContextWindow: 1000000, supportsVision: true, configSchema: { type: 'object', properties: { thinkingLevel: thinking(['low', 'medium', 'high', 'xhigh', 'max'], 'high'), contextSize: context([200000, 936000], ['200K', '1M'], 936000) } } },
  { id: 'gpt-5-mini', name: 'GPT-5 mini', provider: 'copilotcli', maxContextWindow: 264000, configSchema: { type: 'object', properties: { thinkingLevel: thinking(['low', 'medium', 'high'], 'medium') } } },
];

const AGENTS = [
  { provider: 'copilotcli', displayName: 'Copilot', description: 'GitHub Copilot agent', models: MODELS },
  { provider: 'claude', displayName: 'Claude', description: 'Claude agent', models: [{ id: 'claude-opus-5.5', name: 'Claude Opus 5.5', provider: 'claude' }] },
];

function tool(id, toolName, displayName, kind, invocation, past, input, output) {
  return {
    kind: 'toolCall',
    toolCall: {
      status: 'completed', toolCallId: id, toolName, displayName, _meta: { toolKind: kind },
      invocationMessage: md(invocation), pastTenseMessage: md(past), toolInput: JSON.stringify(input),
      confirmed: 'not-needed', success: true, content: output ? [{ type: 'text', text: output }] : [],
    },
  };
}

const userMsg = (text, model = 'claude-opus-5.5') => ({ text, origin: { kind: 'user' }, model: { id: model, config: { thinkingLevel: 'max', contextSize: 1000000 } } });

function folder(name) {
  return `file:///c%3A/Users/you/code/${name}`;
}

function sessionsData() {
  const list = [];
  const add = (id, title, provider, dir, status, minutesAgo, activity, chat) => {
    const resource = `${provider}:/demo-${id}`;
    const chatUri = `ahp-chat://default/demo-${id}`;
    list.push({
      summary: { resource, provider, title, status, createdAt: ago(minutesAgo + 30), modifiedAt: ago(minutesAgo), workingDirectories: [folder(dir)], activity },
      session: { provider, title, status, lifecycle: 'ready', chats: [{ resource: chatUri, title: '', status, modifiedAt: ago(minutesAgo) }], defaultChat: chatUri, workingDirectories: [folder(dir)], config: { ...CONFIG, values: { mode: 'interactive', autoApprove: 'default' } } },
      chat: { resource: chatUri, title: '', status, modifiedAt: ago(minutesAgo), turns: [], ...chat },
      chatUri,
    });
  };

  // 1. Waiting for an approval.
  add('auth', 'Refactor auth module & update tests', 'copilotcli', 'acme-api', S.Input | S.InProgress, 1, 'Waiting for approval', {
    activeTurn: {
      id: 'demo-auth-t1', startedAt: ago(4),
      message: userMsg('Refactor the auth module to use the new token service and update all the tests.'),
      usage: undefined,
      responseParts: [
        { kind: 'reasoning', id: 'r1', content: 'The auth module still calls the legacy session store. I will move token handling into TokenService, update the middleware, then run the whole test suite.' },
        tool('a1', 'view', 'Read', 'read', 'Read [auth/middleware.ts](file:///c%3A/Users/you/code/acme-api/src/auth/middleware.ts)', 'Read [auth/middleware.ts](file:///c%3A/Users/you/code/acme-api/src/auth/middleware.ts)', { path: 'src/auth/middleware.ts' }),
        tool('a2', 'grep', 'Search', 'search', 'Search for `legacySession`', 'Found 7 matches for `legacySession`', { pattern: 'legacySession' }, 'src/auth/middleware.ts:14\nsrc/auth/login.ts:31\nsrc/auth/logout.ts:9\n…'),
        tool('a3', 'edit', 'Edit File', 'edit', 'Edit [auth/middleware.ts]', 'Edited [auth/middleware.ts]', { path: 'src/auth/middleware.ts' }),
        tool('a4', 'edit', 'Edit File', 'edit', 'Edit [auth/login.ts]', 'Edited [auth/login.ts]', { path: 'src/auth/login.ts' }),
        tool('a5', 'create', 'Create File', 'create', 'Create [auth/token-service.ts]', 'Created [auth/token-service.ts]', { path: 'src/auth/token-service.ts' }),
        { kind: 'markdown', id: 'm1', content: 'I moved all token handling into `TokenService` and updated 12 files. Next I want to run the full test suite with coverage.' },
        {
          kind: 'toolCall',
          toolCall: {
            status: 'pending-confirmation', toolCallId: 'demo-approve', toolName: 'powershell', displayName: 'Run Shell Command', _meta: { toolKind: 'terminal' },
            invocationMessage: md('Run the full test suite with coverage'), confirmationTitle: 'Run in terminal?',
            toolInput: JSON.stringify({ command: 'npm test -- --coverage', description: 'Run the test suite' }),
            options: [
              { id: 'allow-session', label: 'Allow in this Session', kind: 'approve', group: 0 },
              { id: 'allow-once', label: 'Allow Once', kind: 'approve', group: 0 },
              { id: 'skip', label: 'Skip', kind: 'deny', group: 1 },
            ],
          },
        },
      ],
    },
  });

  // 2. Working right now.
  add('dark', 'Add dark mode to the settings page', 'copilotcli', 'acme-web', S.InProgress | S.IsRead, 0, 'Editing ThemeToggle.tsx', {
    activeTurn: {
      id: 'demo-dark-t1', startedAt: ago(2), usage: undefined,
      message: userMsg('Add a dark mode toggle to the settings page and remember the choice.'),
      responseParts: [
        tool('d1', 'view', 'Read', 'read', 'Read [settings/Page.tsx]', 'Read [settings/Page.tsx]', { path: 'src/settings/Page.tsx' }),
        tool('d2', 'create', 'Create File', 'create', 'Create [ThemeToggle.tsx]', 'Created [ThemeToggle.tsx]', { path: 'src/settings/ThemeToggle.tsx' }),
        { kind: 'markdown', id: 'dm1', content: 'Added a `ThemeToggle` component that stores the choice in `localStorage`. Now wiring it into the settings page…' },
        { kind: 'toolCall', toolCall: { status: 'running', toolCallId: 'd3', toolName: 'edit', displayName: 'Edit File', _meta: { toolKind: 'edit' }, invocationMessage: md('Edit [settings/Page.tsx]'), toolInput: JSON.stringify({ path: 'src/settings/Page.tsx' }), confirmed: 'not-needed' } },
      ],
    },
  });

  // 3. Finished.
  add('flaky', 'Fix flaky checkout e2e test', 'copilotcli', 'acme-web', S.Idle, 38, undefined, {
    turns: [{
      id: 'demo-flaky-t1', startedAt: ago(45), duration: 96000, state: 'complete', usage: undefined,
      message: userMsg('The checkout e2e test fails about 1 in 5 runs on CI. Find out why and fix it.'),
      responseParts: [
        { kind: 'reasoning', id: 'fr1', content: 'Intermittent failures usually mean a race. Let me look at the test and how it waits for the payment iframe.' },
        tool('f1', 'view', 'Read', 'read', 'Read [e2e/checkout.spec.ts]', 'Read [e2e/checkout.spec.ts]', { path: 'e2e/checkout.spec.ts' }),
        tool('f2', 'powershell', 'Run Shell Command', 'terminal', 'Run `npx playwright test checkout --repeat-each 20`', 'Ran `npx playwright test checkout --repeat-each 20`', { command: 'npx playwright test checkout --repeat-each 20' }, '4 failed, 16 passed\nTimeoutError: locator.click: waiting for "Pay now"'),
        tool('f3', 'edit', 'Edit File', 'edit', 'Edit [e2e/checkout.spec.ts]', 'Edited [e2e/checkout.spec.ts]', { path: 'e2e/checkout.spec.ts' }),
        tool('f4', 'powershell', 'Run Shell Command', 'terminal', 'Run `npx playwright test checkout --repeat-each 50`', 'Ran `npx playwright test checkout --repeat-each 50`', { command: 'npx playwright test checkout --repeat-each 50' }, '50 passed (1.4m)'),
        { kind: 'markdown', id: 'fm1', content: 'Found it: the test clicked **Pay now** before the payment iframe had finished loading, so the click sometimes landed on a disabled button.\n\n```ts\n// before\nawait page.click(\'text=Pay now\');\n\n// after\nconst pay = page.frameLocator(\'#payment\').getByRole(\'button\', { name: \'Pay now\' });\nawait expect(pay).toBeEnabled();\nawait pay.click();\n```\n\nIt now passes **50/50** runs locally. ✅' },
      ],
    }],
  });

  add('node', 'Upgrade the build to Node 24', 'claude', 'infra', S.Idle | S.IsRead, 180, undefined, {
    turns: [{ id: 'demo-node-t1', startedAt: ago(200), duration: 240000, state: 'complete', usage: undefined, message: userMsg('Upgrade our CI images and engines field to Node 24.'), responseParts: [{ kind: 'markdown', id: 'nm1', content: 'Done — CI images, `.nvmrc` and `engines` now target **Node 24**. All pipelines are green.' }] }],
  });
  add('notes', 'Write release notes for v2.3', 'copilotcli', 'acme-web', S.Idle | S.IsRead, 60 * 26, undefined, {
    turns: [{ id: 'demo-notes-t1', startedAt: ago(60 * 26 + 5), duration: 41000, state: 'complete', usage: undefined, message: userMsg('Draft release notes for v2.3 from the merged PRs.'), responseParts: [{ kind: 'markdown', id: 'rm1', content: '## v2.3\n- Dark mode for settings\n- Faster checkout (−38% p95)\n- 14 bug fixes' }] }],
  });
  return list;
}

class DemoConnection extends EventTarget {
  constructor() {
    super();
    this.state = 'online';
    this.detail = '';
    this.stopped = false;
  }
  start() {}
  stop() {}
  poke() {}
  setVisible() {}
  async sendControl() {}
  async upload({ name }) {
    return { ok: true, path: `C:\\Users\\you\\code\\.pocket-pilot\\uploads\\${name}` };
  }
  async subscribePush() {
    return { ok: false, error: 'Notifications are not available in the demo' };
  }
  testPush() {}
  forget() {}
}

class DemoStore extends HostStore {
  constructor(conn) {
    super(conn, { unsubscribeDelayMs: 2 ** 30 });
    this.client = { demo: true };
    this.initialized = true;
    this.ahpConnected = true;
    this.sessionsLoaded = true;
    this.defaultDirectory = 'file:///c%3A/Users/you';
    this.root = { agents: AGENTS };
    this.seq = 1000;
    for (const d of sessionsData()) {
      this.sessions.set(d.summary.resource, d.summary);
      this.sessionState.set(d.summary.resource, d.session);
      this.chatState.set(d.chatUri, d.chat);
      this.snapshotSeq.set(d.summary.resource, 0);
      this.snapshotSeq.set(d.chatUri, 0);
      this.kinds.set(d.chatUri, 'chat');
      this.kinds.set(d.summary.resource, 'session');
    }
    this._tick = setInterval(() => this._advanceBackground(), 2500);
  }

  _subscribe(uri, kind) {
    this.kinds.set(uri, kind);
    this.subscribed.add(uri);
  }

  _release(uri) {
    this.subscribed.delete(uri);
  }

  async refreshSessions() {}

  _dispatch(channel, action) {
    this._apply({ channel, action, serverSeq: ++this.seq, origin: { clientId: this.clientId, clientSeq: this.seq } });
    this._react(channel, action).catch((err) => console.warn('demo', err));
  }

  _sessionOfChat(chat) {
    for (const [uri, st] of this.sessionState) if (st.defaultChat === chat) return uri;
    return null;
  }

  _setSummary(uri, patch) {
    const s = this.sessions.get(uri);
    if (!s) return;
    this.sessions.set(uri, { ...s, ...patch, modifiedAt: new Date().toISOString() });
    this._emit('sessions', uri);
  }

  _chat(chat, fn) {
    const cs = this.chatState.get(chat);
    if (!cs) return;
    this.chatState.set(chat, fn(cs));
    this._emit('chat', chat);
  }

  _parts(chat, fn) {
    this._chat(chat, (cs) => (cs.activeTurn ? { ...cs, activeTurn: { ...cs.activeTurn, responseParts: fn(cs.activeTurn.responseParts) } } : cs));
  }

  async _stream(chat, text) {
    const id = uuid();
    this._parts(chat, (p) => [...p, { kind: 'markdown', id, content: '' }]);
    for (let i = 0; i < text.length; i += 4) {
      await new Promise((r) => setTimeout(r, 28));
      const content = text.slice(0, i + 4);
      this._parts(chat, (p) => p.map((x) => (x.id === id ? { ...x, content } : x)));
    }
  }

  _finish(chat, sessionUri) {
    this._chat(chat, (cs) => {
      if (!cs.activeTurn) return cs;
      const t = cs.activeTurn;
      return { ...cs, activeTurn: undefined, status: S.Idle, turns: [...cs.turns, { ...t, state: 'complete', duration: Date.now() - Date.parse(t.startedAt) }] };
    });
    this._setSummary(sessionUri, { status: S.Idle | S.IsRead, activity: undefined });
  }

  async _react(channel, action) {
    const chat = channel;
    const sessionUri = this._sessionOfChat(chat);
    if (!sessionUri) return;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    if (action.type === 'chat/turnStarted') {
      this._setSummary(sessionUri, { status: S.InProgress | S.IsRead, activity: 'Thinking…' });
      await wait(700);
      this._parts(chat, (p) => [...p, { kind: 'reasoning', id: uuid(), content: 'The user is trying the Pocket Pilot demo.' }]);
      await wait(500);
      await this._stream(chat, '👋 This is the **Pocket Pilot demo**. On your phone, this message would go straight to the agent session on your PC — the very same session you see in VS Code — and you would watch it work live, just like this.\n\n- Approve or skip tool calls\n- Answer the agent\'s questions\n- Get a push notification when it\'s done');
      this._finish(chat, sessionUri);
    } else if (action.type === 'chat/toolCallConfirmed') {
      this._setSummary(sessionUri, { status: S.InProgress | S.IsRead, activity: action.approved ? 'Running tests' : 'Skipping tests' });
      if (!action.approved) {
        await wait(500);
        await this._stream(chat, 'Okay, I skipped the test run. The refactor is complete — run `npm test` whenever you are ready.');
        this._finish(chat, sessionUri);
        return;
      }
      await wait(1600);
      this._parts(chat, (p) => p.map((x) => (x.kind === 'toolCall' && x.toolCall.toolCallId === action.toolCallId
        ? { ...x, toolCall: { ...x.toolCall, status: 'completed', success: true, pastTenseMessage: md('Ran `npm test -- --coverage`'), content: [{ type: 'text', text: 'PASS  src/auth/token-service.test.ts\nPASS  src/auth/middleware.test.ts\n\nTests:  42 passed, 42 total\nCoverage: 94.1% statements' }] } }
        : x)));
      await wait(400);
      await this._stream(chat, 'All **42 tests pass** and coverage went up to **94%**. ✅ The auth module now uses `TokenService` everywhere — want me to open a pull request?');
      this._finish(chat, sessionUri);
    } else if (action.type === 'chat/turnCancelled') {
      this._setSummary(sessionUri, { status: S.Idle | S.IsRead, activity: undefined });
    }
  }

  /** Keeps the "working" session alive so the list shows live activity. */
  _advanceBackground() {
    const uri = 'copilotcli:/demo-dark';
    const chat = 'ahp-chat://default/demo-dark';
    const cs = this.chatState.get(chat);
    if (!cs?.activeTurn) return;
    const steps = ['Editing settings/Page.tsx', 'Running unit tests', 'Updating snapshots', 'Editing ThemeToggle.tsx'];
    this._setSummary(uri, { activity: steps[Math.floor(Date.now() / 2500) % steps.length] });
  }

  async loadOlder() {}

  async listDirectory() {
    return ['acme-api', 'acme-web', 'infra', 'notes'];
  }

  async readFile(uri) {
    return { data: `// ${decodeURIComponent(uri.split('/').pop())}\n// (demo) The real app shows the file from your PC here.\nexport function example() {\n  return 42;\n}\n`, encoding: 'utf-8' };
  }

  async createSession({ provider, folder: dir, config, text, model }) {
    const id = uuid().slice(0, 8);
    const resource = `${provider}:/demo-${id}`;
    const chatUri = `ahp-chat://default/demo-${id}`;
    const title = (text || 'New session').slice(0, 48);
    const values = { mode: config?.mode || 'interactive', autoApprove: config?.autoApprove || 'default' };
    this.sessions.set(resource, { resource, provider, title, status: S.Idle | S.IsRead, createdAt: new Date().toISOString(), modifiedAt: new Date().toISOString(), workingDirectories: [dir] });
    this.sessionState.set(resource, { provider, title, status: S.Idle, lifecycle: 'ready', chats: [{ resource: chatUri, title: '', status: S.Idle, modifiedAt: new Date().toISOString() }], defaultChat: chatUri, workingDirectories: [dir], config: { ...CONFIG, values } });
    this.chatState.set(chatUri, { resource: chatUri, title: '', status: S.Idle, modifiedAt: new Date().toISOString(), turns: [] });
    this.snapshotSeq.set(resource, 0);
    this.snapshotSeq.set(chatUri, 0);
    this.kinds.set(chatUri, 'chat');
    this._emit('sessions');
    if (text) this.sendMessage(resource, { text, model });
    return resource;
  }

  async disposeSession(uri) {
    this.sessions.delete(uri);
    this._emit('sessions');
  }

  dispose() {
    clearInterval(this._tick);
    this.client = null;
    super.dispose();
  }
}

export const DEMO_HOST = {
  hostId: 'demo',
  hostName: 'Studio PC (demo)',
  hostPublicKey: 'BHjhgDkJkMQ3fW9kl8pHfK3m2QmWc8m8Xy4n6oV0Yp2uQw1rT5zL7sA9dE3fG5hJ7kL9mN1pQ3rS5tU7vW9xY1Q',
  passkey: true,
  rendezvous: null,
  pairedAt: now,
  demo: true,
};

export function createDemo() {
  const conn = new DemoConnection();
  const store = new DemoStore(conn);
  return { host: DEMO_HOST, conn, store };
}
