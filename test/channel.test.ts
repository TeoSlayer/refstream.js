import { afterEach, expect, it, vi } from "vitest";
import { FileChannel, FileRegistry, FILE_CHANNEL_PROTOCOL, type Disposable, type FileChannelOptions } from "../src/index.js";

class Wire extends EventTarget {
  protocol = FILE_CHANNEL_PROTOCOL; ordered = true; maxRetransmits = null; maxPacketLifeTime = null;
  readyState = "open"; bufferedAmount = 0; binaryType = "arraybuffer";
  sent: (string | ArrayBuffer)[] = []; peer!: Wire;
  send(value: string | ArrayBuffer) {
    if (this.readyState !== "open") throw new Error("closed");
    const data = typeof value === "string" ? value : value.slice(0); this.sent.push(data);
    queueMicrotask(() => { if (this.peer.readyState === "open") this.peer.dispatchEvent(new MessageEvent("message", { data })); });
  }
  close() {
    if (this.readyState === "closed") return; this.readyState = "closed"; this.dispatchEvent(new Event("close"));
    if (this.peer.readyState !== "closed") this.peer.close();
  }
}
const owned: Disposable[] = [];
const registry = () => { const value = new FileRegistry(); owned.push(value); return value; };
const request = (purpose: "preview" | "download" = "download", signal = new AbortController().signal) => ({ purpose, signal });
async function pair(files: FileRegistry, options: FileChannelOptions = {}) {
  const hostWire = new Wire(), viewerWire = new Wire(); hostWire.peer = viewerWire; viewerWire.peer = hostWire;
  const host = new FileChannel(hostWire as unknown as RTCDataChannel, { ...options, files });
  const viewer = new FileChannel(viewerWire as unknown as RTCDataChannel, options); owned.push(host, viewer);
  await Promise.all([host.ready, viewer.ready]); return { host, viewer, hostWire, viewerWire };
}
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
afterEach(() => { for (const resource of owned.splice(0)) resource.dispose(); vi.restoreAllMocks(); vi.useRealTimers(); });

it("streams complete files in bounded binary chunks, preserving names and UTF-8 bytes", async () => {
  const contents = "こんにちは, streamed file.\n".repeat(10_000);
  const files = registry(); files.add("reports/output.txt", { body: contents, preview: { body: "preview" } });
  const { viewer, hostWire, viewerWire } = await pair(files);
  const result = (await viewer.resolve("reports/output.txt", request()))!;
  expect(result.name).toBe("output.txt"); expect(await new Response(result.body).text()).toBe(contents);
  expect(await new Response((await viewer.resolve("reports/output.txt", request("preview")))!.body).text()).toBe("preview");
  const packets = hostWire.sent.filter(value => typeof value !== "string") as ArrayBuffer[];
  expect(packets.length).toBeGreaterThan(10); expect(packets.every(value => value.byteLength <= 16 * 1024)).toBe(true);
  const transmitted = viewerWire.sent.length;
  expect(await viewer.resolve("/etc/passwd", request())).toBeNull();
  expect(viewerWire.sent).toHaveLength(transmitted);
  expect(JSON.stringify(viewerWire.sent)).not.toContain("/etc/passwd");
});

it("only pulls a backing when its consumer requests bytes, and cancellation reaches the producer", async () => {
  let pulls = 0; const cancelled = vi.fn();
  const files = registry(); files.add("live.bin", { stream: () => new ReadableStream({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(64 * 1024)); }, cancel: cancelled }, { highWaterMark: 0 }) });
  const { viewer, hostWire } = await pair(files);
  const result = (await viewer.resolve("live.bin", request()))!; await settle();
  expect(pulls).toBe(0); expect(hostWire.sent.filter(value => typeof value !== "string")).toHaveLength(0);
  const reader = result.body.getReader(); expect((await reader.read()).value?.byteLength).toBe(16 * 1024 - 4);
  await settle(); expect(pulls).toBe(1); expect(hostWire.sent.filter(value => typeof value !== "string")).toHaveLength(1);
  await reader.cancel(); await settle(); expect(cancelled).toHaveBeenCalledOnce();
});

it("reauthorizes both previews and downloads, without forwarding arbitrary paths or source errors", async () => {
  const authorize = vi.fn(() => false), files = registry();
  files.add("private.txt", { body: "secret", authorize });
  const { viewer, viewerWire } = await pair(files);
  await expect(viewer.resolve("private.txt", request("preview"))).rejects.toMatchObject({ code: "DENIED" });
  await expect(viewer.resolve("private.txt", request())).rejects.toMatchObject({ code: "DENIED" });
  expect(authorize).toHaveBeenCalledTimes(2);
  const messages = viewerWire.sent.filter(value => typeof value === "string").map(value => JSON.parse(value as string));
  expect(messages.filter(value => value.type === "get").every(value => /^[a-f0-9]{32}$/u.test(value.fileId) && value.path === undefined)).toBe(true);
});

it("withdraws a revoked file and cancels an in-flight read", async () => {
  const cancel = vi.fn(), files = registry();
  const registration = files.add("live.txt", { stream: () => new ReadableStream({ pull() {}, cancel }, { highWaterMark: 0 }) });
  const { viewer } = await pair(files); const changes = vi.fn(); viewer.onChange(changes);
  const result = (await viewer.resolve("live.txt", request()))!;
  const pending = result.body.getReader().read(); const rejected = expect(pending).rejects.toMatchObject({ code: "DENIED" });
  await settle(); registration.dispose(); await rejected; await settle();
  expect(viewer.has("live.txt")).toBe(false); expect(viewer.list()).toEqual([]); expect(changes).toHaveBeenCalled(); expect(cancel).toHaveBeenCalledOnce();
});

it("does not advertise backing URLs or fetch anything to share a catalog", async () => {
  const files = new FileRegistry({ allowedOrigins: ["https://private.example"] }); owned.push(files);
  files.add("shared.pdf", { url: "https://private.example/SECRET?token=hidden", mimeType: "application/pdf" });
  const fetch = vi.spyOn(globalThis, "fetch"); const { hostWire, viewer } = await pair(files);
  expect(viewer.has("shared.pdf")).toBe(true); expect(fetch).not.toHaveBeenCalled();
  expect(JSON.stringify(hostWire.sent)).not.toMatch(/private\.example|SECRET|hidden/);
});

it("enforces download limits even without a declared file size", async () => {
  const files = registry(); files.add("huge.bin", { stream: () => new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(2048)); controller.close(); } }) });
  const { viewer } = await pair(files, { maxDownloadBytes: 1024 });
  const result = (await viewer.resolve("huge.bin", request()))!;
  await expect(new Response(result.body).arrayBuffer()).rejects.toMatchObject({ code: "LIMIT" });
});

it("cancels an aborted request, releasing capacity for the next request", async () => {
  const files = registry(); files.add("a.txt", { body: "a" });
  const { viewer } = await pair(files, { maxConcurrentTransfers: 1 }); const abort = new AbortController();
  const first = (await viewer.resolve("a.txt", request("download", abort.signal)))!;
  await expect(viewer.resolve("a.txt", request())).rejects.toMatchObject({ code: "LIMIT" });
  abort.abort(); await expect(first.body.getReader().read()).rejects.toMatchObject({ code: "ABORTED" }); await settle();
  expect(await new Response((await viewer.resolve("a.txt", request()))!.body).text()).toBe("a");
});

it("rejects unsolicited binary data instead of buffering unrequested bytes", async () => {
  const files = registry(); files.add("a.txt", { body: "a" }); const { viewer, hostWire } = await pair(files);
  const result = (await viewer.resolve("a.txt", request()))!;
  const packet = new Uint8Array(8); new DataView(packet.buffer).setUint32(0, 1); hostWire.send(packet.buffer); await settle();
  await expect(result.body.getReader().read()).rejects.toMatchObject({ code: "PROTOCOL" });
  expect(viewer.has("a.txt")).toBe(false); expect(hostWire.readyState).toBe("closed");
});

it("times out stalled transfers and tears down streams on disconnect", async () => {
  vi.useFakeTimers(); const files = registry(), cancel = vi.fn();
  files.add("slow.bin", { stream: () => new ReadableStream({ pull() {}, cancel }, { highWaterMark: 0 }) });
  const connected = pair(files, { timeoutMs: 100 }); await vi.advanceTimersByTimeAsync(0); const { viewer, host } = await connected;
  const resolved = viewer.resolve("slow.bin", request()); await vi.advanceTimersByTimeAsync(0); const resource = (await resolved)!;
  const pending = resource.body.getReader().read(); const rejected = expect(pending).rejects.toMatchObject({ code: "TIMEOUT" });
  await vi.advanceTimersByTimeAsync(101); await rejected; expect(cancel).toHaveBeenCalledOnce();
  const next = viewer.resolve("slow.bin", request()); await vi.advanceTimersByTimeAsync(0); const second = (await next)!;
  host.dispose(); await expect(second.body.getReader().read()).rejects.toMatchObject({ code: "DISCONNECTED" });
});

it("rejects unreliable channels before accepting file traffic", () => {
  const wire = new Wire(); wire.ordered = false;
  expect(() => new FileChannel(wire as unknown as RTCDataChannel)).toThrow("reliable ordered");
});
