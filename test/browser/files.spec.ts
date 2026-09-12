import { expect, test, firefox, webkit, type Page } from '@playwright/test';
import type * as FilesApi from '../../src/files/index.js';

const fileModule = '/dist/browser/files.js';
declare global { interface Window { fileTestPeer: FilesApi.FilePeer; RefstreamFiles: typeof FilesApi } }

test("real WebRTC transfers preserve bytes, apply backpressure, and cancel the producer", async ({ page }) => {
  test.setTimeout(45_000);
  await page.goto("/test/browser/index.html");
  const result = await page.evaluate(async fileModule => {
    const { FileRegistry, createFilePeer }: typeof FilesApi = await import(fileModule);
    const files = new FileRegistry(); let pulls = 0, cancellations = 0;
    const chunk = new TextEncoder().encode("Hello 世界\n".repeat(4000));
    files.add("logs/build.log", { mimeType: "text/plain", stream: () => {
      let count = 0;
      return new ReadableStream<Uint8Array>({ pull(controller) { if (++count > 8) { controller.close(); return; } pulls++; controller.enqueue(chunk); }, cancel() { cancellations++; } }, { highWaterMark: 0 });
    } });
    const sender = createFilePeer({ files }), viewer = createFilePeer();
    try {
      const answer = await viewer.acceptOffer(await sender.createOffer()); await sender.acceptAnswer(answer);
      await Promise.all([sender.ready, viewer.ready]);
      const resource = (await viewer.resolve("logs/build.log", { purpose: "download", signal: new AbortController().signal }))!;
      await new Promise(resolve => setTimeout(resolve, 40)); const beforeRead = pulls;
      const reader = resource.body.getReader(), chunks: Uint8Array[] = [];
      const first = await reader.read(); chunks.push(first.value!); await new Promise(resolve => setTimeout(resolve, 40)); const afterOneRead = pulls;
      for (;;) { const next = await reader.read(); if (next.done) break; chunks.push(next.value); }
      const received = new Uint8Array(chunks.reduce((sum, value) => sum + value.byteLength, 0)); let offset = 0;
      for (const value of chunks) { received.set(value, offset); offset += value.byteLength; }
      const expected = new Uint8Array(chunk.byteLength * 8); for (let i = 0; i < 8; i++) expected.set(chunk, i * chunk.byteLength);
      const digest = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource))].join(",");
      const hashMatches = await digest(received) === await digest(expected);
      const abort = new AbortController(), cancelled = (await viewer.resolve("logs/build.log", { purpose: "download", signal: abort.signal }))!;
      abort.abort(); let cancelCode = ""; try { await cancelled.body.getReader().read(); } catch (error) { cancelCode = (error as FilesApi.FileAccessError).code; }
      for (let i = 0; i < 100 && !cancellations; i++) await new Promise(resolve => setTimeout(resolve, 10));
      return { beforeRead, afterOneRead, bytes: received.byteLength, hashMatches, cancellations, cancelCode, unknown: await viewer.resolve("/etc/passwd", { purpose: "download", signal: new AbortController().signal }) };
    } finally { sender.dispose(); viewer.dispose(); files.dispose(); }
  }, fileModule);
  expect(result).toMatchObject({ beforeRead: 0, afterOneRead: 1, hashMatches: true, cancellations: 1, cancelCode: "ABORTED", unknown: null });
  expect(result.bytes).toBeGreaterThan(256 * 1024);
});

test("ships a standalone browser global without module loaders or runtime dependencies", async ({ page }) => {
  await page.goto("/test/browser/index.html");
  await page.addScriptTag({ url: fileModule.replace("files.js", "files.global.js") });
  const result = await page.evaluate(async () => {
    const { FileRegistry, detectFiles } = window.RefstreamFiles;
    const files = new FileRegistry(); files.add("README.md", { body: "Browser JavaScript" });
    const matched = detectFiles("README.md:1 and missing.txt", files).map(match => match.text);
    const text = await new Response((await files.resolve("README.md", { purpose: "download", signal: new AbortController().signal }))!.body).text(); files.dispose();
    return { text, matched };
  });
  expect(result).toEqual({ text: "Browser JavaScript", matched: ["README.md:1"] });
});

for (const remote of [firefox, webkit]) test(`peer files interoperate between Chromium and ${remote.name()}`, async ({ page, browserName, isMobile }) => {
  test.skip(browserName !== "chromium" || isMobile, "The desktop Chromium project owns cross-engine pairs.");
  test.setTimeout(45_000);
  const browser = await remote.launch(); let other: Page | undefined;
  try {
    other = await browser.newPage();
    await Promise.all([page.goto("/test/browser/index.html"), other.goto("http://127.0.0.1:5203/test/browser/index.html")]);
    const offer = await page.evaluate(async fileModule => {
      const { FileRegistry, createFilePeer }: typeof FilesApi = await import(fileModule);
      const files = new FileRegistry(); files.add("interop.txt", { body: "Cross-engine WebRTC 世界\n".repeat(3000) });
      window.fileTestPeer = createFilePeer({ files }); return window.fileTestPeer.createOffer();
    }, fileModule);
    const answer = await other.evaluate(async ({ fileModule, offer }) => {
      const { createFilePeer }: typeof FilesApi = await import(fileModule);
      window.fileTestPeer = createFilePeer(); return window.fileTestPeer.acceptOffer(offer);
    }, { fileModule, offer });
    await page.evaluate(answer => window.fileTestPeer.acceptAnswer(answer), answer);
    const text = await other.evaluate(async () => {
      await window.fileTestPeer.ready;
      const result = await window.fileTestPeer.resolve("interop.txt", { purpose: "download", signal: new AbortController().signal });
      return new Response(result!.body).text();
    });
    expect(text).toBe("Cross-engine WebRTC 世界\n".repeat(3000));
  } finally {
    await page.evaluate(() => window.fileTestPeer?.dispose()).catch(() => {});
    await other?.evaluate(() => window.fileTestPeer?.dispose()).catch(() => {});
    await browser.close();
  }
});
