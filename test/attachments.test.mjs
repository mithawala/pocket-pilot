import test from 'node:test';
import assert from 'node:assert/strict';
import { isImageAttachment, splitAttachments, sniffImageType, mimeFromName, loadPicture, clearPictures, pictureError, base64ToBytes } from '../pwa/js/lib/attachments.js';

// The shapes VS Code's agent host really sends (captured from a live session).
const pasted = (name, displayKind, contentType) => ({
  type: 'resource',
  uri: `file:///c%3A/Users/me/AppData/Roaming/Code/agentSessionData/4699dd55/attachments/8df4/${encodeURIComponent(name)}`,
  label: name.replace(/\.png$/, ''),
  ...(displayKind ? { displayKind } : {}),
  _meta: { 'vscode.agentHost.snapshotAttachment': { isSnapshot: true, contentType } },
});
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201bf1f6e5d0000000049454e44ae426082', 'hex');

test('attachments: pictures pasted in VS Code, sent from the phone or inline are pictures; the rest are chips', () => {
  assert.equal(isImageAttachment(pasted('Pasted Image.png', 'image', 'image/png')), true);
  assert.equal(isImageAttachment(pasted('Pasted image.jpg', 'document', 'image/jpeg')), true, 'the declared type wins over displayKind');
  assert.equal(isImageAttachment({ type: 'embeddedResource', label: 'photo.jpg', data: 'AAAA', contentType: 'image/jpeg' }), true);
  assert.equal(isImageAttachment({ type: 'resource', uri: 'file:///c:/code/shot.webp', label: 'shot.webp' }), true, 'by extension');
  assert.equal(isImageAttachment({ type: 'resource', uri: 'file:///c:/code/app.ts', label: 'app.ts' }), false);
  assert.equal(isImageAttachment({ type: 'embeddedResource', label: 'doc.pdf', data: 'AAAA', contentType: 'application/pdf' }), false);
  assert.equal(isImageAttachment({ type: 'simple', label: 'Pasted image.jpg' }), false, 'a note has nothing to show');
  assert.equal(isImageAttachment({ type: 'embeddedResource', label: 'x.png', contentType: 'image/png' }), false, 'no data');

  // A photo from the phone travels as a note for the model plus the picture: only the picture shows.
  const { images, others } = splitAttachments({ attachments: [
    { type: 'simple', label: 'Pasted image.jpg', modelRepresentation: 'saved at …' },
    { type: 'resource', uri: 'file:///c%3A/x/attachments/9d1f/Pasted%20image.jpg', label: 'Pasted image.jpg', _meta: { 'vscode.agentHost.snapshotAttachment': { contentType: 'image/jpeg' } } },
    { type: 'simple', label: 'Open browser pages' },
    { type: 'resource', uri: 'file:///c:/code/app.ts', label: 'app.ts' },
  ] });
  assert.deepEqual(images.map((a) => a.label), ['Pasted image.jpg']);
  assert.deepEqual(others.map((a) => a.label), ['app.ts']);
  assert.deepEqual(splitAttachments({ text: 'hi' }), { images: [], others: [] });
});

test('attachments: picture types come from the bytes, then the declared type, then the name', () => {
  assert.equal(sniffImageType(PNG), 'image/png');
  assert.equal(sniffImageType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])), 'image/jpeg');
  assert.equal(sniffImageType(new TextEncoder().encode('GIF89a......')), 'image/gif');
  assert.equal(sniffImageType(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp');
  assert.equal(sniffImageType(new TextEncoder().encode('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>')), 'image/svg+xml');
  assert.equal(sniffImageType(new TextEncoder().encode('\0\0\0\x18ftypheic\0\0')), 'image/heic');
  assert.equal(sniffImageType(new TextEncoder().encode('just some text')), '');
  assert.equal(mimeFromName('file:///c%3A/a/Pasted%20Image%202.PNG'), 'image/png');
  assert.equal(mimeFromName('notes.txt'), '');
  assert.deepEqual([...base64ToBytes(PNG.toString('base64')).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
});

test('attachments: pictures load once as blob: URLs, with base64 from the PC', async () => {
  clearPictures();
  const reads = [];
  const read = async (uri) => {
    reads.push(uri);
    return { data: PNG.toString('base64'), encoding: 'base64', contentType: 'image/png' };
  };
  const att = pasted('Pasted Image.png', 'image', 'image/png');
  const a = await loadPicture(att, read);
  const b = await loadPicture(att, read);
  assert.match(a.url, /^blob:/);
  assert.equal(a.url, b.url, 'cached');
  assert.equal(a.type, 'image/png');
  assert.equal(reads.length, 1);

  const inline = await loadPicture({ type: 'embeddedResource', label: 'photo.png', data: PNG.toString('base64'), contentType: 'image/png' }, read);
  assert.equal(inline.type, 'image/png');
  assert.equal(reads.length, 1, 'inline pictures need no read');

  // A host that answers as text (the default encoding) or refuses: a clear message instead of a broken image.
  await assert.rejects(loadPicture(pasted('Other.png', 'image', 'image/png'), async () => ({ data: '\uFFFDPNG', encoding: 'utf-8' })), /Not a picture/);
  const old = loadPicture(pasted('Third.png', 'image', 'image/png'), async () => { throw new Error('RPC error -32602: Reading files outside your session folders is not allowed'); });
  await assert.rejects(old, (err) => pictureError(err) === 'Update Pocket Pilot on your PC to see the pictures sent in chats.');
  assert.equal(pictureError(new Error('ENOENT: no such file')), 'This picture is no longer on your PC.');
  clearPictures();
});
