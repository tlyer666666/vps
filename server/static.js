// Static file serving for the bundled dashboard.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, normalize, extname } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.sh': 'text/x-shellscript; charset=utf-8',
};

// Returns true when the file was served; false lets the caller answer 404.
export function serveStatic(webDir, urlPath, res) {
  let p;
  try {
    p = decodeURIComponent(urlPath);
  } catch {
    return false;
  }
  if (p === '/') p = '/index.html';
  const root = normalize(webDir + '/');
  const full = normalize(join(webDir, p));
  if (!full.startsWith(root)) return false; // path traversal
  if (!existsSync(full) || !statSync(full).isFile()) return false;
  res.writeHead(200, {
    'content-type': MIME[extname(full).toLowerCase()] ?? 'application/octet-stream',
    'cache-control': 'no-cache',
  });
  createReadStream(full).pipe(res);
  return true;
}
