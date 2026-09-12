import type { ReadableCell, ReadableLine } from "./types.js";

export type TerminalColor = number | string | null;
export interface Attributes {
  fg: TerminalColor; bg: TerminalColor;
  bold: boolean; dim: boolean; italic: boolean; underline: number;
  inverse: boolean; hidden: boolean; strike: boolean; link?: string;
}
export const DEFAULT_ATTRIBUTES: Readonly<Attributes> = Object.freeze({
  fg: null, bg: null, bold: false, dim: false, italic: false,
  underline: 0, inverse: false, hidden: false, strike: false,
});

/** Cells and attributes are immutable, so blank cells and style runs can share storage. */
export class Cell implements ReadableCell {
  constructor(readonly text: string, readonly width: 0 | 1 | 2, readonly attributes = DEFAULT_ATTRIBUTES) {}
  getChars(): string { return this.text; }
  getWidth(): number { return this.width; }
}
export const EMPTY_CELL = new Cell("", 1);

const styles = new Map<string, Readonly<Attributes>>();
/** Repeated ANSI styles share storage; adversarial true-color output cannot grow this cache. */
export function internAttributes(attributes: Attributes): Readonly<Attributes> {
  if (attributes.fg === null && attributes.bg === null && !attributes.bold && !attributes.dim &&
      !attributes.italic && !attributes.underline && !attributes.inverse && !attributes.hidden &&
      !attributes.strike && !attributes.link) return DEFAULT_ATTRIBUTES;
  const key = JSON.stringify([attributes.fg, attributes.bg, attributes.bold, attributes.dim,
    attributes.italic, attributes.underline, attributes.inverse, attributes.hidden, attributes.strike, attributes.link]);
  const existing = styles.get(key);
  if (existing) return existing;
  const style = Object.freeze({ ...attributes });
  if (styles.size === 512) styles.delete(styles.keys().next().value!);
  styles.set(key, style);
  return style;
}

function makePool(attributes: Readonly<Attributes>): Array<Cell | undefined> {
  const cells: Array<Cell | undefined> = [];
  for (let code = 32; code < 127; code++) cells[code] = new Cell(String.fromCharCode(code), 1, attributes);
  return cells;
}
const plainCells = makePool(DEFAULT_ATTRIBUTES);
const styledCells = new Map<Readonly<Attributes>, Array<Cell | undefined>>();
export function asciiCells(attributes = DEFAULT_ATTRIBUTES): ReadonlyArray<Cell | undefined> {
  return cellPool(attributes);
}
function cellPool(attributes: Readonly<Attributes>): Array<Cell | undefined> {
  if (attributes === DEFAULT_ATTRIBUTES) return plainCells;
  const existing = styledCells.get(attributes);
  if (existing) return existing;
  // Most RGB styles occur briefly. Allocate only the characters actually used
  // instead of constructing 95 cells whenever a new color appears.
  const cells: Array<Cell | undefined> = [];
  if (styledCells.size === 128) styledCells.delete(styledCells.keys().next().value!);
  styledCells.set(attributes, cells);
  return cells;
}
/** A log's repeated ASCII characters need references, not millions of identical objects. */
export function createCell(text: string, width: 0 | 1 | 2, attributes = DEFAULT_ATTRIBUTES): Cell {
  const code = text.length === 0 ? width === 0 ? 128 : 129 : text.length === 1 && width === 1 ? text.charCodeAt(0) : -1;
  if (code < 0 || code > 129 || (text.length !== 0 && code >= 127)) return new Cell(text, width, attributes);
  if (text === "" && width === 1 && attributes === DEFAULT_ATTRIBUTES) return EMPTY_CELL;
  const cells = cellPool(attributes);
  return cells[code] ?? (cells[code] = new Cell(text, width, attributes));
}

let nextLineId = 1;
export class TerminalLine implements ReadableLine {
  readonly id: number;
  version = 0;
  isWrapped = false;
  cells: Cell[];
  constructor(cols: number, cell = EMPTY_CELL, id = nextLineId++) {
    this.id = id; nextLineId = Math.max(nextLineId, id + 1);
    this.cells = Array(cols).fill(cell);
  }
  get length(): number { return this.cells.length; }
  getCell(column: number): Cell | undefined { return this.cells[column]; }
  translateToString(trimRight = false, start = 0, end = this.length): string {
    let text = "";
    if (trimRight) end = Math.min(end, this.usedLength());
    for (let index = Math.max(0, start); index < Math.min(end, this.length); index++) {
      if (this.cells[index].width !== 0) text += this.cells[index].text || " ";
    }
    return text;
  }
  /** Editing either half of a wide character erases the whole character. */
  erase(start: number, end: number, blank = EMPTY_CELL): void {
    start = Math.max(0, start);
    end = Math.min(this.length, end);
    if (this.cells[start]?.width === 0) start--;
    if (this.cells[end - 1]?.width === 2) end++;
    this.cells.fill(blank, Math.max(0, start), Math.min(this.length, end));
    this.version++;
  }
  repairWideCells(blank = EMPTY_CELL): void {
    for (let index = 0; index < this.length; index++) {
      const cell = this.cells[index];
      if ((cell.width === 2 && this.cells[index + 1]?.width !== 0) ||
          (cell.width === 0 && this.cells[index - 1]?.width !== 2)) this.cells[index] = blank;
    }
    this.version++;
  }
  usedLength(): number {
    for (let index = this.length - 1; index >= 0; index--) {
      const cell = this.cells[index];
      if (cell.text !== "" || cell.width === 0) return index + 1;
    }
    return 0;
  }
}

/** O(1) retention when a verbose process has filled scrollback. */
export class LineHistory {
  private lines: Array<TerminalLine | undefined>;
  private head = 0;
  length = 0;
  dropped = 0;
  constructor(private limit: number) { this.lines = Array(limit); }
  get capacity(): number { return this.limit; }
  setCapacity(capacity: number): void {
    if (capacity === this.limit) return;
    const retained = Math.min(this.length, capacity);
    const removed = this.length - retained;
    const lines: Array<TerminalLine | undefined> = Array(capacity);
    for (let index = 0; index < retained; index++) lines[index] = this.get(removed + index);
    this.lines = lines;
    this.limit = capacity;
    this.head = 0;
    this.length = retained;
    this.dropped += removed;
  }
  get(index: number): TerminalLine | undefined {
    return index >= 0 && index < this.length ? this.lines[(this.head + index) % this.capacity] : undefined;
  }
  push(line: TerminalLine): void {
    if (!this.capacity) { this.dropped++; return; }
    if (this.length === this.capacity) {
      this.lines[this.head] = line;
      this.head = (this.head + 1) % this.capacity;
      this.dropped++;
    } else {
      this.lines[(this.head + this.length++) % this.capacity] = line;
    }
  }
  pop(): TerminalLine | undefined {
    if (!this.length) return undefined;
    const index = (this.head + --this.length) % this.capacity;
    const line = this.lines[index];
    this.lines[index] = undefined;
    return line;
  }
  clear(): void { this.lines.fill(undefined); this.head = 0; this.length = 0; this.dropped = 0; }
}
