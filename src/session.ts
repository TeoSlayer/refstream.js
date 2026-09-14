/* eslint-disable no-control-regex -- Terminal input validation intentionally matches control bytes. */
import { CommandTracker, type CommandRecord } from "./commands.js";
import { TerminalCore } from "./core.js";
import { findInTerminal } from "./search.js";
import { TerminalRecorder } from "./recording.js";
import { Signal, type Disposable } from "./types.js";
import type { NativeTerminal, TerminalViewState } from "./native.js";
import { encodeTerminalKey, type TerminalKey } from "./input.js";
import { validateState } from "./state.js";
import { TerminalTasks, validateTaskId, type TerminalTask, type TerminalTaskResult } from "./tasks.js";
import { inspectCursorLine, validateApplicationReport, type TerminalApplicationReport, type TerminalApplicationState, type TerminalApplicationObservation, type TerminalComposerContent, type TerminalInputState } from "./application.js";

export interface InputReceipt { inputId: string; sequence: number; status: "sent"; commandId?: number }
export interface SessionSnapshot {
  version: 1; sequence: number; terminal: TerminalViewState; commands: CommandRecord[];
  executionPending?: boolean;
  sessionId?: string;
  tasks?: TerminalTask[];
  retiredTaskIds?: string[];
  input?: { revision: number; owner: "none" | "local" | "agent" | "unknown" };
}
export interface TerminalAskOptions { kind?: "command" | "message"; confirmEmptyInput?: boolean }
export interface TerminalCollectTaskOptions {
  /** From read_task.task.revision; harmless terminal output does not invalidate it. */
  expectedTaskRevision?: number;
  /** Legacy screen observation guard. Prefer expectedTaskRevision for an observed answer. */
  expectedSequence?: number;
  answer?: string;
  completion?: "agent_observed";
}
let sessionCounter = 0;
function sessionIdentity(): string {
  // Identity is metadata, never an authorization credential. The fallback also
  // permits headless use in older Node environments without global Web Crypto.
  return globalThis.crypto?.randomUUID?.() ?? `session-${Date.now().toString(36)}-${++sessionCounter}`;
}

/** A stable live-session API shared by command UI, replay and optional agent adapters. */
export class TerminalSession implements Disposable {
  readonly commands: CommandTracker;
  readonly tasks = new TerminalTasks();
  readonly onChange: (listener: (sequence: number) => void) => Disposable;
  private change = new Signal<number>();
  private subscriptions: Disposable[];
  private receipts = new Map<string, { signature: string; receipt: InputReceipt }>();
  private sequenceValue = 0;
  private outputSequenceValue = 0;
  private disposed = false;
  private executionPending = false;
  private sessionId = sessionIdentity();
  private inputRevision = 0;
  private applicationObservationRevision = 0;
  private applicationObservationId = sessionIdentity();
  private shellPromptObserved = false;
  private inputOwner: "none" | "local" | "agent" | "unknown" = "unknown";
  private hostInputEmpty = false;
  private composer?: TerminalComposerContent;
  private applicationValue: TerminalApplicationState = { status: "unknown", source: null, revision: 0 };
  private applicationBuffer: "normal" | "alternate";
  private inputSource = Symbol("session input");
  private lifetime = new AbortController();
  /** End of the logical session, independent of a toolbar or agent connection. */
  readonly signal = this.lifetime.signal;
  private recorder?: TerminalRecorder;
  constructor(readonly terminal: NativeTerminal) {
    if (terminal.signal.aborted) throw new Error("Terminal has ended");
    this.commands = new CommandTracker(terminal.core);
    this.applicationBuffer = terminal.core.type;
    this.onChange = this.change.event;
    const changed = () => this.change.fire(++this.sequenceValue);
    this.subscriptions = [terminal.core.activity.event(event => {
      if (event.type === "reset" || event.type === "restore") {
        this.executionPending = false; this.inputOwner = "unknown"; this.hostInputEmpty = false; this.inputRevision++;
        this.clearApplicationState();
        this.tasks.attention("Terminal state changed. Inspect it before continuing the handoff.");
      }
      if (event.type === "write") {
        this.outputSequenceValue++;
        if (this.applicationBuffer !== terminal.core.type) {
          this.inputOwner = "unknown"; this.inputRevision++; this.clearApplicationState();
          this.tasks.attention("The application buffer changed. Inspect the current application before continuing.");
        }
        this.hostInputEmpty = false;
        this.tasks.output();
        for (const task of this.tasks.summary()) if (task.kind === "command" && task.commandId !== undefined && ["waiting", "needs_attention"].includes(task.status)) {
          const command = this.commands.get(task.commandId);
          if (command?.status === "completed") {
            const output = this.commands.output(task.commandId);
            this.tasks.complete(task.id, { text: output.text, truncated: output.truncated, sequence: this.sequence + 1, completion: "shell", exitCode: command.exitCode });
          } else if (command?.status === "unknown") this.tasks.attention("The shell returned without an explicit completion status. Inspect the result.");
        }
      }
      changed();
    }), terminal.core.command.event(marker => {
      if (marker.kind === "output" || marker.kind === "finished" || marker.kind === "prompt") this.executionPending = false;
      if (marker.kind === "command") { this.inputOwner = "none"; this.clearApplicationState(); this.shellPromptObserved = true; }
    }), terminal.onInput(event => {
      this.applicationObservationRevision++;
      this.hostInputEmpty = false; this.composer = undefined;
      if (event.source !== this.inputSource) {
        this.inputRevision++;
        // Enter may submit or insert a newline in an application. It leaves an
        // unverified composer, never a claimed-empty one.
        this.inputOwner = event.data === "\r" || event.data === "\r\n" || event.data === "\x03" ? "unknown" : "local";
        if (!["authentication_required", "input_required"].includes(this.applicationValue.status)) this.tasks.attention("Local input changed. Its effect on the application's composer is unverified; inspect before continuing.");
      }
      changed();
    }), this.tasks.onChange(changed)];
    const ended = () => this.dispose();
    terminal.signal.addEventListener("abort", ended, { once: true });
    this.subscriptions.push({ dispose: () => terminal.signal.removeEventListener("abort", ended) });
  }
  get id(): string { return this.sessionId; }
  get input() { return this.inputState(); }
  get application(): TerminalApplicationState {
    if (this.applicationValue.source === null && this.shellPromptObserved && this.commands.atPrompt && !this.executionPending) return { ...this.applicationValue, status: "ready", source: "shell" };
    return { ...this.applicationValue };
  }
  observeApplication(): TerminalApplicationObservation { this.assertLive(); return { sessionId: this.id, contextId: this.applicationObservationId, revision: this.applicationObservationRevision }; }
  /** Host detachment or failed observation revokes all live semantic claims. No input is sent. */
  invalidateApplicationState(): void { this.assertLive(); this.clearApplicationState(); this.change.fire(++this.sequenceValue); }
  get sequence(): number { return this.sequenceValue; }
  get recording(): TerminalRecorder | undefined { return this.recorder; }
  startRecording(maxBytes?: number): TerminalRecorder {
    this.recorder?.dispose(); this.recorder = new TerminalRecorder(this.terminal.core, maxBytes); return this.recorder;
  }
  stopRecording(): void { this.recorder?.dispose(); }
  read(options: { startRow?: number; maxRows?: number } = {}) {
    const { core } = this.terminal;
    const count = Math.max(1, Math.min(500, Math.floor(options.maxRows ?? 100)));
    const start = Math.max(0, Math.min(core.length, Math.floor(options.startRow ?? Math.max(0, core.length - count))));
    const lines = Array.from({ length: Math.min(count, core.length - start) }, (_, index) => core.getLine(start + index)!.translateToString(true));
    return {
      sequence: this.sequence, outputSequence: this.outputSequenceValue, title: core.title, directory: core.directory || null,
      cols: core.cols, rows: core.rows, buffer: core.type, modes: { ...core.modes },
      cursor: { row: core.cursorY, column: core.cursorX, visible: core.cursorVisible },
      viewportY: this.terminal.buffer.active.viewportY, selection: this.terminal.getSelection(),
      startRow: start, totalRows: core.length, droppedRows: core.history.dropped, lines,
      inputEnabled: !this.terminal.options.disableStdin, atPrompt: this.commands.atPrompt && !this.executionPending, executionPending: this.executionPending,
      terminalSessionId: this.id, input: { ...this.inputState(), screen: inspectCursorLine(core) }, application: this.application, tasks: this.tasks.summary(),
      commands: this.commands.list().slice(-50).map(({ output: _output, ...record }) => record),
    };
  }
  search(query: string, caseSensitive = false) { return findInTerminal(this.terminal.buffer.active, this.terminal.cols, query, caseSensitive); }
  snapshot(): SessionSnapshot { return { version: 1, sequence: this.sequence, sessionId: this.id, terminal: this.terminal.serialize(), commands: this.commands.serialize(), executionPending: this.executionPending, tasks: this.tasks.serialize(), retiredTaskIds: this.tasks.retired(), input: { revision: this.inputRevision, owner: this.inputOwner } }; }
  restore(snapshot: SessionSnapshot): void {
    if (!snapshot || snapshot.version !== 1 || !Number.isSafeInteger(snapshot.sequence) || snapshot.sequence < 0) throw new TypeError("Invalid session snapshot");
    if (snapshot.executionPending !== undefined && typeof snapshot.executionPending !== "boolean") throw new TypeError("Invalid pending execution state");
    if (snapshot.sessionId !== undefined) validateTaskId(snapshot.sessionId);
    if (snapshot.input !== undefined && (!snapshot.input || !Number.isSafeInteger(snapshot.input.revision) || snapshot.input.revision < 0 || !["none", "local", "agent", "unknown"].includes(snapshot.input.owner))) throw new TypeError("Invalid input state");
    const tasks = TerminalTasks.validate(snapshot.tasks ?? []);
    const retired = TerminalTasks.validateRetired(snapshot.retiredTaskIds ?? [], tasks);
    validateState(snapshot.terminal?.model);
    const validation = new CommandTracker(new TerminalCore());
    try { validation.restore(snapshot.commands); } finally { validation.dispose(); }
    this.terminal.restore(snapshot.terminal); this.commands.restore(snapshot.commands);
    this.executionPending = snapshot.executionPending ?? false;
    this.sessionId = snapshot.sessionId ?? this.sessionId; this.tasks.restore(tasks, retired);
    this.inputRevision = Math.max(this.inputRevision, snapshot.input?.revision ?? 0) + 1;
    // A saved ownership flag cannot authorize Enter in a newly attached process.
    this.inputOwner = snapshot.input?.owner === "local" || snapshot.input?.owner === "agent" ? "local" : "unknown";
    this.receipts.clear();
    this.sequenceValue = Math.max(this.sequenceValue, snapshot.sequence) + 1; this.change.fire(this.sequenceValue);
  }
  sendText(text: string, inputId: string, expectedSequence?: number, confirmEmptyInput = false): InputReceipt {
    if (typeof text !== "string" || !text.replace(/\x1b/gu, "")) throw new TypeError("Input text is empty");
    return this.send(inputId, JSON.stringify(["text", text]), expectedSequence, () => {
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(text)) throw new TypeError("sendText accepts plain text; use sendKey for control keys");
      this.assertInputAvailable(confirmEmptyInput, true);
      if (/[\r\n\t]/u.test(text) && !this.terminal.core.modes.bracketedPasteMode) throw new Error("Multiline input requires bracketed paste; nothing was sent");
      this.inputOwner = "agent"; this.terminal.paste(text, this.inputSource);
    });
  }
  sendKey(key: TerminalKey, inputId: string, expectedSequence?: number): InputReceipt {
    const encoded = encodeTerminalKey(key, this.terminal.core.modes);
    if (!encoded) throw new TypeError("This key cannot be sent to the terminal");
    return this.send(inputId, JSON.stringify(["key", key]), expectedSequence, () => {
      this.assertApplicationAvailable();
      if (this.input.protected) throw new Error("Local input is protected; its composer may contain a draft. Nothing was sent. Leave input unchanged.");
      if ((/[\r\n]/u.test(encoded) || key.key === "Enter") && this.inputOwner !== "agent") throw new Error("No agent-owned draft to submit. Use ask to submit a new message atomically.");
      if (/[\r\n]/u.test(encoded) || key.key === "Enter") this.inputOwner = "unknown";
      else if (encoded.length === 1 && encoded >= " " && encoded !== "\x7f") {
        this.assertInputAvailable(false, true); this.inputOwner = "agent";
      }
      this.terminal.sendKey(key, this.inputSource);
    });
  }
  execute(command: string, inputId: string, expectedSequence?: number): InputReceipt {
    return this.send(inputId, JSON.stringify(["execute", command]), expectedSequence, () => {
      this.assertApplicationAvailable();
      if (!command || /[\x00-\x1f\x7f]/u.test(command)) throw new TypeError("execute accepts one command line; use sendText for interactive or multiline input");
      if (this.executionPending) throw new Error("Previous input is awaiting a shell boundary; inspect state or wait before executing another command");
      if (!this.commands.atPrompt || this.inputState().state !== "empty") throw new Error("No empty, explicitly marked shell prompt. Existing input was left unchanged.");
      this.executionPending = true;
      const revision = this.inputRevision;
      this.inputOwner = "agent"; this.terminal.paste(command, this.inputSource);
      if (revision !== this.inputRevision || this.input.owner !== "agent" || this.input.protected || this.terminal.inputComposing) throw new Error("Input changed before submission. Inspect the terminal before retrying.");
      this.assertApplicationAvailable();
      this.inputOwner = "unknown"; this.terminal.sendKey({ key: "Enter" }, this.inputSource);
    }, this.commands.active?.id);
  }
  /** Submit once and retain the handoff independently of the connection that sent it. */
  ask(prompt: string, taskId: string, expectedSequence: number, options: TerminalAskOptions = {}): TerminalTask {
    this.assertLive(true); validateTaskId(taskId);
    const kind = options.kind ?? "message";
    if (!["command", "message"].includes(kind) || typeof prompt !== "string" || !prompt.trim() || prompt.length > 8192 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(prompt)) throw new TypeError("Use a plain-text prompt of at most 8192 characters");
    const previous = this.tasks.find(taskId);
    if (previous) {
      if (previous.prompt !== prompt || previous.kind !== kind) throw new Error("Task ID was already used for a different request");
      return previous;
    }
    this.assertSequence(expectedSequence);
    this.assertApplicationAvailable();
    if (this.tasks.pending.length) throw new Error("Collect the previous answer before starting another task. Keep this session connected.");
    if (this.executionPending) throw new Error("Previous input is awaiting a shell boundary. Nothing was sent.");
    if (kind === "command") {
      if (!this.commands.atPrompt || this.inputState().state !== "empty" || /[\r\n\t]/u.test(prompt)) throw new Error("A command needs an empty marked shell prompt and one line; nothing was sent");
    } else {
      if (this.commands.atPrompt) throw new Error("This is a shell prompt. Use kind: command for a shell command, or open the intended application first.");
      this.assertInputAvailable(options.confirmEmptyInput === true);
      if (/[\r\n\t]/u.test(prompt) && !this.terminal.core.modes.bracketedPasteMode) throw new Error("Multiline messages require bracketed paste; nothing was sent");
    }
    const revision = this.inputRevision;
    // A previous turn's lifecycle is not progress for the new request.
    this.applicationObservationRevision++;
    this.applicationValue = { status: "unknown", source: null, revision: this.applicationValue.revision + 1 };
    this.tasks.begin({ id: taskId, prompt, kind, submittedSequence: this.sequence, ...(kind === "command" ? { commandId: this.commands.active?.id } : {}) });
    // The task exists before either input event, so even immediate shell output
    // has somewhere to report completion. Never roll back and retry input.
    try {
      if (revision !== this.inputRevision || this.terminal.inputComposing) throw new Error("Input changed before submission; nothing was sent.");
      if (kind === "command") this.executionPending = true;
      this.inputOwner = "agent";
      this.terminal.paste(prompt, this.inputSource);
      if (revision !== this.inputRevision || this.input.owner !== "agent" || this.input.protected || this.terminal.inputComposing) throw new Error("Input changed before submission. The task needs inspection; do not retry it with a new ID.");
      this.assertApplicationAvailable();
      this.inputOwner = "unknown"; this.terminal.sendKey({ key: "Enter" }, this.inputSource);
    } catch (error) { this.tasks.attention("Submission was interrupted. Inspect the terminal before retrying; delivery may be partial."); throw error; }
    return this.tasks.get(taskId);
  }
  readTask(taskId: string) { return { task: this.tasks.get(taskId), terminal: this.read(), next: this.taskNext(taskId) }; }
  async waitTask(taskId: string, afterRevision: number, timeoutMs = 15_000, signal?: AbortSignal, afterOutputSequence?: number) {
    const task = this.tasks.get(taskId);
    if (!Number.isSafeInteger(afterRevision) || afterRevision < 0 || afterRevision > task.revision) throw new RangeError("Revision does not belong to this task");
    if (!Number.isFinite(timeoutMs)) throw new RangeError("Task timeout must be finite");
    if (afterOutputSequence !== undefined && (!Number.isSafeInteger(afterOutputSequence) || afterOutputSequence < 0 || afterOutputSequence > this.outputSequenceValue)) throw new RangeError("Output sequence does not belong to this session");
    if (this.disposed || signal?.aborted) throw new Error("Session wait cancelled");
    const ready = () => {
      const current = this.tasks.get(taskId), app = this.applicationValue;
      return current.revision > afterRevision || ["completed", "collected", "cancelled"].includes(current.status)
        || app.status === "authentication_required" || app.status === "input_required"
        || app.taskId === taskId && app.status === "answer_ready";
    };
    const outputReady = () => afterOutputSequence !== undefined && this.outputSequenceValue > afterOutputSequence;
    const result = () => ({ ...this.readTask(taskId), ...(this.taskNext(taskId) === "wait" && outputReady() ? { next: "inspect" as const } : {}), timedOut: false, reason: ready() ? "state" as const : "output" as const });
    if (ready() || outputReady()) return result();
    const deadline = Date.now() + Math.max(1, Math.min(30_000, timeoutMs));
    for (;;) {
      const waited = await this.wait(this.sequence, Math.max(1, deadline - Date.now()), signal);
      // An actionable result wins even if it arrives on the timeout boundary.
      if (ready() || outputReady()) return result();
      if (waited.timedOut || Date.now() >= deadline) return { ...this.readTask(taskId), timedOut: true, reason: "timeout" as const };
    }
  }
  /** A trusted host adapter can supply actual application completion, without screen guessing. */
  completeTask(taskId: string, answer: string, options: { truncated?: boolean } = {}): TerminalTask {
    this.assertLive();
    const previous = this.tasks.get(taskId);
    if (["completed", "collected"].includes(previous.status) && previous.result?.completion === "host" && previous.result.text === answer && previous.result.truncated === (options.truncated === true)) return previous;
    if (["completed", "collected", "cancelled"].includes(previous.status)) throw new Error("This task already has a final result or is closed");
    const result = { text: answer, truncated: options.truncated === true, sequence: this.sequence, completion: "host" as const };
    // Validate before publishing either state, so synchronous listeners see the
    // completed answer and its host status together, with no partial transition.
    TerminalTasks.validate([{ ...previous, status: "completed", result }]);
    this.applicationValue = { status: "answer_ready", source: "host", taskId, revision: this.applicationValue.revision + 1 };
    this.applicationObservationRevision++;
    const task = this.tasks.complete(taskId, result);
    this.change.fire(++this.sequenceValue); return task;
  }
  /**
   * Trusted host integration only. Observe real application state after capturing
   * an observation token, and report before input or context changes. Terminal text is not
   * evidence. Report every composer/context change, and unknown on detachment.
   */
  reportApplicationState(report: TerminalApplicationReport, observation: number | TerminalApplicationObservation): void {
    this.assertLive(); validateApplicationReport(report);
    if (typeof observation === "number") this.assertSequence(observation);
    else if (!observation || observation.sessionId !== this.id || observation.contextId !== this.applicationObservationId || observation.revision !== this.applicationObservationRevision) throw new Error("Application state changed; observe the host again before reporting");
    if (report.taskId !== undefined) {
      const task = this.tasks.get(report.taskId);
      const retainedAnswer = ["completed", "collected"].includes(task.status) && report.taskId === this.applicationValue.taskId
        && ["ready", "answer_ready"].includes(report.status) && this.tasks.pending.every(pending => pending.id === task.id);
      if (["completed", "collected", "cancelled"].includes(task.status) && !retainedAnswer) throw new Error("Application progress belongs to a closed task");
    }
    if (report.composer !== undefined && this.terminal.inputComposing) throw new Error("Keyboard composition is still active; wait for committed input");
    const empty = ["empty", "placeholder", "suggestion"].includes(report.composer ?? "");
    if (empty && this.commands.atPrompt && this.commands.inputText) throw new Error("The marked shell prompt still contains input");
    const clearsComposer = ["unknown", "working", "authentication_required", "input_required"].includes(report.status);
    const composer = report.composer ?? (clearsComposer ? undefined : this.composer);
    const discardedInput = clearsComposer && (this.inputOwner === "agent" || this.hostInputEmpty);
    const changed = report.status !== this.applicationValue.status || report.taskId !== this.applicationValue.taskId || this.applicationValue.source !== "host" || composer !== this.composer || discardedInput;
    // Even an identical confirmation supersedes an older in-flight observation.
    // Deduplicate task progress, never the freshness guard (including legacy sequences).
    this.applicationObservationRevision++;
    if (!changed) { this.change.fire(++this.sequenceValue); return; }
    if (composer !== this.composer || discardedInput) this.inputRevision++;
    this.applicationValue = { status: report.status, source: "host", revision: this.applicationValue.revision + 1, ...(report.taskId === undefined ? {} : { taskId: report.taskId }) };
    if (clearsComposer) {
      this.composer = undefined; this.hostInputEmpty = false;
      if (this.inputOwner === "agent") this.inputOwner = "unknown";
    }
    if (report.composer !== undefined) {
      this.composer = report.composer; this.hostInputEmpty = false;
      // A report knows whether a value exists, not who authored it. It must
      // never confer submission ownership on a visiting agent.
      this.inputOwner = empty ? "none" : report.composer === "draft" ? "local" : this.inputOwner;
    }
    this.tasks.applicationChanged(report.taskId);
    this.change.fire(++this.sequenceValue);
  }
  /** Owner acknowledgement for an unintegrated TUI; cannot contradict a host-reported draft. */
  confirmInputEmpty(expectedRevision: number): void {
    this.assertLive(true);
    if (expectedRevision !== this.inputRevision || this.terminal.inputComposing || this.composer === "draft" || this.commands.atPrompt && Boolean(this.commands.inputText)) throw new Error("Input changed; inspect the application's composer again");
    const changed = this.input.state !== "empty" || this.input.protected;
    this.applicationObservationRevision++;
    this.inputOwner = "none"; this.hostInputEmpty = true;
    if (changed) this.tasks.applicationChanged();
    this.change.fire(++this.sequenceValue);
  }
  collectTask(taskId: string, options: TerminalCollectTaskOptions = {}) {
    this.assertLive();
    const task = this.tasks.get(taskId);
    if (task.status === "collected" || task.status === "cancelled") return this.readTask(taskId);
    if (task.status === "completed") this.tasks.collect(taskId);
    else {
      if (options.answer !== undefined || options.completion !== undefined) {
        if (options.expectedTaskRevision !== undefined) {
          if (!Number.isSafeInteger(options.expectedTaskRevision) || options.expectedTaskRevision !== task.revision) throw new Error("Task state changed; read this task again before confirming its answer");
        } else this.assertSequence(options.expectedSequence);
      }
      const result: TerminalTaskResult = {
        text: options.answer ?? this.read({ maxRows: 100 }).lines.join("\n").slice(0, 32768),
        truncated: options.answer === undefined, sequence: this.sequence,
      };
      if (options.completion === "agent_observed") {
        this.assertApplicationAvailable();
        if (!options.answer?.trim()) throw new Error("Include the actual answer before confirming observed completion. A quiet screen is not completion.");
        this.tasks.complete(taskId, { ...result, completion: "agent_observed" }); this.tasks.collect(taskId);
      } else this.tasks.collect(taskId, result);
    }
    return this.readTask(taskId);
  }
  cancelTask(taskId: string, reason: string): TerminalTask {
    this.assertLive();
    if (typeof reason !== "string" || !reason.trim() || reason.length > 1024) throw new TypeError("Give a brief reason for abandoning the task");
    return this.tasks.cancel(taskId, reason);
  }
  assertCanDisconnect(): void {
    const pending = this.tasks.pending;
    if (pending.length) throw new Error(`Task ${pending[0].id} still needs an answer or collection. Keep the session connected, collect the answer, or explicitly abandon the task before stopping.`);
  }
  private taskNext(taskId: string): "wait" | "inspect" | "collect" | "done" | "authenticate" {
    const status = this.tasks.get(taskId).status;
    if (status === "completed") return "collect";
    if (status === "collected" || status === "cancelled") return "done";
    const app = this.applicationValue;
    if (app.status === "authentication_required") return "authenticate";
    if (status !== "needs_attention" && app.taskId === taskId && app.status === "working") return "wait";
    if (app.status === "input_required" || app.taskId === taskId && ["answer_ready", "ready"].includes(app.status)) return "inspect";
    return status === "needs_attention" ? "inspect" : "wait";
  }
  private inputState(): TerminalInputState {
    const composing = this.terminal.inputComposing, shellDraft = this.commands.atPrompt && Boolean(this.commands.inputText);
    const content = this.composer ?? (this.inputOwner === "agent" || shellDraft ? "draft" : !this.executionPending && (this.hostInputEmpty || this.commands.atPrompt && this.inputOwner === "none") ? "empty" : "unknown");
    const state = composing || content === "draft" ? "occupied" : ["empty", "placeholder", "suggestion"].includes(content) ? "empty" : "unknown";
    return { state, content, owner: this.inputOwner, revision: this.inputRevision, composing,
      protected: composing || this.inputOwner === "local" || content === "draft" && this.inputOwner !== "agent",
      verifiedBy: this.composer && this.composer !== "unknown" ? "host" : shellDraft || state === "empty" && this.commands.atPrompt ? "shell" : this.hostInputEmpty ? "owner" : null };
  }
  private assertInputAvailable(confirmEmpty: boolean, append = false): void {
    this.assertApplicationAvailable();
    const input = this.inputState();
    if (input.protected || input.state === "occupied" && !(append && input.owner === "agent")) throw new Error("Local input is protected; its composer may contain a draft. Nothing was sent. Leave input unchanged.");
    if (input.state === "unknown" && !confirmEmpty) throw new Error("Composer state is unknown, not a confirmed draft. Placeholder and suggested text may be visible even when the editable value is empty. Inspect input.screen, then use confirmEmptyInput only after verifying an empty composer. Nothing was sent.");
  }
  private assertApplicationAvailable(): void {
    if (this.applicationValue.status === "authentication_required") throw new Error("Authentication required. Keep the session connected while its owner signs in; do not type credentials or a prompt.");
    if (this.applicationValue.status === "working") throw new Error("The application is working. Wait for its answer before sending more input.");
    if (this.applicationValue.status === "input_required") throw new Error("The application needs a response to its current dialog. Inspect it before continuing; a new prompt was not sent.");
  }
  private clearApplicationState(): void {
    const changed = this.applicationValue.source !== null || this.composer !== undefined || this.inputOwner === "agent" || this.hostInputEmpty || this.shellPromptObserved;
    this.applicationObservationRevision++;
    this.shellPromptObserved = false;
    if (this.inputOwner === "agent") { this.inputOwner = "unknown"; this.inputRevision++; }
    this.composer = undefined; this.hostInputEmpty = false; this.applicationBuffer = this.terminal.core.type;
    this.applicationValue = { status: "unknown", source: null, revision: this.applicationValue.revision + 1 };
    if (changed) this.tasks.applicationChanged();
  }
  private assertSequence(expected: number | undefined): void {
    if (expected === undefined || expected !== this.sequence) throw new Error("Terminal state changed or no recent sequence was supplied; read it again before sending input");
  }
  private assertLive(input = false): void { if (this.disposed || input && this.terminal.options.disableStdin) throw new Error("Terminal input is unavailable"); }
  wait(after: number, timeoutMs = 15_000, signal?: AbortSignal): Promise<{ sequence: number; timedOut: boolean }> {
    if (!Number.isSafeInteger(after) || after < 0 || after > this.sequence) return Promise.reject(new RangeError("Sequence does not belong to the current session"));
    if (this.disposed || signal?.aborted) return Promise.reject(new Error("Session wait cancelled"));
    if (this.sequence > after) return Promise.resolve({ sequence: this.sequence, timedOut: false });
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const finish = (timedOut: boolean, error?: Error) => {
        subscription.dispose(); clearTimeout(timer); signal?.removeEventListener("abort", aborted);
        if (error) reject(error); else resolve({ sequence: this.sequence, timedOut });
      };
      const aborted = () => finish(false, new Error("Session wait cancelled"));
      const subscription = this.onChange(() => this.disposed ? aborted() : finish(false));
      signal?.addEventListener("abort", aborted, { once: true });
      timer = setTimeout(() => finish(true), Math.max(1, Math.min(30_000, timeoutMs)));
      if (this.sequence > after) finish(false);
    });
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.lifetime.abort(); this.change.fire(this.sequence);
    for (const subscription of this.subscriptions) subscription.dispose();
    this.commands.dispose(); this.tasks.dispose(); this.recorder?.dispose(); this.change.dispose(); this.receipts.clear();
  }
  private send(id: string, signature: string, expected: number | undefined, action: () => void, commandId?: number): InputReceipt {
    if (this.disposed || this.terminal.options.disableStdin) throw new Error("Terminal input is unavailable");
    if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/u.test(id) || signature.length > 16_384) throw new TypeError("Invalid or oversized input request");
    const previous = this.receipts.get(id);
    if (previous) {
      if (previous.signature !== signature) throw new Error("Input ID was already used for a different action");
      return { ...previous.receipt };
    }
    if (expected !== undefined && expected !== this.sequence) throw new Error("Terminal state changed; read it again before sending input");
    action();
    const receipt: InputReceipt = { inputId: id, sequence: this.sequence, status: "sent", ...(commandId === undefined ? {} : { commandId }) };
    this.receipts.set(id, { signature, receipt });
    if (this.receipts.size > 128) this.receipts.delete(this.receipts.keys().next().value!);
    return { ...receipt };
  }
}

const sessions = new WeakMap<NativeTerminal, TerminalSession>();
/** The default session used by optional UI. It survives UI remounts until the terminal ends. */
export function getTerminalSession(terminal: NativeTerminal): TerminalSession {
  let session = sessions.get(terminal);
  if (!session || session.signal.aborted) { session = new TerminalSession(terminal); sessions.set(terminal, session); }
  return session;
}
