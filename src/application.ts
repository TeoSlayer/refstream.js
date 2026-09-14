import type { TerminalCore } from "./core.js";
import type { TerminalColor } from "./buffer.js";

export type TerminalApplicationStatus = "unknown" | "ready" | "authentication_required" | "input_required" | "working" | "answer_ready";
/** Describes the actual composer value, separately from decorative prompt text. */
export type TerminalComposerContent = "unknown" | "empty" | "placeholder" | "suggestion" | "draft";
export interface TerminalApplicationReport {
  status: TerminalApplicationStatus;
  /** Placeholder and suggestion mean the editable value is empty. A typed prefix is a draft. Never include the value itself. */
  composer?: TerminalComposerContent;
  /** Associate progress with the request the application is actually handling. */
  taskId?: string;
}
export interface TerminalApplicationState {
  status: TerminalApplicationStatus;
  source: "host" | null;
  revision: number;
  taskId?: string;
}
export interface TerminalInputState {
  state: "empty" | "occupied" | "unknown";
  content: TerminalComposerContent;
  owner: "none" | "local" | "agent" | "unknown";
  revision: number;
  composing: boolean;
  /** Local activity is protected even when its effect on a TUI's composer is unknown. */
  protected: boolean;
  verifiedBy: "host" | "shell" | "owner" | null;
}

export function validateApplicationReport(value: TerminalApplicationReport): void {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    !["unknown", "ready", "authentication_required", "input_required", "working", "answer_ready"].includes(value.status) ||
    value.composer !== undefined && !["unknown", "empty", "placeholder", "suggestion", "draft"].includes(value.composer) ||
    Object.keys(value).some(key => !["status", "composer", "taskId"].includes(key))) throw new TypeError("Invalid application state; report status and composer kind, never composer text");
}

/** Bounded visual evidence, never an editable value or an input authorization. */
export function inspectCursorLine(core: TerminalCore) {
  const row = core.baseY + core.cursorY, line = core.getLine(row)!;
  let startColumn = Math.max(0, core.cursorX - 128);
  if (line.cells[startColumn]?.width === 0) startColumn--;
  const endColumn = Math.min(core.cols, Math.max(core.cursorX, line.usedLength()), startColumn + 256);
  let beforeCursor = "", afterCursor = "";
  const styles: { startColumn: number; endColumn: number; foreground: TerminalColor; dim: boolean; concealed: boolean }[] = [];
  let stylesTruncated = false;
  for (let column = startColumn; column < endColumn; column++) {
    const cell = line.cells[column];
    if (cell.width === 0) continue;
    const text = cell.attributes.hidden ? " ".repeat(cell.width) : cell.text || " ";
    if (column < core.cursorX) beforeCursor += text; else afterCursor += text;
    const last = styles[styles.length - 1];
    const { fg: foreground, dim, hidden: concealed } = cell.attributes;
    if (!stylesTruncated && last && last.foreground === foreground && last.dim === dim && last.concealed === concealed) last.endColumn = column + cell.width;
    else if (styles.length < 64) styles.push({ startColumn: column, endColumn: column + cell.width, foreground, dim, concealed });
    else stylesTruncated = true;
  }
  return { semantics: "display_only" as const, row, cursorColumn: core.cursorX, startColumn, endColumn, wrapped: line.isWrapped,
    beforeCursor, afterCursor, styles, truncated: startColumn > 0 || endColumn < line.usedLength() || stylesTruncated };
}
