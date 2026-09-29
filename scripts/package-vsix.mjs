#!/usr/bin/env node
// Builds pocket-pilot-<version>.vsix without vsce (no npm needed): an OPC zip with the manifest,
// content types and the extension files. Install with: code --install-extension pocket-pilot-<v>.vsix
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const INCLUDE_DIRS = ['extension', 'media', 'pwa'];
const INCLUDE_FILES = [['package.json', 'package.json'], ['README.md', 'README.md'], ['CHANGELOG.md', 'CHANGELOG.md'], ['LICENSE', 'LICENSE.txt'], ['THIRD-PARTY-NOTICES.md', 'THIRD-PARTY-NOTICES.md']];
const EXCLUDE = [/\.map$/, /\.test\./, /(^|\/)\.DS_Store$/, /(^|\/)Thumbs\.db$/];

function walk(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(root, dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(dir, r));
    else out.push(`${dir}/${r}`);
  }
  return out;
}

const files = [];
for (const [src, dest] of INCLUDE_FILES) if (fs.existsSync(path.join(root, src))) files.push({ src, dest: `extension/${dest}` });
for (const d of INCLUDE_DIRS) for (const f of walk(d)) if (!EXCLUDE.some((re) => re.test(f))) files.push({ src: f, dest: `extension/${f}` });

// Like vsce: VS Code and the Marketplace only render README/CHANGELOG images from absolute https URLs,
// so relative images point at the raw files on GitHub and relative links at the repository.
const repoSlug = (/github\.com[/:]([^/]+\/[^/.]+)/.exec(pkg.repository?.url || '') || [])[1];
function absolutize(md) {
  if (!repoSlug) return md;
  const raw = `https://raw.githubusercontent.com/${repoSlug}/HEAD/`;
  const blob = `https://github.com/${repoSlug}/blob/HEAD/`;
  const isRelative = (u) => !/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(u);
  const clean = (u) => u.replace(/^\.\//, '');
  return md
    .replace(/(<img\b[^>]*?\bsrc=")([^"]+)"/gi, (m, a, u) => (isRelative(u) ? `${a}${raw}${clean(u)}"` : m))
    .replace(/(!\[[^\]]*\]\()([^)\s]+)/g, (m, a, u) => (isRelative(u) ? `${a}${raw}${clean(u)}` : m))
    .replace(/(^|[^!])(\[[^\]]*\]\()([^)\s]+)/g, (m, pre, a, u) => (isRelative(u) ? `${pre}${a}${blob}${clean(u)}` : m));
}
const TRANSFORM = { 'extension/README.md': absolutize, 'extension/CHANGELOG.md': absolutize };

const esc = (s) => String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
const repo = pkg.repository?.url || '';
const manifest = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${esc(pkg.name)}" Version="${esc(pkg.version)}" Publisher="${esc(pkg.publisher)}" />
    <DisplayName>${esc(pkg.displayName)}</DisplayName>
    <Description xml:space="preserve">${esc(pkg.description)}</Description>
    <Tags>${esc((pkg.keywords || []).join(','))}</Tags>
    <Categories>${esc((pkg.categories || []).join(','))}</Categories>
    <GalleryFlags>${pkg.preview ? 'Public Preview' : 'Public'}</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${esc(pkg.engines.vscode)}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="${esc((pkg.extensionKind || ['workspace']).join(','))}" />
      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.EnabledApiProposals" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExecutesCode" Value="true" />
      <Property Id="Microsoft.VisualStudio.Services.Links.Source" Value="${esc(repo)}" />
      <Property Id="Microsoft.VisualStudio.Services.Links.Getstarted" Value="${esc(pkg.homepage)}" />
      <Property Id="Microsoft.VisualStudio.Services.Links.GitHub" Value="${esc(repo)}" />
      <Property Id="Microsoft.VisualStudio.Services.Links.Support" Value="${esc(pkg.bugs?.url)}" />
      <Property Id="Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown" Value="true" />
      <Property Id="Microsoft.VisualStudio.Services.Content.Pricing" Value="Free" />
      <Property Id="Microsoft.VisualStudio.Services.Branding.Color" Value="${esc(pkg.galleryBanner?.color || '#21252b')}" />
      <Property Id="Microsoft.VisualStudio.Services.Branding.Theme" Value="${esc(pkg.galleryBanner?.theme || 'dark')}" />
    </Properties>
    <License>extension/LICENSE.txt</License>
    <Icon>extension/${esc(pkg.icon)}</Icon>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Changelog" Path="extension/CHANGELOG.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/${esc(pkg.icon)}" Addressable="true" />
  </Assets>
</PackageManifest>
`;

const MIME = { '.js': 'application/javascript', '.mjs': 'application/javascript', '.json': 'application/json', '.css': 'text/css', '.html': 'text/html', '.md': 'text/markdown', '.txt': 'text/plain', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.vsixmanifest': 'text/xml', '': 'application/octet-stream' };
const exts = new Set(['.vsixmanifest', ...files.map((f) => path.extname(f.dest).toLowerCase())]);
const overrides = files.filter((f) => !path.extname(f.dest)).map((f) => `<Override PartName="/${encodeURI(f.dest)}" ContentType="text/plain"/>`);
const contentTypes = `<?xml version="1.0" encoding="utf-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${[...exts].filter(Boolean).sort().map((e) => `<Default Extension="${e}" ContentType="${MIME[e] || 'application/octet-stream'}"/>`).join('')}${overrides.join('')}</Types>\n`;

// ---- zip writer
const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const d = new Date();
const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();

const entries = [
  { name: '[Content_Types].xml', data: Buffer.from(contentTypes) },
  { name: 'extension.vsixmanifest', data: Buffer.from(manifest) },
  ...files.map((f) => {
    const data = fs.readFileSync(path.join(root, f.src));
    return { name: f.dest, data: TRANSFORM[f.dest] ? Buffer.from(TRANSFORM[f.dest](data.toString('utf8'))) : data };
  }),
];
const chunks = [];
const central = [];
let offset = 0;
for (const e of entries) {
  const name = Buffer.from(e.name, 'utf8');
  const crc = crc32(e.data);
  const comp = zlib.deflateRawSync(e.data, { level: 9 });
  const useStore = comp.length >= e.data.length;
  const body = useStore ? e.data : comp;
  const method = useStore ? 0 : 8;
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0);
  lh.writeUInt16LE(20, 4);
  lh.writeUInt16LE(0x0800, 6);
  lh.writeUInt16LE(method, 8);
  lh.writeUInt16LE(dosTime, 10);
  lh.writeUInt16LE(dosDate, 12);
  lh.writeUInt32LE(crc, 14);
  lh.writeUInt32LE(body.length, 18);
  lh.writeUInt32LE(e.data.length, 22);
  lh.writeUInt16LE(name.length, 26);
  lh.writeUInt16LE(0, 28);
  chunks.push(lh, name, body);
  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(0x02014b50, 0);
  ch.writeUInt16LE(20, 4);
  ch.writeUInt16LE(20, 6);
  ch.writeUInt16LE(0x0800, 8);
  ch.writeUInt16LE(method, 10);
  ch.writeUInt16LE(dosTime, 12);
  ch.writeUInt16LE(dosDate, 14);
  ch.writeUInt32LE(crc, 16);
  ch.writeUInt32LE(body.length, 20);
  ch.writeUInt32LE(e.data.length, 24);
  ch.writeUInt16LE(name.length, 28);
  ch.writeUInt32LE(offset, 42);
  central.push(ch, name);
  offset += lh.length + name.length + body.length;
}
const cd = Buffer.concat(central);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(entries.length, 8);
eocd.writeUInt16LE(entries.length, 10);
eocd.writeUInt32LE(cd.length, 12);
eocd.writeUInt32LE(offset, 16);
const out = path.join(root, `${pkg.name}-${pkg.version}.vsix`);
fs.writeFileSync(out, Buffer.concat([...chunks, cd, eocd]));
console.log(`Packaged ${entries.length} files -> ${path.basename(out)} (${Math.round(fs.statSync(out).size / 1024)} KB)`);
