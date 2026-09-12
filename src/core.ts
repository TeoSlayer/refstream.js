/* eslint-disable no-control-regex -- A terminal parser must recognize control characters. */
import { asciiCells, createCell, internAttributes, DEFAULT_ATTRIBUTES, EMPTY_CELL, LineHistory, TerminalLine, type Attributes, type Cell } from "./buffer.js";
import { cellWidth, joinsCell, safeHyperlink } from "./unicode.js";
import { Signal } from "./types.js";
import { Utf8Decoder } from "./utf8.js";
import { validateState, type LineState, type ParserState, type ScreenState, type TerminalState } from "./state.js";

/*
 * Shell's terminal state machine. No DOM, xterm, network, or storage dependency.
 * Write boundaries have no semantic meaning: UTF-8, CSI, OSC and DCS can all
 * arrive one byte at a time. See docs/terminal-engine.md for the support matrix.
 */
const ESC = "\x1b";
const MAX_CONTROL_LENGTH = 4096;
const MAX_CSI_LENGTH = 256;
const MAX_DIAGNOSTICS = 32;
const DEC_GRAPHICS: Record<string, string> = {
  "`": "◆", a: "▒", f: "°", g: "±", j: "┘", k: "┐", l: "┌", m: "└", n: "┼",
  o: "⎺", p: "⎻", q: "─", r: "⎼", s: "⎽", t: "├", u: "┤", v: "┴", w: "┬", x: "│",
  y: "≤", z: "≥", "{": "π", "|": "≠", "}": "£", "~": "·",
};

export interface TerminalModes {
  applicationCursorKeysMode: boolean;
  applicationKeypadMode: boolean;
  bracketedPasteMode: boolean;
  mouseTrackingMode: "none" | "x10" | "vt200" | "drag" | "any";
  sgrMouse: boolean;
  sendFocusMode: boolean;
  synchronizedOutputMode: boolean;
  insertMode: boolean;
  originMode: boolean;
  wraparoundMode: boolean;
  reverseVideo: boolean;
  newlineMode: boolean;
}

function defaultModes(): TerminalModes {
  return {
    applicationCursorKeysMode: false, applicationKeypadMode: false, bracketedPasteMode: false,
    mouseTrackingMode: "none", sgrMouse: false, sendFocusMode: false, synchronizedOutputMode: false,
    insertMode: false, originMode: false, wraparoundMode: true, reverseVideo: false, newlineMode: false,
  };
}

interface SavedCursor {
  x: number; y: number; pendingWrap: boolean; attributes: Readonly<Attributes>;
  origin: boolean; g0: boolean; g1: boolean; charset: number;
}

class Screen {
  lines: TerminalLine[];
  x = 0;
  y = 0;
  pendingWrap = false;
  top = 0;
  bottom: number;
  saved?: SavedCursor;
  constructor(cols: number, rows: number) {
    this.lines = Array.from({ length: rows }, () => new TerminalLine(cols));
    this.bottom = rows - 1;
  }
}

export interface CommandMarker {
  id: number;
  lineId: number;
  column: number;
  timestamp: number;
  kind: "prompt" | "command" | "output" | "finished";
  exitCode?: number;
}

export type TerminalActivity = { type: "write"; data: string | Uint8Array; timestamp: number } |
  { type: "resize"; cols: number; rows: number } | { type: "reset" } | { type: "restore" };

export class TerminalCore {
  cols: number;
  rows: number;
  readonly history: LineHistory;
  modes = defaultModes();
  cursorVisible = true;
  cursorStyle: "block" | "underline" | "bar" = "block";
  cursorBlink = true;
  title = "";
  directory = "";
  revision = 0;
  bytesReceived = 0;
  readonly unsupported = new Map<string, number>();
  readonly markers: CommandMarker[] = [];
  readonly changed = new Signal<void>();
  readonly reply = new Signal<string>();
  readonly titleChanged = new Signal<string>();
  readonly bell = new Signal<void>();
  readonly command = new Signal<CommandMarker>();
  readonly activity = new Signal<TerminalActivity>();
  private primary: Screen;
  private alternate: Screen;
  private screen: Screen;
  private attributes = DEFAULT_ATTRIBUTES;
  private decoder = new Utf8Decoder();
  private highSurrogate = "";
  private state: ParserState = "ground";
  private stringState: ParserState = "ignore";
  private sequence = "";
  private oversized = false;
  private escapeIntermediate = "";
  private charsetTarget = 0;
  private charsets = [false, false];
  private charset = 0;
  private tabs = new Set<number>();
  private lastPrinted?: { line: TerminalLine; column: number };
  private repeated = "";
  private markerId = 0;
  private scrollbackLimit: number;
  private writeTimestamp = 0;

  constructor(options: { cols?: number; rows?: number; scrollback?: number; convertEol?: boolean } = {}) {
    this.cols = dimension(options.cols, 80, 500);
    this.rows = dimension(options.rows, 24, 300);
    // Also cap retained cells, so a very wide grid cannot multiply the memory ceiling.
    this.scrollbackLimit = dimension(options.scrollback, 10_000, 50_000, 0);
    this.history = new LineHistory(Math.min(this.scrollbackLimit, Math.floor(2_000_000 / this.cols)));
    this.primary = new Screen(this.cols, this.rows);
    this.alternate = new Screen(this.cols, this.rows);
    this.screen = this.primary;
    this.modes.newlineMode = options.convertEol ?? false;
    this.resetTabs();
  }

  get type(): "normal" | "alternate" { return this.screen === this.primary ? "normal" : "alternate"; }
  get cursorX(): number { return this.screen.x; }
  get cursorY(): number { return this.screen.y; }
  get pendingWrap(): boolean { return this.screen.pendingWrap; }
  get baseY(): number { return this.type === "normal" ? this.history.length : 0; }
  get length(): number { return this.baseY + this.rows; }
  getLine(row: number): TerminalLine | undefined {
    return row < this.baseY ? this.history.get(row) : this.screen.lines[row - this.baseY];
  }

  write(data: Uint8Array | string, timestamp = Date.now()): void {
    this.writeTimestamp = Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : Date.now();
    this.bytesReceived += typeof data === "string" ? data.length : data.byteLength;
    let text = this.highSurrogate + (typeof data === "string" ? data : this.decoder.decode(data));
    this.highSurrogate = "";
    const last = text.charCodeAt(text.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) {
      this.highSurrogate = text.slice(-1);
      text = text.slice(0, -1);
    }
    for (let index = 0; index < text.length;) {
      const code = text.charCodeAt(index);
      if (this.state === "ground" && code >= 32 && code < 127 && !this.charsets[this.charset] && !this.modes.insertMode) {
        index = this.printAscii(text, index);
      } else {
        const character = String.fromCodePoint(text.codePointAt(index)!);
        this.parse(character); index += character.length;
      }
    }
    this.revision++;
    this.changed.fire();
    this.activity.fire({ type: "write", data, timestamp: this.writeTimestamp });
  }

  reset(): void {
    this.history.clear();
    this.primary = new Screen(this.cols, this.rows);
    this.alternate = new Screen(this.cols, this.rows);
    this.screen = this.primary;
    this.modes = defaultModes();
    this.attributes = DEFAULT_ATTRIBUTES;
    this.cursorVisible = true;
    this.cursorStyle = "block";
    this.cursorBlink = true;
    this.title = "";
    this.directory = "";
    this.state = "ground";
    this.sequence = "";
    this.highSurrogate = "";
    this.decoder = new Utf8Decoder();
    this.oversized = false;
    this.charsets = [false, false];
    this.charset = 0;
    this.lastPrinted = undefined;
    this.repeated = "";
    this.markers.length = 0;
    this.unsupported.clear();
    this.resetTabs();
    this.revision++;
    this.changed.fire();
    this.activity.fire({ type: "reset" });
  }

  resize(cols: number, rows: number): void {
    cols = dimension(cols, this.cols, 500);
    rows = dimension(rows, this.rows, 300);
    if (cols === this.cols && rows === this.rows) return;
    const oldCols = this.cols;
    this.cols = cols;
    this.history.setCapacity(Math.min(this.scrollbackLimit, Math.floor(2_000_000 / cols)));
    if (cols !== oldCols) this.reflowPrimary(oldCols, rows);
    else this.resizeScreen(this.primary, rows, true);
    this.resizeScreen(this.alternate, rows, false);
    this.rows = rows;
    this.primary.top = this.alternate.top = 0;
    this.primary.bottom = this.alternate.bottom = rows - 1;
    this.lastPrinted = undefined;
    for (let col = Math.ceil(oldCols / 8) * 8; col < cols; col += 8) if (col > 0) this.tabs.add(col);
    this.revision++;
    this.changed.fire();
    this.activity.fire({ type: "resize", cols, rows });
  }

  /** Lossless, versioned model state, including incomplete decoding and VT sequences. */
  serialize(): TerminalState {
    const styles: Readonly<Attributes>[] = [];
    const indices = new Map<Readonly<Attributes>, number>();
    const line = (source: TerminalLine): LineState => {
      const runs: LineState["runs"] = [];
      for (const cell of source.cells) {
        let index = indices.get(cell.attributes);
        if (index === undefined) { index = styles.length; indices.set(cell.attributes, index); styles.push({ ...cell.attributes }); }
        const previous = runs[runs.length - 1];
        if (previous && previous[0] === cell.text && previous[1] === cell.width && previous[2] === index) previous[3]++;
        else runs.push([cell.text, cell.width, index, 1]);
      }
      return { id: source.id, wrapped: source.isWrapped, runs };
    };
    const screen = (source: Screen): ScreenState => ({
      lines: source.lines.map(line), x: source.x, y: source.y, pendingWrap: source.pendingWrap,
      top: source.top, bottom: source.bottom,
      ...(source.saved ? { saved: { ...source.saved, attributes: { ...source.saved.attributes } } } : {}),
    });
    return {
      version: 1, cols: this.cols, rows: this.rows, scrollback: this.scrollbackLimit,
      primary: screen(this.primary), alternate: screen(this.alternate), active: this.type,
      history: Array.from({ length: this.history.length }, (_, row) => line(this.history.get(row)!)),
      dropped: this.history.dropped, styles, modes: { ...this.modes }, attributes: { ...this.attributes },
      cursor: { visible: this.cursorVisible, style: this.cursorStyle, blink: this.cursorBlink },
      title: this.title, directory: this.directory, revision: this.revision, bytesReceived: this.bytesReceived,
      markers: this.markers.map(marker => ({ ...marker })), markerId: this.markerId, unsupported: [...this.unsupported],
      parser: {
        state: this.state, stringState: this.stringState, sequence: this.sequence, oversized: this.oversized,
        escapeIntermediate: this.escapeIntermediate, charsetTarget: this.charsetTarget, charsets: [...this.charsets],
        charset: this.charset, tabs: [...this.tabs], highSurrogate: this.highSurrogate, repeated: this.repeated,
        ...(this.lastPrinted ? { lastPrinted: { lineId: this.lastPrinted.line.id, column: this.lastPrinted.column } } : {}),
        utf8: { ...this.decoder.state },
      },
    };
  }

  /** Restore only validated data; no input, replies, titles or commands are sent. */
  restore(value: unknown): void {
    const state = validateState(value);
    const styles = state.styles.map(internAttributes);
    const lines = new Map<number, TerminalLine>();
    const line = (source: LineState): TerminalLine => {
      const result = new TerminalLine(state.cols, EMPTY_CELL, source.id);
      result.isWrapped = source.wrapped;
      let column = 0;
      for (const [text, width, attr, count] of source.runs) {
        const cell = createCell(text, width, styles[attr]);
        result.cells.fill(cell, column, column + count); column += count;
      }
      result.repairWideCells(); lines.set(result.id, result); return result;
    };
    const screen = (source: ScreenState): Screen => {
      const result = new Screen(state.cols, state.rows);
      Object.assign(result, source, { lines: source.lines.map(line) });
      return result;
    };
    this.cols = state.cols; this.rows = state.rows; this.scrollbackLimit = state.scrollback;
    this.history.clear(); this.history.setCapacity(Math.min(state.scrollback, Math.floor(2_000_000 / state.cols)));
    for (const row of state.history) this.history.push(line(row));
    this.history.dropped = state.dropped;
    this.primary = screen(state.primary); this.alternate = screen(state.alternate);
    this.screen = state.active === "normal" ? this.primary : this.alternate;
    this.modes = state.modes; this.attributes = internAttributes(state.attributes);
    this.cursorVisible = state.cursor.visible; this.cursorStyle = state.cursor.style; this.cursorBlink = state.cursor.blink;
    this.title = state.title; this.directory = state.directory; this.revision = state.revision; this.bytesReceived = state.bytesReceived;
    this.markers.splice(0, this.markers.length, ...state.markers); this.markerId = state.markerId;
    this.unsupported.clear(); for (const [key, value] of state.unsupported) this.unsupported.set(key, value);
    const parser = state.parser;
    this.state = parser.state; this.stringState = parser.stringState; this.sequence = parser.sequence; this.oversized = parser.oversized;
    this.escapeIntermediate = parser.escapeIntermediate; this.charsetTarget = parser.charsetTarget; this.charsets = parser.charsets;
    this.charset = parser.charset; this.tabs = new Set(parser.tabs); this.highSurrogate = parser.highSurrogate; this.repeated = parser.repeated;
    this.decoder = new Utf8Decoder(); this.decoder.state = parser.utf8;
    const printed = parser.lastPrinted && lines.get(parser.lastPrinted.lineId);
    this.lastPrinted = printed && parser.lastPrinted ? { line: printed, column: parser.lastPrinted.column } : undefined;
    this.changed.fire(); this.activity.fire({ type: "restore" });
  }

  private resizeScreen(screen: Screen, rows: number, primary: boolean): void {
    while (screen.lines.length > rows) {
      if (screen.y >= rows) {
        const removed = screen.lines.shift()!;
        if (primary) this.history.push(removed);
        screen.y--;
        if (screen.saved) screen.saved.y--;
      } else screen.lines.pop();
    }
    // Growing a normal screen brings retained lines back into view.
    while (screen.lines.length < rows && primary && this.history.length) {
      screen.lines.unshift(this.history.pop()!);
      screen.y++;
      if (screen.saved) screen.saved.y++;
    }
    while (screen.lines.length < rows) screen.lines.push(new TerminalLine(this.cols));
    for (const line of screen.lines) {
      if (line.length > this.cols) line.cells.length = this.cols;
      while (line.length < this.cols) line.cells.push(EMPTY_CELL);
      line.repairWideCells();
    }
    screen.x = Math.min(screen.x, this.cols - 1);
    screen.y = Math.min(screen.y, rows - 1);
    screen.pendingWrap = false;
    if (screen.saved) {
      screen.saved.x = Math.min(screen.saved.x, this.cols - 1);
      screen.saved.y = Math.max(0, Math.min(screen.saved.y, rows - 1));
      screen.saved.pendingWrap = false;
    }
  }

  /** Reflow only normal-buffer logical lines; full-screen applications keep a fixed grid. */
  private reflowPrimary(oldCols: number, rows: number): void {
    const original = Array.from({ length: this.history.length }, (_, index) => this.history.get(index)!);
    original.push(...this.primary.lines);
    const markersByLine = new Map<number, CommandMarker[]>();
    for (const marker of this.markers) {
      const markers = markersByLine.get(marker.lineId) ?? [];
      markers.push(marker); markersByLine.set(marker.lineId, markers);
    }
    const oldCursorRow = this.history.length + this.primary.y;
    const saved = this.primary.saved;
    const oldSavedRow = saved ? this.history.length + saved.y : -1;
    let last = original.length - 1;
    while (last > Math.max(oldCursorRow, oldSavedRow) && original[last].usedLength() === 0 && !original[last].isWrapped) last--;
    const result: TerminalLine[] = [];
    let line = new TerminalLine(this.cols);
    let x = 0;
    let cursorRow = 0;
    let cursorCol = 0;
    let savedRow = 0;
    let savedCol = 0;
    for (let row = 0; row <= last; row++) {
      const source = original[row];
      if (row > 0 && !source.isWrapped) { result.push(line); line = new TerminalLine(this.cols); x = 0; }
      const continues = row < last && original[row + 1].isWrapped;
      const cursorEnd = row === oldCursorRow ? this.primary.x + (this.primary.pendingWrap ? 1 : 0) : 0;
      const savedEnd = saved && row === oldSavedRow ? saved.x + (saved.pendingWrap ? 1 : 0) : 0;
      const rowMarkers = markersByLine.get(source.id) ?? [];
      const used = continues ? oldCols : Math.max(source.usedLength(), cursorEnd, savedEnd, ...rowMarkers.map(marker => marker.column));
      const moveMarkers = (column: number) => {
        for (const marker of rowMarkers) if (marker.column === column && marker.lineId === source.id) {
          marker.lineId = line.id; marker.column = x;
        }
      };
      for (let col = 0; col <= used; col++) {
        if (row === oldCursorRow && col === cursorEnd) { cursorRow = result.length; cursorCol = x; }
        if (row === oldSavedRow && col === savedEnd) { savedRow = result.length; savedCol = x; }
        if (col === used) { moveMarkers(col); break; }
        const cell = source.cells[col] ?? EMPTY_CELL;
        if (cell.width === 0) continue;
        if (x + cell.width > this.cols) {
          result.push(line);
          line = new TerminalLine(this.cols);
          line.isWrapped = true;
          x = 0;
          if (row === oldCursorRow && col === cursorEnd) { cursorRow = result.length; cursorCol = 0; }
          if (row === oldSavedRow && col === savedEnd) { savedRow = result.length; savedCol = 0; }
        }
        moveMarkers(col);
        if (cell.width > this.cols) continue;
        line.cells[x] = cell;
        if (cell.width === 2) line.cells[x + 1] = createCell("", 0, cell.attributes);
        x += cell.width;
      }
    }
    result.push(line);
    this.history.clear();
    const start = Math.min(cursorRow, Math.max(0, result.length - rows));
    for (let index = 0; index < start; index++) this.history.push(result[index]);
    this.primary.lines = result.slice(start, start + rows);
    while (this.primary.lines.length < rows) this.primary.lines.push(new TerminalLine(this.cols));
    this.primary.x = Math.min(cursorCol, this.cols - 1);
    this.primary.y = Math.min(rows - 1, cursorRow - start);
    this.primary.pendingWrap = cursorCol === this.cols;
    if (saved) {
      saved.x = Math.min(savedCol, this.cols - 1);
      saved.y = Math.max(0, Math.min(rows - 1, savedRow - start));
      saved.pendingWrap = savedCol === this.cols;
    }
    const retained = new Set([...this.primary.lines.map(line => line.id), ...Array.from({ length: this.history.length }, (_, row) => this.history.get(row)!.id)]);
    for (let index = this.markers.length - 1; index >= 0; index--) if (!retained.has(this.markers[index].lineId)) this.markers.splice(index, 1);
  }

  private parse(character: string): void {
    const code = character.codePointAt(0)!;
    if (character === "\x18" || character === "\x1a") {
      this.state = "ground"; this.sequence = ""; this.oversized = false; return;
    }
    if (this.state === "string-escape") {
      if (character === "\\") { this.finishString(); return; }
      // ESC begins a new escape sequence if it did not form ST.
      this.state = "escape";
      this.sequence = "";
      this.oversized = false;
      this.parse(character);
      return;
    }
    if (this.state === "osc" || this.state === "dcs" || this.state === "ignore") {
      if (character === ESC) { this.stringState = this.state; this.state = "string-escape"; return; }
      if (character === "\x07" && this.state === "osc") { this.stringState = this.state; this.finishString(); return; }
      if (code < 0x20) return;
      if (this.sequence.length + character.length > MAX_CONTROL_LENGTH) { this.oversized = true; this.sequence = ""; }
      if (!this.oversized && this.state !== "ignore") this.sequence += character;
      return;
    }
    if (character === ESC) { this.state = "escape"; this.sequence = ""; this.lastPrinted = undefined; return; }
    if (code < 0x20 || code === 0x7f) { this.control(character); return; }
    if (this.state === "ground") { this.print(character); return; }
    if (this.state === "charset") {
      this.charsets[this.charsetTarget] = character === "0";
      this.state = "ground";
      return;
    }
    if (this.state === "escape-intermediate") {
      if (this.escapeIntermediate === "#" && character === "8") {
        for (const line of this.screen.lines) { line.cells.fill(createCell("E", 1)); line.version++; }
      }
      this.state = "ground";
      return;
    }
    if (this.state === "escape") { this.escape(character); return; }
    if (this.state === "csi") {
      if (code >= 0x40 && code <= 0x7e) {
        if (!this.oversized) this.csi(character, this.sequence);
        else this.unsupportedSequence("oversized CSI");
        this.state = "ground"; this.sequence = ""; this.oversized = false;
      } else if (code >= 0x20 && code <= 0x3f) {
        if (this.sequence.length < MAX_CSI_LENGTH && !this.oversized) this.sequence += character;
        else { this.oversized = true; this.sequence = ""; }
      } else { this.state = "ground"; this.sequence = ""; this.oversized = false; }
    }
  }

  private control(character: string): void {
    this.lastPrinted = undefined;
    switch (character) {
      case "\x07": this.bell.fire(); break;
      case "\b": this.screen.x = Math.max(0, this.screen.x - 1); this.screen.pendingWrap = false; break;
      case "\t": this.tab(1); break;
      case "\n": case "\v": case "\f":
        if (this.modes.newlineMode) this.screen.x = 0;
        this.lineFeed(); break;
      case "\r": this.screen.x = 0; this.screen.pendingWrap = false; break;
      case "\x0e": this.charset = 1; break;
      case "\x0f": this.charset = 0; break;
    }
  }

  private escape(character: string): void {
    this.state = "ground";
    this.oversized = false;
    switch (character) {
      case "[": this.state = "csi"; return;
      case "]": this.state = "osc"; return;
      case "P": this.state = "dcs"; return;
      case "_": case "^": case "X": this.state = "ignore"; return;
      case "(": case ")": this.charsetTarget = character === "(" ? 0 : 1; this.state = "charset"; return;
      case "*": case "+": case "%": case "#": case " ":
        this.escapeIntermediate = character; this.state = "escape-intermediate"; return;
      case "7": this.saveCursor(); return;
      case "8": this.restoreCursor(); return;
      case "D": this.lineFeed(); return;
      case "E": this.screen.x = 0; this.lineFeed(); return;
      case "M":
        if (this.screen.y === this.screen.top) this.scrollDown(1);
        else this.screen.y = Math.max(0, this.screen.y - 1);
        this.screen.pendingWrap = false;
        return;
      case "H": this.tabs.add(this.screen.x); return;
      case "c": this.reset(); return;
      case "=": this.modes.applicationKeypadMode = true; return;
      case ">": this.modes.applicationKeypadMode = false; return;
      case "Z": this.reply.fire(`${ESC}[?1;2c`); return;
      case "\\": return;
      default: this.unsupportedSequence(`ESC ${character}`);
    }
  }

  /** Plain text runs share cells and update each affected row only once. */
  private printAscii(text: string, start: number): number {
    if (this.screen.pendingWrap && this.modes.wraparoundMode) { this.screen.x = 0; this.lineFeed(true); }
    this.screen.pendingWrap = false;
    const line = this.screen.lines[this.screen.y];
    const cells = asciiCells(this.attributes);
    let index = start; let column = this.screen.x;
    const end = Math.min(text.length, start + this.cols - column);
    while (index < end) {
      const code = text.charCodeAt(index);
      if (code < 32 || code >= 127) break;
      if (line.cells[column].width !== 1) line.erase(column, column + 1, this.blank());
      line.cells[column++] = cells[code] ?? createCell(String.fromCharCode(code), 1, this.attributes); index++;
    }
    line.version++;
    if (this.lastPrinted) { this.lastPrinted.line = line; this.lastPrinted.column = column - 1; }
    else this.lastPrinted = { line, column: column - 1 };
    this.repeated = text[index - 1];
    if (column === this.cols) { this.screen.x = this.cols - 1; this.screen.pendingWrap = true; }
    else this.screen.x = column;
    return index;
  }

  private print(input: string): void {
    const previous = this.lastPrinted;
    if (previous && joinsCell(previous.line.cells[previous.column].text, input)) {
      const old = previous.line.cells[previous.column];
      // Bound pathological combining sequences independently of the scrollback bound.
      if (old.text.length >= 128) return;
      const combined = old.text + input;
      const width = Math.max(old.width, cellWidth(combined)) as 1 | 2;
      if (width > old.width && previous.column + width <= this.cols) {
        previous.line.erase(previous.column + 1, previous.column + 2, this.blank());
        previous.line.cells[previous.column + 1] = createCell("", 0, old.attributes);
        if (!this.screen.pendingWrap) this.screen.x++;
        if (this.screen.x >= this.cols) { this.screen.x = this.cols - 1; this.screen.pendingWrap = true; }
      }
      previous.line.cells[previous.column] = createCell(combined, previous.column + width <= this.cols ? width : old.width, old.attributes);
      previous.line.version++;
      this.repeated = combined;
      return;
    }
    let character = this.charsets[this.charset] ? DEC_GRAPHICS[input] ?? input : input;
    let width = cellWidth(character);
    if (!width) return;
    if (width > this.cols) { character = "�"; width = 1; }
    if (this.modes.wraparoundMode && (this.screen.pendingWrap || this.screen.x + width > this.cols)) {
      this.screen.x = 0;
      this.lineFeed(true);
    }
    this.screen.pendingWrap = false;
    if (this.screen.x + width > this.cols) return;
    const line = this.screen.lines[this.screen.y];
    const column = this.screen.x;
    if (this.modes.insertMode) {
      line.cells.splice(column, 0, ...Array(width).fill(this.blank()));
      line.cells.length = this.cols;
      line.repairWideCells(this.blank());
    }
    if (width !== 1 || line.cells[column].width !== 1) line.erase(column, column + width, this.blank());
    line.cells[column] = createCell(character, width, this.attributes);
    if (width === 2) line.cells[column + 1] = createCell("", 0, this.attributes);
    line.version++;
    if (previous) { previous.line = line; previous.column = column; }
    else this.lastPrinted = { line, column };
    this.repeated = character;
    if (column + width >= this.cols) { this.screen.x = this.cols - 1; this.screen.pendingWrap = true; }
    else this.screen.x += width;
  }

  private lineFeed(wrapped = false): void {
    if (this.screen.y === this.screen.bottom) this.scrollUp(1);
    else if (this.screen.y < this.rows - 1) this.screen.y++;
    if (wrapped) this.screen.lines[this.screen.y].isWrapped = true;
    this.screen.pendingWrap = false;
  }

  private scrollUp(count: number): void {
    count = Math.min(count, this.screen.bottom - this.screen.top + 1);
    for (let index = 0; index < count; index++) {
      const removed = this.screen.lines.splice(this.screen.top, 1)[0];
      if (this.type === "normal" && this.screen.top === 0 && this.screen.bottom === this.rows - 1) this.history.push(removed);
      this.screen.lines.splice(this.screen.bottom, 0, new TerminalLine(this.cols, this.blank()));
    }
  }

  private scrollDown(count: number): void {
    count = Math.min(count, this.screen.bottom - this.screen.top + 1);
    for (let index = 0; index < count; index++) {
      this.screen.lines.splice(this.screen.bottom, 1);
      this.screen.lines.splice(this.screen.top, 0, new TerminalLine(this.cols, this.blank()));
    }
  }

  private csi(final: string, sequence: string): void {
    const match = sequence.match(/^([?<=>]?)([0-9;:]*)([ -/]*)$/u);
    if (!match) { this.unsupportedSequence("malformed CSI"); return; }
    const [, prefix, raw, intermediate] = match;
    const parameters = raw.split(";").map((value) => Math.min(65535, Number.parseInt(value, 10) || 0));
    const amount = Math.min(parameters[0] || 1, 65535);
    const screen = this.screen;
    const move = (x: number, y: number): void => {
      screen.x = Math.max(0, Math.min(this.cols - 1, x));
      screen.y = Math.max(this.modes.originMode ? screen.top : 0, Math.min(this.modes.originMode ? screen.bottom : this.rows - 1, y));
      screen.pendingWrap = false;
    };
    if (intermediate === "$" && final === "p") {
      for (const mode of parameters) {
        const value = this.modeValue(mode, prefix === "?");
        this.reply.fire(`${ESC}[${prefix}${mode};${value === undefined ? 0 : value ? 1 : 2}$y`);
      }
      return;
    }
    if (intermediate === " " && final === "q") {
      const style = parameters[0];
      if (style <= 6) {
        this.cursorStyle = style < 3 ? "block" : style < 5 ? "underline" : "bar";
        this.cursorBlink = style === 0 || style % 2 === 1;
      }
      return;
    }
    if (intermediate === "!" && final === "p") {
      this.attributes = DEFAULT_ATTRIBUTES;
      this.modes = defaultModes();
      screen.top = 0; screen.bottom = this.rows - 1; screen.pendingWrap = false;
      this.cursorVisible = true;
      return;
    }
    if (intermediate || (prefix && !["h", "l", "n", "c", "J", "K"].includes(final))) {
      this.unsupportedSequence(`CSI ${prefix}${intermediate}${final}`); return;
    }
    switch (final) {
      case "A": move(screen.x, Math.max(screen.y >= screen.top ? screen.top : 0, screen.y - amount)); break;
      case "B": case "e": move(screen.x, Math.min(screen.y <= screen.bottom ? screen.bottom : this.rows - 1, screen.y + amount)); break;
      case "C": case "a": move(screen.x + amount, screen.y); break;
      case "D": move(screen.x - amount, screen.y); break;
      case "E": move(0, screen.y + amount); break;
      case "F": move(0, screen.y - amount); break;
      case "G": case "`": move(amount - 1, screen.y); break;
      case "d": move(screen.x, amount - 1 + (this.modes.originMode ? screen.top : 0)); break;
      case "H": case "f": move((parameters[1] || 1) - 1, amount - 1 + (this.modes.originMode ? screen.top : 0)); break;
      case "I": this.tab(amount); break;
      case "Z": this.tab(-amount); break;
      case "J": this.eraseDisplay(parameters[0]); break;
      case "K": this.eraseLine(parameters[0]); break;
      case "m": this.sgr(raw); break;
      case "@": {
        const line = screen.lines[screen.y];
        line.cells.splice(screen.x, 0, ...Array(Math.min(amount, this.cols - screen.x)).fill(this.blank()));
        line.cells.length = this.cols;
        line.repairWideCells(this.blank()); screen.pendingWrap = false; break;
      }
      case "P": {
        const line = screen.lines[screen.y];
        line.cells.splice(screen.x, Math.min(amount, this.cols - screen.x));
        while (line.length < this.cols) line.cells.push(this.blank());
        line.repairWideCells(this.blank()); screen.pendingWrap = false; break;
      }
      case "X": screen.lines[screen.y].erase(screen.x, screen.x + amount, this.blank()); screen.pendingWrap = false; break;
      case "L": case "M": {
        if (screen.y < screen.top || screen.y > screen.bottom) break;
        const count = Math.min(amount, screen.bottom - screen.y + 1);
        for (let index = 0; index < count; index++) {
          screen.lines.splice(final === "L" ? screen.bottom : screen.y, 1);
          screen.lines.splice(final === "L" ? screen.y : screen.bottom, 0, new TerminalLine(this.cols, this.blank()));
        }
        screen.x = 0; screen.pendingWrap = false; break;
      }
      case "S": this.scrollUp(amount); break;
      case "T": if (parameters.length === 1) this.scrollDown(amount); break;
      case "b": for (let index = 0; index < Math.min(amount, this.cols * this.rows); index++) if (this.repeated) this.print(this.repeated); break;
      case "r": {
        const top = (parameters[0] || 1) - 1;
        const bottom = (parameters[1] || this.rows) - 1;
        if (top < bottom && bottom < this.rows) { screen.top = top; screen.bottom = bottom; move(0, this.modes.originMode ? top : 0); }
        break;
      }
      case "s": this.saveCursor(); break;
      case "u": this.restoreCursor(); break;
      case "g": if (parameters[0] === 3) this.tabs.clear(); else if (parameters[0] === 0) this.tabs.delete(screen.x); break;
      case "h": case "l": for (const mode of parameters) this.setMode(mode, final === "h", prefix === "?"); break;
      case "n":
        if (parameters[0] === 5 && !prefix) this.reply.fire(`${ESC}[0n`);
        if (parameters[0] === 6) this.reply.fire(`${ESC}[${prefix === "?" ? "?" : ""}${screen.y + 1 - (this.modes.originMode ? screen.top : 0)};${screen.x + 1}R`);
        break;
      case "c":
        if (parameters[0] === 0) this.reply.fire(prefix === ">" ? `${ESC}[>0;1;0c` : `${ESC}[?1;2c`);
        break;
      case "t":
        if (parameters[0] === 18) this.reply.fire(`${ESC}[8;${this.rows};${this.cols}t`);
        // Output is never allowed to resize the browser or the shared PTY.
        break;
      default: this.unsupportedSequence(`CSI ${prefix}${final}`);
    }
  }

  private eraseLine(mode: number): void {
    const screen = this.screen;
    if (mode < 0 || mode > 2) return;
    screen.lines[screen.y].erase(mode === 0 ? screen.x : 0, mode === 1 ? screen.x + 1 : this.cols, this.blank());
    screen.pendingWrap = false;
  }

  private eraseDisplay(mode: number): void {
    const screen = this.screen;
    if (mode === 3) { if (this.type === "normal") this.history.clear(); this.markers.length = 0; return; }
    if (mode < 0 || mode > 2) return;
    const first = mode === 0 ? screen.y : 0;
    const last = mode === 1 ? screen.y : this.rows - 1;
    for (let row = first; row <= last; row++) {
      screen.lines[row].erase(row === screen.y && mode === 0 ? screen.x : 0,
        row === screen.y && mode === 1 ? screen.x + 1 : this.cols, this.blank());
      if (mode === 2 || row !== screen.y) screen.lines[row].isWrapped = false;
    }
    screen.pendingWrap = false;
  }

  private sgr(raw: string): void {
    const groups = (raw || "0").split(";");
    let attributes = { ...this.attributes };
    for (let index = 0; index < groups.length; index++) {
      const sub = groups[index].split(":");
      const value = Number(sub[0]) || 0;
      switch (value) {
        case 0: attributes = { ...DEFAULT_ATTRIBUTES, link: attributes.link }; break;
        case 1: attributes.bold = true; break;
        case 2: attributes.dim = true; break;
        case 3: attributes.italic = true; break;
        case 4: attributes.underline = sub.length > 1 ? Math.min(5, Number(sub[1]) || 0) : 1; break;
        case 7: attributes.inverse = true; break;
        case 8: attributes.hidden = true; break;
        case 9: attributes.strike = true; break;
        case 21: attributes.underline = 2; break;
        case 22: attributes.bold = attributes.dim = false; break;
        case 23: attributes.italic = false; break;
        case 24: attributes.underline = 0; break;
        case 27: attributes.inverse = false; break;
        case 28: attributes.hidden = false; break;
        case 29: attributes.strike = false; break;
        case 39: attributes.fg = null; break;
        case 49: attributes.bg = null; break;
        case 38: case 48: case 58: {
          const colon = sub.length > 1;
          const values = colon ? sub.slice(1) : groups.slice(index + 1);
          const mode = Number(values[0]);
          let color: string | number | undefined;
          if (mode === 5 && values[1] !== undefined && validByte(values[1])) color = Number(values[1]);
          if (mode === 2) {
            const rgb = colon && values.length >= 5 ? values.slice(2, 5) : values.slice(1, 4);
            if (rgb.length === 3 && rgb.every(validByte)) color = `#${rgb.map((part) => Number(part).toString(16).padStart(2, "0")).join("")}`;
          }
          if (color !== undefined && value !== 58) attributes[value === 38 ? "fg" : "bg"] = color;
          if (!colon) index += mode === 2 ? Math.min(4, values.length) : mode === 5 ? Math.min(2, values.length) : 0;
          break;
        }
        case 5: case 6: case 25: case 59: break; // blink and underline colors are not rendered yet
        default:
          if (value >= 30 && value <= 37) attributes.fg = value - 30;
          else if (value >= 40 && value <= 47) attributes.bg = value - 40;
          else if (value >= 90 && value <= 97) attributes.fg = value - 90 + 8;
          else if (value >= 100 && value <= 107) attributes.bg = value - 100 + 8;
      }
    }
    this.attributes = internAttributes(attributes);
  }

  private setMode(mode: number, enabled: boolean, dec: boolean): void {
    if (!dec) {
      if (mode === 4) this.modes.insertMode = enabled;
      else if (mode === 20) this.modes.newlineMode = enabled;
      else this.unsupportedSequence(`mode ${mode}`);
      return;
    }
    switch (mode) {
      case 1: this.modes.applicationCursorKeysMode = enabled; break;
      case 5: this.modes.reverseVideo = enabled; break;
      case 6: this.modes.originMode = enabled; this.screen.x = 0; this.screen.y = enabled ? this.screen.top : 0; this.screen.pendingWrap = false; break;
      case 7: this.modes.wraparoundMode = enabled; break;
      case 12: this.cursorBlink = enabled; break;
      case 25: this.cursorVisible = enabled; break;
      case 47: case 1047: case 1049:
        if (enabled && this.type === "normal") {
          if (mode === 1049) this.saveCursor();
          if (mode !== 47) this.alternate = new Screen(this.cols, this.rows);
          this.screen = this.alternate;
        } else if (!enabled && this.type === "alternate") {
          this.screen = this.primary;
          if (mode === 1049) this.restoreCursor();
        }
        break;
      case 1048: if (enabled) this.saveCursor(); else this.restoreCursor(); break;
      case 9: case 1000: case 1002: case 1003:
        this.modes.mouseTrackingMode = enabled ? ({ 9: "x10", 1000: "vt200", 1002: "drag", 1003: "any" } as const)[mode] : "none";
        break;
      case 1004: this.modes.sendFocusMode = enabled; break;
      case 1006: this.modes.sgrMouse = enabled; break;
      case 2004: this.modes.bracketedPasteMode = enabled; break;
      case 2026: this.modes.synchronizedOutputMode = enabled; break;
      default: this.unsupportedSequence(`DEC ${mode}`);
    }
  }

  private modeValue(mode: number, dec: boolean): boolean | undefined {
    if (!dec) return mode === 4 ? this.modes.insertMode : mode === 20 ? this.modes.newlineMode : undefined;
    switch (mode) {
      case 1: return this.modes.applicationCursorKeysMode;
      case 5: return this.modes.reverseVideo;
      case 6: return this.modes.originMode;
      case 7: return this.modes.wraparoundMode;
      case 12: return this.cursorBlink;
      case 25: return this.cursorVisible;
      case 47: case 1047: case 1049: return this.type === "alternate";
      case 9: return this.modes.mouseTrackingMode === "x10";
      case 1000: return this.modes.mouseTrackingMode === "vt200";
      case 1002: return this.modes.mouseTrackingMode === "drag";
      case 1003: return this.modes.mouseTrackingMode === "any";
      case 1004: return this.modes.sendFocusMode;
      case 1006: return this.modes.sgrMouse;
      case 2004: return this.modes.bracketedPasteMode;
      case 2026: return this.modes.synchronizedOutputMode;
      default: return undefined;
    }
  }

  private finishString(): void {
    const kind = this.state === "string-escape" ? this.stringState : this.state;
    const sequence = this.sequence;
    this.state = "ground"; this.sequence = "";
    if (this.oversized) { this.oversized = false; this.unsupportedSequence("oversized control string"); return; }
    if (kind === "osc") this.osc(sequence);
    if (kind === "dcs") {
      if (sequence.startsWith("$q")) {
        const query = sequence.slice(2);
        const answer = query === "m" ? "0m" : query === "r" ? `${this.screen.top + 1};${this.screen.bottom + 1}r` : undefined;
        this.reply.fire(`${ESC}P${answer ? "1" : "0"}$r${answer ?? ""}${ESC}\\`);
      } else this.unsupportedSequence("DCS");
    }
  }

  private osc(sequence: string): void {
    const separator = sequence.indexOf(";");
    const opcode = sequence.slice(0, separator);
    const value = sequence.slice(separator + 1);
    if (separator < 0) return;
    if (opcode === "0" || opcode === "2") {
      this.title = value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "").slice(0, 256);
      this.titleChanged.fire(this.title);
    } else if (opcode === "8") {
      const split = value.indexOf(";");
      this.attributes = internAttributes({ ...this.attributes, link: split < 0 ? undefined : safeHyperlink(value.slice(split + 1)) });
    } else if (opcode === "7") {
      try { const url = new URL(value); if (url.protocol === "file:") this.directory = decodeURIComponent(url.pathname).slice(0, 1024); } catch { /* metadata only */ }
    } else if (opcode === "133") {
      const [code, status] = value.split(";");
      const kind = ({ A: "prompt", B: "command", C: "output", D: "finished" } as const)[code as "A" | "B" | "C" | "D"];
      if (!kind || this.type === "alternate") return;
      const marker: CommandMarker = { id: ++this.markerId, lineId: this.screen.lines[this.screen.y].id,
        column: this.screen.pendingWrap ? this.cols : this.screen.x, timestamp: this.writeTimestamp, kind };
      if (kind === "finished" && /^\d{1,3}$/u.test(status ?? "") && Number(status) <= 255) marker.exitCode = Number(status);
      this.markers.push(marker);
      if (this.markers.length > 1000) this.markers.splice(0, this.markers.length - 1000);
      this.command.fire(marker);
    } else if (opcode === "52") {
      // Untrusted process output must never read or overwrite the clipboard.
      this.unsupportedSequence("OSC 52 (blocked)");
    } else this.unsupportedSequence(`OSC ${/^\d{1,5}$/u.test(opcode) ? opcode : "unknown"}`);
  }

  private saveCursor(): void {
    this.screen.saved = {
      x: this.screen.x, y: this.screen.y, pendingWrap: this.screen.pendingWrap,
      attributes: this.attributes, origin: this.modes.originMode,
      g0: this.charsets[0], g1: this.charsets[1], charset: this.charset,
    };
  }
  private restoreCursor(): void {
    const saved = this.screen.saved;
    this.screen.x = Math.min(saved?.x ?? 0, this.cols - 1);
    this.screen.y = Math.min(saved?.y ?? 0, this.rows - 1);
    this.screen.pendingWrap = saved?.pendingWrap ?? false;
    this.attributes = saved?.attributes ?? DEFAULT_ATTRIBUTES;
    this.modes.originMode = saved?.origin ?? false;
    this.charsets = [saved?.g0 ?? false, saved?.g1 ?? false];
    this.charset = saved?.charset ?? 0;
  }
  private tab(count: number): void {
    const direction = count < 0 ? -1 : 1;
    for (let index = 0; index < Math.min(Math.abs(count), this.cols); index++) {
      let x = this.screen.x;
      do { x += direction; } while (x > 0 && x < this.cols - 1 && !this.tabs.has(x));
      this.screen.x = Math.max(0, Math.min(this.cols - 1, x));
    }
    this.screen.pendingWrap = false;
  }
  private resetTabs(): void { this.tabs.clear(); for (let col = 8; col < this.cols; col += 8) this.tabs.add(col); }
  private blank(): Cell {
    if (this.attributes.bg === null) return EMPTY_CELL;
    return createCell("", 1, internAttributes({ ...DEFAULT_ATTRIBUTES, bg: this.attributes.bg }));
  }
  private unsupportedSequence(name: string): void {
    if (this.unsupported.has(name) || this.unsupported.size < MAX_DIAGNOSTICS) this.unsupported.set(name, (this.unsupported.get(name) ?? 0) + 1);
  }
}

function validByte(value: string): boolean { return /^\d{1,3}$/u.test(value) && Number(value) <= 255; }
function dimension(value: number | undefined, fallback: number, maximum: number, minimum = 1): number {
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, Math.floor(value!))) : fallback;
}
