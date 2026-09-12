import { ChangeSignal, FileAccessError, abortable, boundedNumber, validReference, validSize, type Disposable, type FileBacking, type FileDescriptor, type FileRequest, type FileSource, type RegisteredFile, type ResolvedFile } from "./types.js";

export interface FileRegistryOptions {
  /** Exact allowed URL origins. Empty by default. No cookies, referrers or redirects. */
  allowedOrigins?: readonly string[];
  maxPreviewBytes?: number;
  maxDownloadBytes?: number;
  /** Idle deadline while opening or consuming a stream. Default 60 seconds. */
  timeoutMs?: number;
  maxFiles?: number;
  maxConcurrentReads?: number;
}
type Entry = { descriptor: FileDescriptor; backing: RegisteredFile; lifetime: AbortController };
const cancel = (stream: ReadableStream<Uint8Array>) => { if (stream && typeof stream.cancel === "function" && !stream.locked) void stream.cancel().catch(() => {}); };
const mime = (value?: string) => {
  const result = value?.split(";", 1)[0].trim().toLowerCase() || "application/octet-stream";
  if (result.length > 128 || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(result)) throw new TypeError("Invalid file MIME type");
  return result;
};

/** An explicitly scoped set of files. Registration and lookup never read a backing. */
export class FileRegistry implements FileSource, Disposable {
  private entries = new Map<string, Entry>();
  private reads = new Set<AbortController>();
  private changed = new ChangeSignal();
  readonly onChange = this.changed.subscribe;
  private disposed = false;
  private origins: readonly string[];
  private previewLimit: number;
  private downloadLimit: number;
  private timeout: number;
  private maximumFiles: number;
  private maximumReads: number;

  constructor(options: FileRegistryOptions = {}) {
    this.origins = Object.freeze([...(options.allowedOrigins ?? [])]);
    for (const origin of this.origins) { const url = new URL(origin); if (!["http:", "https:"].includes(url.protocol) || url.origin !== origin || url.username || url.password) throw new TypeError("Use exact HTTP(S) file origins"); }
    this.previewLimit = boundedNumber(options.maxPreviewBytes, 16 * 1024 ** 2, 1024, 128 * 1024 ** 2);
    this.downloadLimit = boundedNumber(options.maxDownloadBytes, 128 * 1024 ** 2, 1024, 1024 ** 3);
    this.timeout = boundedNumber(options.timeoutMs, 60_000, 100, 300_000);
    this.maximumFiles = boundedNumber(options.maxFiles, 256, 1, 256);
    this.maximumReads = boundedNumber(options.maxConcurrentReads, 8, 1, 32);
  }

  add(reference: string, definition: RegisteredFile): Disposable {
    if (this.disposed) throw new FileAccessError("UNAVAILABLE");
    if (!validReference(reference)) throw new TypeError("Invalid file reference");
    if (this.entries.has(reference)) throw new Error("Remove the existing file before replacing it");
    if (this.entries.size >= this.maximumFiles) throw new FileAccessError("LIMIT");
    const copyBacking = (backing: FileBacking): FileBacking => {
      if (!backing || [backing.body !== undefined, backing.stream !== undefined, backing.url !== undefined].filter(Boolean).length !== 1) throw new TypeError("Supply one file body, stream factory or URL");
      if (backing.body !== undefined && typeof backing.body !== "string" && !(backing.body instanceof Blob)) throw new TypeError("File bodies must be strings or Blobs; use a factory for streams");
      if (backing.stream !== undefined && typeof backing.stream !== "function") throw new TypeError("Supply a stream factory");
      if (backing.size !== undefined && !validSize(backing.size)) throw new TypeError("Invalid file size");
      if (backing.mimeType !== undefined) mime(backing.mimeType);
      return Object.freeze({
        ...(backing.body === undefined ? {} : { body: backing.body }),
        ...(backing.stream === undefined ? {} : { stream: backing.stream }),
        ...(backing.url === undefined ? {} : { url: this.authorizedUrl(backing.url) }),
        ...(backing.mimeType === undefined ? {} : { mimeType: mime(backing.mimeType) }),
        ...(backing.size === undefined ? {} : { size: backing.size }),
      });
    };
    if (definition.authorize !== undefined && typeof definition.authorize !== "function") throw new TypeError("Supply an authorization callback");
    const backing: RegisteredFile = Object.freeze({ ...copyBacking(definition), authorize: definition.authorize, ...(definition.preview ? { preview: copyBacking(definition.preview) } : {}) });
    const blob = typeof backing.body === "string" ? new Blob([backing.body], { type: "text/plain" }) : backing.body;
    const pieces = reference.split(/[\\/]/u);
    const name = definition.name ?? pieces[pieces.length - 1] ?? "file";
    if (!validReference(name) || name.length > 180 || /[\\/]/u.test(name) || name === "." || name === "..") throw new TypeError("Invalid display filename");
    const id = [...crypto.getRandomValues(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2, "0")).join("");
    const descriptor: FileDescriptor = Object.freeze({ id, reference, name, mimeType: mime(backing.mimeType || blob?.type), ...(validSize(backing.size ?? blob?.size) ? { size: backing.size ?? blob!.size } : {}) });
    const entry = { descriptor, backing, lifetime: new AbortController() }; this.entries.set(reference, entry); this.changed.fire();
    return { dispose: () => { if (this.entries.get(reference) === entry) { this.entries.delete(reference); entry.lifetime.abort(new FileAccessError("DENIED")); this.changed.fire(); } } };
  }

  has(reference: string): boolean { return !this.disposed && this.entries.has(reference); }
  /** Metadata for explicitly sharing this registry with a peer; URLs and callbacks are excluded. */
  list(): readonly FileDescriptor[] { return [...this.entries.values()].map(entry => ({ ...entry.descriptor })); }
  async resolveId(id: string, request: FileRequest): Promise<ResolvedFile | null> {
    const entry = [...this.entries.values()].find(entry => entry.descriptor.id === id);
    return entry ? this.resolve(entry.descriptor.reference, request) : null;
  }

  private authorizedUrl(value: string): string {
    if (typeof value !== "string" || value.length > 8192 || /[\u0000-\u0020\u007f]/u.test(value)) throw new TypeError("Invalid file URL");
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash || !this.origins.includes(url.origin)) throw new TypeError("File URL origin is not authorized");
    return url.href;
  }

  async resolve(reference: string, request: FileRequest): Promise<ResolvedFile | null> {
    if (!["preview", "download"].includes(request.purpose)) throw new TypeError("Invalid file purpose");
    if (request.signal.aborted) throw new FileAccessError("ABORTED");
    const entry = this.entries.get(reference); if (this.disposed || !entry) return null;
    if (this.reads.size >= this.maximumReads) throw new FileAccessError("LIMIT");
    const abort = new AbortController(); this.reads.add(abort);
    const requestedAbort = () => abort.abort(new FileAccessError("ABORTED"));
    const revoked = () => abort.abort(new FileAccessError("DENIED"));
    request.signal.addEventListener("abort", requestedAbort, { once: true }); entry.lifetime.signal.addEventListener("abort", revoked, { once: true });
    let timeout: ReturnType<typeof setTimeout>;
    const arm = () => { clearTimeout(timeout); timeout = setTimeout(() => abort.abort(new FileAccessError("TIMEOUT")), this.timeout); }; arm();
    let done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(timeout); this.reads.delete(abort); request.signal.removeEventListener("abort", requestedAbort); entry.lifetime.signal.removeEventListener("abort", revoked); };
    const context = { purpose: request.purpose, signal: abort.signal };
    let stream: ReadableStream<Uint8Array> | undefined;
    try {
      if (entry.backing.authorize && !await abortable(Promise.resolve(entry.backing.authorize(context)), abort.signal)) throw new FileAccessError("DENIED");
      const source = request.purpose === "preview" ? entry.backing.preview ?? entry.backing : entry.backing;
      const limit = request.purpose === "preview" ? this.previewLimit : this.downloadLimit;
      let type = source.mimeType, size = source.size;
      if (source.body !== undefined) {
        const blob = typeof source.body === "string" ? new Blob([source.body], { type: "text/plain" }) : source.body;
        size = blob.size; type ||= blob.type; stream = blob.stream();
      } else if (source.url) {
        const response = await abortable(fetch(this.authorizedUrl(source.url), { signal: abort.signal, mode: "cors", credentials: "omit", referrerPolicy: "no-referrer", referrer: "", redirect: "error", cache: "no-store" }), abort.signal, response => { void response.body?.cancel().catch(() => {}); });
        if (!response.ok || !response.body || response.redirected) { void response.body?.cancel().catch(() => {}); throw new FileAccessError("UNAVAILABLE"); }
        stream = response.body; type ||= response.headers.get("content-type") ?? undefined;
        const length = response.headers.get("content-length"); if (length !== null && validSize(Number(length))) size ??= Number(length);
      } else stream = await abortable(Promise.resolve(source.stream!(context)), abort.signal, cancel);
      if (!stream || typeof stream.getReader !== "function" || stream.locked) throw new FileAccessError("UNAVAILABLE");
      if (abort.signal.aborted) throw abort.signal.reason;
      if (size !== undefined && size > limit) throw new FileAccessError("LIMIT");
      const mimeType = mime(type);
      const reader = stream.getReader(); let bytes = 0, empty = 0;
      const release = () => { try { reader.releaseLock(); } catch { /* A pending read is released after cancellation. */ } };
      const cancelReader = () => { void reader.cancel().catch(() => {}).finally(release); };
      let controller: ReadableStreamDefaultController<Uint8Array>;
      const stop = () => { if (done) return; cancelReader(); controller.error(abort.signal.reason ?? new FileAccessError("ABORTED")); finish(); };
      const body = new ReadableStream<Uint8Array>({
        start(value) { controller = value; abort.signal.addEventListener("abort", stop, { once: true }); },
        async pull(value) {
          arm();
          try {
            for (;;) {
              const next = await reader.read(); if (done) return;
              if (next.done) { value.close(); finish(); release(); abort.signal.removeEventListener("abort", stop); return; }
              if (!ArrayBuffer.isView(next.value) || next.value.BYTES_PER_ELEMENT !== 1) throw new FileAccessError("UNAVAILABLE");
              if (!next.value.byteLength) { if (++empty > 128) throw new FileAccessError("LIMIT"); continue; }
              empty = 0; bytes += next.value.byteLength;
              if (bytes > limit) throw new FileAccessError("LIMIT");
              value.enqueue(new Uint8Array(next.value.buffer, next.value.byteOffset, next.value.byteLength)); arm(); return;
            }
          } catch (error) { if (!done) {
            const failure = error instanceof FileAccessError ? error : new FileAccessError("UNAVAILABLE");
            value.error(failure); finish(); abort.signal.removeEventListener("abort", stop); abort.abort(failure); cancelReader();
          } }
        },
        cancel() { finish(); abort.signal.removeEventListener("abort", stop); abort.abort(new FileAccessError("ABORTED")); cancelReader(); },
      }, { highWaterMark: 0 });
      return { name: entry.descriptor.name, mimeType, ...(size === undefined ? {} : { size }), body };
    } catch (error) {
      const failure = error instanceof FileAccessError ? error : new FileAccessError("UNAVAILABLE");
      finish(); abort.abort(failure); if (stream && !stream.locked) cancel(stream);
      throw failure;
    }
  }

  dispose(): void {
    if (this.disposed) return; this.disposed = true;
    for (const entry of this.entries.values()) entry.lifetime.abort(new FileAccessError("DENIED"));
    for (const read of this.reads) read.abort(new FileAccessError("ABORTED"));
    this.entries.clear(); this.changed.fire(); this.changed.dispose();
  }
}
