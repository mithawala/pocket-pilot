import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const temp = [];
const tempDir = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temp.push(dir);
  return dir;
};
after(() => {
  for (const dir of temp) fs.rmSync(dir, { recursive: true, force: true });
});

process.env.POCKET_PILOT_HOME = tempDir('pp-new-attach-');
const lib = '../copilot-plugin/com.github.copilot/extensions/pocket-pilot/lib';
const { CopilotAgentHost } = await import(`${lib}/agent-host.mjs`);
const { rootReducer, sessionReducer, chatReducer, SUPPORTED_PROTOCOL_VERSIONS } = await import('../pwa/vendor/ahp/types/index.js');
const { HostStore } = await import('../pwa/js/model/host-store.js');
const { MAX_UPLOAD, prepareFile, attachmentItems, uploadFile, previewItems, pastedFiles, filesOnlyText } = await import('../pwa/js/lib/uploads.js');
const { answerFor } = await import('../pwa/js/ui/parts.js');
const agentHost = createRequire(import.meta.url)('../extension/core/agentHost.js');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const css = read('pwa', 'css', 'app.css');
const rule = (selector) => {
  const line = css.split('\n').find((l) => l.startsWith(`${selector} {`));
  assert.ok(line, `app.css has a rule for ${selector}`);
  return line;
};

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const toJpeg = async () => JPEG;
const unreadable = async () => null;
const file = (name, type, bytes = [1, 2, 3]) => new File([new Uint8Array(bytes)], name, { type });
const base64 = (bytes) => Buffer.from(bytes).toString('base64');

async function until(fn, ms = 4000) {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('uploads: pictures become JPEGs; other files, and pictures the browser cannot read, stay as they are', async () => {
  let f = await prepareFile(file('IMG_0001.HEIC', 'image/heic'), { convert: toJpeg });
  assert.deepEqual(f, { name: 'IMG_0001.jpg', mime: 'image/jpeg', data: base64(JPEG), size: 4, picture: true });
  f = await prepareFile(file('photo.jpeg', 'image/jpeg'), { convert: toJpeg });
  assert.equal(f.name, 'photo.jpeg', 'already a JPEG name');
  f = await prepareFile(file('.png', 'image/png'), { convert: toJpeg });
  assert.equal(f.name, 'photo.jpg');
  // Not converted: the name and type stay true to the bytes, and only formats models take go inline.
  f = await prepareFile(file('diagram.svg', 'image/svg+xml'), { convert: unreadable });
  assert.deepEqual(f, { name: 'diagram.svg', mime: 'image/svg+xml', data: base64([1, 2, 3]), size: 3, picture: false });
  f = await prepareFile(file('IMG_0002.HEIC', 'image/heic'), { convert: unreadable });
  assert.deepEqual([f.name, f.mime, f.picture], ['IMG_0002.HEIC', 'image/heic', false]);
  f = await prepareFile(file('chart.png', 'image/png'), { convert: unreadable });
  assert.deepEqual([f.name, f.mime, f.picture], ['chart.png', 'image/png', true]);
  f = await prepareFile(file('notes.txt', 'text/plain'), { convert: () => assert.fail('only pictures are converted') });
  assert.deepEqual(f, { name: 'notes.txt', mime: 'text/plain', data: base64([1, 2, 3]), size: 3, picture: false });
  f = await prepareFile(file('', ''));
  assert.deepEqual([f.name, f.mime], ['upload', 'application/octet-stream']);
  await assert.rejects(prepareFile({ name: 'clip.mov', type: 'video/quicktime', size: MAX_UPLOAD + 1 }), /clip\.mov is larger than 20 MB/);
});

test('uploads: the agent gets the path on the PC, and the model sees small pictures', async () => {
  const pic = { name: 'shot.jpg', mime: 'image/jpeg', data: 'AAAA', size: 3, picture: true };
  const at = 'C:\\work\\app\\.pocket-pilot\\uploads\\2026-01-01T10-00-00-shot.jpg';
  const items = attachmentItems(pic, at, 'phone');
  assert.deepEqual(items, [
    { type: 'simple', label: 'shot.jpg', modelRepresentation: `The user sent a file from their phone (Pocket Pilot). It is saved on this machine at: ${at}` },
    { type: 'embeddedResource', label: 'shot.jpg', data: 'AAAA', contentType: 'image/jpeg' },
  ]);
  // The Copilot app plugin turns the note into a file attachment with this pattern (extension.mjs toPrompt).
  const plugin = read('copilot-plugin', 'com.github.copilot', 'extensions', 'pocket-pilot', 'extension.mjs');
  assert.ok(plugin.includes('/saved on this machine at: (.+)$/m'));
  assert.equal(/saved on this machine at: (.+)$/m.exec(items[0].modelRepresentation)[1], at);
  assert.equal(attachmentItems({ ...pic, size: 3 * 1024 * 1024 }, at, 'phone').length, 1, 'a big picture is only saved');
  assert.equal(attachmentItems({ ...pic, name: 'a.pdf', mime: 'application/pdf', picture: false }, at, 'phone').length, 1);
  assert.match(attachmentItems(pic, at, 'other computer')[0].modelRepresentation, /from their other computer/);
  assert.deepEqual(previewItems(pic), [items[1]]);
  assert.deepEqual(previewItems({ ...pic, picture: false }), []);

  const sent = [];
  const conn = { upload: async (m) => (sent.push(m), { path: at, uri: pathToFileURL(at).href }) };
  const up = await uploadFile(conn, 'copilotcli:/abc', pic);
  assert.deepEqual(sent, [{ session: 'copilotcli:/abc', name: 'shot.jpg', mime: 'image/jpeg', data: 'AAAA' }]);
  assert.deepEqual(up, items, 'from a phone (no fine pointer here)');
});

test('uploads: a pasted screenshot gets a name, copied files keep theirs, pasted text stays text', () => {
  const clip = (files, text = '') => ({
    items: [...files.map((f) => ({ kind: 'file', getAsFile: () => f })), ...(text ? [{ kind: 'string', getAsFile: () => null }] : [])],
    getData: (t) => (t === 'text/plain' ? text : ''),
  });
  const shot = file('image.png', 'image/png');
  const doc = file('report.pdf', 'application/pdf');
  const photo = file('beach.jpg', 'image/jpeg');
  assert.equal(pastedFiles(clip([shot], 'some text')), null, 'text with a picture of it (Word, Excel) pastes the text');
  assert.equal(pastedFiles(clip([])), null);
  assert.equal(pastedFiles(undefined), null);
  assert.deepEqual(pastedFiles(clip([shot])).map((f) => [f.name, f.type]), [['Pasted image.png', 'image/png']]);
  assert.deepEqual(pastedFiles(clip([shot, shot, doc, photo]), 1).map((f) => f.name), ['Pasted image 2.png', 'Pasted image 3.png', 'report.pdf', 'beach.jpg']);
});

function fakeBridge() {
  const calls = [];
  return { calls, request: async (op, params) => (calls.push({ op, params }), true) };
}

function fakeConnection(transport) {
  const conn = new EventTarget();
  conn.state = 'online';
  queueMicrotask(() => conn.dispatchEvent(new CustomEvent('ready', { detail: { transport } })));
  return conn;
}

/** The Copilot app plugin's host, starting sessions the way the hub does, and a phone connected to it. */
async function phoneAndHost() {
  const bridge = fakeBridge();
  const host = new CopilotAgentHost({
    reducers: { rootReducer, sessionReducer, chatReducer }, supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
    createSession: async (req) => {
      setTimeout(() => host.attach({ sessionId: req.sessionId, cwd: req.cwd, title: 'New session', history: [], bridge }), 30);
    },
  });
  host.setModels([{ id: 'gpt-5.4', name: 'GPT-5.4', policy: { state: 'enabled' }, capabilities: { supports: { vision: true } } }]);
  const store = new HostStore(fakeConnection(agentHost.transportFor(host.openConnection())), { unsubscribeDelayMs: 10 });
  await until(() => store.sessionsLoaded);
  return { bridge, host, store, close: () => (store.dispose(), host.closeAll()) };
}

test('new session with a photo: it goes to the new session\'s folder first, then the first message carries it', async () => {
  const { bridge, host, store, close } = await phoneAndHost();
  const dir = tempDir('pp-new-attach-cwd-');
  try {
    const saved = [];
    // The hub saves an upload in the folder of the session it names (hub.mjs saveUpload).
    const conn = {
      upload: async ({ session, name }) => {
        const cwd = host.sessions.get(session)?.cwd;
        assert.equal(cwd, dir, 'the PC knows the new session and its folder when the file arrives');
        assert.equal(bridge.calls.some((c) => c.op === 'send'), false, 'before the first message');
        const at = path.join(cwd, '.pocket-pilot', 'uploads', name);
        saved.push(at);
        return { path: at, uri: pathToFileURL(at).href };
      },
    };
    const photo = await prepareFile(file('IMG_7.HEIC', 'image/heic'), { convert: toJpeg });
    const notes = await prepareFile(file('notes.txt', 'text/plain'));
    const uri = await store.createSession({
      provider: 'copilotcli', folder: pathToFileURL(dir).href, text: 'What is in this picture?', modelAtStart: true,
      prepare: async (sessionUri) => [...(await uploadFile(conn, sessionUri, photo)), ...(await uploadFile(conn, sessionUri, notes))],
    });
    assert.deepEqual(saved, [path.join(dir, '.pocket-pilot', 'uploads', 'IMG_7.jpg'), path.join(dir, '.pocket-pilot', 'uploads', 'notes.txt')]);
    const send = await until(() => bridge.calls.find((c) => c.op === 'send'));
    assert.equal(send.params.prompt, 'What is in this picture?');
    assert.deepEqual(send.params.attachments.map((a) => [a.type, a.label]), [['simple', 'IMG_7.jpg'], ['embeddedResource', 'IMG_7.jpg'], ['simple', 'notes.txt']]);
    assert.match(send.params.attachments[2].modelRepresentation, /saved on this machine at: .*notes\.txt$/);
    assert.equal(store.sessions.has(uri), true);

    // Just files: the phone writes the words, which the plugin requires.
    bridge.calls.length = 0;
    await store.createSession({ provider: 'copilotcli', folder: pathToFileURL(dir).href, text: filesOnlyText([notes.picture]), prepare: (sessionUri) => uploadFile(conn, sessionUri, notes) });
    const only = await until(() => bridge.calls.find((c) => c.op === 'send'));
    assert.equal(only.params.prompt, 'Take a look at this file.');
    assert.deepEqual(only.params.attachments.map((a) => a.label), ['notes.txt']);
  } finally {
    close();
  }
});

test('a message of just files gets words, in the chat box and in New session', () => {
  assert.equal(filesOnlyText([true]), 'Take a look at this picture.');
  assert.equal(filesOnlyText([false]), 'Take a look at this file.');
  assert.equal(filesOnlyText([true, true]), 'Take a look at these pictures.');
  assert.equal(filesOnlyText([true, false]), 'Take a look at these files.');
  assert.match(read('pwa', 'js', 'ui', 'composer.js'), /const t = text\.trim\(\) \|\| filesOnlyText\(attachments\.map\(\(a\) => !!a\.picture\)\);/);
  assert.match(read('pwa', 'js', 'ui', 'sessions.js'), /text: message \|\| \(chosen\.length \? filesOnlyText\(chosen\.map\(\(f\) => f\.file\.picture\)\) : ''\),/);
});

test('new session with a photo that does not arrive: no message goes out, and the error names the session to open', async () => {
  const { bridge, store, close } = await phoneAndHost();
  const dir = tempDir('pp-new-attach-fail-');
  try {
    const conn = { upload: async () => { throw new Error('The PC could not save the file'); } };
    const photo = await prepareFile(file('a.png', 'image/png'), { convert: toJpeg });
    let failed;
    await assert.rejects(store.createSession({ provider: 'copilotcli', folder: pathToFileURL(dir).href, text: 'Look at this', prepare: (u) => uploadFile(conn, u, photo) }), (err) => {
      failed = err;
      return /could not save the file/.test(err.message);
    });
    assert.match(failed.sessionUri, /^copilotcli:\/[0-9a-f-]{36}$/);
    assert.equal(store.sessions.has(failed.sessionUri), true, 'the session is there to open');
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(bridge.calls.some((c) => c.op === 'send'), false);
  } finally {
    close();
  }
});

test('question cards: an answer in your own words, sent the way VS Code sends it', () => {
  const single = { id: 'lib', kind: 'single-select', allowFreeformInput: true, options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] };
  assert.deepEqual(answerFor(single, 'a', ''), { state: 'submitted', value: { kind: 'selected', value: 'a' } });
  assert.deepEqual(answerFor(single, 'a', '  luxon \n'), { state: 'submitted', value: { kind: 'text', value: 'luxon' } }, 'instead of the choice');
  assert.equal(answerFor(single, undefined, '   '), null, 'blank is no answer');
  assert.equal(answerFor({ ...single, allowFreeformInput: false }, undefined, 'luxon'), null, 'only when the agent takes one');
  const multi = { ...single, kind: 'multi-select' };
  assert.deepEqual(answerFor(multi, ['a'], 'and C'), { state: 'submitted', value: { kind: 'selected-many', value: ['a'], freeformValues: ['and C'] } });
  assert.deepEqual(answerFor(multi, [], 'just C'), { state: 'submitted', value: { kind: 'text', value: 'just C' } });
  assert.equal(answerFor(multi, [], ''), null);
  assert.deepEqual(answerFor({ id: 'n', kind: 'number' }, 3), { state: 'submitted', value: { kind: 'number', value: 3 } });
  assert.deepEqual(answerFor({ id: 'ok', kind: 'boolean' }, false), { state: 'submitted', value: { kind: 'boolean', value: false } });
  assert.deepEqual(answerFor({ id: 't', kind: 'text' }, 'hi'), { state: 'submitted', value: { kind: 'text', value: 'hi' } });
});

test('question cards: the Copilot app plugin takes a typed answer as the user\'s own words', async () => {
  const { SessionTranslator } = await import(`${lib}/translate.mjs`);
  const typed = { answer: { state: 'submitted', value: { kind: 'text', value: 'luxon' } } };
  assert.deepEqual(SessionTranslator.inputResolution({ kind: 'question', choices: ['date-fns', 'dayjs'] }, 'accept', typed), { op: 'input', response: { answer: 'luxon', wasFreeform: true } });
});

test('writing full screen: in the chat box and in New session', () => {
  // The button shows once a message runs over a line, and always in full screen.
  assert.match(rule('.grow-btn'), /display: none/);
  assert.match(rule('.composer.tall .grow-btn, .composer-wrap.expanded .grow-btn'), /display: grid/);
  assert.match(rule('.composer-wrap.expanded'), /position: absolute; inset: 0;/);
  assert.match(rule('.composer-wrap.expanded .composer > textarea'), /flex: 1; min-height: 0; max-height: none;/);
  // New session: the sheet itself fills the screen, with just the text and its files.
  assert.match(rule('.sheet.full'), /top: 0; max-height: none;/);
  assert.match(rule('.sheet.full .stack > :not(.prompt-field)'), /display: none/);
  assert.match(css, /@media \(min-width: 900px\)[\s\S]*\n {2}\.sheet\.full \{ top: 0; bottom: 0; width: min\(900px, 100vw\); max-height: none;/);
  const js = read('pwa', 'js', 'ui', 'sessions.js');
  assert.match(js, /<\$\{Sheet\} open=\$\{open\} onClose=\$\{writing \? \(\) => setWriting\(false\) : onClose\}/, 'closing full screen goes back to the form');
  assert.match(js, /full=\$\{writing\}/);
});
