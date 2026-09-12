import { ChangeSignal, FileAccessError, boundedNumber, validId, validReference, validSize, type Disposable, type FileDescriptor, type FileErrorCode, type FileRequest, type FileSource, type ResolvedFile } from "./types.js";

export const FILE_CHANNEL_PROTOCOL = "shell-files/1";
// Including the request ID, every binary message fits within 16 KiB.
const CHUNK_BYTES = 16 * 1024 - 4;
const MAX_CONTROL_BYTES = 8192;
const MAX_BUFFERED_BYTES = 1024 * 1024;
const MAX_FILES = 256;
const errorCodes = new Set<FileErrorCode>(["UNAVAILABLE", "DENIED", "LIMIT", "ABORTED", "TIMEOUT", "DISCONNECTED", "PROTOCOL"]);

export interface FileChannelOptions {
  /** Only this explicitly scoped set is advertised. Backing URLs are never advertised. */
  files?: FileSource;
  timeoutMs?: number;
  maxPreviewBytes?: number;
  maxDownloadBytes?: number;
  maxConcurrentTransfers?: number;
}
type Read = {
  id: number; fileId: string; limit: number; bytes: number; timer?: ReturnType<typeof setTimeout>;
  resolve(value: ResolvedFile): void; reject(error: FileAccessError): void; cleanup(): void;
  controller?: ReadableStreamDefaultController<Uint8Array>;
  credit?: () => void;
};
type Send = {
  id: number; fileId: string; limit: number; bytes: number; abort: AbortController;
  timer?: ReturnType<typeof setTimeout>; reader?: ReadableStreamDefaultReader<Uint8Array>;
  chunk?: Uint8Array; offset: number; busy: boolean;
};
type Message = Record<string, unknown>;
const requestId = (value: unknown): value is number => Number.isInteger(value) && Number(value) > 0 && Number(value) <= 0xffffffff;
const displayName = (value: unknown): value is string => validReference(value) && value.length <= 180 && !/[\\/]/u.test(value) && value !== "." && value !== "..";
const mimeType = (value: unknown): value is string => typeof value === "string" && value.length <= 128 && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(value);
function descriptor(value: Message): FileDescriptor {
  if (!validId(value.id) || !validReference(value.reference) || !displayName(value.name) || !mimeType(value.mimeType) || value.size !== undefined && !validSize(value.size)) throw new FileAccessError("PROTOCOL");
  return { id: value.id, reference: value.reference, name: value.name, mimeType: value.mimeType, ...(value.size === undefined ? {} : { size: value.size as number }) };
}
const safeError = (error: unknown): FileAccessError => error instanceof FileAccessError ? error : new FileAccessError("UNAVAILABLE");

/** Transfer explicitly shared files over an already authenticated, reliable ordered data channel. */
export class FileChannel implements FileSource, Disposable {
  readonly ready: Promise<void>;
  private complete!: () => void;
  private reject!: (error: FileAccessError) => void;
  private changed = new ChangeSignal();
  readonly onChange = this.changed.subscribe;
  private remote = new Map<string, FileDescriptor>();
  private remoteIds = new Map<string, string>();
  private published = new Map<string, FileDescriptor>();
  private reads = new Map<number, Read>();
  private sends = new Map<number, Send>();
  private nextId = 0;
  private lastRemoteId = 0;
  private started = false;
  private receivedHello = false;
  private receivedReady = false;
  private disposed = false;
  private subscription?: Disposable;
  private handshake?: ReturnType<typeof setTimeout>;
  private timeout: number;
  private previewLimit: number;
  private downloadLimit: number;
  private maximumTransfers: number;

  constructor(private channel: RTCDataChannel, private options: FileChannelOptions = {}) {
    if (channel.protocol !== FILE_CHANNEL_PROTOCOL || !channel.ordered || channel.maxRetransmits !== null || channel.maxPacketLifeTime !== null) throw new TypeError("File streams require the shell-files/1 reliable ordered data channel");
    this.timeout = boundedNumber(options.timeoutMs, 30_000, 100, 300_000);
    this.previewLimit = boundedNumber(options.maxPreviewBytes, 16 * 1024 ** 2, 1024, 128 * 1024 ** 2);
    this.downloadLimit = boundedNumber(options.maxDownloadBytes, 128 * 1024 ** 2, 1024, 1024 ** 3);
    this.maximumTransfers = boundedNumber(options.maxConcurrentTransfers, 4, 1, 16);
    this.options = { ...options };
    this.ready = new Promise((resolve, reject) => { this.complete = resolve; this.reject = reject; });
    // It is valid to dispose a peer before awaiting ready.
    void this.ready.catch(() => {});
    channel.binaryType = "arraybuffer";
    channel.addEventListener("open", this.open);
    channel.addEventListener("message", this.message);
    channel.addEventListener("close", this.disconnect);
    channel.addEventListener("error", this.disconnect);
    this.handshake = setTimeout(() => this.close(new FileAccessError("TIMEOUT")), this.timeout);
    if (channel.readyState === "open") queueMicrotask(this.open);
    else if (channel.readyState === "closed" || channel.readyState === "closing") queueMicrotask(this.disconnect);
  }

  private open = (): void => {
    if (this.disposed || this.started) return;
    this.started = true;
    try {
      this.control({ type: "hello", version: 1 });
      this.publish();
      this.control({ type: "ready" });
      this.subscription = this.options.files?.onChange(() => { try { this.publish(); } catch (error) { this.close(safeError(error)); } });
    } catch (error) { this.close(safeError(error)); }
  };
  private disconnect = (): void => { this.close(new FileAccessError("DISCONNECTED")); };
  private control(message: Message): void {
    const json = JSON.stringify(message);
    if (new TextEncoder().encode(json).byteLength > MAX_CONTROL_BYTES) throw new FileAccessError("LIMIT");
    this.send(json);
  }
  private send(data: string | ArrayBuffer): void {
    if (this.disposed || this.channel.readyState !== "open") throw new FileAccessError("DISCONNECTED");
    const bytes = typeof data === "string" ? new TextEncoder().encode(data).byteLength : data.byteLength;
    // Credit-based reads normally keep this far below the cap. Never queue an unbounded backlog.
    if (this.channel.bufferedAmount + bytes > MAX_BUFFERED_BYTES) throw new FileAccessError("LIMIT");
    if (typeof data === "string") this.channel.send(data); else this.channel.send(data);
  }
  private publish(): void {
    const files = this.options.files?.list() ?? [];
    if (files.length > MAX_FILES) throw new FileAccessError("LIMIT");
    const current = new Map<string, FileDescriptor>(); const references = new Set<string>();
    for (const file of files) {
      const valid = descriptor({ ...file });
      if (current.has(valid.id) || references.has(valid.reference)) throw new FileAccessError("PROTOCOL");
      current.set(valid.id, valid); references.add(valid.reference);
    }
    for (const [id] of this.published) if (!current.has(id)) {
      this.control({ type: "removed", id });
      for (const outgoing of [...this.sends.values()]) if (outgoing.fileId === id) this.finishSend(outgoing, new FileAccessError("DENIED"));
    }
    for (const [id, file] of current) {
      const previous = this.published.get(id);
      if (previous && previous.reference !== file.reference) throw new FileAccessError("PROTOCOL");
      if (JSON.stringify(previous) !== JSON.stringify(file)) this.control({ type: "file", ...file });
    }
    this.published = current;
  }

  has(reference: string): boolean { return !this.disposed && this.receivedReady && this.remote.has(reference); }
  list(): readonly FileDescriptor[] { return this.disposed || !this.receivedReady ? [] : [...this.remote.values()].map(file => ({ ...file })); }

  resolve(reference: string, request: FileRequest): Promise<ResolvedFile | null> {
    if (request.purpose !== "preview" && request.purpose !== "download") return Promise.reject(new TypeError("Invalid file purpose"));
    if (request.signal.aborted) return Promise.reject(new FileAccessError("ABORTED"));
    const file = this.remote.get(reference);
    // Unknown text is never sent to a peer, even when it resembles a file path.
    if (!file || !this.has(reference)) return Promise.resolve(null);
    if (this.reads.size >= this.maximumTransfers || this.nextId === 0xffffffff) return Promise.reject(new FileAccessError("LIMIT"));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const abort = () => this.finishRead(read, new FileAccessError("ABORTED"), true);
      const read: Read = { id, fileId: file.id, limit: request.purpose === "preview" ? this.previewLimit : this.downloadLimit, bytes: 0, resolve, reject,
        cleanup: () => request.signal.removeEventListener("abort", abort) };
      this.reads.set(id, read); request.signal.addEventListener("abort", abort, { once: true });
      this.armRead(read);
      try { this.control({ type: "get", id, fileId: file.id, purpose: request.purpose }); }
      catch (error) { this.close(safeError(error)); }
    });
  }

  private armRead(read: Read): void {
    clearTimeout(read.timer);
    read.timer = setTimeout(() => this.finishRead(read, new FileAccessError("TIMEOUT"), true), this.timeout);
  }
  private finishRead(read: Read, error?: FileAccessError, notify = false, cancelled = false): void {
    if (!this.reads.delete(read.id)) return;
    clearTimeout(read.timer); read.cleanup();
    if (notify && !this.disposed) { try { this.control({ type: "cancel", id: read.id }); } catch (failure) { this.close(safeError(failure)); } }
    if (read.controller) {
      if (!cancelled) { if (error) read.controller.error(error); else read.controller.close(); }
    } else read.reject(error ?? new FileAccessError("UNAVAILABLE"));
    read.credit?.(); read.credit = undefined;
  }
  private metadata(read: Read, value: Message): void {
    if (read.controller || !displayName(value.name) || !mimeType(value.mimeType) || value.size !== undefined && !validSize(value.size)) throw new FileAccessError("PROTOCOL");
    if (value.size !== undefined && Number(value.size) > read.limit) { this.finishRead(read, new FileAccessError("LIMIT"), true); return; }
    const body = new ReadableStream<Uint8Array>({
      start: controller => { read.controller = controller; },
      pull: () => new Promise<void>(resolve => {
        if (!this.reads.has(read.id)) { resolve(); return; }
        read.credit = resolve; this.armRead(read);
        try { this.control({ type: "pull", id: read.id }); } catch (error) { this.close(safeError(error)); }
      }),
      cancel: () => { this.finishRead(read, undefined, true, true); },
    }, { highWaterMark: 0 });
    this.armRead(read);
    read.resolve({ name: value.name, mimeType: value.mimeType, ...(value.size === undefined ? {} : { size: value.size as number }), body });
  }

  private armSend(outgoing: Send): void {
    clearTimeout(outgoing.timer);
    outgoing.timer = setTimeout(() => this.finishSend(outgoing, new FileAccessError("TIMEOUT")), this.timeout);
  }
  private finishSend(outgoing: Send, error?: FileAccessError, notify = true): void {
    if (!this.sends.delete(outgoing.id)) return;
    clearTimeout(outgoing.timer);
    if (error) outgoing.abort.abort(error);
    const reader = outgoing.reader;
    if (reader) {
      const release = () => { try { reader.releaseLock(); } catch { /* A cancellation is still settling. */ } };
      if (error) void reader.cancel().catch(() => {}).finally(release); else release();
    }
    outgoing.chunk = undefined;
    if (error && notify && !this.disposed) {
      try { this.control({ type: "error", id: outgoing.id, code: error.code }); } catch (failure) { this.close(safeError(failure)); }
    }
  }
  private async get(value: Message): Promise<void> {
    const id = value.id as number;
    if (id <= this.lastRemoteId || !validId(value.fileId) || value.purpose !== "preview" && value.purpose !== "download") throw new FileAccessError("PROTOCOL");
    this.lastRemoteId = id;
    const file = this.published.get(value.fileId);
    if (!file || !this.options.files?.has(file.reference)) { this.control({ type: "error", id, code: "UNAVAILABLE" }); return; }
    if (this.sends.size >= this.maximumTransfers) { this.control({ type: "error", id, code: "LIMIT" }); return; }
    const outgoing: Send = { id, fileId: file.id, abort: new AbortController(), offset: 0, bytes: 0, busy: true, limit: value.purpose === "preview" ? this.previewLimit : this.downloadLimit };
    this.sends.set(id, outgoing); this.armSend(outgoing);
    try {
      const resource = await this.options.files.resolve(file.reference, { purpose: value.purpose, signal: outgoing.abort.signal });
      if (!this.sends.has(id)) { if (resource?.body && !resource.body.locked) void resource.body.cancel().catch(() => {}); return; }
      if (!resource || !displayName(resource.name) || !mimeType(resource.mimeType) || !resource.body || resource.body.locked || resource.size !== undefined && !validSize(resource.size)) {
        if (resource?.body && !resource.body.locked) void resource.body.cancel().catch(() => {});
        throw new FileAccessError("UNAVAILABLE");
      }
      if (resource.size !== undefined && resource.size > outgoing.limit) { void resource.body.cancel().catch(() => {}); throw new FileAccessError("LIMIT"); }
      outgoing.reader = resource.body.getReader(); outgoing.busy = false; this.armSend(outgoing);
      this.control({ type: "meta", id, name: resource.name, mimeType: resource.mimeType, ...(resource.size === undefined ? {} : { size: resource.size }) });
    } catch (error) { this.finishSend(outgoing, safeError(error)); }
  }
  private async pull(outgoing: Send): Promise<void> {
    if (outgoing.busy || !outgoing.reader) throw new FileAccessError("PROTOCOL");
    outgoing.busy = true; this.armSend(outgoing);
    try {
      let empty = 0;
      while (!outgoing.chunk) {
        const next = await outgoing.reader.read(); if (!this.sends.has(outgoing.id)) return;
        if (next.done) { this.control({ type: "end", id: outgoing.id }); this.finishSend(outgoing); return; }
        if (!ArrayBuffer.isView(next.value) || next.value.BYTES_PER_ELEMENT !== 1) throw new FileAccessError("UNAVAILABLE");
        if (!next.value.byteLength) { if (++empty > 128) throw new FileAccessError("LIMIT"); continue; }
        if (outgoing.bytes + next.value.byteLength > outgoing.limit) throw new FileAccessError("LIMIT");
        outgoing.chunk = next.value; outgoing.offset = 0;
      }
      const length = Math.min(CHUNK_BYTES, outgoing.chunk.byteLength - outgoing.offset);
      const packet = new Uint8Array(length + 4); new DataView(packet.buffer).setUint32(0, outgoing.id);
      packet.set(outgoing.chunk.subarray(outgoing.offset, outgoing.offset + length), 4);
      this.send(packet.buffer);
      outgoing.offset += length; outgoing.bytes += length;
      if (outgoing.offset === outgoing.chunk.byteLength) outgoing.chunk = undefined;
      outgoing.busy = false; this.armSend(outgoing);
    } catch (error) { this.finishSend(outgoing, safeError(error)); }
  }

  private message = (event: MessageEvent): void => {
    if (this.disposed) return;
    try {
      if (typeof event.data !== "string") {
        if (!this.receivedReady || !(event.data instanceof ArrayBuffer) || event.data.byteLength <= 4 || event.data.byteLength > CHUNK_BYTES + 4) throw new FileAccessError("PROTOCOL");
        const id = new DataView(event.data).getUint32(0);
        if (!requestId(id) || id > this.nextId) throw new FileAccessError("PROTOCOL");
        const read = this.reads.get(id); if (!read) return; // A cancelled request can have one chunk in flight.
        if (!read.controller || !read.credit) throw new FileAccessError("PROTOCOL");
        const chunk = new Uint8Array(event.data, 4); read.bytes += chunk.byteLength;
        if (read.bytes > read.limit) { this.finishRead(read, new FileAccessError("LIMIT"), true); return; }
        read.controller.enqueue(chunk); const credit = read.credit; read.credit = undefined; credit(); this.armRead(read); return;
      }
      if (event.data.length > MAX_CONTROL_BYTES || new TextEncoder().encode(event.data).byteLength > MAX_CONTROL_BYTES) throw new FileAccessError("PROTOCOL");
      const value: Message = JSON.parse(event.data);
      if (!value || Array.isArray(value) || typeof value !== "object") throw new FileAccessError("PROTOCOL");
      if (value.type === "hello") {
        if (this.receivedHello || value.version !== 1) throw new FileAccessError("PROTOCOL");
        this.receivedHello = true; return;
      }
      if (!this.receivedHello) throw new FileAccessError("PROTOCOL");
      if (value.type === "file") {
        const file = descriptor(value), previous = this.remote.get(file.reference), existing = this.remoteIds.get(file.id);
        if (previous && previous.id !== file.id || existing && existing !== file.reference || !previous && this.remote.size >= MAX_FILES) throw new FileAccessError("PROTOCOL");
        this.remote.set(file.reference, file); this.remoteIds.set(file.id, file.reference);
        if (this.receivedReady) this.changed.fire(); return;
      }
      if (value.type === "removed") {
        if (!validId(value.id)) throw new FileAccessError("PROTOCOL");
        const reference = this.remoteIds.get(value.id);
        if (reference) { this.remote.delete(reference); this.remoteIds.delete(value.id); }
        for (const read of [...this.reads.values()]) if (read.fileId === value.id) this.finishRead(read, new FileAccessError("DENIED"), true);
        if (this.receivedReady) this.changed.fire(); return;
      }
      if (value.type === "ready") {
        if (this.receivedReady) throw new FileAccessError("PROTOCOL");
        this.receivedReady = true; clearTimeout(this.handshake); this.complete(); this.changed.fire(); return;
      }
      if (!this.receivedReady || !requestId(value.id)) throw new FileAccessError("PROTOCOL");
      if (value.type === "get") { void this.get(value).catch(error => this.close(safeError(error))); return; }
      if (value.type === "pull" || value.type === "cancel") {
        if (value.id > this.lastRemoteId) throw new FileAccessError("PROTOCOL");
        const outgoing = this.sends.get(value.id); if (!outgoing) return;
        if (value.type === "cancel") this.finishSend(outgoing, new FileAccessError("ABORTED"), false);
        else void this.pull(outgoing).catch(error => this.close(safeError(error)));
        return;
      }
      if (value.id > this.nextId || !["meta", "end", "error"].includes(String(value.type))) throw new FileAccessError("PROTOCOL");
      const read = this.reads.get(value.id); if (!read) return;
      if (value.type === "meta") this.metadata(read, value);
      else if (value.type === "end") {
        if (!read.controller || !read.credit) throw new FileAccessError("PROTOCOL");
        this.finishRead(read);
      } else {
        if (!errorCodes.has(value.code as FileErrorCode)) throw new FileAccessError("PROTOCOL");
        this.finishRead(read, new FileAccessError(value.code as FileErrorCode));
      }
    } catch (error) { this.close(error instanceof FileAccessError ? error : new FileAccessError("PROTOCOL")); }
  };

  private close(error: FileAccessError): void {
    if (this.disposed) return; this.disposed = true;
    clearTimeout(this.handshake); this.subscription?.dispose();
    this.channel.removeEventListener("open", this.open); this.channel.removeEventListener("message", this.message);
    this.channel.removeEventListener("close", this.disconnect); this.channel.removeEventListener("error", this.disconnect);
    for (const read of [...this.reads.values()]) this.finishRead(read, error);
    for (const outgoing of [...this.sends.values()]) this.finishSend(outgoing, error, false);
    this.remote.clear(); this.remoteIds.clear(); this.published.clear();
    this.reject(error); this.channel.close(); this.changed.fire(); this.changed.dispose();
  }
  dispose(): void { this.close(new FileAccessError("DISCONNECTED")); }
}
