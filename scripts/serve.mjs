import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.TERMINAL_TEST_PORT || 5203);
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    // Use a real redirect: WebKit cannot fulfill intercepted requests with a 302.
    if (pathname === "/test/browser/redirect-file.txt") {
      response.writeHead(302, { Location: "/test/browser/redirect-target.txt?private=do-not-follow", "Cache-Control": "no-store" }).end(); return;
    }
    const file = resolve(root, `.${pathname === "/" ? "/test/browser/harness.html" : pathname}`);
    if (!["dist", "test/browser"].some(directory => file.startsWith(resolve(root, directory) + sep))) {
      response.writeHead(403).end(); return;
    }
    const body = await readFile(file);
    response.writeHead(200, {
      "Content-Type": `${types[extname(file)] ?? "application/octet-stream"}; charset=utf-8`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src blob:; connect-src 'self'; object-src 'none'; base-uri 'none'",
    }).end(body);
  } catch { response.writeHead(404).end("Not found"); }
}).listen(port, "127.0.0.1", () => process.stdout.write(`Terminal library: http://127.0.0.1:${port}\n`));
