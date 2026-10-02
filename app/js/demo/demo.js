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

const userMsg = (text, model = 'claude-opus-5.5', config = { thinkingLevel: 'max', contextSize: 1000000 }) => ({ text, origin: { kind: 'user' }, model: { id: model, config } });

// A pasted screenshot, the way VS Code keeps it: a file on the PC that the app reads when it's shown.
const DEMO_PICTURE = 'file:///c%3A/Users/you/AppData/Roaming/Code/agentSessionData/demo-dark/attachments/demo/Pasted%20Image.png';
const pictureOf = (uri, label) => ({ type: 'resource', uri, label, displayKind: 'image', _meta: { 'vscode.agentHost.snapshotAttachment': { isSnapshot: true, contentType: 'image/png' } } });

// The settings page before dark mode, drawn as an SVG.
function settingsScreenshot() {
  const row = (y, label, value) => `<rect x="24" y="${y}" width="342" height="52" rx="10" fill="#fff" stroke="#e3e6ea"/><text x="42" y="${y + 32}" font-size="16" fill="#1f2328">${label}</text><text x="348" y="${y + 32}" font-size="15" fill="#6e7781" text-anchor="end">${value}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="390" height="640" viewBox="0 0 390 640" font-family="Segoe UI, -apple-system, sans-serif">
<rect width="390" height="640" fill="#f6f8fa"/><rect width="390" height="64" fill="#fff"/><rect y="63" width="390" height="1" fill="#e3e6ea"/>
<text x="24" y="41" font-size="21" font-weight="700" fill="#1f2328">Settings</text><circle cx="356" cy="32" r="15" fill="#dbe9ff"/><text x="356" y="38" font-size="14" font-weight="700" fill="#2f6feb" text-anchor="middle">AK</text>
<text x="28" y="104" font-size="12" font-weight="700" fill="#6e7781" letter-spacing="1">ACCOUNT</text>
${row(116, 'Profile', 'Ada K.')}${row(176, 'Notifications', 'On')}${row(236, 'Language', 'English')}
<text x="28" y="330" font-size="12" font-weight="700" fill="#6e7781" letter-spacing="1">APPEARANCE</text>
${row(342, 'Theme', 'Light only')}${row(402, 'Text size', 'Default')}
<rect x="24" y="482" width="342" height="92" rx="10" fill="#fff8c5" stroke="#eac54f"/><text x="42" y="514" font-size="15" font-weight="600" fill="#7d4e00">No dark mode yet</text>
<text x="42" y="540" font-size="14" fill="#7d4e00">Add a toggle here that remembers</text><text x="42" y="560" font-size="14" fill="#7d4e00">the choice.</text>
</svg>`;
}

function folder(name) {
  return `file:///c%3A/Users/you/code/${name}`;
}

const CHANGES = {
  auth: { additions: 214, deletions: 87, files: 12 },
  dark: { additions: 96, deletions: 4, files: 3 },
  flaky: { additions: 18, deletions: 9, files: 2 },
  node: { additions: 41, deletions: 38, files: 6 },
  notes: { additions: 132, deletions: 0, files: 1 },
};

function sessionsData() {
  const list = [];
  const add = (id, title, provider, dir, status, minutesAgo, activity, chat) => {
    const resource = `${provider}:/demo-${id}`;
    const chatUri = `ahp-chat://default/demo-${id}`;
    list.push({
      summary: {
        resource, provider, title, status, createdAt: ago(minutesAgo + 30), modifiedAt: ago(minutesAgo), workingDirectories: [folder(dir)], activity,
        project: { uri: folder(dir), displayName: dir }, ...(CHANGES[id] ? { changes: CHANGES[id] } : {}),
      },
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
        tool('a3', 'edit', 'Edit File', 'edit', 'Edit [auth/middleware.ts](file:///c%3A/Users/you/code/acme-api/src/auth/middleware.ts)', 'Edited [auth/middleware.ts](file:///c%3A/Users/you/code/acme-api/src/auth/middleware.ts)', { path: 'src/auth/middleware.ts' }),
        tool('a4', 'edit', 'Edit File', 'edit', 'Edit [auth/login.ts](file:///c%3A/Users/you/code/acme-api/src/auth/login.ts)', 'Edited [auth/login.ts](file:///c%3A/Users/you/code/acme-api/src/auth/login.ts)', { path: 'src/auth/login.ts' }),
        tool('a5', 'create', 'Create File', 'create', 'Create [auth/token-service.ts](file:///c%3A/Users/you/code/acme-api/src/auth/token-service.ts)', 'Created [auth/token-service.ts](file:///c%3A/Users/you/code/acme-api/src/auth/token-service.ts)', { path: 'src/auth/token-service.ts' }),
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

  // 1b. The agent asked a question.
  add('dates', 'Pick a date library for the booking form', 'copilotcli', 'acme-web', S.Input | S.InProgress | S.IsRead, 7, 'Waiting for your answer', {
    activeTurn: {
      id: 'demo-dates-t1', startedAt: ago(9), usage: undefined,
      message: userMsg('The booking form needs a date picker. Pick a date library and wire it up.', 'gpt-5.6-sol', { thinkingLevel: 'high', contextSize: 272000 }),
      responseParts: [
        { kind: 'reasoning', id: 'q1', content: 'There is no date library yet, and the options trade bundle size for API style. The team should choose.' },
        tool('q2', 'grep', 'Search', 'search', 'Search for `moment|dayjs|date-fns`', 'Searched for `moment|dayjs|date-fns`, no results', { pattern: 'moment|dayjs|date-fns' }),
        {
          kind: 'inputRequest',
          request: {
            id: 'demo-question', message: 'The project has no date library yet. Which one should I add?',
            questions: [{
              id: 'lib', kind: 'single-select', title: 'Date library', message: 'All three are tree-shakeable and handle time zones.', required: true, allowFreeformInput: true,
              options: [
                { id: 'date-fns', label: 'date-fns', description: 'Plain functions, about 6 KB for what the form needs', recommended: true },
                { id: 'dayjs', label: 'Day.js', description: 'Moment-style API, 2 KB core plus plugins' },
                { id: 'temporal', label: 'Temporal polyfill', description: 'The upcoming standard; larger today' },
              ],
            }],
          },
        },
      ],
    },
  });

  // 2. Working right now.
  add('dark', 'Add dark mode to the settings page', 'copilotcli', 'acme-web', S.InProgress | S.IsRead, 0, 'Editing ThemeToggle.tsx', {
    activeTurn: {
      id: 'demo-dark-t1', startedAt: ago(2), usage: undefined,
      message: { ...userMsg('Add a dark mode toggle to the settings page and remember the choice. This is how it looks now:'), attachments: [pictureOf(DEMO_PICTURE, 'Pasted Image')] },
      responseParts: [
        tool('d1', 'view', 'Read', 'read', 'Read [settings/Page.tsx](file:///c%3A/Users/you/code/acme-web/src/settings/Page.tsx)', 'Read [settings/Page.tsx](file:///c%3A/Users/you/code/acme-web/src/settings/Page.tsx)', { path: 'src/settings/Page.tsx' }),
        tool('d2', 'create', 'Create File', 'create', 'Create [ThemeToggle.tsx](file:///c%3A/Users/you/code/acme-web/src/settings/ThemeToggle.tsx)', 'Created [ThemeToggle.tsx](file:///c%3A/Users/you/code/acme-web/src/settings/ThemeToggle.tsx)', { path: 'src/settings/ThemeToggle.tsx' }),
        { kind: 'markdown', id: 'dm1', content: 'Added a `ThemeToggle` component that stores the choice in `localStorage`. Now wiring it into the settings page…' },
        { kind: 'toolCall', toolCall: { status: 'running', toolCallId: 'd3', toolName: 'edit', displayName: 'Edit File', _meta: { toolKind: 'edit' }, invocationMessage: md('Edit [settings/Page.tsx](file:///c%3A/Users/you/code/acme-web/src/settings/Page.tsx)'), toolInput: JSON.stringify({ path: 'src/settings/Page.tsx' }), confirmed: 'not-needed' } },
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
        tool('f1', 'view', 'Read', 'read', 'Read [e2e/checkout.spec.ts](file:///c%3A/Users/you/code/acme-web/e2e/checkout.spec.ts)', 'Read [e2e/checkout.spec.ts](file:///c%3A/Users/you/code/acme-web/e2e/checkout.spec.ts)', { path: 'e2e/checkout.spec.ts' }),
        tool('f2', 'powershell', 'Run Shell Command', 'terminal', 'Run `npx playwright test checkout --repeat-each 20`', 'Ran `npx playwright test checkout --repeat-each 20`', { command: 'npx playwright test checkout --repeat-each 20' }, '4 failed, 16 passed\nTimeoutError: locator.click: waiting for "Pay now"'),
        tool('f3', 'edit', 'Edit File', 'edit', 'Edit [e2e/checkout.spec.ts](file:///c%3A/Users/you/code/acme-web/e2e/checkout.spec.ts)', 'Edited [e2e/checkout.spec.ts](file:///c%3A/Users/you/code/acme-web/e2e/checkout.spec.ts)', { path: 'e2e/checkout.spec.ts' }),
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
    this._drainQueue(chat);
  }

  /** Like a real host: once the agent is idle, the next queued message starts a turn. */
  _drainQueue(chat) {
    const next = this.chatState.get(chat)?.queuedMessages?.[0];
    if (!next || this.chatState.get(chat)?.activeTurn) return;
    setTimeout(() => {
      this._dispatch(chat, { type: 'chat/pendingMessageRemoved', kind: 'queued', id: next.id });
      this._dispatch(chat, { type: 'chat/turnStarted', turnId: uuid(), startedAt: new Date().toISOString(), message: next.message, queuedMessageId: next.id });
    }, 300);
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
    } else if (action.type === 'chat/inputCompleted') {
      const answer = action.answers?.lib?.value;
      const picked = answer?.value;
      // An answer in the user's own words: that library, if it looks like a package name.
      const own = answer?.kind === 'text' ? String(picked).trim() : '';
      const name = own || { 'date-fns': 'date-fns', dayjs: 'Day.js', temporal: 'the Temporal polyfill' }[picked] || 'date-fns';
      const pkg = own ? (/^@?[a-z0-9][\w.-]*(\/[\w.-]+)?$/i.test(own) ? own.toLowerCase() : 'date-fns') : { 'date-fns': 'date-fns', dayjs: 'dayjs', temporal: '@js-temporal/polyfill' }[picked] || 'date-fns';
      this._setSummary(sessionUri, { status: S.InProgress | S.IsRead, activity: `Installing ${pkg}` });
      await wait(900);
      this._parts(chat, (p) => [...p, tool(uuid(), 'powershell', 'Run Shell Command', 'terminal', `Run \`npm install ${pkg}\``, `Ran \`npm install ${pkg}\``, { command: `npm install ${pkg}` }, `added 1 package in 2s`)]);
      await wait(500);
      await this._stream(chat, `${action.response === 'accept' ? `Going with **${name}**.` : 'No preference, so I went with **date-fns**.'} The booking form now uses a \`<DatePicker>\` with localized labels:\n\n\`\`\`tsx\nimport { format } from '${pkg === 'date-fns' ? 'date-fns' : pkg}';\n\nexport function BookingDate({ value, onChange }: Props) {\n  return (\n    <DatePicker\n      value={value}\n      onChange={onChange}\n      label={(d) => format(d, 'PPP')}\n    />\n  );\n}\n\`\`\``);
      this._finish(chat, sessionUri);
    } else if (action.type === 'chat/turnCancelled') {
      this._setSummary(sessionUri, { status: S.Idle | S.IsRead, activity: undefined });
      this._drainQueue(chat);
    } else if (action.type === 'chat/pendingMessageSet' && action.kind === 'steering') {
      // The running agent picks the guidance up, like VS Code's "Steer with Message".
      await wait(900);
      this._dispatch(chat, { type: 'chat/pendingMessageRemoved', kind: 'steering', id: action.id });
      if (this.chatState.get(chat)?.activeTurn) await this._stream(chat, `Got it — adjusting course: *${action.message.text.replace(/[*_`]/g, '')}*`);
    } else if (action.type === 'chat/pendingMessageSet' && action.kind === 'queued' && !this.chatState.get(chat)?.activeTurn) {
      this._drainQueue(chat);
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

  async readImage(uri) {
    if (uri !== DEMO_PICTURE) throw new Error('This picture is only on the PC (demo)');
    return { data: btoa(settingsScreenshot()), encoding: 'base64', contentType: 'image/svg+xml' };
  }

  async createSession({ provider, folder: dir, config, text, model, attachments, prepare }) {
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
    const all = [...(attachments || []), ...((prepare && (await prepare(resource))) || [])];
    if (text || all.length) this.sendMessage(resource, { text: text || '', model, attachments: all });
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
