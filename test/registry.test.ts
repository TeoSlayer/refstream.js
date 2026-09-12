import { afterEach, describe, expect, it, vi } from "vitest";
import { detectFiles, fileLinks, FileRegistry, FileAccessError, createFilePeer, type Disposable } from "../src/index.js";

const owned: Disposable[] = [];
const registry = (options: ConstructorParameters<typeof FileRegistry>[0] = {}) => { const value = new FileRegistry(options); owned.push(value); return value; };
const request = (purpose: "preview" | "download" = "download", signal = new AbortController().signal) => ({ purpose, signal });
afterEach(() => { for (const resource of owned.splice(0)) resource.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("explicit file sources", () => {
  it("detects only registered references without reading files or accessing the network", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const open = vi.fn(() => new Blob(["private contents"]).stream());
    const files = registry(); const registration = files.add("src/hello world.ts", { stream: open });
    const matches = detectFiles('See "src/hello world.ts:12:3", missing.ts and src/hello world.tsx. https://elsewhere/src/hello world.ts', files);
    expect(matches.map(match => [match.text, match.line, match.column])).toEqual([["src/hello world.ts:12:3", 12, 3]]);
    expect(matches[0].start).toBe(5);
    expect(fileLinks(files).canResolve({ path: "src/hello world.ts" })).toBe(true);
    expect(await files.resolve("/etc/passwd", request())).toBeNull();
    expect(open).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    registration.dispose();
    expect(detectFiles("src/hello world.ts", files)).toEqual([]);
    expect(fileLinks(files).canResolve({ path: "src/hello world.ts" })).toBe(false);
  });

  it("requires one backing, exact URL origins and safe metadata; descriptors exclude backing URLs", () => {
    const files = registry({ allowedOrigins: ["https://files.example"] });
    expect(() => files.add("a.txt", {})).toThrow("Supply one");
    expect(() => files.add("a.txt", { body: "a", url: "https://files.example/secret" })).toThrow("Supply one");
    for (const url of ["https://evil.example/x", "https://user:password@files.example/x", "https://files.example/x#secret", "javascript:alert(1)", "/file.txt"]) expect(() => files.add("a.txt", { url })).toThrow();
    expect(() => files.add("a.txt", { body: "a", name: "../secret" })).toThrow();
    expect(() => files.add("a\u202etxt", { body: "a" })).toThrow();
    files.add("a.txt", { url: "https://files.example/capability?secret=private", mimeType: "text/plain" });
    expect(JSON.stringify(files.list())).not.toMatch(/capability|private|https/);
    expect(files.list()[0].id).toMatch(/^[a-f0-9]{32}$/u);
    expect(() => files.add("a.txt", { body: "replacement" })).toThrow("Remove the existing");
  });

  it("opens fresh streams, separates previews, and reauthorizes each operation", async () => {
    const purposes: string[] = [];
    let permitted = true;
    const files = registry(); files.add("report.txt", { body: "full report", preview: { body: "summary" }, authorize: context => { purposes.push(context.purpose); return permitted; } });
    expect(await new Response((await files.resolve("report.txt", request("preview")))!.body).text()).toBe("summary");
    expect(await new Response((await files.resolve("report.txt", request()))!.body).text()).toBe("full report");
    permitted = false;
    await expect(files.resolve("report.txt", request())).rejects.toMatchObject({ code: "DENIED" });
    expect(purposes).toEqual(["preview", "download", "download"]);
  });

  it("fetches only explicit URLs without cookies, referrers or redirects", async () => {
    const fetch = vi.fn(async () => new Response("verified", { headers: { "Content-Type": "text/plain; charset=utf-8" } })); vi.stubGlobal("fetch", fetch);
    const files = registry({ allowedOrigins: ["https://files.example"] });
    files.add("proof.txt", { url: "https://files.example/opaque-id" });
    expect(fetch).not.toHaveBeenCalled();
    const resource = (await files.resolve("proof.txt", request()))!;
    expect(await new Response(resource.body).text()).toBe("verified");
    expect(fetch).toHaveBeenCalledWith("https://files.example/opaque-id", expect.objectContaining({ credentials: "omit", mode: "cors", redirect: "error", referrer: "", referrerPolicy: "no-referrer", cache: "no-store", signal: expect.any(AbortSignal) }));
    expect(resource.mimeType).toBe("text/plain");
  });

  it("bounds unknown-size streams and releases the source when the byte cap is exceeded", async () => {
    let pulls = 0; const cancelled = vi.fn();
    const files = registry({ maxDownloadBytes: 1024 });
    files.add("large.bin", { stream: () => new ReadableStream({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(400)); }, cancel: cancelled }, { highWaterMark: 0 }) });
    const resource = (await files.resolve("large.bin", request()))!;
    expect(pulls).toBe(0);
    await expect(new Response(resource.body).arrayBuffer()).rejects.toMatchObject({ code: "LIMIT" });
    expect(pulls).toBe(3); expect(cancelled).toHaveBeenCalledOnce();
  });

  it("revokes an active stream and immediately removes its detected links", async () => {
    const cancelled = vi.fn(); let signal: AbortSignal;
    const files = registry(); const registration = files.add("live.txt", { stream: context => { signal = context.signal; return new ReadableStream({ pull() {}, cancel: cancelled }, { highWaterMark: 0 }); } });
    const resource = (await files.resolve("live.txt", request()))!, read = resource.body.getReader().read();
    registration.dispose();
    await expect(read).rejects.toMatchObject({ code: "DENIED" });
    expect(signal!.aborted).toBe(true); expect(cancelled).toHaveBeenCalledOnce(); expect(files.has("live.txt")).toBe(false);
  });

  it("cancels a stream factory that resolves after its request was aborted", async () => {
    let open!: (stream: ReadableStream<Uint8Array>) => void;
    const cancelled = vi.fn(), abort = new AbortController();
    const files = registry(); files.add("slow.txt", { stream: () => new Promise(resolve => { open = resolve; }) });
    const result = files.resolve("slow.txt", request("download", abort.signal)); abort.abort();
    await expect(result).rejects.toMatchObject({ code: "ABORTED" });
    open(new ReadableStream({ cancel: cancelled })); await Promise.resolve();
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("times out stalled authorization and does not expose source errors", async () => {
    vi.useFakeTimers(); const files = registry({ timeoutMs: 100 });
    files.add("slow.txt", { body: "secret", authorize: () => new Promise(() => {}) });
    const result = files.resolve("slow.txt", request()); const rejected = expect(result).rejects.toMatchObject({ code: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(101); await rejected;
    files.add("private.txt", { stream: () => { throw new Error("secret token at https://private.example/x"); } });
    await expect(files.resolve("private.txt", request())).rejects.toEqual(new FileAccessError("UNAVAILABLE"));
  });

  it("enforces concurrent reads and frees capacity after cancellation", async () => {
    const files = registry({ maxConcurrentReads: 1 }); files.add("a.txt", { body: "a" });
    const first = (await files.resolve("a.txt", request()))!;
    await expect(files.resolve("a.txt", request())).rejects.toMatchObject({ code: "LIMIT" });
    await first.body.cancel();
    const second = (await files.resolve("a.txt", request()))!;
    expect(await new Response(second.body).text()).toBe("a");
  });

  it("notifies a stream factory through its signal when the consumer cancels the body", async () => {
    const files = registry(); let signal: AbortSignal | undefined;
    files.add("live.txt", { stream: context => { signal = context.signal; return new ReadableStream({ pull() {} }, { highWaterMark: 0 }); } });
    const resource = (await files.resolve("live.txt", request()))!;
    expect(signal?.aborted).toBe(false);
    await resource.body.cancel(); expect(signal?.aborted).toBe(true);
    expect(signal?.reason).toMatchObject({ code: "ABORTED" });
  });

  it("imports without a DOM and only requires WebRTC when creating a peer", () => {
    vi.stubGlobal("RTCPeerConnection", undefined);
    expect(() => createFilePeer()).toThrow(new FileAccessError("UNAVAILABLE"));
  });
});
