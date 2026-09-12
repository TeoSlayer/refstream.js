/* eslint-disable no-control-regex -- Terminal input validation intentionally matches control bytes. */
import { CommandTracker, type CommandRecord } from "./commands.js";
import { TerminalCore } from "./core.js";
import { findInTerminal } from "./search.js";
import { TerminalRecorder } from "./recording.js";
import { Signal, type Disposable } from "./types.js";
import type { NativeTerminal, TerminalViewState } from "./native.js";
import { encodeTerminalKey, type TerminalKey } from "./input.js";
import { validateState } from "./state.js";

export interface InputReceipt { inputId: string; sequence: number; status: "sent"; commandId?: number }
export interface SessionSnapshot {
  version: 1; sequence: number; terminal: TerminalViewState; commands: CommandRecord[];
  executionPending?: boolean;
}

/** A stable live-session API shared by command UI, replay and optional agent adapters. */
export class TerminalSession implements Disposable {
  readonly commands: CommandTracker;
  readonly onChange: (listener: (sequence: number) => void) => Disposable;
  private change = new Signal<number>();
  private subscriptions: Disposable[];
  private receipts = new Map<string, { signature: string; receipt: InputReceipt }>();
  private sequenceValue = 0;
  private disposed = false;
  private executionPending = false;
  private recorder?: TerminalRecorder;
  constructor(readonly terminal: NativeTerminal) {
    this.commands = new CommandTracker(terminal.core);
    this.onChange = this.change.event;
    const changed = () => this.change.fire(++this.sequenceValue);
    this.subscriptions = [terminal.core.activity.event(event => {
      if (event.type === "reset" || event.type === "restore") this.executionPending = false;
      changed();
    }), terminal.core.command.event(marker => {
      if (marker.kind === "output" || marker.kind === "finished" || marker.kind === "prompt") this.executionPending = false;
    }), terminal.onData(changed), terminal.onBinary(changed)];
  }
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
      sequence: this.sequence, title: core.title, directory: core.directory || null,
      cols: core.cols, rows: core.rows, buffer: core.type, modes: { ...core.modes },
      cursor: { row: core.cursorY, column: core.cursorX, visible: core.cursorVisible },
      viewportY: this.terminal.buffer.active.viewportY, selection: this.terminal.getSelection(),
      startRow: start, totalRows: core.length, droppedRows: core.history.dropped, lines,
      inputEnabled: !this.terminal.options.disableStdin, atPrompt: this.commands.atPrompt && !this.executionPending, executionPending: this.executionPending,
      commands: this.commands.list().slice(-50).map(({ output: _output, ...record }) => record),
    };
  }
  search(query: string, caseSensitive = false) { return findInTerminal(this.terminal.buffer.active, this.terminal.cols, query, caseSensitive); }
  snapshot(): SessionSnapshot { return { version: 1, sequence: this.sequence, terminal: this.terminal.serialize(), commands: this.commands.serialize(), executionPending: this.executionPending }; }
  restore(snapshot: SessionSnapshot): void {
    if (!snapshot || snapshot.version !== 1 || !Number.isSafeInteger(snapshot.sequence) || snapshot.sequence < 0) throw new TypeError("Invalid session snapshot");
    if (snapshot.executionPending !== undefined && typeof snapshot.executionPending !== "boolean") throw new TypeError("Invalid pending execution state");
    validateState(snapshot.terminal?.model);
    const validation = new CommandTracker(new TerminalCore());
    try { validation.restore(snapshot.commands); } finally { validation.dispose(); }
    this.terminal.restore(snapshot.terminal); this.commands.restore(snapshot.commands);
    this.executionPending = snapshot.executionPending ?? false;
    this.sequenceValue = Math.max(this.sequenceValue, snapshot.sequence) + 1; this.change.fire(this.sequenceValue);
  }
  sendText(text: string, inputId: string, expectedSequence?: number): InputReceipt {
    if (typeof text !== "string" || !text.replace(/\x1b/gu, "")) throw new TypeError("Input text is empty");
    return this.send(inputId, JSON.stringify(["text", text]), expectedSequence, () => this.terminal.paste(text));
  }
  sendKey(key: TerminalKey, inputId: string, expectedSequence?: number): InputReceipt {
    if (!encodeTerminalKey(key, this.terminal.core.modes)) throw new TypeError("This key cannot be sent to the terminal");
    return this.send(inputId, JSON.stringify(["key", key]), expectedSequence, () => this.terminal.sendKey(key));
  }
  execute(command: string, inputId: string, expectedSequence?: number): InputReceipt {
    return this.send(inputId, JSON.stringify(["execute", command]), expectedSequence, () => {
      if (!command || /[\x00-\x1f\x7f]/u.test(command)) throw new TypeError("execute accepts one command line; use sendText for interactive or multiline input");
      if (this.executionPending) throw new Error("Previous input is awaiting a shell boundary; inspect state or wait before executing another command");
      if (!this.commands.atPrompt || this.commands.inputText) throw new Error("No empty, explicitly marked shell prompt. Use sendText/sendKey to interact with the current application.");
      this.executionPending = true;
      this.terminal.paste(command); this.terminal.sendKey({ key: "Enter" });
    }, this.commands.active?.id);
  }
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
    this.disposed = true; this.change.fire(this.sequence);
    for (const subscription of this.subscriptions) subscription.dispose();
    this.commands.dispose(); this.recorder?.dispose(); this.change.dispose(); this.receipts.clear();
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
