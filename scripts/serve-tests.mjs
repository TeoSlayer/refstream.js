import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

// Serve only the browser fixture and built public assets, on loopback.
const routes = new Map([
  ['/test/browser/index.html', ['../test/browser/index.html', 'text/html; charset=utf-8']],
  ['/dist/browser/refstream.js', ['../dist/browser/refstream.js', 'text/javascript; charset=utf-8']],
  ['/dist/browser/refstream.global.js', ['../dist/browser/refstream.global.js', 'text/javascript; charset=utf-8']],
  ['/dist/browser/refstream.js.map', ['../dist/browser/refstream.js.map', 'application/json']],
  ['/dist/browser/refstream.global.js.map', ['../dist/browser/refstream.global.js.map', 'application/json']],
]);
const server = createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Referrer-Policy', 'no-referrer');
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' }); response.end(); return;
  }
  const route = routes.get((request.url ?? '').split('?')[0]);
  if (!route) { response.writeHead(404); response.end(); return; }
  try {
    const bytes = await readFile(new URL(route[0], import.meta.url));
    response.writeHead(200, { 'Content-Type': route[1], 'Content-Length': bytes.length });
    response.end(request.method === 'HEAD' ? undefined : bytes);
  } catch { response.writeHead(404); response.end(); }
});
server.listen(5203, '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  server.close(); server.closeAllConnections();
});
