import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileKind, mimeOf, formatSize, fileTime, childUri, underUri, baseName, partsUnder, Download, downloadFor, MAX_DOWNLOAD } from '../pwa/js/lib/files.js';

const require = createRequire(import.meta.url);
const files = require('../extension/core/files.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-files-core-'));
  const put = (rel, data, minutesAgo) => {
    const p = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, data);
    const t = new Date(Date.now() - minutesAgo * 60000);
    fs.utimesSync(p, t, t);
  };
  put('README.md', '# Notes\n', 300);
  put('renders/promo.mp4', crypto.randomBytes(5000), 2);
  put('renders/old/teaser.mp4', crypto.randomBytes(100), 600);
  put('deep/a/b/c/d/e/screenshot.png', crypto.randomBytes(50), 1);
  put('.git/HEAD', 'ref', 0);
  put('node_modules/pkg/index.js', 'x', 0);
  put('.hidden.txt', 'x', 0);
  return dir;
}

test('core: a folder is listed with types, sizes and times, and a piece of a file is read', async () => {
  const dir = tree();
  try {
    const { entries, truncated } = await files.listFolder(dir);
    assert.equal(truncated, false);
    const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
    assert.equal(byName['README.md'].type, 'file');
    assert.equal(byName['README.md'].size, 8);
    assert.ok(Math.abs(byName['README.md'].mtime - (Date.now() - 300 * 60000)) < 5000);
    assert.equal(byName.renders.type, 'directory');
    assert.ok(byName['.git'] && byName['.hidden.txt'], 'everything is listed; the phone hides dot files');
    await assert.rejects(files.listFolder(path.join(dir, 'README.md')), (e) => e.code === 'ENOTDIR');

    const film = fs.readFileSync(path.join(dir, 'renders/promo.mp4'));
    const piece = await files.readPiece(path.join(dir, 'renders/promo.mp4'), 1000, 300);
    assert.ok(piece.data.equals(film.subarray(1000, 1300)));
    assert.equal(piece.size, 5000);
    const tail = await files.readPiece(path.join(dir, 'renders/promo.mp4'), 4900, 300);
    assert.equal(tail.data.length, 100, 'the last piece is shorter');
    assert.equal((await files.readPiece(path.join(dir, 'renders/promo.mp4'), 9000, 300)).data.length, 0, 'nothing past the end');
    await assert.rejects(files.readPiece(path.join(dir, 'renders'), 0, 10), (e) => ['EISDIR', 'EPERM', 'EACCES'].includes(e.code));
    assert.deepEqual(await files.statPath(path.join(dir, 'renders')), { type: 'directory', size: 0, mtime: (await files.statPath(path.join(dir, 'renders'))).mtime });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('core: the newest files, newest first, without hidden, dependency or linked folders', async () => {
  const dir = tree();
  try {
    const r = await files.newestFiles(dir);
    assert.deepEqual(r.files.map((f) => f.path), ['deep/a/b/c/d/e/screenshot.png', 'renders/promo.mp4', 'README.md', 'renders/old/teaser.mp4']);
    assert.equal(r.files[1].name, 'promo.mp4');
    assert.equal(r.files[1].size, 5000);
    assert.equal(r.truncated, false);
    assert.deepEqual((await files.newestFiles(dir, { limit: 2 })).files.map((f) => f.name), ['screenshot.png', 'promo.mp4']);
    // A huge folder: searched nearest folders first, then it stops and says so.
    const cut = await files.newestFiles(dir, { maxDirs: 2 });
    assert.equal(cut.truncated, true);
    assert.deepEqual(cut.files.map((f) => f.path), ['README.md'], 'the folder itself, then its first subfolder (deep), which has no files of its own');
    const late = await files.newestFiles(dir, { budgetMs: -1 });
    assert.equal(late.truncated, true);
    // A home folder: Windows' AppData (anywhere) and a Mac's Library (at the top) are app storage, skipped.
    const put = (rel) => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), 'x');
    };
    put('AppData/Local/cache/blob.tmp');
    put('Library/Caches/x.db');
    put('code/library/util.js');
    const home = await files.newestFiles(dir, { home: dir });
    assert.ok(!home.files.some((f) => /^(AppData|Library)\//.test(f.path)), 'no app storage');
    assert.ok(home.files.some((f) => f.path === 'code/library/util.js'), 'a project\'s own library folder is searched');
    assert.ok((await files.newestFiles(dir, { home: os.tmpdir() })).files.some((f) => f.path === 'Library/Caches/x.db'), 'Library is only skipped in a home folder');
    // A link to elsewhere is not followed (no loops, nothing outside the folder).
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-files-out-'));
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
    try {
      fs.symlinkSync(outside, path.join(dir, 'linked'), 'junction');
      const withLink = await files.newestFiles(dir);
      assert.ok(!withLink.files.some((f) => f.name === 'secret.txt'), 'linked folders are skipped');
    } catch (err) {
      if (err.code !== 'EPERM') throw err;
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('phone: what a file is, its size and time, and its address', () => {
  assert.equal(fileKind('promo.MP4'), 'video');
  assert.equal(fileKind('shot.png'), 'image');
  assert.equal(fileKind('song.m4a'), 'audio');
  assert.equal(fileKind('notes.md'), 'text');
  assert.equal(fileKind('deck.pptx'), 'document');
  assert.equal(fileKind('bundle.zip'), 'archive');
  assert.equal(fileKind('Makefile'), 'other');
  assert.equal(mimeOf('promo.mp4'), 'video/mp4', 'an iPhone offers Save Video for this');
  assert.equal(mimeOf('clip.mov'), 'video/quicktime');
  assert.equal(mimeOf('x.unknown'), 'application/octet-stream');
  assert.equal(formatSize(999), '999 B');
  assert.equal(formatSize(48200000), '48 MB');
  assert.equal(formatSize(4820000), '4.8 MB');
  assert.equal(formatSize(1.5e9), '1.5 GB');
  const now = new Date(2026, 10, 8, 22, 0).getTime();
  assert.match(fileTime(now - 3600000, now), /^Today /);
  assert.match(fileTime(now - 24 * 3600000, now), /^Yesterday /);
  assert.equal(fileTime(0, now), '');

  const root = 'file:///c%3A/Users/you/code/acme-web';
  const film = underUri(root, 'renders/promo final #1.mp4');
  assert.equal(film, 'file:///c%3A/Users/you/code/acme-web/renders/promo%20final%20%231.mp4');
  assert.equal(childUri(`${root}/`, 'a b'), `${root}/a%20b`);
  assert.equal(underUri(root, ''), root);
  assert.equal(baseName(film), 'promo final #1.mp4');
  assert.deepEqual(partsUnder(root, film), ['renders', 'promo final #1.mp4']);
  assert.deepEqual(partsUnder(root, root), []);
  assert.deepEqual(partsUnder('file:///C:/Users/you/code/acme-web', `${root}/x`), ['x'], 'C: and c%3A are the same folder');
  assert.equal(partsUnder(root, 'file:///c%3A/Users/you/code/acme-web-2/x'), null, 'a folder with a longer name is not inside');
});

/** A PC answering `files` requests for one file, with a choice of delays and failures. */
function fakePc(bytes, { mtime = 1000, delay = () => 0, fail = () => null } = {}) {
  const pc = new EventTarget();
  pc.mtime = mtime;
  pc.bytes = bytes;
  pc.reads = [];
  pc.inflight = 0;
  pc.maxInflight = 0;
  pc.files = async (op, p) => {
    if (op === 'stat') return { ok: true, type: 'file', size: pc.bytes.length, mtime: pc.mtime };
    assert.equal(op, 'read');
    pc.reads.push(p.offset);
    pc.inflight++;
    pc.maxInflight = Math.max(pc.maxInflight, pc.inflight);
    try {
      await sleep(delay(p));
      const err = fail(p);
      if (err) throw err;
      return { ok: true, data: Buffer.from(pc.bytes.subarray(p.offset, p.offset + p.length)).toString('base64'), size: pc.bytes.length, mtime: pc.mtime };
    } finally {
      pc.inflight--;
    }
  };
  return pc;
}
const settle = (d) => new Promise((resolve) => {
  if (['done', 'failed', 'cancelled'].includes(d.state)) return resolve(d.state);
  const on = () => {
    if (!['done', 'failed', 'cancelled'].includes(d.state)) return;
    d.removeEventListener('change', on);
    resolve(d.state);
  };
  d.addEventListener('change', on);
});
const contents = async (d) => Buffer.from(await d.blob.arrayBuffer());

test('phone: a download asks for a few pieces at once and joins them in order, whatever order they come in', async () => {
  const bytes = crypto.randomBytes(5 * 512 * 1024 + 777);
  const pc = fakePc(bytes, { delay: (p) => ((p.offset / 524288) % 3) * 15 });
  const d = new Download(pc, 'file:///c%3A/x/promo.mp4');
  const seen = [];
  d.addEventListener('change', () => seen.push(d.received));
  d.start();
  assert.equal(await settle(d), 'done');
  assert.ok((await contents(d)).equals(bytes));
  assert.equal(d.blob.type, 'video/mp4');
  assert.equal(pc.maxInflight, 4, 'four pieces ahead');
  assert.deepEqual(pc.reads, [0, 1, 2, 3, 4, 5].map((i) => i * 524288));
  assert.ok(seen.includes(524288 * 2), 'progress after each piece');
  assert.ok(d.url.startsWith('blob:'));
  d.release();
  assert.equal(d.blob, null);

  const empty = new Download(fakePc(Buffer.alloc(0)), 'file:///c%3A/x/empty.txt');
  empty.start();
  assert.equal(await settle(empty), 'done');
  assert.equal(empty.blob.size, 0);
});

test('phone: a dropped connection keeps what arrived, and the download goes on from there', async () => {
  const bytes = crypto.randomBytes(6 * 512 * 1024);
  let drop = true;
  const pc = fakePc(bytes, { fail: (p) => (drop && p.offset >= 3 * 524288 ? Object.assign(new Error('The connection to your computer dropped'), { code: 'offline' }) : null) });
  const d = downloadFor(pc, 'file:///c%3A/x/film.mov', { name: 'film.mov' });
  assert.equal(downloadFor(pc, 'file:///c%3A/x/film.mov'), d, 'one download per file');
  d.start();
  assert.equal(await settle(d), 'failed');
  assert.equal(d.error.code, 'offline');
  assert.equal(d.received, 3 * 524288, 'the pieces before the drop are kept');
  assert.equal(d.resumable, true);
  // The connection comes back: the download carries on by itself, from where it stopped.
  drop = false;
  pc.reads = [];
  pc.dispatchEvent(new Event('ready'));
  assert.equal(await settle(d), 'done');
  assert.equal(pc.reads[0], 3 * 524288, 'went on from the first missing piece');
  assert.ok((await contents(d)).equals(bytes));
  assert.equal(d.blob.type, 'video/quicktime');
  // A listing that shows another version of the file drops the old download.
  const again = downloadFor(pc, 'file:///c%3A/x/film.mov', { size: bytes.length + 1 });
  assert.notEqual(again, d);
  assert.equal(d.blob, null, 'released');
});

test('phone: a file that changes while downloading starts over; cancel drops what arrived; too large is refused', async () => {
  const bytes = crypto.randomBytes(4 * 512 * 1024);
  const pc = fakePc(bytes, { delay: () => 5 });
  const d = new Download(pc, 'file:///c%3A/x/render.mp4');
  d.addEventListener('change', () => {
    if (d.received === 524288) pc.mtime = 2000; // re-rendered on the PC
  });
  d.start();
  assert.equal(await settle(d), 'failed');
  assert.equal(d.error.code, 'changed');
  assert.equal(d.received, 0, 'starts over');
  assert.equal(d.resumable, false);
  d.start();
  assert.equal(await settle(d), 'done');
  assert.equal(d.mtime, 2000);
  assert.ok((await contents(d)).equals(bytes));

  const slow = fakePc(crypto.randomBytes(16 * 512 * 1024), { delay: () => 40 });
  const c = new Download(slow, 'file:///c%3A/x/render.mp4');
  c.start();
  await sleep(60);
  assert.equal(c.state, 'running');
  c.cancel();
  assert.equal(c.state, 'cancelled');
  assert.equal(c.received, 0);
  const reads = slow.reads.length;
  await sleep(120);
  assert.equal(c.state, 'cancelled', 'pieces arriving after Cancel are ignored');
  assert.ok(slow.reads.length <= reads, 'nothing more is asked for');

  const huge = fakePc(Buffer.alloc(16));
  huge.files = async (op) => (op === 'stat' ? { ok: true, type: 'file', size: MAX_DOWNLOAD + 1, mtime: 1 } : assert.fail('no reads'));
  const h = new Download(huge, 'file:///c%3A/x/huge.mkv');
  h.start();
  assert.equal(await settle(h), 'failed');
  assert.equal(h.error.code, 'too-large');
});

test('demo: Files shows a small project, newest first, and downloads from it', async () => {
  const { createDemo } = await import('../pwa/js/demo/demo.js');
  const { conn, store } = createDemo();
  try {
    const root = 'file:///c%3A/Users/you/code/acme-web';
    assert.equal(conn.canBrowseFiles, true);
    const recent = await conn.files('recent', { uri: root });
    assert.deepEqual(recent.files.map((f) => f.path), ['renders/launch-film.mp4', 'screenshots/settings-before.svg', 'src/settings/ThemeToggle.tsx', 'README.md']);
    const list = await conn.files('list', { uri: root });
    assert.deepEqual(list.entries.map((e) => e.name).sort(), ['README.md', 'renders', 'screenshots', 'src']);
    const d = new Download(conn, underUri(root, 'README.md'));
    d.start();
    assert.equal(await settle(d), 'done');
    assert.match(await d.blob.text(), /^# acme-web/);
    // A file the chat links to (not in the listing) reads as some code, as the old viewer showed.
    const linked = await conn.files('stat', { uri: underUri(root, 'src/settings/Page.tsx') });
    assert.equal(linked.type, 'file');
    assert.equal((await conn.files('list', { uri: underUri(root, 'src/settings') })).entries.map((e) => e.name).join(), 'ThemeToggle.tsx', 'not listed');
    await assert.rejects(conn.files('list', { uri: 'file:///c%3A/Windows' }), (e) => e.code === 'denied');
    await assert.rejects(conn.files('stat', { uri: underUri(root, 'nope') }), (e) => e.code === 'not-found');
  } finally {
    store.dispose();
  }
});
