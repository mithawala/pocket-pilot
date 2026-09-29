import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { CopilotAgentHost } from '../copilot-plugin/com.github.copilot/extensions/pocket-pilot/lib/agent-host.mjs';
import { SessionTranslator, messageAttachments } from '../copilot-plugin/com.github.copilot/extensions/pocket-pilot/lib/translate.mjs';
import { rootReducer, sessionReducer, chatReducer, SUPPORTED_PROTOCOL_VERSIONS } from '../pwa/vendor/ahp/types/index.js';

const require = createRequire(import.meta.url);
const { isSessionAttachment, sessionIdOf } = require('../extension/core/attachments.js');

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001', 'hex');

test('vs code: the phone may read what was pasted into a chat on this PC, nothing else there', () => {
  const userData = path.join(os.tmpdir(), 'Code');
  const sessions = ['copilotcli:/4699dd55-5d4c-47a7-8ca9-823281324c26', 'claude:/abc'];
  const inSession = (id, ...rest) => path.join(userData, 'agentSessionData', id, 'attachments', ...rest);
  assert.equal(sessionIdOf('copilotcli:/4699dd55-5d4c-47a7-8ca9-823281324c26'), '4699dd55-5d4c-47a7-8ca9-823281324c26');
  assert.equal(sessionIdOf('copilotcli:/..'), null);
  assert.equal(sessionIdOf('copilotcli:/a/b'), null);
  assert.equal(isSessionAttachment(inSession('4699dd55-5d4c-47a7-8ca9-823281324c26', '8df4', 'Pasted Image.png'), userData, sessions), true);
  assert.equal(isSessionAttachment(inSession('abc', 'x', 'photo.jpg'), userData, sessions), true);
  assert.equal(isSessionAttachment(inSession('other-session', 'x', 'photo.jpg'), userData, sessions), false, 'a session this PC no longer lists');
  assert.equal(isSessionAttachment(path.join(userData, 'agentSessionData', 'abc', 'state.json'), userData, sessions), false, 'only the attachments folder');
  assert.equal(isSessionAttachment(inSession('abc', '..', '..', '..', 'User', 'settings.json'), userData, sessions), false, 'no way out with ..');
  assert.equal(isSessionAttachment(inSession('abc', 'x.png'), null, sessions), false);
});

test('copilot app: pictures in a message reach the phone, and only attached files can be read', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-att-'));
  const shot = path.join(dir, 'screenshot.png');
  fs.writeFileSync(shot, PNG);
  const secret = path.join(dir, 'secret.png');
  fs.writeFileSync(secret, PNG);

  const files = [];
  const atts = messageAttachments([
    { type: 'file', path: shot, displayName: 'screenshot.png' },
    { type: 'blob', data: PNG.toString('base64'), mimeType: 'image/png', displayName: 'Pasted image' },
    { type: 'blob', mimeType: 'image/png', displayName: 'Old image' },
    { type: 'directory', path: dir, displayName: 'src' },
    { type: 'github_reference', title: 'ignored' },
  ], (p) => files.push(p));
  assert.deepEqual(atts.map((a) => [a.type, a.label, a.displayKind || '']), [
    ['resource', 'screenshot.png', 'image'],
    ['embeddedResource', 'Pasted image', 'image'],
    ['simple', 'Old image', 'image'],
    ['simple', 'src', ''],
  ]);
  assert.equal(atts[0].uri, pathToFileURL(shot).href);
  assert.deepEqual(files, [shot]);

  const host = new CopilotAgentHost({ reducers: { rootReducer, sessionReducer, chatReducer }, supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS] });
  const cwd = path.join(os.tmpdir(), 'pp-att-cwd');
  host.attach({
    sessionId: 'p1', cwd, title: 'Pictures', bridge: { request: async () => true },
    history: [{ type: 'user.message', id: 'e1', timestamp: new Date().toISOString(), data: { content: 'Look at this', messageId: 'm1', attachments: [{ type: 'file', path: shot, displayName: 'screenshot.png' }] } }],
  });
  const r = host._read(pathToFileURL(shot).href, 'base64');
  assert.equal(r.encoding, 'base64');
  assert.equal(r.contentType, 'image/png');
  assert.equal(Buffer.from(r.data, 'base64').subarray(0, 4).toString('hex'), '89504e47');
  assert.throws(() => host._read(pathToFileURL(secret).href, 'base64'), /outside your session folders/, 'a picture nobody attached stays private');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('copilot app: the translator puts attachments on the turn it starts', () => {
  const actions = [];
  const t = new SessionTranslator({ emit: (a) => actions.push(a) });
  const shot = path.join(os.tmpdir(), 'pp-shot.png');
  t.replay([{ type: 'user.message', id: 'e1', timestamp: new Date().toISOString(), data: { content: 'See the screenshot', messageId: 'm1', attachments: [{ type: 'file', path: shot, displayName: 'shot.png' }] } }]);
  let chat = { resource: 'c', title: '', status: 1, modifiedAt: '', turns: [] };
  for (const a of actions) chat = chatReducer(chat, a);
  const msg = chat.turns[0].message;
  assert.equal(msg.text, 'See the screenshot');
  assert.deepEqual(msg.attachments.map((a) => [a.type, a.label, a.displayKind]), [['resource', 'shot.png', 'image']]);
  assert.equal(t.files.size, 1);
});
