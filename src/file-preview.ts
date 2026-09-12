import type { TerminalFileReference } from "./links.js";
import { terminalUiThemeVariables } from "./themes.js";
import { configureUi, ownUiCleanup, uiButton, uiText, uiTooltip, type TerminalUiOptions, type TerminalUiCleanup } from "./ui-options.js";

export interface TerminalFileResource {
  name?: string;
  mimeType?: string;
  size?: number;
  /** Supply either a body or a URL. Authenticated hosts should supply the response stream themselves. */
  body?: string | Blob | ReadableStream<Uint8Array>;
  /** Only an explicit host allowlist permits a URL request. Never derived from terminal output. */
  url?: string;
  /** Optional same-origin attachment endpoint. The host server authorizes the browser's native download. */
  downloadUrl?: string;
}
export interface TerminalFileLinkOptions {
  /** Optional synchronous, local availability check. Unbacked references remain plain text. */
  canResolve?(reference: Readonly<TerminalFileReference>): boolean;
  /** Notify when backed files change. The renderer refreshes links and removes revoked previews. */
  onChange?(listener: () => void): { dispose(): void };
  /** Called only after hover intent, keyboard focus or activation. Authorize every reference and purpose. */
  resolve(reference: Readonly<TerminalFileReference>, request: { signal: AbortSignal; purpose: "preview" | "download" }): TerminalFileResource | null | Promise<TerminalFileResource | null>;
  /** Optional host-owned save action, called in the click's user gesture. The host authorizes this operation. */
  download?(reference: Readonly<TerminalFileReference>, request: { signal: AbortSignal }): void | Promise<void>;
  /** Exact origins, including the current origin if needed. Empty by default. Redirects are refused. */
  allowedOrigins?: readonly string[];
  hoverDelayMs?: number;
  /** Grace period when leaving a preview. Defaults to 600ms; the gap to the file stays interactive. */
  hideDelayMs?: number;
  /** Defaults to 8 MiB; capped at 16 MiB. Truncated media is never decoded. */
  maxPreviewBytes?: number;
  /** Defaults to 64 MiB; capped at 128 MiB. Downloads re-authorize using purpose: download. */
  maxDownloadBytes?: number;
  /** Labels, actions, styling and renderers are host-owned; authorized reads still use the same limits. */
  ui?: TerminalFilePreviewUi;
}
export interface TerminalFilePreviewContext {
  reference: Readonly<TerminalFileReference>;
  container: HTMLElement;
  content: HTMLElement;
  signal: AbortSignal;
  controls: { download: HTMLElement; close: HTMLButtonElement };
  close(): void;
  download(): Promise<void>;
}
export interface TerminalFilePreviewUi extends Pick<TerminalUiOptions, "labels" | "tooltips" | "className" | "cssVariables" | "renderTooltip"> {
  /** Defaults to Download and Close. Custom actions run only after a user click. */
  actions?: readonly ("download" | "close" | { id: string; label: string; tooltip?: string | false; run(context: TerminalFilePreviewContext): void | Promise<void> })[];
  /** Reuse or move the supplied live controls; cleanup runs whenever this preview closes. */
  render?(context: TerminalFilePreviewContext): TerminalUiCleanup;
  /** Receives only the bounded, explicitly authorized preview blob, never an implicit URL fetch. */
  renderContent?(context: TerminalFilePreviewContext & { blob: Blob; mimeType: string; truncated: boolean }): TerminalUiCleanup;
}

const sizeLimit = (value: number | undefined, fallback: number, ceiling: number) => Number.isFinite(value) ? Math.max(1024, Math.min(ceiling, Math.floor(value!))) : fallback;
const abortError = () => new DOMException("File operation cancelled", "AbortError");
const safeName = (value: string) => value.replace(/[\\/:*?"<>|\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, "_").slice(0, 180) || "download";

/** Invoke the host in the current user gesture, but release the UI on cancellation. */
export function runHostDownload(download: NonNullable<TerminalFileLinkOptions["download"]>, reference: TerminalFileReference, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(abortError()); return; }
    const aborted = () => reject(abortError());
    signal.addEventListener("abort", aborted, { once: true });
    const finish = () => signal.removeEventListener("abort", aborted);
    try {
      Promise.resolve(download(Object.freeze({ ...reference }), { signal })).then(() => { finish(); resolve(); }, error => { finish(); reject(error); });
    } catch (error) { finish(); reject(error); }
  });
}

export function authorizedFileUrl(value: string, base: string, origins: readonly string[] = []): string {
  if (value.length > 8192 || /[\u0000-\u0020\u007f-\u009f]/u.test(value)) throw new TypeError("Invalid file URL");
  const url = new URL(value, base);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash || !origins.includes(url.origin)) throw new TypeError("File URL origin is not authorized");
  return url.href;
}

function cancelResource(resource: TerminalFileResource | null): void {
  const body = resource?.body;
  if (body && typeof body !== "string" && "getReader" in body && !body.locked) void body.cancel().catch(() => {});
}

/** Abort even when a host resolver ignores its signal; dispose late streams without retaining their contents. */
export function resolveFileResource(options: TerminalFileLinkOptions, reference: TerminalFileReference, signal: AbortSignal, purpose: "preview" | "download"): Promise<TerminalFileResource | null> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    let settled = false;
    const aborted = () => { settled = true; reject(abortError()); };
    signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve().then(() => options.resolve(Object.freeze({ ...reference }), { signal, purpose })).then(resource => {
      signal.removeEventListener("abort", aborted);
      if (settled || signal.aborted) { cancelResource(resource); return; }
      settled = true; resolve(resource);
    }, error => { signal.removeEventListener("abort", aborted); if (!settled) { settled = true; reject(error); } });
  });
}

/** All URL reads are credential-free, referrer-free, uncached and unable to follow redirects. */
export async function readFileResource(resource: TerminalFileResource, options: TerminalFileLinkOptions, signal: AbortSignal, base: string, purpose: "preview" | "download"): Promise<{ blob: Blob; truncated: boolean; mimeType: string; size?: number }> {
  if (signal.aborted) { cancelResource(resource); throw abortError(); }
  if (!resource || typeof resource !== "object" || Boolean(resource.url) === (resource.body !== undefined)) { cancelResource(resource); throw new TypeError("Supply exactly one file source"); }
  const maximum = purpose === "preview" ? sizeLimit(options.maxPreviewBytes, 8 * 1024 * 1024, 16 * 1024 * 1024) : sizeLimit(options.maxDownloadBytes, 64 * 1024 * 1024, 128 * 1024 * 1024);
  let mimeType = resource.mimeType?.split(";", 1)[0].trim().toLowerCase() ?? "";
  let size = Number.isSafeInteger(resource.size) && resource.size! >= 0 ? resource.size : undefined;
  let source = resource.body;
  if (resource.url) {
    const url = authorizedFileUrl(resource.url, base, options.allowedOrigins);
    const response = await fetch(url, { signal, mode: "cors", credentials: "omit", referrerPolicy: "no-referrer", referrer: "", redirect: "error", cache: "no-store" });
    if (!response.ok || !response.body || response.redirected) { void response.body?.cancel().catch(() => {}); throw new Error("File unavailable"); }
    source = response.body;
    mimeType ||= (response.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
    const headerSize = Number(response.headers.get("content-length"));
    if (response.headers.has("content-length") && Number.isSafeInteger(headerSize) && headerSize >= 0) size ??= headerSize;
  }
  if (signal.aborted) { cancelResource({ body: source }); throw abortError(); }
  let stream: ReadableStream<Uint8Array>;
  if (typeof source === "string") {
    const blob = new Blob([source], { type: mimeType || "text/plain" });
    mimeType ||= "text/plain"; size ??= blob.size; stream = blob.stream();
  } else if (source && "getReader" in source) stream = source;
  else if (source && typeof source.stream === "function") { mimeType ||= source.type; size ??= source.size; stream = source.stream(); }
  else throw new TypeError("Invalid file body");
  const reader = stream.getReader(); const parts: Uint8Array[] = []; let bytes = 0; let truncated = false;
  let block = new Uint8Array(Math.min(64 * 1024, maximum)); let filled = 0; let empty = 0; let chunks = 0;
  const cancelled = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancelled, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw abortError();
      const chunk = await reader.read();
      if (signal.aborted) throw abortError();
      if (chunk.done) break;
      if (!chunk.value || !ArrayBuffer.isView(chunk.value) || chunk.value.BYTES_PER_ELEMENT !== 1) throw new TypeError("File streams must contain bytes");
      if (!chunk.value.byteLength) { if (++empty > 128) throw new RangeError("File stream made no progress"); continue; }
      empty = 0;
      const keep = Math.min(chunk.value.byteLength, maximum - bytes);
      for (let offset = 0; offset < keep;) {
        const length = Math.min(keep - offset, block.length - filled);
        block.set(chunk.value.subarray(offset, offset + length), filled); filled += length; offset += length;
        if (filled === block.length) { parts.push(block); block = new Uint8Array(block.length); filled = 0; }
      }
      bytes += keep;
      if (keep < chunk.value.byteLength) {
        truncated = true; void reader.cancel().catch(() => {});
        if (purpose === "download") throw new RangeError("File exceeds the configured download limit");
        break;
      }
      if (++chunks % 128 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
  } catch (error) { void reader.cancel().catch(() => {}); throw error; }
  finally { signal.removeEventListener("abort", cancelled); reader.releaseLock(); }
  if (filled) parts.push(block.subarray(0, filled));
  return { blob: new Blob(parts as BlobPart[], { type: mimeType || "application/octet-stream" }), truncated, mimeType: mimeType || "application/octet-stream", size: size ?? (truncated ? undefined : bytes) };
}

let previewId = 0;

/** A hover/focus preview with a real download action. Its content never enters terminal state or recordings. */
export class TerminalFilePreview {
  private pending?: ReturnType<typeof setTimeout>;
  private leaving?: ReturnType<typeof setTimeout>;
  private request?: AbortController;
  private downloadRequest?: AbortController;
  private card?: HTMLDivElement;
  private anchor?: HTMLElement;
  private reference?: TerminalFileReference;
  private sourceKey?: string;
  private pinned = false;
  private sourceFocus = false;
  private placement?: "above" | "below";
  private objectUrls = new Set<string>();
  private downloadUrls = new Set<string>();
  private downloadTimers = new Set<ReturnType<typeof setTimeout>>();
  private lifetime = new AbortController();
  private cardEvents?: AbortController;
  private observer?: ResizeObserver;
  private options: TerminalFileLinkOptions;
  constructor(private readonly terminal: HTMLElement, options: TerminalFileLinkOptions) {
    this.options = { ...options, allowedOrigins: [...(options.allowedOrigins ?? [])] };
    const document = terminal.ownerDocument; const signal = this.lifetime.signal;
    document.addEventListener("pointerdown", event => { if (!this.contains(event.target) && !this.anchor?.contains(event.target as Node)) this.close(); }, { signal, capture: true });
    document.addEventListener("keydown", event => { if (event.key === "Escape" && this.card) { event.preventDefault(); const anchor = this.anchor; const focused = this.card.contains(document.activeElement); this.close(); if (focused) this.focusSource(anchor); } }, { signal });
    document.addEventListener("scroll", event => { if (!this.contains(event.target)) this.close(); }, { signal, capture: true, passive: true });
    document.addEventListener("visibilitychange", () => { if (document.hidden) this.close(); }, { signal });
    document.defaultView?.addEventListener("resize", () => this.close(), { signal, passive: true });
    document.addEventListener("pointermove", event => {
      if (event.pointerType !== "mouse" || !this.card || !this.anchor || this.pinned) return;
      const source = this.anchor.getBoundingClientRect(); const card = this.card.getBoundingClientRect();
      const above = card.bottom <= source.top;
      const top = above ? card.bottom : source.bottom; const bottom = above ? source.top : card.top;
      const bridge = event.clientY >= top - 2 && event.clientY <= bottom + 2 &&
        event.clientX >= Math.min(source.left, card.left) - 8 && event.clientX <= Math.max(source.right, card.right) + 8;
      if (this.contains(event.target) || this.anchor.contains(event.target as Node) || bridge) {
        clearTimeout(this.leaving); this.leaving = undefined;
        if (bridge || this.contains(event.target)) this.cancelPending();
      } else if (!this.leaving) this.leave();
    }, { signal, passive: true });
  }
  schedule(reference: TerminalFileReference, anchor: HTMLElement, key: string, immediate = false): void {
    clearTimeout(this.leaving);
    if (this.sourceKey === key) {
      if (this.card) this.cancelPending();
      if (this.anchor !== anchor) {
        this.anchor?.removeAttribute("aria-describedby"); this.anchor?.removeAttribute("aria-expanded"); this.anchor = anchor;
        if (this.card) { anchor.setAttribute("aria-describedby", this.card.id); anchor.setAttribute("aria-expanded", "true"); this.position(); }
      }
      if (immediate) {
        this.pinned = true;
        if (this.pending) { clearTimeout(this.pending); this.pending = undefined; void this.show(); }
        else this.card?.querySelector<HTMLButtonElement>(".shell-file-close")?.focus({ preventScroll: true });
      }
      return;
    }
    this.cancelPending();
    const show = () => {
      this.pending = undefined; this.close(); this.reference = { ...reference }; this.anchor = anchor; this.sourceKey = key; this.pinned = immediate;
      if (anchor.isConnected) void this.show();
    };
    if (immediate) show();
    else {
      if (!this.card) { this.reference = { ...reference }; this.anchor = anchor; this.sourceKey = key; }
      this.pending = setTimeout(show, Number.isFinite(this.options.hoverDelayMs) ? Math.max(100, Math.min(1000, this.options.hoverDelayMs!)) : 300);
    }
  }
  leave(): void {
    if (this.pinned || this.card?.contains(this.terminal.ownerDocument.activeElement)) return;
    clearTimeout(this.leaving); this.leaving = setTimeout(() => this.close(), Number.isFinite(this.options.hideDelayMs) ? Math.max(200, Math.min(2000, this.options.hideDelayMs!)) : 600);
  }
  cancelPending(): void {
    clearTimeout(this.pending); this.pending = undefined;
    if (!this.card) { this.anchor = undefined; this.reference = undefined; this.sourceKey = undefined; }
  }
  contains(node: EventTarget | null): boolean { return Boolean(node && this.card?.contains(node as Node)); }
  get returningFocus(): boolean { return this.sourceFocus; }
  private focusSource(anchor?: HTMLElement): void {
    if (!anchor?.isConnected) return;
    this.sourceFocus = true;
    try { anchor.focus({ preventScroll: true }); } finally { this.sourceFocus = false; }
  }
  validate(current: (anchor: HTMLElement, key: string) => boolean): void {
    if (this.anchor && this.sourceKey && (!this.anchor.isConnected || !current(this.anchor, this.sourceKey))) this.close();
  }
  updateTheme(): void {
    if (!this.card) return;
    const style = this.terminal.ownerDocument.defaultView?.getComputedStyle(this.terminal); if (!style) return;
    for (const name of terminalUiThemeVariables) this.card.style.setProperty(name, style.getPropertyValue(name));
    this.card.style.colorScheme = style.colorScheme;
    configureUi(this.card, this.options.ui ?? {});
  }
  close(): void {
    clearTimeout(this.pending); clearTimeout(this.leaving); this.pending = this.leaving = undefined;
    this.request?.abort(); this.downloadRequest?.abort(); this.request = this.downloadRequest = undefined;
    this.cardEvents?.abort(); this.cardEvents = undefined; this.observer?.disconnect(); this.observer = undefined;
    this.anchor?.removeAttribute("aria-describedby"); this.anchor?.removeAttribute("aria-expanded");
    for (const media of this.card?.querySelectorAll("video, audio") ?? []) { const element = media as HTMLMediaElement; element.pause(); element.removeAttribute("src"); element.load(); }
    this.card?.remove(); this.card = undefined; this.anchor = undefined; this.reference = undefined; this.sourceKey = undefined; this.pinned = false; this.placement = undefined;
    for (const url of this.objectUrls) URL.revokeObjectURL(url); this.objectUrls.clear();
  }
  dispose(): void {
    this.close(); this.lifetime.abort();
    for (const timer of this.downloadTimers) clearTimeout(timer); this.downloadTimers.clear();
    for (const url of this.downloadUrls) URL.revokeObjectURL(url); this.downloadUrls.clear();
  }
  private position(): void {
    if (!this.card || !this.anchor) return;
    const view = this.terminal.ownerDocument.defaultView; if (!view) return;
    const source = this.anchor.getBoundingClientRect(); const card = this.card.getBoundingClientRect();
    const width = view.visualViewport?.width ?? view.innerWidth; const height = view.visualViewport?.height ?? view.innerHeight;
    const offsetX = view.visualViewport?.offsetLeft ?? 0; const offsetY = view.visualViewport?.offsetTop ?? 0;
    // Pick a side once, so loading an image cannot make the tooltip jump across the pointer.
    this.placement ??= offsetY + height - source.bottom < 320 && source.top - offsetY > offsetY + height - source.bottom ? "above" : "below";
    this.card.style.left = `${Math.max(offsetX + 8, Math.min(source.left, offsetX + width - card.width - 8))}px`;
    this.card.style.top = `${Math.max(offsetY + 8, Math.min(this.placement === "above" ? source.top - card.height - 8 : source.bottom + 8, offsetY + height - card.height - 8))}px`;
  }
  private async show(): Promise<void> {
    if (!this.reference || !this.anchor) return;
    const reference = { ...this.reference }; const document = this.terminal.ownerDocument;
    const request = new AbortController(); this.request = request;
    const events = new AbortController(); this.cardEvents = events;
    const ui = this.options.ui ?? {}; const text = (id: string, fallback: string) => uiText(ui, id, fallback);
    const card = document.createElement("div"); card.className = "shell-file-preview"; card.id = `shell-file-preview-${++previewId}`;
    card.setAttribute("role", "dialog"); card.setAttribute("aria-label", text("previewRegion", `File preview: ${reference.path}`)); this.card = card;
    this.updateTheme();
    const header = document.createElement("header");
    const title = document.createElement("strong"); title.textContent = reference.path.split(/[\\/]/u).pop() || reference.path;
    const download = uiButton(document, ui, "download", "Download", false, events.signal); download.className = "shell-file-download";
    const close = uiButton(document, ui, "close", "×", "Close file preview", events.signal); close.className = "shell-file-close";
    close.addEventListener("click", () => { const anchor = this.anchor; this.close(); this.focusSource(anchor); }, { signal: events.signal });
    header.append(title);
    const content = document.createElement("div"); content.className = "shell-file-content"; content.textContent = text("loading", "Loading…");
    const status = document.createElement("p"); status.className = "shell-file-error"; status.hidden = true; status.setAttribute("role", "status");
    card.append(header, content, status); document.body.append(card);
    const context: TerminalFilePreviewContext = { reference: Object.freeze({ ...reference }), container: card, content, signal: events.signal, controls: { download, close }, close: () => this.close(), download: () => this.download(reference, download, status) };
    download.addEventListener("click", () => { void context.download(); }, { signal: events.signal });
    for (const action of ui.actions ?? ["download", "close"]) {
      if (action === "download") header.append(download);
      else if (action === "close") header.append(close);
      else {
        const item = uiButton(document, ui, action.id, action.label, action.tooltip ?? false, events.signal);
        item.addEventListener("click", () => {
          try { void Promise.resolve(action.run(context)).catch(() => { if (!events.signal.aborted) { status.textContent = text("actionFailed", "Action unavailable. Try again."); status.hidden = false; } }); }
          catch { status.textContent = text("actionFailed", "Action unavailable. Try again."); status.hidden = false; }
        }, { signal: events.signal }); header.append(item);
      }
    }
    try { ownUiCleanup(ui.render?.(context), events.signal); } catch { this.close(); return; }
    this.anchor.setAttribute("aria-describedby", card.id); this.anchor.setAttribute("aria-expanded", "true");
    card.addEventListener("pointerenter", () => { clearTimeout(this.leaving); this.leaving = undefined; this.cancelPending(); }, { signal: events.signal });
    card.addEventListener("pointerleave", () => this.leave(), { signal: events.signal });
    card.addEventListener("focusin", () => { this.pinned = true; clearTimeout(this.leaving); }, { signal: events.signal });
    this.observer = new ResizeObserver(() => this.position()); this.observer.observe(card); this.position();
    if (this.pinned) close.focus({ preventScroll: true });
    let timedOut = false; const timeout = setTimeout(() => { timedOut = true; request.abort(); }, 15_000);
    try {
      const resource = await resolveFileResource(this.options, reference, request.signal, "preview");
      if (request.signal.aborted) { cancelResource(resource); throw abortError(); }
      if (!resource) throw new Error("File unavailable");
      if (resource.name) title.textContent = safeName(resource.name);
      if (resource.downloadUrl && !this.options.download) {
        const link = document.createElement("a"); link.className = "shell-file-download"; link.textContent = text("download", "Download"); uiTooltip(link, ui, "download", false, events.signal);
        link.href = authorizedFileUrl(resource.downloadUrl, document.baseURI, [new URL(document.baseURI).origin]);
        link.download = safeName(resource.name || title.textContent || "download"); link.rel = "noopener noreferrer"; link.referrerPolicy = "no-referrer";
        link.addEventListener("click", () => { this.pinned = true; }, { signal: events.signal });
        download.replaceWith(link); context.controls.download = link; context.download = async () => { this.pinned = true; link.click(); };
      }
      const result = await readFileResource(resource, this.options, request.signal, document.baseURI, "preview");
      if (request.signal.aborted || this.card !== card) return;
      if (ui.renderContent) { content.replaceChildren(); ownUiCleanup(ui.renderContent({ ...context, ...result }), events.signal); }
      else this.render(content, result, reference);
    } catch {
      if (this.card === card && (!request.signal.aborted || timedOut)) {
        content.textContent = timedOut ? text("previewTimedOut", "Preview timed out.") : text("previewUnavailable", "Preview not available.");
        const retry = uiButton(document, ui, "retry", "Retry", false, events.signal);
        retry.addEventListener("click", () => { const anchor = this.anchor; const key = this.sourceKey; this.close(); if (anchor && key) this.schedule(reference, anchor, key, true); }, { signal: events.signal }); content.append(" ", retry);
      }
    } finally { clearTimeout(timeout); }
  }
  private render(content: HTMLDivElement, result: Awaited<ReturnType<typeof readFileResource>>, reference: TerminalFileReference): void {
    const document = content.ownerDocument; content.replaceChildren();
    const image = /^image\/(?:png|jpeg|gif|webp|avif|bmp)$/u.test(result.mimeType);
    const video = /^video\/(?:mp4|webm|ogg)$/u.test(result.mimeType);
    const audio = /^audio\/(?:mpeg|mp4|webm|ogg|wav|x-wav)$/u.test(result.mimeType);
    if (!result.truncated && (image || video || audio)) {
      const url = URL.createObjectURL(result.blob); this.objectUrls.add(url);
      const media = document.createElement(image ? "img" : video ? "video" : "audio"); media.className = "shell-file-media";
      if (image) { const picture = media as HTMLImageElement; picture.alt = reference.path.split(/[\\/]/u).pop() || "File preview"; picture.referrerPolicy = "no-referrer"; }
      else { const player = media as HTMLMediaElement; player.controls = true; player.autoplay = false; player.preload = "metadata"; if (video) (player as HTMLVideoElement).playsInline = true; }
      media.src = url; media.addEventListener("error", () => { if (media.isConnected) content.textContent = "This browser cannot preview this file."; }, { once: true });
      content.append(media); return;
    }
    const text = result.mimeType.startsWith("text/") || /^(?:application\/(?:json|[^;]+\+json|javascript|xml|[^;]+\+xml|x-sh|yaml|toml)|image\/svg\+xml)$/u.test(result.mimeType);
    if (text) {
      const request = this.request; const card = this.card;
      void result.blob.slice(0, 64 * 1024).text().then(value => {
        if (request?.signal.aborted || this.card !== card || !content.isConnected) return;
        const pre = document.createElement("pre"); pre.className = "shell-file-text"; pre.tabIndex = 0; pre.setAttribute("aria-label", "File excerpt");
        const lines = value.split(/\r\n?|\n/u); const requested = Math.max(0, (reference.line ?? 1) - 1); const start = Math.max(0, Math.min(lines.length - 1, requested) - 3); const end = Math.min(lines.length, start + 8);
        for (let index = start; index < end; index++) {
          const row = document.createElement("span"); row.className = "shell-file-text-line"; row.dataset.line = String(index + 1);
          if (index === requested && reference.line) row.dataset.highlight = "true";
          row.textContent = lines[index].slice(0, 2000) || " "; pre.append(row);
        }
        content.replaceChildren(pre);
        if (requested >= lines.length) { const note = document.createElement("p"); note.className = "shell-file-error"; note.textContent = "Referenced line is outside this excerpt."; content.append(note); }
      }).catch(() => { if (content.isConnected) content.textContent = "Text preview unavailable."; });
      return;
    }
    content.textContent = "Preview not available. Download to open.";
  }
  private async download(reference: TerminalFileReference, button: HTMLButtonElement, status: HTMLElement): Promise<void> {
    if (this.downloadRequest) return;
    this.pinned = true; const request = new AbortController(); this.downloadRequest = request;
    const text = (id: string, fallback: string) => uiText(this.options.ui ?? {}, id, fallback);
    button.disabled = true; button.textContent = text("preparing", "Preparing…"); status.hidden = true;
    let timedOut = false; const timeout = setTimeout(() => { timedOut = true; request.abort(); }, 60_000);
    try {
      if (this.options.download) {
        await runHostDownload(this.options.download, reference, request.signal);
        return;
      }
      const resource = await resolveFileResource(this.options, reference, request.signal, "download");
      if (request.signal.aborted) { cancelResource(resource); throw abortError(); }
      if (!resource) throw new Error("File unavailable");
      const result = await readFileResource(resource, this.options, request.signal, this.terminal.ownerDocument.baseURI, "download");
      if (request.signal.aborted || !button.isConnected) return;
      const url = URL.createObjectURL(new Blob([result.blob], { type: "application/octet-stream" })); this.downloadUrls.add(url);
      const anchor = this.terminal.ownerDocument.createElement("a"); anchor.href = url; anchor.download = safeName(resource.name || reference.path.split(/[\\/]/u).pop() || "download");
      anchor.rel = "noopener noreferrer"; anchor.referrerPolicy = "no-referrer"; this.terminal.ownerDocument.body.append(anchor); anchor.click(); anchor.remove();
      const timer = setTimeout(() => { URL.revokeObjectURL(url); this.downloadUrls.delete(url); this.downloadTimers.delete(timer); }, 1000); this.downloadTimers.add(timer);
    } catch { if ((!request.signal.aborted || timedOut) && status.isConnected) { status.textContent = timedOut ? text("downloadTimedOut", "Download timed out. Try again.") : text("downloadUnavailable", "Download unavailable. Try again."); status.hidden = false; } }
    finally { clearTimeout(timeout); if (this.downloadRequest === request) this.downloadRequest = undefined; if (button.isConnected) { button.disabled = false; button.textContent = text("download", "Download"); } }
  }
}
