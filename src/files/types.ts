export interface Disposable { dispose(): void }
export type FilePurpose = "preview" | "download";
export interface FileRequest { purpose: FilePurpose; signal: AbortSignal }
export interface FileDescriptor {
  /** Opaque capability for a registered source. It is not a URL or a filesystem path. */
  id: string;
  reference: string;
  name: string;
  mimeType: string;
  size?: number;
}
export interface ResolvedFile {
  name: string;
  mimeType: string;
  size?: number;
  body: ReadableStream<Uint8Array>;
}
export interface FileSource {
  has(reference: string): boolean;
  list(): readonly FileDescriptor[];
  resolve(reference: string, request: FileRequest): Promise<ResolvedFile | null>;
  onChange(listener: () => void): Disposable;
}
/** Supply exactly one backing. Stream factories must return a fresh stream per read. */
export interface FileBacking {
  body?: Blob | string;
  stream?(request: FileRequest): ReadableStream<Uint8Array> | Promise<ReadableStream<Uint8Array>>;
  url?: string;
  mimeType?: string;
  size?: number;
}
export interface RegisteredFile extends FileBacking {
  name?: string;
  preview?: FileBacking;
  /** Rechecked for every preview and download, before opening the backing. */
  authorize?(request: FileRequest): boolean | Promise<boolean>;
}
export type FileErrorCode = "UNAVAILABLE" | "DENIED" | "LIMIT" | "ABORTED" | "TIMEOUT" | "DISCONNECTED" | "PROTOCOL";
const messages: Record<FileErrorCode, string> = {
  UNAVAILABLE: "File unavailable.", DENIED: "File access denied.", LIMIT: "File or transfer limit exceeded.",
  ABORTED: "File request cancelled.", TIMEOUT: "File request timed out.", DISCONNECTED: "File peer disconnected.", PROTOCOL: "Invalid file protocol message.",
};
export class FileAccessError extends Error {
  constructor(readonly code: FileErrorCode) { super(messages[code]); this.name = "FileAccessError"; }
}
export class ChangeSignal {
  private listeners = new Set<() => void>();
  readonly subscribe = (listener: () => void): Disposable => { this.listeners.add(listener); return { dispose: () => { this.listeners.delete(listener); } }; };
  fire(): void { for (const listener of [...this.listeners]) listener(); }
  dispose(): void { this.listeners.clear(); }
}
export const validReference = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 1024 && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value);
export const validId = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{32}$/u.test(value);
export const validSize = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
export function boundedNumber(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError("Invalid file resource limit");
  return value;
}
export function abortable<T>(promise: Promise<T>, signal: AbortSignal, late?: (value: T) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let cancelled = signal.aborted;
    const abort = () => { cancelled = true; reject(signal.reason instanceof FileAccessError ? signal.reason : new FileAccessError("ABORTED")); };
    if (cancelled) abort(); else signal.addEventListener("abort", abort, { once: true });
    promise.then(value => { signal.removeEventListener("abort", abort); if (cancelled) { try { late?.(value); } catch { /* The cancelled operation no longer owns this result. */ } } else resolve(value); }, error => { signal.removeEventListener("abort", abort); if (!cancelled) reject(error); });
  });
}
/** Synchronous detection is a map lookup; only an explicit resolve opens a source. */
export function fileLinks(source: FileSource) {
  return {
    canResolve(reference: { path: string }): boolean { return source.has(reference.path); },
    onChange(listener: () => void): Disposable { return source.onChange(listener); },
    resolve(reference: { path: string }, request: FileRequest): Promise<ResolvedFile | null> { return source.resolve(reference.path, request); },
  };
}
