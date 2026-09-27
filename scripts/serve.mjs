// Minimal static file server for local testing of the PWA / landing page (no dependencies).
// Usage: node scripts/serve.mjs [dir=dist/site] [port=8790]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] || 'dist/site');
const port = Number(process.argv[3] || 8790);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

http.createServer((req, res) => {
  let rel;
  try {
    rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  let file = path.join(root, rel);
  if (!file.startsWith(root)) {
    res.writeHead(403).end();
    return;
  }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
    if (!rel.endsWith('/')) {
      res.writeHead(301, { location: `${rel}/` }).end();
      return;
    }
    file = path.join(file, 'index.html');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  });
}).listen(port, '127.0.0.1', () => console.log(`Serving ${root} on http://127.0.0.1:${port}/`));
