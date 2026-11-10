import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as parser from '../pwa/js/core/links.js';
import { resolveUri } from '../pwa/js/lib/files.js';

const { localLink, linkTargets, linkMatches, pathToUri } = parser;
const require = createRequire(import.meta.url);
const { LinkedPaths, MAX_PATHS } = require('../extension/core/links.js');
const win = process.platform === 'win32';

test('a link to a file or folder on the computer, however the agent writes it', () => {
  // As seen in a real chat: Windows paths with forward slashes.
  assert.deepEqual(localLink('C:/Users/amithawala/Downloads/caip-se-manager-1.17.0-highlights'), { uri: 'file:///C:/Users/amithawala/Downloads/caip-se-manager-1.17.0-highlights' });
  assert.deepEqual(localLink('C:\\Users\\me\\My Shots\\1.png'), { uri: 'file:///C:/Users/me/My%20Shots/1.png' });
  assert.deepEqual(localLink('C:/Users/me/a%20b/x.png'), { uri: 'file:///C:/Users/me/a%20b/x.png' }, 'percent-encoded (marked encodes spaces)');
  assert.deepEqual(localLink('C:/Users/me/100%done.png'), { uri: 'file:///C:/Users/me/100%25done.png' }, 'a % that is not an escape');
  assert.deepEqual(localLink('C:/Users/me/r%C3%A4kna.md'), { uri: 'file:///C:/Users/me/r%C3%A4kna.md' }, 'non-ASCII');
  assert.deepEqual(localLink('C:/src/app.ts#L10-L20'), { uri: 'file:///C:/src/app.ts' }, 'line anchors are left out');
  assert.deepEqual(localLink('C:/src/app.ts:10:5'), { uri: 'file:///C:/src/app.ts' });
  assert.deepEqual(localLink('C:/src/q?.ts'), { uri: 'file:///C:/src/q' }, 'a query is not part of the path');
  assert.deepEqual(localLink('file:///c%3A/Users/me/x.png#top'), { uri: 'file:///c%3A/Users/me/x.png' });
  assert.deepEqual(localLink('file://localhost/C:/x'), { uri: 'file:///C:/x' });
  assert.deepEqual(localLink('vscode://file/C:/Users/me/x.ts:3'), { uri: 'file:///C:/Users/me/x.ts' });
  assert.deepEqual(localLink('/Users/me/Movies/promo.mov'), { uri: 'file:///Users/me/Movies/promo.mov' }, 'a Mac path');
  assert.deepEqual(localLink('\\\\server\\share\\a b.txt'), { uri: 'file://server/share/a%20b.txt' }, 'a network share, as Windows writes it');
  assert.deepEqual(localLink('%5C%5Cserver%5Cshare%5Cx'), { uri: 'file://server/share/x' });
  // The markdown library writes C:\Users\… in a link as C:%5CUsers%5C…
  assert.deepEqual(localLink('C:%5CUsers%5Cme%5Cx.png'), { uri: 'file:///C:/Users/me/x.png' });
  assert.deepEqual(localLink('c:%5cwork%5Ca%20b.md'), { uri: 'file:///c:/work/a%20b.md' });
  // Relative to the session's folder.
  assert.deepEqual(localLink('docs/filters.md'), { rel: 'docs/filters.md' });
  assert.deepEqual(localLink('./out/shot%201.png#x'), { rel: './out/shot 1.png' });
  assert.deepEqual(localLink('..\\notes.md'), { rel: '../notes.md' });
  // Not files: web links (//host/… is one without its scheme), and nothing that only looks like a path.
  for (const href of ['https://github.com/x', 'mailto:me@x.com', 'javascript:alert(1)', '#heading', '', 'C:', '\\x', 'data:text/html,hi', '//cdn.example.com/a.png', '//server/share/x', '%2F%2Fhost/x', '/%2Fhost/x', '/\\server\\share']) assert.equal(localLink(href), null, href);
  assert.equal(pathToUri('relative/x'), null);
  assert.equal(pathToUri('//host/x'), null);
});

test('the links in some markdown, as written', () => {
  const md = 'See [caip-se-manager-1.17.0-highlights](C:/Users/me/Downloads/caip-se-manager-1.17.0-highlights), '
    + '[a [nested] label](<C:/Users/me/My Shots/1.png> "Shot 1"), ![shot](C:/x/file%20(1).png), '
    + '[run](https://github.com/x/actions/runs/1) and [escaped](C:/x/a\\_b.md). Not a link: [x] (C:/y).\n\n'
    + 'The [report][1] is ready.\n\n[1]: <C:/x/report 1.pdf> "Report"\n  [w\\]x]: C:\\x\\w.md\n';
  assert.deepEqual(linkTargets(md), [
    'C:/Users/me/Downloads/caip-se-manager-1.17.0-highlights',
    'C:/Users/me/My Shots/1.png',
    'C:/x/file%20(1).png',
    'https://github.com/x/actions/runs/1',
    'C:/x/a_b.md',
    'C:/x/report 1.pdf',
    'C:\\x\\w.md',
  ]);
  assert.deepEqual(linkMatches('Saved [promo](C:/out/promo.mp4 "Promo") here.'), [{ target: 'C:/out/promo.mp4', text: '[promo](C:/out/promo.mp4 "Promo")' }]);
  assert.deepEqual(linkTargets(''), []);
});

test('reading the links takes as long as the text, however it is written', () => {
  // Lines that never close a label or a destination used to be read again from every [.
  for (const md of ['['.repeat(40000), '![x](data:'.repeat(100000), `[x](${'a'.repeat(200000)}`, `${'[a]('.repeat(50000)}`, `[1]: ${'\\'.repeat(100000)}`, '[a\\]'.repeat(50000)]) {
    const t0 = performance.now();
    linkTargets(md);
    assert.ok(performance.now() - t0 < 250, `${md.slice(0, 12)}… took ${Math.round(performance.now() - t0)} ms`);
  }
});

test('a relative link opens under the session\'s folder, never above its drive', () => {
  const root = 'file:///c%3A/Users/me/code/app';
  assert.equal(resolveUri(root, 'docs/filters.md'), 'file:///c%3A/Users/me/code/app/docs/filters.md');
  assert.equal(resolveUri(`${root}/`, './out/shot 1.png'), 'file:///c%3A/Users/me/code/app/out/shot%201.png');
  assert.equal(resolveUri(root, '../notes.md'), 'file:///c%3A/Users/me/code/notes.md');
  assert.equal(resolveUri(root, '../../../../../../x'), 'file:///c%3A/x');
  assert.equal(resolveUri(root, 'a%20b'), 'file:///c%3A/Users/me/code/app/a%2520b', 'a name with a real % stays as it is');
});

function linked(opts = {}) {
  return new LinkedPaths({ parser, home: opts.home || path.join(os.tmpdir(), 'pp-home-x'), ...opts });
}
const abs = (p) => path.resolve(p);

test('the computer notes the links in chat content: snapshots, older turns and streamed answers', () => {
  const l = linked();
  const base = win ? 'C:/Work' : '/work';
  const md = (content) => ({ kind: 'markdown', id: 'm', content });
  l.scanMessage({ id: 1, result: { snapshot: { state: {
    turns: [{ id: 't1', responseParts: [
      md(`The shots are in [highlights](${base}/highlights) and [notes](https://x.com).`),
      { kind: 'toolCall', toolCall: { status: 'completed', invocationMessage: { markdown: `Read [a.ts](${pathToUri(`${base}/src/a.ts`)})` }, content: [{ type: 'text', text: `[secret](${base}/secret.txt)` }] } },
      { kind: 'inputRequest', request: { message: `Use [this](${base}/plan.md)?` } },
    ] }],
    activeTurn: { id: 't2', responseParts: [{ kind: 'reasoning', id: 'r', content: `Looking at [log](${base}/build.log)` }] },
  } } } });
  assert.ok(l.grantFor(abs(`${base}/highlights`)), 'a linked folder');
  assert.ok(l.grantFor(abs(`${base}/highlights/1.png`)), 'what is in it');
  assert.ok(l.grantFor(abs(`${base}/highlights/deep/2.png`)));
  assert.ok(l.grantFor(abs(`${base}/src/a.ts`)), 'a file a tool row links to');
  assert.ok(l.grantFor(abs(`${base}/plan.md`)));
  assert.ok(l.grantFor(abs(`${base}/build.log`)), 'reasoning');
  assert.equal(l.grantFor(abs(`${base}/secret.txt`)), null, 'not tool output, which the app does not show as links');
  assert.equal(l.grantFor(abs(`${base}/highlights-2/x.png`)), null, 'a folder with a longer name is not inside');
  assert.equal(l.grantFor(abs(`${base}/src/b.ts`)), null, 'a linked file grants only itself');

  // Older turns, and live actions: a link split across two streamed pieces is still seen.
  l.scanMessage({ id: 2, result: { turns: [{ id: 't0', responseParts: [md(`[old](${base}/old.md)`)] }] } });
  assert.ok(l.grantFor(abs(`${base}/old.md`)));
  const act = (action) => l.scanMessage({ jsonrpc: '2.0', method: 'action', params: { channel: 'ahp-chat:/c1', action } });
  act({ type: 'chat/responsePart', turnId: 't3', part: md('Rendered: [promo](') });
  act({ type: 'chat/delta', turnId: 't3', partId: 'm', content: `${base}/renders/pro` });
  assert.equal(l.grantFor(abs(`${base}/renders/promo.mp4`)), null, 'not finished yet');
  act({ type: 'chat/delta', turnId: 't3', partId: 'm', content: 'mo.mp4) is ready.' });
  assert.ok(l.grantFor(abs(`${base}/renders/promo.mp4`)));
  act({ type: 'chat/toolCallComplete', turnId: 't3', toolCallId: 'x', result: { success: true, pastTenseMessage: `Created [x](${base}/x.txt)` } });
  assert.ok(l.grantFor(abs(`${base}/x.txt`)));
  // What a client sent (a device, VS Code's window) is not the agent's: its links are not noted.
  l.scanMessage({ jsonrpc: '2.0', method: 'action', params: { channel: 'ahp-chat:/c1', origin: { clientId: 'phone', clientSeq: 3 }, action: { type: 'chat/toolCallComplete', turnId: 't3', toolCallId: 'y', result: { success: false, pastTenseMessage: `[k](${base}/keys/id_rsa)` } } } });
  l.scanMessage({ id: 9, result: { type: 'replay', actions: [{ channel: 'ahp-chat:/c1', origin: { clientId: 'phone', clientSeq: 4 }, action: { type: 'chat/toolCallConfirmed', turnId: 't3', toolCallId: 'y', invocationMessage: `[k](${base}/keys/id_rsa)` } }] } });
  assert.equal(l.grantFor(abs(`${base}/keys/id_rsa`)), null);
  // A reconnect's replay.
  l.scanMessage({ id: 3, result: { type: 'replay', actions: [{ channel: 'ahp-chat:/c2', action: { type: 'chat/turnsLoaded', turns: [{ id: 'z', responseParts: [md(`[z](${base}/z.md)`)] }] } }] } });
  assert.ok(l.grantFor(abs(`${base}/z.md`)));
  l.scanMessage(null);
  l.scanMessage({ id: 4, result: { snapshot: { state: { turns: 'nonsense' } } } });
});

test('what VS Code shows back from a message is not the agent\'s: nothing in a !command turn, nor a link already in the message', () => {
  const l = linked();
  const base = win ? 'C:/Work' : '/work';
  const CHAT = 'ahp-chat:/c1';
  const md = (content, id = 'm') => ({ kind: 'markdown', id, content });
  const env = (action, extra = {}) => l.scanMessage({ jsonrpc: '2.0', method: 'action', params: { channel: CHAT, action, serverSeq: 1, ...extra } });
  const started = (turnId, text, extra) => env({ type: 'chat/turnStarted', turnId, message: { text } }, extra);
  const phone = { origin: { clientId: 'phone', clientSeq: 1 } };

  // `/rename <title>` is answered "Renamed: <title>" by VS Code, whoever sent it.
  started('t1', `/rename [x](${base}/secret/a.txt)`, phone);
  env({ type: 'chat/responsePart', turnId: 't1', part: md(`Renamed: [x](${base}/secret/a.txt)`) });
  // `!<command>` is run and shown by VS Code: no part of that turn is the agent's.
  started('t2', `!type ${base}/secret/b.txt`, phone);
  env({ type: 'chat/toolCallReady', turnId: 't2', toolCallId: 'b', invocationMessage: `echo [y](${base}/secret/c.txt)`, confirmed: 'not-needed' });
  env({ type: 'chat/toolCallComplete', turnId: 't2', toolCallId: 'b', result: { success: true, pastTenseMessage: `Ran [z](${base}/secret/d.txt)` } });
  for (const n of ['a', 'c', 'd']) assert.equal(l.grantFor(abs(`${base}/secret/${n}.txt`)), null, n);

  // A path typed in a message, which the agent then links (as its own link): that opens.
  started('t3', `Render the promo and save it to ${base}/out/promo.mp4, like [the last one](${base}/out/old.mp4)`);
  env({ type: 'chat/delta', turnId: 't3', partId: 'm', content: `Saved [promo.mp4](${base}/out/promo.mp4), next to [the last one](${base}/out/old.mp4) and [old.mp4](${base}/out/old.mp4).` });
  assert.ok(l.grantFor(abs(`${base}/out/promo.mp4`)));
  assert.ok(l.grantFor(abs(`${base}/out/old.mp4`)), 'its own link to it, not the one repeated from the message');

  // A turn start the host refused changes nothing; a turn this relay didn't see start is the agent's.
  started('t2', 'hello', { rejectionReason: 'duplicate turn', ...phone });
  env({ type: 'chat/toolCallComplete', turnId: 't2', toolCallId: 'c', result: { success: true, pastTenseMessage: `Ran [e](${base}/secret/e.txt)` } });
  assert.equal(l.grantFor(abs(`${base}/secret/e.txt`)), null);
  started('t8', '!refused', { rejectionReason: 'no such chat', ...phone });
  env({ type: 'chat/responsePart', turnId: 't8', part: md(`[g](${base}/g.txt)`) });
  assert.ok(l.grantFor(abs(`${base}/g.txt`)), 'as if the refused start never was');
  env({ type: 'chat/responsePart', turnId: 't9', part: md(`[f](${base}/f.txt)`) });
  assert.ok(l.grantFor(abs(`${base}/f.txt`)));

  // The same in a snapshot: finished turns by their own message, the one going on for what follows.
  l.scanMessage({ id: 5, result: { snapshot: { resource: 'ahp-chat:/c2', fromSeq: 1, state: {
    turns: [
      { id: 'h1', message: { text: `/rename [h](${base}/secret/h.txt)` }, responseParts: [md(`Renamed: [h](${base}/secret/h.txt)`)] },
      { id: 'h2', message: { text: '!dir' }, responseParts: [{ kind: 'toolCall', toolCall: { invocationMessage: `[i](${base}/secret/i.txt)` } }] },
      { id: 'h3', message: { text: 'make the video' }, responseParts: [md(`[video](${base}/out/v.mp4)`)] },
    ],
    activeTurn: { id: 'h4', message: { text: '!echo' }, responseParts: [] },
  } } } });
  l.scanMessage({ jsonrpc: '2.0', method: 'action', params: { channel: 'ahp-chat:/c2', action: { type: 'chat/toolCallReady', turnId: 'h4', toolCallId: 'k', invocationMessage: `[j](${base}/secret/j.txt)` } } });
  for (const n of ['h', 'i', 'j']) assert.equal(l.grantFor(abs(`${base}/secret/${n}.txt`)), null, n);
  assert.ok(l.grantFor(abs(`${base}/out/v.mp4`)));
});

test('a link to a network share is never noted, and no check looks at the disk', () => {
  const { realFolder } = require('../extension/core/attachments.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-links-'));
  const file = path.join(dir, 'linked-paths.json');
  try {
    const l = linked({ file });
    l.scanText('[a](\\\\\\\\pp-nohost.invalid\\\\share\\\\a.txt) [b](file://pp-nohost.invalid/share/b.txt) [c](<\\\\pp-nohost.invalid\\share>)');
    assert.equal(l.paths.size, 0);
    fs.writeFileSync(file, JSON.stringify({ v: 1, paths: ['\\\\pp-nohost.invalid\\share', '//pp-nohost.invalid/share', abs(win ? 'C:/Shots' : '/shots')] }));
    assert.deepEqual([...linked({ file }).paths.values()], [abs(win ? 'C:/Shots' : '/shots')], 'not even from an old list');
    const native = fs.realpathSync.native;
    const looked = [];
    fs.realpathSync.native = (p, ...rest) => {
      looked.push(String(p));
      return native(p, ...rest);
    };
    try {
      assert.equal(realFolder('\\\\pp-nohost.invalid\\share'), '\\\\pp-nohost.invalid\\share');
      assert.equal(realFolder('//pp-nohost.invalid/share'), '//pp-nohost.invalid/share');
    } finally {
      fs.realpathSync.native = native;
    }
    assert.deepEqual(looked, [], 'a share is not looked up');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a link never opens a whole drive or the home folder, nor what is in its app-data and sign-in folders; the list is kept on disk and stays bounded', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-links-'));
  const home = path.join(dir, 'home', 'me');
  const file = path.join(dir, 'linked-paths.json');
  try {
    const l = linked({ home, file });
    const root = path.parse(dir).root;
    l.scanText(`[drive](${pathToUri(root)}) [home](${pathToUri(home)}) [users](${pathToUri(path.dirname(home))}) [shots](${pathToUri(path.join(home, 'Downloads', 'shots'))})`);
    assert.equal(l.grantFor(path.join(home, '.ssh', 'id_rsa')), null, 'the home folder');
    assert.equal(l.grantFor(home), null, 'not even its list');
    assert.equal(l.grantFor(path.join(dir, 'other.txt')), null, 'a whole drive');
    assert.ok(l.blockedBy(home) && l.blockedBy(root) && l.blockedBy(path.dirname(home)) && l.blockedBy(path.join(home, 'x.txt')));
    assert.equal(l.grantFor(path.join(home, 'Downloads', 'shots', '1.png')), path.join(home, 'Downloads', 'shots'), 'a folder in it is fine');
    assert.equal(l.blockedBy(path.join(home, 'Downloads', 'shots')), null);
    if (win) assert.ok(l.grantFor(path.join(home, 'DOWNLOADS', 'Shots', '1.png')), 'Windows paths ignore case');

    // App data and sign-ins: a linked folder of them shows its list, but not what's in it; a linked file in one opens.
    l.scanText(`[keys](${pathToUri(path.join(home, '.ssh'))}) [local](${pathToUri(path.join(home, 'AppData', 'Local'))}) [npmrc](${pathToUri(path.join(home, '.npmrc'))}) [shot](${pathToUri(path.join(home, 'AppData', 'Local', 'Temp', 'shot.png'))}) [app](${pathToUri(path.join(home, 'AppData', 'Local', 'Acme'))})`);
    assert.ok(l.grantFor(path.join(home, '.ssh')), 'the folder itself: its list');
    assert.equal(l.grantFor(path.join(home, '.ssh', 'id_rsa')), null, 'not what is in it');
    assert.ok(l.blockedBy(path.join(home, '.ssh', 'id_rsa')));
    assert.equal(l.grantFor(path.join(home, 'AppData', 'Local', 'Google', 'Chrome', 'Cookies')), null);
    assert.ok(l.grantFor(path.join(home, '.npmrc')), 'a linked file opens');
    assert.ok(l.grantFor(path.join(home, 'AppData', 'Local', 'Temp', 'shot.png')));
    assert.ok(l.grantFor(path.join(home, 'AppData', 'Local', 'Acme', 'out', 'report.pdf')), 'an app\'s own folder in it opens');

    l.flush();
    const again = linked({ home, file });
    assert.ok(again.grantFor(path.join(home, 'Downloads', 'shots', '2.png')), 'kept after a restart');
    assert.equal(fs.statSync(file).size > 0, true);

    // Bounded, the oldest dropped first.
    for (let i = 0; i < MAX_PATHS + 5; i++) again.add(path.join(dir, `f${i}.txt`));
    assert.equal(again.paths.size, MAX_PATHS);
    assert.equal(again.grantFor(path.join(dir, 'f0.txt')), null);
    assert.ok(again.grantFor(path.join(dir, `f${MAX_PATHS + 4}.txt`)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('links that are not paths on this computer are ignored, and so are files a device may read anyway', () => {
  const l = linked();
  l.scanText(win ? '[mac](/Users/me/x.mov) [web](https://x.com/a.png)' : '[web](https://x.com/a.png) [rel](docs/a.md)');
  assert.equal(l.paths.size, 0);
  assert.ok(typeof fileURLToPath === 'function');
  // Most links in a chat are files in its own folder (the agent read or edited them): not noted.
  const work = abs(win ? 'C:/Work/app' : '/work/app');
  const c = linked({ covered: (p) => p.toLowerCase().startsWith(work.toLowerCase()) });
  c.scanText(`[a](${pathToUri(path.join(work, 'a.ts'))}) [b](${pathToUri(path.join(work, 'src', 'b.ts'))}) [shots](${pathToUri(abs(win ? 'C:/Shots' : '/shots'))})`);
  assert.deepEqual([...c.paths.values()], [abs(win ? 'C:/Shots' : '/shots')]);
});
