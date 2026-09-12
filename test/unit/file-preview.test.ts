import { afterEach, expect, test, vi } from "vitest";
import { authorizedFileUrl, readFileResource, resolveFileResource, runHostDownload, type TerminalFileLinkOptions, type TerminalFileResource } from "../../src/file-preview.js";

afterEach(() => vi.restoreAllMocks());
const options: TerminalFileLinkOptions = { resolve: () => null };
const base = "https://terminal.example/session/private#key";

test("a stalled host download keeps the user gesture and releases the UI when cancelled", async () => {
  const controller = new AbortController(); let gesture = true;
  const download = vi.fn(() => { expect(gesture).toBe(true); return new Promise<void>(() => {}); });
  const pending = runHostDownload(download, { path: "private/file.txt" } as never, controller.signal);
  gesture = false; expect(download).toHaveBeenCalledOnce(); controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await expect(runHostDownload(download, { path: "private/file.txt" } as never, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(download).toHaveBeenCalledOnce();
});

test("file URLs need explicit origins and cannot carry credentials or executable schemes", async () => {
  const fetch = vi.spyOn(globalThis, "fetch");
  for (const url of ["https://files.example/a", "/api/file", "javascript:alert(1)", "data:text/html,hi", "file:///etc/passwd", "https://user:password@terminal.example/a", "https://terminal.example/a#key"]) {
    await expect(readFileResource({ url }, options, new AbortController().signal, base, "preview")).rejects.toThrow();
  }
  expect(fetch).not.toHaveBeenCalled();
  expect(authorizedFileUrl("/file.txt", base, ["https://terminal.example"])).toBe("https://terminal.example/file.txt");
});

test("authorized requests omit credentials and referrers, refuse redirects, and do not cache private files", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("private bytes", { headers: { "content-type": "text/plain", "content-length": "13" } }));
  const controller = new AbortController();
  const result = await readFileResource({ url: "/authorized-file" }, { ...options, allowedOrigins: ["https://terminal.example"] }, controller.signal, base, "preview");
  expect(await result.blob.text()).toBe("private bytes");
  expect(fetch).toHaveBeenCalledWith("https://terminal.example/authorized-file", expect.objectContaining({ credentials: "omit", referrer: "", referrerPolicy: "no-referrer", redirect: "error", cache: "no-store", signal: controller.signal }));
});

test("streams are bounded and cancellable; truncated preview bytes never become a partial download", async () => {
  const cancelled = vi.fn();
  const stream = () => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(1800)); }, cancel: cancelled });
  const result = await readFileResource({ body: stream(), mimeType: "image/png" }, { ...options, maxPreviewBytes: 1024 }, new AbortController().signal, base, "preview");
  expect(result.truncated).toBe(true); expect(result.blob.size).toBe(1024); expect(cancelled).toHaveBeenCalled();
  await expect(readFileResource({ body: stream() }, { ...options, maxDownloadBytes: 1024 }, new AbortController().signal, base, "download")).rejects.toThrow("download limit");
  const stopped = new AbortController(); const blocked = new ReadableStream<Uint8Array>({ cancel: cancelled });
  const pending = readFileResource({ body: blocked }, options, stopped.signal, base, "preview"); stopped.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(blocked.locked).toBe(false);
});

test("downloads preserve tiny chunks and exact-limit files, while stalled streams are cancelled", async () => {
  const bytes = new Uint8Array(1024).map((_, index) => index % 256);
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({ pull(controller) {
    if (index < bytes.length) controller.enqueue(bytes.slice(index, ++index));
    else { controller.enqueue(new Uint8Array(0)); controller.close(); }
  } });
  const result = await readFileResource({ body: stream }, { ...options, maxDownloadBytes: 1024 }, new AbortController().signal, base, "download");
  expect(result.truncated).toBe(false);
  expect(new Uint8Array(await result.blob.arrayBuffer())).toEqual(bytes);
  const cancel = vi.fn();
  const empty = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(0)); }, cancel });
  await expect(readFileResource({ body: empty }, options, new AbortController().signal, base, "preview")).rejects.toThrow("no progress");
  expect(cancel).toHaveBeenCalled(); expect(empty.locked).toBe(false);
});

test("an uncooperative resolver aborts promptly and its late stream is cancelled", async () => {
  let finish!: (value: TerminalFileResource) => void;
  const controller = new AbortController(), cancelled = vi.fn();
  const pending = resolveFileResource({ resolve: () => new Promise(resolve => { finish = resolve; }) }, { path: "private/file.txt" } as never, controller.signal, "preview");
  await Promise.resolve(); controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  finish({ body: new ReadableStream({ cancel: cancelled }) });
  await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
});
