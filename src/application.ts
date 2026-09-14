import type { TerminalCore } from "./core.js";
import type { TerminalColor } from "./buffer.js";
import type { Disposable } from "./types.js";
import type { TerminalSession } from "./session.js";

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
  source: "host" | "shell" | null;
  revision: number;
  taskId?: string;
}
/** Capture before observing the host. Output and rendering do not invalidate it. */
export interface TerminalApplicationObservation {
  sessionId: string;
  /** Live instance identity; restoring a saved session does not restore this context. */
  contextId: string;
  revision: number;
}
export interface TerminalApplicationCompletion {
  taskId: string;
  answer: string;
  truncated?: boolean;
}
/** A trusted, synchronous view of the application's real model, never terminal text. */
export interface TerminalApplicationAdapter {
  getState(): TerminalApplicationReport;
  onStateChange(listener: () => void): Disposable;
  /** Emit only the final answer for the exact request this application accepted. */
  onTaskComplete?(listener: (result: TerminalApplicationCompletion) => void): Disposable;
}
const applications = new WeakMap<TerminalSession, Disposable>();
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

/**
 * Keep host state wired for the lifetime of one application. The host must notify
 * every editor/lifecycle change, including input from outside this browser.
 * Detach before changing processes; stale subscriptions cannot authorize input.
 */
export function attachTerminalApplication(session: TerminalSession, adapter: TerminalApplicationAdapter): Disposable {
  if (session.signal.aborted) throw new Error("Terminal session has ended");
  applications.get(session)?.dispose();
  let disposed = false;
  const subscriptions: Disposable[] = [];
  const refresh = () => {
    if (disposed || session.signal.aborted) return;
    try {
      const observation = session.observeApplication();
      const state = adapter.getState();
      // Reading a host model must be synchronous. The observation also detects
      // reentrant input or a process change while the model is being read.
      session.reportApplicationState(state, observation);
    } catch (error) {
      if (!disposed && !session.signal.aborted) session.invalidateApplicationState();
      throw error;
    }
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    session.signal.removeEventListener("abort", dispose);
    if (applications.get(session) === binding) {
      applications.delete(session);
      if (!session.signal.aborted) session.invalidateApplicationState();
    }
    let failure: unknown;
    for (const subscription of subscriptions) {
      try { subscription.dispose(); } catch (error) { failure ??= error; }
    }
    if (failure !== undefined) throw failure;
  };
  const binding = { dispose };
  applications.set(session, binding);
  try {
    session.signal.addEventListener("abort", dispose, { once: true });
    subscriptions.push(adapter.onStateChange(refresh));
    if (adapter.onTaskComplete) subscriptions.push(adapter.onTaskComplete(result => {
      if (disposed || session.signal.aborted) return;
      session.completeTask(result.taskId, result.answer, { truncated: result.truncated });
    }));
    refresh();
  } catch (error) { dispose(); throw error; }
  return binding;
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
