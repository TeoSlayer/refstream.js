/** Public browser and buffer contracts. Importing these requires no DOM. */
import type { TerminalFileLinkOptions } from "./file-preview.js";
import type { TerminalThemeName } from "./themes.js";
export interface Disposable { dispose(): void }

export class Signal<T> {
  private listeners = new Set<(event: T) => void>();
  readonly event = (listener: (event: T) => void): Disposable => {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  };
  fire(event: T): void { for (const listener of this.listeners) listener(event); }
  dispose(): void { this.listeners.clear(); }
}

export interface TerminalTheme {
  colorScheme?: "dark" | "light";
  foreground?: string; background?: string; cursor?: string; cursorAccent?: string;
  selectionBackground?: string; selectionInactiveBackground?: string;
  black?: string; red?: string; green?: string; yellow?: string;
  blue?: string; magenta?: string; cyan?: string; white?: string;
  brightBlack?: string; brightRed?: string; brightGreen?: string; brightYellow?: string;
  brightBlue?: string; brightMagenta?: string; brightCyan?: string; brightWhite?: string;
}

export interface TerminalOptions {
  /** Initial grid and retained history. Use resize() to change the grid. */
  readonly cols?: number; readonly rows?: number; readonly scrollback?: number;
  /** Initial newline mode. A host may subsequently change it using VT sequences. */
  readonly convertEol?: boolean;
  fontFamily?: string; fontSize?: number;
  lineHeight?: number; letterSpacing?: number; theme?: TerminalTheme | TerminalThemeName;
  cursorBlink?: boolean; cursorStyle?: "block" | "underline" | "bar";
  cursorInactiveStyle?: "outline" | "block" | "bar" | "underline" | "none";
  disableStdin?: boolean; drawBoldTextInBrightColors?: boolean;
  /** On macOS, send Option as ESC-prefixed input instead of composing characters. */
  macOptionIsMeta?: boolean; scrollOnUserInput?: boolean;
  fontWeight?: "normal" | "bold" | "100" | "200" | "300" | "400" | "500" | "600" | "700" | "800" | "900" | number;
  fontWeightBold?: TerminalOptions["fontWeight"];
  /** Detect plain HTTP(S) URLs in output. Explicit OSC 8 links remain supported. Default true. */
  linkify?: boolean;
  /** Opt-in file references and previews. Detection never grants file access. */
  fileLinks?: TerminalFileLinkOptions;
}

export interface TerminalSize { cols: number; rows: number }
export interface TerminalCellMetrics { width: number; height: number; scrollbar: number }

export interface ReadableCell {
  getChars(): string;
  getWidth(): number;
}

export interface ReadableLine {
  readonly isWrapped: boolean;
  readonly length: number;
  getCell(column: number): ReadableCell | undefined;
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string;
}

export interface ReadableBuffer {
  readonly type: "normal" | "alternate";
  readonly baseY: number;
  readonly viewportY: number;
  readonly cursorX: number;
  readonly cursorY: number;
  readonly length: number;
  getLine(row: number): ReadableLine | undefined;
}

export interface TerminalSurface {
  readonly cols: number;
  readonly rows: number;
  readonly element: HTMLElement | undefined;
  readonly textarea: HTMLTextAreaElement | undefined;
  options: TerminalOptions;
  readonly buffer: { readonly active: ReadableBuffer };
  readonly modes: { readonly mouseTrackingMode: string; readonly applicationCursorKeysMode: boolean };
  open(element: HTMLElement): void;
  write(data: string | Uint8Array, callback?: () => void): void;
  reset(): void;
  resize(cols: number, rows: number): void;
  refresh(start: number, end: number): void;
  focus(): void;
  blur(): void;
  dispose(): void;
  paste(data: string): void;
  scrollLines(lines: number): void;
  scrollToLine(line: number): void;
  scrollToBottom(): void;
  hasSelection(): boolean;
  getSelection(): string;
  clearSelection(): void;
  select(column: number, row: number, length: number): void;
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void;
  onData(listener: (data: string) => void): Disposable;
  onBinary(listener: (data: string) => void): Disposable;
  onTitleChange(listener: (title: string) => void): Disposable;
  onScroll(listener: (position: number) => void): Disposable;
  onRender(listener: (range: { start: number; end: number }) => void): Disposable;
}
