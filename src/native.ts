import { TerminalCore } from "./core.js";
import { encodeTerminalKey, encodeTerminalMouse, encodeTerminalPaste, type TerminalKey, type TerminalMouse } from "./input.js";
import { Signal, type ReadableBuffer, type TerminalCellMetrics, type TerminalOptions, type TerminalSize, type TerminalSurface, type TerminalTheme } from "./types.js";
import type { Attributes, Cell, TerminalColor, TerminalLine } from "./buffer.js";
import { measureCell } from "./metrics.js";
import type { TerminalState } from "./state.js";
import { TerminalLinkCache, type RenderedTerminalLink, type TerminalRowLink } from "./links.js";
import { TerminalFilePreview, type TerminalFileLinkOptions } from "./file-preview.js";
import { resolveTerminalTheme, applyTerminalUiTheme } from "./themes.js";

const PALETTE = ["#647084", "#f08080", "#a6d995", "#e8cd8b", "#91b5ef", "#c7a1e5", "#83c9cd", "#d8dee9", "#8994a6", "#ffa0a0", "#c5ebb6", "#f8e2af", "#b3cefa", "#dec0f4", "#ace8e9", "#ffffff"];
const COLOR_NAMES: (keyof TerminalTheme)[] = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white", "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"];
const DEFAULT_FONT = 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace';
interface SelectionRange { anchor: number; focus: number }
interface RenderedRun { element: HTMLElement; attributes?: Readonly<Attributes>; selected?: boolean; revision: number; reverse?: boolean; width: number; text: string; linkKey?: string }
interface RenderedRow { element: HTMLDivElement; key: string; row: number; height: number; runs: RenderedRun[] }
export interface TerminalViewState {
  version: 1; model: TerminalState; viewportY: number; selection?: { anchor: number; focus: number };
}

/**
 * A virtualized DOM renderer over Refstream's own VT state machine. Only visible
 * rows exist in the DOM; search, selection and export read the retained model.
 * Output is always assigned through textContent and never interpreted as HTML.
 */
export class NativeTerminal implements TerminalSurface {
  readonly core: TerminalCore;
  readonly options: TerminalOptions;
  element: HTMLElement | undefined;
  textarea: HTMLTextAreaElement | undefined;
  readonly buffer: { readonly active: ReadableBuffer };
  private viewport?: HTMLDivElement;
  private content?: HTMLDivElement;
  private rowLayer?: HTMLDivElement;
  private cursor?: HTMLSpanElement;
  private announcement?: HTMLDivElement;
  private abort = new AbortController();
  private rowNodes = new Map<number, RenderedRow>();
  private rowPool: RenderedRow[] = [];
  private viewportY = 0;
  private programmaticScrollTop = 0;
  private scrollDirty = true;
  private navigationPending = false;
  private scrollRemainder = 0;
  private scrollMargin = 2;
  private scrollIdleTimer: ReturnType<typeof setTimeout> | undefined;
  private contentWidth = -1;
  private contentHeight = -1;
  private interceptWheel = false;
  private wheelHandler = (event: WheelEvent) => this.handleWheel(event);
  private previousBaseY = 0;
  private previousDropped = 0;
  private previousType = "normal";
  private cellWidth = 8;
  private cellHeight = 18;
  private scrollbar = 14;
  private view?: Window;
  private frame = 0;
  private syncTimer: ReturnType<typeof setTimeout> | undefined;
  private announcementTimer: ReturnType<typeof setTimeout> | undefined;
  private selection?: SelectionRange;
  private selecting = false;
  private dragPosition?: { x: number; y: number };
  private dragFrame = 0;
  private focused = false;
  private composing = false;
  private compositionCommit = "";
  private compositionTimer: ReturnType<typeof setTimeout> | undefined;
  private keyHandler?: (event: KeyboardEvent) => boolean;
  private disposed = false;
  private linkCache = new TerminalLinkCache();
  private runLinks = new WeakMap<HTMLElement, RenderedTerminalLink>();
  private filePreview?: TerminalFilePreview;
  private fileLinkOptions?: TerminalFileLinkOptions;
  private fileLinkSubscription?: { dispose(): void };
  private linkPointer?: { x: number; y: number; pointerId: number };
  private linkDragged = false;
  private styleRevision = 0;
  private theme: TerminalTheme = {};
  private dataSignal = new Signal<string>();
  private inputSignal = new Signal<{ type: "input" | "composition" | "mouse"; data?: string; source?: unknown }>();
  private binarySignal = new Signal<string>();
  private scrollSignal = new Signal<number>();
  private renderSignal = new Signal<{ start: number; end: number }>();
  private resizeSignal = new Signal<TerminalSize>();

  readonly onData = this.dataSignal.event;
  /** Input activity before transport delivery. Terminal protocol replies are excluded. */
  readonly onInput = this.inputSignal.event;
  /** Terminal lifetime; UI mounts have their own, shorter lifetimes. */
  readonly signal = this.abort.signal;
  get inputComposing(): boolean { return this.composing; }
  readonly onBinary = this.binarySignal.event;
  readonly onScroll = this.scrollSignal.event;
  readonly onRender = this.renderSignal.event;
  readonly onResize = this.resizeSignal.event;

  constructor(options: TerminalOptions = {}) {
    resolveTerminalTheme(options.theme);
    this.core = new TerminalCore(options);
    const values: TerminalOptions = {
      fontFamily: DEFAULT_FONT, fontSize: 14, lineHeight: 1.18,
      cursorBlink: true, cursorStyle: "block", cursorInactiveStyle: "outline",
      scrollOnUserInput: true, drawBoldTextInBrightColors: true,
      ...options,
    };
    this.options = new Proxy(values, {
      set: (target, key: keyof TerminalOptions, value: never) => {
        if (["cols", "rows", "scrollback", "convertEol"].includes(key)) {
          throw new TypeError(`${key} is a constructor option. Use resize() to change the grid.`);
        }
        if (key === "theme") resolveTerminalTheme(value);
        Reflect.set(target, key, value);
        this.applyOptions();
        return true;
      },
    });
    // Accessors on the buffer facade need the terminal rather than the facade's `this`.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    this.buffer = { active: {
      get type() { return self.core.type; },
      get baseY() { return self.core.baseY; },
      get viewportY() { return self.viewportY; },
      get cursorX() { return self.core.cursorX; },
      get cursorY() { return self.core.cursorY; },
      get length() { return self.core.length; },
      getLine: (row) => self.core.getLine(row),
    } };
    this.core.changed.event(() => this.onModelChange());
    this.core.reply.event((value) => this.emitInput(value, false));
    this.core.activity.event(event => {
      if (event.type === "reset" || event.type === "restore" || event.type === "resize") { this.filePreview?.close(); this.linkCache.clear(); }
      if (event.type === "restore") { this.styleRevision++; this.applyOptions(); }
    });
  }

  get cols(): number { return this.core.cols; }
  get rows(): number { return this.core.rows; }
  get modes() { return this.core.modes; }
  readonly onTitleChange = (listener: (title: string) => void) => this.core.titleChanged.event(listener);
  readonly onBell = (listener: () => void) => this.core.bell.event(listener);
  readonly onCommand = (listener: (marker: import("./core.js").CommandMarker) => void) => this.core.command.event(listener);

  /** CSS pixel dimensions after open(); remeasured on font and option changes. */
  getCellMetrics(): Readonly<TerminalCellMetrics> {
    return { width: this.cellWidth, height: this.cellHeight, scrollbar: this.scrollbar };
  }

  serialize(): TerminalViewState {
    return { version: 1, model: this.core.serialize(), viewportY: this.viewportY,
      ...(this.selection ? { selection: { ...this.selection } } : {}) };
  }

  restore(value: TerminalViewState): void {
    if (this.disposed) return;
    if (!value || value.version !== 1 || !Number.isSafeInteger(value.viewportY) || value.viewportY < 0) throw new TypeError("Invalid terminal view state");
    const selected = value.selection;
    if (selected && (!Number.isSafeInteger(selected.anchor) || !Number.isSafeInteger(selected.focus) || selected.anchor < 0 || selected.focus < 0)) throw new TypeError("Invalid selection state");
    this.core.restore(value.model);
    const length = this.core.length * this.cols;
    this.selection = selected && selected.anchor <= length && selected.focus <= length ? { ...selected } : undefined;
    this.scrollToLine(value.viewportY); this.applyOptions();
  }

  /** Fit the parent's content box. Hidden/detached hosts leave the grid alone. */
  fit(): TerminalSize | undefined {
    const parent = this.element?.parentElement;
    if (!parent || !this.view || this.disposed || !parent.isConnected) return;
    this.applyOptions();
    const style = this.view.getComputedStyle(parent);
    const pixels = (value: string) => Number.parseFloat(value) || 0;
    const width = parent.clientWidth - pixels(style.paddingLeft) - pixels(style.paddingRight) - this.scrollbar;
    const height = parent.clientHeight - pixels(style.paddingTop) - pixels(style.paddingBottom);
    if (width < this.cellWidth || height < this.cellHeight) return;
    this.resize(Math.floor(width / this.cellWidth), Math.floor(height / this.cellHeight));
    return { cols: this.cols, rows: this.rows };
  }

  open(parent: HTMLElement): void {
    if (this.element || this.disposed) return;
    const document = parent.ownerDocument;
    this.view = document.defaultView ?? undefined;
    this.element = document.createElement("div");
    this.element.className = "shell-terminal";
    this.element.dataset.engine = "native";
    this.viewport = document.createElement("div");
    this.viewport.className = "shell-terminal-viewport";
    this.viewport.setAttribute("role", "log");
    this.viewport.setAttribute("aria-label", "Terminal output");
    this.viewport.setAttribute("aria-live", "off");
    this.content = document.createElement("div");
    this.content.className = "shell-terminal-content";
    this.rowLayer = document.createElement("div");
    this.rowLayer.className = "shell-terminal-rows";
    this.cursor = document.createElement("span");
    this.cursor.className = "shell-terminal-cursor";
    this.cursor.setAttribute("aria-hidden", "true");
    this.content.append(this.rowLayer, this.cursor);
    this.viewport.append(this.content);
    this.textarea = document.createElement("textarea");
    this.textarea.className = "shell-terminal-input";
    this.textarea.setAttribute("aria-label", "Terminal input");
    this.textarea.setAttribute("autocorrect", "off");
    this.textarea.autocapitalize = "off";
    this.textarea.autocomplete = "off";
    this.textarea.spellcheck = false;
    this.textarea.enterKeyHint = "enter";
    this.textarea.wrap = "off";
    this.announcement = document.createElement("div");
    this.announcement.className = "shell-terminal-announcement";
    this.announcement.setAttribute("aria-live", "polite");
    this.announcement.setAttribute("aria-atomic", "true");
    this.element.append(this.viewport, this.textarea, this.announcement);
    parent.append(this.element);
    this.bindInput();
    this.applyOptions();
    this.render();
    // A font finishing after open() must not leave stale cell dimensions.
    document.fonts?.ready.then(() => { if (!this.disposed) this.applyOptions(); });
    document.fonts?.addEventListener("loadingdone", () => this.applyOptions(), { signal: this.abort.signal });
  }

  write(data: string | Uint8Array, callback?: () => void): void {
    if (!this.disposed) this.core.write(data);
    // An async completion lets the caller coalesce writes without recursive flushes.
    if (callback) queueMicrotask(callback);
  }

  reset(): void { this.clearSelection(); this.viewportY = 0; this.core.reset(); }
  resize(cols: number, rows: number): void {
    if (this.disposed) return;
    const previous = { cols: this.cols, rows: this.rows };
    this.clearSelection(); this.core.resize(cols, rows); this.applyOptions();
    if (previous.cols !== this.cols || previous.rows !== this.rows) this.resizeSignal.fire({ cols: this.cols, rows: this.rows });
  }
  refresh(_start: number, _end: number): void { this.styleRevision++; this.scheduleRender(); }
  focus(): void { this.textarea?.focus({ preventScroll: true }); }
  blur(): void { this.textarea?.blur(); }
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void { this.keyHandler = handler; }
  paste(text: string, source?: unknown): void { this.emitInput(encodeTerminalPaste(text, this.modes.bracketedPasteMode), true, source); }
  sendKey(key: TerminalKey, source?: unknown): void { const data = encodeTerminalKey(key, this.modes); if (data !== null) this.emitInput(data, true, source); }
  scrollLines(count: number): void { this.scrollToLine(this.viewportY + count); }
  scrollToBottom(): void { this.scrollToLine(this.core.baseY); }
  scrollToLine(line: number): void {
    this.viewportY = Math.max(0, Math.min(this.core.baseY, Math.floor(line)));
    this.scrollRemainder = 0; this.scrollDirty = true; this.navigationPending = true;
    this.scheduleRender();
    this.scrollSignal.fire(this.viewportY);
  }

  hasSelection(): boolean {
    return Boolean(this.selection && this.selection.anchor !== this.selection.focus) || Boolean(this.domSelection());
  }
  getSelection(): string {
    if (!this.selection || this.selection.anchor === this.selection.focus) return this.domSelection();
    const first = Math.min(this.selection.anchor, this.selection.focus);
    const last = Math.max(this.selection.anchor, this.selection.focus);
    let text = "";
    for (let row = Math.floor(first / this.cols); row <= Math.floor((last - 1) / this.cols); row++) {
      const line = this.core.getLine(row);
      if (!line) continue;
      const start = Math.max(0, first - row * this.cols);
      const end = Math.min(this.cols, last - row * this.cols);
      if (row > Math.floor(first / this.cols) && start === 0 && !line.isWrapped) text += "\n";
      text += line.translateToString(end === this.cols, start, end);
    }
    return text;
  }
  clearSelection(): void {
    this.selection = undefined;
    const selection = this.element?.ownerDocument.getSelection();
    if (selection?.anchorNode && this.element?.contains(selection.anchorNode)) selection.removeAllRanges();
    this.scheduleRender();
  }
  select(column: number, row: number, length: number): void {
    const anchor = Math.max(0, row * this.cols + column);
    this.selection = { anchor, focus: Math.min(this.core.length * this.cols, anchor + Math.max(0, length)) };
    this.scheduleRender();
  }

  dispose(): void {
    this.disposed = true;
    this.filePreview?.dispose(); this.fileLinkSubscription?.dispose(); this.linkCache.clear();
    this.abort.abort();
    this.view?.cancelAnimationFrame(this.frame);
    this.view?.cancelAnimationFrame(this.dragFrame);
    clearTimeout(this.syncTimer);
    clearTimeout(this.announcementTimer);
    clearTimeout(this.compositionTimer);
    clearTimeout(this.scrollIdleTimer);
    this.core.changed.dispose(); this.core.reply.dispose(); this.core.titleChanged.dispose(); this.core.command.dispose(); this.core.bell.dispose();
    this.core.activity.dispose();
    this.dataSignal.dispose(); this.inputSignal.dispose(); this.binarySignal.dispose(); this.scrollSignal.dispose(); this.renderSignal.dispose();
    this.resizeSignal.dispose();
    this.rowNodes.clear(); this.rowPool = [];
    this.element?.remove();
  }

  private onModelChange(): void {
    const following = this.viewportY >= this.previousBaseY;
    const dropped = Math.max(0, this.core.history.dropped - this.previousDropped);
    if (following || this.previousType !== this.core.type) { this.viewportY = this.core.baseY; this.scrollRemainder = 0; this.scrollDirty = true; }
    else this.viewportY = Math.min(this.core.baseY, Math.max(0, this.viewportY - dropped));
    if (dropped) this.scrollDirty = true;
    if (this.selection && dropped) {
      this.selection.anchor -= dropped * this.cols;
      this.selection.focus -= dropped * this.cols;
      if (this.selection.anchor < 0 || this.selection.focus < 0) this.selection = undefined;
    }
    this.previousBaseY = this.core.baseY;
    this.previousDropped = this.core.history.dropped;
    this.previousType = this.core.type;
    this.updateWheelListener();
    if (this.core.modes.synchronizedOutputMode) {
      // A broken or interrupted app must not leave the viewer permanently frozen.
      if (this.syncTimer === undefined) this.syncTimer = setTimeout(() => {
        this.syncTimer = undefined;
        this.core.modes.synchronizedOutputMode = false;
        this.scheduleRender();
      }, 1000);
      return;
    }
    clearTimeout(this.syncTimer); this.syncTimer = undefined;
    this.scheduleRender();
    if (this.announcementTimer === undefined) this.announcementTimer = setTimeout(() => {
      this.announcementTimer = undefined;
      if (!this.announcement || !this.focused) return;
      const first = Math.max(this.core.baseY, this.core.baseY + this.core.cursorY - 2);
      this.announcement.textContent = Array.from({ length: this.core.baseY + this.core.cursorY - first + 1 }, (_, index) => this.core.getLine(first + index)?.translateToString(true) ?? "").join("\n");
    }, 700);
  }

  private applyOptions(): void {
    if (!this.element || !this.textarea || this.disposed) return;
    if (this.fileLinkOptions !== this.options.fileLinks) {
      this.filePreview?.dispose(); this.filePreview = undefined; this.fileLinkSubscription?.dispose(); this.fileLinkSubscription = undefined; this.linkCache.clear();
      this.fileLinkOptions = this.options.fileLinks;
      if (this.fileLinkOptions) {
        if (typeof this.fileLinkOptions.resolve !== "function") throw new TypeError("fileLinks requires a host resolver");
        this.filePreview = new TerminalFilePreview(this.element, this.fileLinkOptions);
        this.fileLinkSubscription = this.fileLinkOptions.onChange?.(() => { this.linkCache.clear(); this.styleRevision++; this.scheduleRender(); });
      }
    }
    const finite = (value: number | undefined, fallback: number) => Number.isFinite(value) ? value! : fallback;
    const size = Math.max(4, Math.min(64, finite(this.options.fontSize, 14)));
    const family = this.options.fontFamily ?? DEFAULT_FONT;
    const metrics = measureCell(this.element.ownerDocument, family, size, String(this.options.fontWeight ?? "400"));
    const ratio = this.view?.devicePixelRatio || 1;
    this.cellWidth = Math.max(1, metrics.width + finite(this.options.letterSpacing, 0));
    this.cellHeight = Math.floor(Math.ceil(metrics.height * ratio) * Math.max(1, Math.min(4, finite(this.options.lineHeight, 1.18)))) / ratio;
    this.scrollbar = Math.max(14, this.viewport ? this.viewport.offsetWidth - this.viewport.clientWidth : 0);
    const theme = this.theme = resolveTerminalTheme(this.options.theme);
    applyTerminalUiTheme(this.element, theme);
    this.filePreview?.updateTheme();
    this.element.style.fontFamily = family;
    this.element.style.fontSize = `${size}px`;
    this.element.style.lineHeight = `${this.cellHeight}px`;
    this.element.style.fontWeight = String(this.options.fontWeight ?? "400");
    this.element.style.letterSpacing = `${finite(this.options.letterSpacing, 0)}px`;
    this.element.style.width = `${Math.ceil(this.cols * this.cellWidth) + this.scrollbar}px`;
    this.element.style.height = `${this.rows * this.cellHeight}px`;
    this.element.style.setProperty("--shell-fg", theme.foreground ?? "#dfe4ed");
    this.element.style.setProperty("--shell-bg", theme.background ?? "#11151b");
    this.element.style.setProperty("--shell-selection", theme.selectionBackground ?? "#39577d");
    this.element.style.setProperty("--shell-selection-inactive", theme.selectionInactiveBackground ?? theme.selectionBackground ?? "#39577d");
    this.element.style.setProperty("--shell-cursor", theme.cursor ?? "#c8f28d");
    this.element.style.setProperty("--shell-cursor-ink", theme.cursorAccent ?? theme.background ?? "#11151b");
    this.textarea.readOnly = this.options.disableStdin ?? false;
    this.scrollDirty = true;
    this.styleRevision++;
    this.scheduleRender();
  }

  private scheduleRender(): void {
    if (this.disposed || !this.element || this.frame || this.core.modes.synchronizedOutputMode) return;
    this.frame = this.view?.requestAnimationFrame(() => { this.frame = 0; this.render(); }) ?? 0;
  }

  private render(): void {
    if (!this.viewport || !this.content || !this.rowLayer || !this.cursor || !this.element) return;
    const document = this.element.ownerDocument;
    const width = Math.round(this.cols * this.cellWidth);
    const height = this.core.length * this.cellHeight;
    if (width !== this.contentWidth) { this.content.style.width = `${width}px`; this.contentWidth = width; }
    if (height !== this.contentHeight) { this.content.style.height = `${height}px`; this.contentHeight = height; }
    // Let the browser own fractional/inertial scrolling. Only output anchoring
    // and explicit navigation set scrollTop, before the row mutations below.
    if (this.scrollDirty) {
      const top = Math.min(this.core.baseY * this.cellHeight, this.viewportY * this.cellHeight + this.scrollRemainder);
      // Explicit navigation must interrupt native smooth scrolling as well as
      // any scroll event queued before this frame (notably on WebKit/GTK).
      if (this.navigationPending) this.viewport.scrollTo({ top, behavior: "instant" });
      else this.viewport.scrollTop = top;
      this.programmaticScrollTop = top; this.scrollDirty = false; this.navigationPending = false;
    }
    const first = Math.max(0, this.viewportY - this.scrollMargin);
    const end = Math.min(this.core.length, this.viewportY + this.rows + this.scrollMargin);
    const lines = Array.from({ length: end - first }, (_, index) => this.core.getLine(first + index)!);
    const detectedLinks = this.linkCache.rows(this.core, first, end, Boolean(this.filePreview), this.options.linkify !== false, this.fileLinkOptions?.canResolve);
    const visible = new Set(lines.map(line => line.id));
    // Stable line IDs survive scrollback eviction. Recycle only rows which
    // actually leave the retained viewport, including their styled text runs.
    for (const [id, cached] of this.rowNodes) if (!visible.has(id)) {
      cached.element.remove(); this.rowNodes.delete(id); this.rowPool.push(cached);
    }
    let previousRow: Element | null = null;
    const focusableFiles = new Set<string>();
    for (let row = first; row < end; row++) {
      const line = lines[row - first];
      const selected = this.selectionFor(row);
      const links = detectedLinks.get(line.id);
      const key = `${line.id}:${line.version}:${this.styleRevision}:${this.modes.reverseVideo}:${selected?.join(",") ?? ""}:${links?.map(link => `${link.start}-${link.end}-${link.target.key}`).join("|") ?? ""}:${links?.length ? row : ""}`;
      let cached = this.rowNodes.get(line.id);
      if (!cached) {
        cached = this.rowPool.pop();
        if (!cached) {
          const element = document.createElement("div"); element.className = "shell-terminal-row";
          cached = { element, key: "", row: -1, height: 0, runs: [] };
        }
        this.rowNodes.set(line.id, cached);
      }
      if (cached.row !== row || cached.height !== this.cellHeight) {
        cached.element.style.top = `${row * this.cellHeight}px`;
        cached.element.style.height = `${this.cellHeight}px`;
        cached.element.dataset.row = String(row); cached.row = row; cached.height = this.cellHeight;
      }
      // Absolute positioning is visual only; keep reading/selection order correct too.
      const nextRow: Element | null = previousRow ? previousRow.nextElementSibling : this.rowLayer.firstElementChild;
      if (nextRow !== cached.element) this.rowLayer.insertBefore(cached.element, nextRow);
      previousRow = cached.element;
      if (cached.key !== key) { this.drawLine(cached, line, selected, links); cached.key = key; }
      for (const run of cached.runs) {
        const link = this.runLinks.get(run.element); if (!link?.file) continue;
        const tabIndex = focusableFiles.has(link.key) ? -1 : 0;
        if (run.element.tabIndex !== tabIndex) run.element.tabIndex = tabIndex;
        focusableFiles.add(link.key);
      }
    }
    this.filePreview?.validate((anchor, key) => this.runLinks.get(anchor)?.key === key);
    // A past large grid or fast fling must not retain an oversized detached pool.
    this.rowPool.length = Math.min(this.rowPool.length, this.rows + 4);
    const cursorRow = this.core.baseY + this.core.cursorY;
    const cursorColumn = Math.min(this.cols - 1, this.core.cursorX);
    const cursorCell = this.core.getLine(cursorRow)?.cells[cursorColumn];
    this.cursor.hidden = !this.core.cursorVisible || cursorRow < this.viewportY || cursorRow >= this.viewportY + this.rows ||
      (!this.focused && this.options.cursorInactiveStyle === "none");
    this.cursor.style.left = `${cursorColumn * this.cellWidth}px`;
    this.cursor.style.top = `${cursorRow * this.cellHeight}px`;
    this.cursor.style.width = `${Math.max(1, cursorCell?.width ?? 1) * this.cellWidth}px`;
    this.cursor.style.height = `${this.cellHeight}px`;
    this.cursor.textContent = cursorCell?.text || " ";
    this.cursor.dataset.style = this.focused ? this.core.cursorStyle === "block" ? this.options.cursorStyle ?? "block" : this.core.cursorStyle : this.options.cursorInactiveStyle ?? "outline";
    this.cursor.dataset.blink = String(this.focused && this.options.cursorBlink !== false && this.core.cursorBlink);
    this.element.dataset.focused = String(this.focused);
    if (this.textarea) {
      this.textarea.style.left = `${cursorColumn * this.cellWidth}px`;
      this.textarea.style.top = `${Math.max(0, Math.min(this.rows - 1, cursorRow - this.viewportY)) * this.cellHeight}px`;
    }
    this.scrollSignal.fire(this.viewportY);
    this.renderSignal.fire({ start: first, end: end - 1 });
  }

  private drawLine(row: RenderedRow, line: TerminalLine, selection?: [number, number], links?: TerminalRowLink[]): void {
    const document = row.element.ownerDocument;
    let run: { attributes: Readonly<Attributes>; selected: boolean; width: number; text: string; target?: RenderedTerminalLink } | undefined;
    let index = 0;
    let linkIndex = 0;
    const finish = (): void => {
      if (!run) return;
      const attr = run.attributes;
      let cached = row.runs[index];
      const tag = run.target ? "A" : "SPAN";
      if (!cached || cached.element.tagName !== tag) {
        const span = document.createElement(run.target ? "a" : "span"); span.className = "shell-terminal-run";
        if (cached) row.element.replaceChild(span, cached.element); else row.element.append(span);
        cached = { element: span, revision: -1, width: -1, text: "" }; row.runs[index] = cached;
      }
      const span = cached.element;
      const restyle = cached.attributes !== attr || cached.selected !== run.selected || cached.revision !== this.styleRevision || cached.reverse !== this.modes.reverseVideo || cached.linkKey !== run.target?.key;
      if (run.target) this.runLinks.set(span, run.target); else this.runLinks.delete(span);
      if (restyle) {
        span.removeAttribute("style");
        if (run.target) {
          const anchor = span as HTMLAnchorElement;
          anchor.draggable = false; anchor.classList.add("shell-terminal-link"); anchor.tabIndex = 0;
          anchor.dataset.linkKind = run.target.file ? "file" : "url";
          if (run.target.url) {
            anchor.removeAttribute("aria-label");
            anchor.href = run.target.url; anchor.target = "_blank"; anchor.rel = "noopener noreferrer"; anchor.referrerPolicy = "no-referrer";
            anchor.title = run.target.url; anchor.removeAttribute("role"); anchor.removeAttribute("aria-haspopup");
          } else {
            anchor.setAttribute("aria-label", run.target.label);
            anchor.removeAttribute("href"); anchor.removeAttribute("target"); anchor.removeAttribute("rel"); anchor.removeAttribute("title");
            anchor.setAttribute("role", "link"); anchor.setAttribute("aria-haspopup", "dialog");
          }
        }
        let foreground = this.color(attr.fg, true, attr.bold);
        let background = this.color(attr.bg, false);
        if (attr.inverse !== this.modes.reverseVideo) [foreground, background] = [background, foreground];
        span.style.color = attr.hidden ? "transparent" : foreground;
        span.style.backgroundColor = run.selected ? "var(--shell-active-selection)" : background;
        if (attr.bold) span.style.fontWeight = String(this.options.fontWeightBold ?? "700");
        if (attr.dim) span.style.opacity = "0.6";
        if (attr.italic) span.style.fontStyle = "italic";
        if (attr.underline || attr.strike) span.style.textDecorationLine = `${attr.underline ? "underline" : ""} ${attr.strike ? "line-through" : ""}`.trim();
        if (attr.underline === 2) span.style.textDecorationStyle = "double";
        if (attr.underline === 3) span.style.textDecorationStyle = "wavy";
        cached.attributes = attr; cached.selected = run.selected; cached.revision = this.styleRevision; cached.reverse = this.modes.reverseVideo;
        cached.linkKey = run.target?.key;
      }
      if (restyle || cached.width !== run.width) { span.style.width = `${run.width * this.cellWidth}px`; cached.width = run.width; }
      if (cached.text !== run.text) { span.textContent = run.text; cached.text = run.text; }
      index++;
    };
    for (let column = 0; column < line.length; column++) {
      const cell = line.cells[column];
      if (!cell.width) continue;
      while (links && linkIndex < links.length && links[linkIndex].end <= column) linkIndex++;
      const found = links?.[linkIndex];
      const target = cell.attributes.hidden ? undefined : cell.attributes.link ? { key: `osc8:${cell.attributes.link}`, label: cell.attributes.link, url: cell.attributes.link } : found && found.start <= column && found.end > column ? found.target : undefined;
      const selected = Boolean(selection && column < selection[1] && column + cell.width > selection[0]);
      const simple = cell.width === 1 && (cell.text === "" || cell.text.length === 1 && cell.text.charCodeAt(0) >= 32 && cell.text.charCodeAt(0) < 127);
      if (run && simple && run.attributes === cell.attributes && run.selected === selected && run.target?.key === target?.key) {
        run.text += cell.text || " "; run.width += cell.width; continue;
      }
      finish();
      run = { attributes: cell.attributes, selected, width: cell.width, text: cell.text || " ", target };
      // Wide and combined graphemes get their own explicitly sized cell.
      if (!simple) { finish(); run = undefined; }
    }
    finish();
    while (row.runs.length > index) row.runs.pop()!.element.remove();
  }

  private updateWheelListener(): void {
    if (!this.viewport || this.disposed) return;
    const intercept = this.modes.mouseTrackingMode !== "none" || this.core.type === "alternate" && this.modes.applicationCursorKeysMode;
    if (intercept === this.interceptWheel) return;
    this.interceptWheel = intercept;
    if (intercept) this.viewport.addEventListener("wheel", this.wheelHandler, { signal: this.abort.signal, passive: false });
    else this.viewport.removeEventListener("wheel", this.wheelHandler);
  }

  private handleWheel(event: WheelEvent): void {
    if (event.ctrlKey || event.shiftKey) return;
    if (this.modes.mouseTrackingMode !== "none") {
      event.preventDefault(); this.reportMouse("wheel", event.deltaY > 0 ? 1 : 0, event);
    } else if (this.core.type === "alternate" && this.modes.applicationCursorKeysMode && event.deltaY) {
      event.preventDefault();
      const key = encodeTerminalKey({ key: event.deltaY > 0 ? "ArrowDown" : "ArrowUp" }, this.modes)!;
      this.emitInput(key.repeat(Math.min(5, Math.max(1, Math.ceil(Math.abs(event.deltaY) / this.cellHeight)))));
    }
  }

  private color(value: TerminalColor, foreground: boolean, bold = false): string {
    if (value === null) return foreground ? "var(--shell-fg)" : "var(--shell-bg)";
    if (typeof value === "string") return value;
    if (value < 16) {
      const index = value < 8 && foreground && bold && this.options.drawBoldTextInBrightColors ? value + 8 : value;
      return this.theme[COLOR_NAMES[index]] ?? PALETTE[index];
    }
    if (value >= 232) { const gray = 8 + (value - 232) * 10; return `rgb(${gray},${gray},${gray})`; }
    const cube = value - 16;
    const levels = [0, 95, 135, 175, 215, 255];
    return `rgb(${levels[Math.floor(cube / 36)]},${levels[Math.floor(cube / 6) % 6]},${levels[cube % 6]})`;
  }

  private bindInput(): void {
    const textarea = this.textarea!;
    const viewport = this.viewport!;
    const signal = this.abort.signal;
    let lastPointerType = "mouse";
    const linkAt = (target: EventTarget | null) => {
      const anchor = (target as Element | null)?.closest?.<HTMLElement>("a.shell-terminal-link");
      const link = anchor && this.runLinks.get(anchor);
      return anchor && link ? { anchor, link } : undefined;
    };
    viewport.addEventListener("pointerover", event => {
      if (event.pointerType !== "mouse" || this.selecting || this.linkPointer || this.linkDragged || this.hasSelection() || this.modes.mouseTrackingMode !== "none" && !event.shiftKey) return;
      const target = linkAt(event.target);
      if (target?.link.file) this.filePreview?.schedule(target.link.file, target.anchor, target.link.key);
    }, { signal, passive: true });
    viewport.addEventListener("pointerout", event => {
      if (!this.filePreview?.contains(event.relatedTarget) && linkAt(event.target)?.anchor !== linkAt(event.relatedTarget)?.anchor) this.filePreview?.leave();
    }, { signal, passive: true });
    viewport.addEventListener("focusin", event => {
      if (this.filePreview?.returningFocus || this.linkPointer || this.hasSelection()) return;
      const target = linkAt(event.target);
      if (target?.link.file && this.modes.mouseTrackingMode === "none") this.filePreview?.schedule(target.link.file, target.anchor, target.link.key);
    }, { signal });
    viewport.addEventListener("focusout", event => { if (!this.filePreview?.contains(event.relatedTarget)) this.filePreview?.leave(); }, { signal });
    viewport.addEventListener("keydown", event => {
      const target = linkAt(event.target);
      if (target?.link.file && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); this.filePreview?.schedule(target.link.file, target.anchor, target.link.key, true); }
    }, { signal });
    viewport.addEventListener("click", event => {
      const target = linkAt(event.target);
      if (!target) return;
      if (this.linkDragged || this.hasSelection() || this.modes.mouseTrackingMode !== "none" && !event.shiftKey) { event.preventDefault(); return; }
      if (target.link.file) { event.preventDefault(); this.filePreview?.schedule(target.link.file, target.anchor, target.link.key, true); }
    }, { signal });
    textarea.addEventListener("keydown", (event) => {
      if (this.keyHandler?.(event) === false) { event.preventDefault(); return; }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c" && this.hasSelection()) {
        // Give the browser a real selection so its native copy command fires,
        // even when the selected rows only exist in our scrollback model.
        textarea.value = this.getSelection(); textarea.select(); return;
      }
      if (event.shiftKey && !event.ctrlKey && !event.altKey && (event.key === "PageUp" || event.key === "PageDown")) {
        event.preventDefault(); this.scrollLines((event.key === "PageUp" ? -1 : 1) * this.rows); return;
      }
      // Paste remains a clipboard event, including Ctrl-V on non-Apple keyboards.
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") return;
      if (this.composing) return;
      const platform = this.view?.navigator.platform ?? "";
      if (/Mac|iPhone|iPad|iPod/u.test(platform) && event.altKey && !event.ctrlKey && !this.options.macOptionIsMeta) return;
      const data = encodeTerminalKey(event, this.modes);
      if (data !== null) { event.preventDefault(); this.emitInput(data); textarea.value = ""; }
    }, { signal });
    textarea.addEventListener("compositionstart", () => {
      this.composing = true; this.compositionCommit = "";
      this.inputSignal.fire({ type: "composition" });
    }, { signal });
    textarea.addEventListener("compositionend", (event) => {
      this.composing = false;
      this.compositionCommit = event.data;
      if (event.data) this.emitInput(event.data);
      else this.inputSignal.fire({ type: "composition" });
      textarea.value = "";
      clearTimeout(this.compositionTimer);
      this.compositionTimer = setTimeout(() => { this.compositionCommit = ""; }, 0);
    }, { signal });
    textarea.addEventListener("input", (event) => {
      if (this.composing || (event as InputEvent).isComposing) return;
      const value = textarea.value;
      if (value && value !== this.compositionCommit) this.emitInput(value);
      textarea.value = "";
      this.compositionCommit = "";
    }, { signal });
    textarea.addEventListener("beforeinput", (event) => {
      if (this.composing) return;
      if (event.inputType === "deleteContentBackward") { event.preventDefault(); this.emitInput("\x7f"); }
      if (event.inputType === "insertLineBreak" || event.inputType === "insertParagraph") { event.preventDefault(); this.emitInput("\r"); }
    }, { signal });
    textarea.addEventListener("paste", (event) => {
      if (!event.clipboardData) return;
      event.preventDefault(); this.paste(event.clipboardData.getData("text/plain"));
    }, { signal });
    this.element!.addEventListener("copy", (event) => {
      if (!this.hasSelection() || !event.clipboardData) return;
      event.clipboardData.setData("text/plain", this.getSelection()); event.preventDefault();
      textarea.value = "";
    }, { signal });
    textarea.addEventListener("focus", () => {
      this.focused = true; this.scheduleRender();
      if (this.modes.sendFocusMode) this.emitInput("\x1b[I", false);
    }, { signal });
    textarea.addEventListener("blur", () => {
      this.focused = false; this.scheduleRender();
      if (this.modes.sendFocusMode) this.emitInput("\x1b[O", false);
    }, { signal });
    viewport.addEventListener("scroll", () => {
      if (this.navigationPending) return;
      // Scroll events are queued. A paint from an earlier output batch must not
      // be mistaken for a user scrolling away from a newer, not-yet-painted tail.
      const top = viewport.scrollTop;
      if (Math.abs(top - this.programmaticScrollTop) < 0.5) return;
      const next = Math.min(this.core.baseY, Math.max(0, Math.floor(top / this.cellHeight)));
      this.scrollRemainder = Math.max(0, top - next * this.cellHeight); this.scrollDirty = false;
      this.scrollMargin = Math.min(this.rows, 8, Math.max(4, Math.abs(next - this.viewportY) * 2));
      this.viewportY = next;
      clearTimeout(this.scrollIdleTimer);
      this.scrollIdleTimer = setTimeout(() => { this.scrollMargin = 2; this.scheduleRender(); }, 160);
      this.scheduleRender(); this.scrollSignal.fire(this.viewportY);
    }, { signal, passive: true });
    this.updateWheelListener();
    viewport.addEventListener("pointerdown", (event) => {
      lastPointerType = event.pointerType;
      this.linkDragged = false; this.linkPointer = undefined;
      if (event.pointerType !== "mouse") return;
      if (this.modes.mouseTrackingMode !== "none" && !event.shiftKey) {
        event.preventDefault(); this.focus(); this.reportMouse("down", event.button, event); viewport.setPointerCapture(event.pointerId); return;
      }
      if (event.button !== 0) return;
      if (linkAt(event.target)) { this.clearSelection(); this.filePreview?.cancelPending(); this.linkPointer = { x: event.clientX, y: event.clientY, pointerId: event.pointerId }; return; }
      event.preventDefault();
      this.focus();
      const position = this.position(event.clientX, event.clientY);
      const offset = position.row * this.cols + position.column;
      this.selection = { anchor: offset, focus: offset };
      this.selecting = true;
      viewport.setPointerCapture(event.pointerId);
      this.scheduleRender();
    }, { signal });
    viewport.addEventListener("pointermove", (event) => {
      if (this.linkPointer && !this.selecting && Math.hypot(event.clientX - this.linkPointer.x, event.clientY - this.linkPointer.y) >= 4) {
        this.linkDragged = true; this.filePreview?.close(); this.focus();
        const start = this.position(this.linkPointer.x, this.linkPointer.y);
        const offset = start.row * this.cols + start.column; this.selection = { anchor: offset, focus: offset }; this.selecting = true;
        viewport.setPointerCapture(this.linkPointer.pointerId);
      }
      if (this.selecting && this.selection) {
        this.dragPosition = { x: event.clientX, y: event.clientY };
        this.updateDrag();
      } else if (event.pointerType === "mouse" && !event.shiftKey) {
        this.reportMouse("move", event.buttons & 1 ? 0 : event.buttons & 4 ? 1 : event.buttons & 2 ? 2 : 3, event);
      }
    }, { signal });
    viewport.addEventListener("pointerup", (event) => {
      this.linkPointer = undefined;
      if (!this.selecting && !event.shiftKey) this.reportMouse("up", event.button, event);
      this.selecting = false; this.dragPosition = undefined;
      this.view?.cancelAnimationFrame(this.dragFrame); this.dragFrame = 0;
      if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
    }, { signal });
    viewport.addEventListener("pointercancel", () => {
      this.linkPointer = undefined; this.filePreview?.close();
      this.selecting = false; this.dragPosition = undefined;
      this.view?.cancelAnimationFrame(this.dragFrame); this.dragFrame = 0;
    }, { signal });
    viewport.addEventListener("dblclick", (event) => {
      // Chromium can synthesize dblclick across quick taps on adjacent links.
      // Touch selection belongs to the browser; those taps must not leave a
      // model selection that blocks every subsequent file activation.
      if (lastPointerType !== "mouse") {
        if (linkAt(event.target)) event.preventDefault();
        return;
      }
      if (this.modes.mouseTrackingMode !== "none" && !event.shiftKey) return;
      const { column, row } = this.position(event.clientX, event.clientY);
      const line = this.core.getLine(row);
      if (!line) return;
      const word = (cell?: Cell) => Boolean(cell && /[\p{L}\p{N}_./~:@-]/u.test(cell.text));
      let start = column; let end = column + 1;
      while (start > 0 && word(line.cells[start - 1])) start--;
      while (end < this.cols && word(line.cells[end])) end++;
      this.select(start, row, end - start);
    }, { signal });
    viewport.addEventListener("contextmenu", (event) => {
      if (this.modes.mouseTrackingMode !== "none" && !event.shiftKey) event.preventDefault();
    }, { signal });
    // Mobile taps open the real input/IME; a pan is handled by native scrolling.
    let touchStart: { x: number; y: number } | undefined;
    let touchTap = false;
    viewport.addEventListener("pointerdown", (event) => {
      touchTap = false;
      if (event.pointerType === "touch") touchStart = { x: event.clientX, y: event.clientY };
    }, { signal, passive: true });
    viewport.addEventListener("pointerup", (event) => {
      touchTap = Boolean(event.pointerType === "touch" && touchStart &&
        Math.hypot(event.clientX - touchStart.x, event.clientY - touchStart.y) < 6 &&
        !this.domSelection() && !(event.target as Element).closest("a"));
      if (touchTap) this.focus();
      touchStart = undefined;
    }, { signal, passive: true });
    viewport.addEventListener("pointercancel", () => { touchStart = undefined; touchTap = false; }, { signal });
    viewport.addEventListener("click", () => {
      // Chromium sends compatibility mouse events after touch pointerup; their
      // default focus handling can blur the textarea. Reclaim it during the
      // same trusted tap's click, while leaving pans, links and selections alone.
      if (touchTap && !this.domSelection()) this.focus();
      touchTap = false;
    }, { signal });
  }

  private emitInput(data: string, user = true, source?: unknown): void {
    if (this.disposed || this.options.disableStdin || !data) return;
    if (user) {
      this.inputSignal.fire({ type: "input", data, source });
      this.clearSelection();
      if (this.options.scrollOnUserInput !== false) this.scrollToBottom();
    }
    this.dataSignal.fire(data);
  }
  private selectionFor(row: number): [number, number] | undefined {
    if (!this.selection) return undefined;
    const first = Math.max(0, Math.min(this.selection.anchor, this.selection.focus) - row * this.cols);
    const last = Math.min(this.cols, Math.max(this.selection.anchor, this.selection.focus) - row * this.cols);
    return first < last ? [first, last] : undefined;
  }
  private domSelection(): string {
    const selection = this.element?.ownerDocument.getSelection();
    return selection?.anchorNode && this.element?.contains(selection.anchorNode) ? selection.toString() : "";
  }
  private position(x: number, y: number, scrollTop?: number): { row: number; column: number } {
    const rect = this.viewport!.getBoundingClientRect();
    return {
      row: Math.max(0, Math.min(this.core.length - 1, Math.floor((y - rect.top + (scrollTop ?? this.viewport!.scrollTop)) / this.cellHeight))),
      column: Math.max(0, Math.min(this.cols - 1, Math.floor((x - rect.left + this.viewport!.scrollLeft) / this.cellWidth))),
    };
  }
  private updateDrag(): void {
    if (!this.dragPosition || !this.selection || !this.viewport) return;
    const { x, y } = this.dragPosition;
    const rect = this.viewport.getBoundingClientRect();
    const direction = y < rect.top ? -1 : y > rect.bottom ? 1 : 0;
    if (direction) this.scrollLines(direction * 2);
    const position = this.position(x, y, direction ? this.viewportY * this.cellHeight : undefined);
    this.selection.focus = position.row * this.cols + position.column;
    this.scheduleRender();
    if (direction && !this.dragFrame) this.dragFrame = this.view?.requestAnimationFrame(() => { this.dragFrame = 0; this.updateDrag(); }) ?? 0;
  }
  private reportMouse(kind: TerminalMouse["kind"], button: number, event: MouseEvent): void {
    if (this.options.disableStdin || this.modes.mouseTrackingMode === "none") return;
    const { row, column } = this.position(event.clientX, event.clientY);
    const encoded = encodeTerminalMouse({ kind, button, x: column + 1, y: row - this.core.baseY + 1, shift: event.shiftKey, alt: event.altKey, ctrl: event.ctrlKey }, this.modes);
    if (encoded) {
      this.inputSignal.fire({ type: "mouse" });
      (encoded.binary ? this.binarySignal : this.dataSignal).fire(encoded.data);
    }
  }
}
