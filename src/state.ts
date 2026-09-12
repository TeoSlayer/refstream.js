import type { Attributes } from "./buffer.js";
import type { CommandMarker, TerminalModes } from "./core.js";
import type { Utf8State } from "./utf8.js";
import { safeHyperlink } from "./unicode.js";

export type ParserState = "ground" | "escape" | "csi" | "osc" | "dcs" | "ignore" | "string-escape" | "charset" | "escape-intermediate";
export interface SavedCursorState {
  x: number; y: number; pendingWrap: boolean; attributes: Readonly<Attributes>;
  origin: boolean; g0: boolean; g1: boolean; charset: number;
}
export interface LineState {
  id: number; wrapped: boolean;
  /** Text, width, attribute-table index, repeated cells. */
  runs: [string, 0 | 1 | 2, number, number][];
}
export interface ScreenState {
  lines: LineState[]; x: number; y: number; pendingWrap: boolean;
  top: number; bottom: number; saved?: SavedCursorState;
}
export interface TerminalState {
  version: 1;
  cols: number; rows: number; scrollback: number;
  primary: ScreenState; alternate: ScreenState; active: "normal" | "alternate";
  history: LineState[]; dropped: number; styles: Readonly<Attributes>[];
  modes: TerminalModes; attributes: Readonly<Attributes>;
  cursor: { visible: boolean; style: "block" | "underline" | "bar"; blink: boolean };
  title: string; directory: string; revision: number; bytesReceived: number;
  markers: CommandMarker[]; markerId: number; unsupported: [string, number][];
  parser: {
    state: ParserState; stringState: ParserState; sequence: string; oversized: boolean;
    escapeIntermediate: string; charsetTarget: number; charsets: boolean[]; charset: number;
    tabs: number[]; highSurrogate: string; repeated: string;
    lastPrinted?: { lineId: number; column: number }; utf8: Utf8State;
  };
}

/** Validate bounds and all data used for allocation, indexing, styling or URLs. */
export function validateState(value: unknown): TerminalState {
  const fail = (): never => { throw new TypeError("Invalid or oversized terminal state"); };
  const encoded = JSON.stringify(value);
  if (!encoded || encoded.length > 32 * 1024 * 1024) fail();
  // Own the state; neither caller mutations nor prototypes can affect restoration.
  const state = JSON.parse(encoded) as TerminalState;
  const integer = (n: unknown, min: number, max: number) => { if (!Number.isSafeInteger(n) || (n as number) < min || (n as number) > max) fail(); };
  const string = (s: unknown, max: number) => { if (typeof s !== "string" || s.length > max) fail(); };
  const boolean = (b: unknown) => { if (typeof b !== "boolean") fail(); };
  const array = (a: unknown, max: number) => { if (!Array.isArray(a) || a.length > max) fail(); };
  const attributes = (attr: Attributes) => {
    if (!attr) fail();
    for (const color of [attr.fg, attr.bg]) {
      if (color !== null && !(Number.isInteger(color) && Number(color) >= 0 && Number(color) < 256) && !(typeof color === "string" && /^#[\da-f]{6}$/iu.test(color))) fail();
    }
    for (const key of ["bold", "dim", "italic", "inverse", "hidden", "strike"] as const) boolean(attr[key]);
    integer(attr.underline, 0, 5);
    if (attr.link !== undefined && (typeof attr.link !== "string" || safeHyperlink(attr.link) !== attr.link)) fail();
  };
  if (!state || state.version !== 1 || !["normal", "alternate"].includes(state.active)) fail();
  integer(state.cols, 1, 500); integer(state.rows, 1, 300); integer(state.scrollback, 0, 50_000);
  array(state.styles, 2_300_000); state.styles.forEach(attributes); attributes(state.attributes);
  const ids = new Set<number>();
  const line = (line: LineState) => {
    integer(line.id, 1, Number.MAX_SAFE_INTEGER - 1); boolean(line.wrapped);
    if (ids.has(line.id)) fail(); ids.add(line.id);
    array(line.runs, state.cols);
    let length = 0;
    for (const run of line.runs) {
      if (!Array.isArray(run) || run.length !== 4) fail();
      string(run[0], 256); integer(run[1], 0, 2); integer(run[2], 0, state.styles.length - 1); integer(run[3], 1, state.cols);
      length += run[3];
    }
    if (length !== state.cols) fail();
  };
  const screen = (screen: ScreenState) => {
    if (!screen) fail();
    array(screen.lines, state.rows); if (screen.lines.length !== state.rows) fail(); screen.lines.forEach(line);
    integer(screen.x, 0, state.cols - 1); integer(screen.y, 0, state.rows - 1); boolean(screen.pendingWrap);
    integer(screen.top, 0, state.rows - 1); integer(screen.bottom, screen.top, state.rows - 1);
    if (screen.saved) {
      const saved = screen.saved;
      integer(saved.x, 0, state.cols); integer(saved.y, 0, state.rows - 1); attributes(saved.attributes);
      for (const key of ["pendingWrap", "origin", "g0", "g1"] as const) boolean(saved[key]);
      integer(saved.charset, 0, 1);
    }
  };
  array(state.history, Math.min(state.scrollback, Math.floor(2_000_000 / state.cols)));
  state.history.forEach(line); screen(state.primary); screen(state.alternate);
  integer(state.dropped, 0, Number.MAX_SAFE_INTEGER); integer(state.revision, 0, Number.MAX_SAFE_INTEGER);
  integer(state.bytesReceived, 0, Number.MAX_SAFE_INTEGER); integer(state.markerId, 0, Number.MAX_SAFE_INTEGER);
  string(state.title, 256); string(state.directory, 4096);
  for (const key of ["applicationCursorKeysMode", "applicationKeypadMode", "bracketedPasteMode", "sgrMouse", "sendFocusMode", "synchronizedOutputMode", "insertMode", "originMode", "wraparoundMode", "reverseVideo", "newlineMode"] as const) boolean(state.modes?.[key]);
  if (!["none", "x10", "vt200", "drag", "any"].includes(state.modes.mouseTrackingMode)) fail();
  boolean(state.cursor?.visible); boolean(state.cursor?.blink);
  if (!["block", "underline", "bar"].includes(state.cursor.style)) fail();
  array(state.markers, 1000);
  for (const marker of state.markers) {
    integer(marker.id, 1, Number.MAX_SAFE_INTEGER); integer(marker.lineId, 1, Number.MAX_SAFE_INTEGER);
    integer(marker.column, 0, state.cols); integer(marker.timestamp, 0, Number.MAX_SAFE_INTEGER);
    if (!["prompt", "command", "output", "finished"].includes(marker.kind)) fail();
    if (marker.exitCode !== undefined) integer(marker.exitCode, 0, 255);
  }
  array(state.unsupported, 32);
  for (const entry of state.unsupported) { array(entry, 2); string(entry[0], 256); integer(entry[1], 0, Number.MAX_SAFE_INTEGER); }
  const parser = state.parser;
  if (!parser) fail();
  const states = ["ground", "escape", "csi", "osc", "dcs", "ignore", "string-escape", "charset", "escape-intermediate"];
  if (!states.includes(parser.state) || !states.includes(parser.stringState)) fail();
  string(parser.sequence, 4096); string(parser.escapeIntermediate, 8); string(parser.highSurrogate, 1); string(parser.repeated, 256);
  if (parser.highSurrogate && !/^[\ud800-\udbff]$/u.test(parser.highSurrogate)) fail();
  boolean(parser.oversized); integer(parser.charset, 0, 1); integer(parser.charsetTarget, 0, 1);
  array(parser.charsets, 2); if (parser.charsets.length !== 2) fail(); parser.charsets.forEach(boolean);
  array(parser.tabs, 500); parser.tabs.forEach(tab => integer(tab, 0, 499));
  if (parser.lastPrinted) { integer(parser.lastPrinted.lineId, 1, Number.MAX_SAFE_INTEGER); integer(parser.lastPrinted.column, 0, state.cols - 1); }
  const utf8 = parser.utf8;
  if (!utf8) fail();
  integer(utf8.point, 0, 0x10ffff); integer(utf8.needed, 0, 3); integer(utf8.seen, 0, Math.max(0, utf8.needed - 1));
  if (utf8.needed) integer(utf8.point, 0, Math.min((1 << (6 - utf8.needed + 6 * utf8.seen)) - 1, 0x10ffff >> (6 * (utf8.needed - utf8.seen))));
  else if (utf8.point !== 0) fail();
  integer(utf8.lower, 0x80, 0xbf); integer(utf8.upper, utf8.lower, 0xbf); boolean(utf8.bomSeen);
  return state;
}
