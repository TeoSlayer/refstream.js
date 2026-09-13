import { Signal, type Disposable } from "./types.js";

export type TerminalTaskStatus = "waiting" | "needs_attention" | "completed" | "collected" | "cancelled";
export type TerminalTaskCompletion = "shell" | "host" | "agent_observed";
export interface TerminalTaskResult {
  text: string;
  truncated: boolean;
  sequence: number;
  /** An observation by the visiting agent is distinct from a host or shell completion event. */
  completion?: TerminalTaskCompletion;
  exitCode?: number;
}
export interface TerminalTask {
  id: string;
  kind: "command" | "message";
  prompt: string;
  status: TerminalTaskStatus;
  revision: number;
  submittedSequence: number;
  startedAt: number;
  updatedAt: number;
  outputObserved: boolean;
  commandId?: number;
  note?: string;
  result?: TerminalTaskResult;
  collectedAt?: number;
}

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const statuses: readonly string[] = ["waiting", "needs_attention", "completed", "collected", "cancelled"];
const completions: readonly string[] = ["shell", "host", "agent_observed"];
export function validateTaskId(id: unknown): asserts id is string {
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/u.test(id)) throw new TypeError("Invalid task ID");
}

/** Bounded, session-owned handoffs. Connection credentials never enter these records. */
export class TerminalTasks implements Disposable {
  private records: TerminalTask[] = [];
  private retiredIds = new Set<string>();
  /** Undefined identifies a history replacement rather than one task changing. */
  private changed = new Signal<string | undefined>();
  readonly onChange = this.changed.event;
  get pending(): TerminalTask[] { return copy(this.records.filter(task => task.status !== "collected" && task.status !== "cancelled")); }
  summary() { return this.records.map(({ prompt: _prompt, result, ...task }) => ({ ...task, completion: result?.completion, resultAvailable: result !== undefined })); }
  list(): TerminalTask[] { return copy(this.records); }
  get(id: string): TerminalTask {
    validateTaskId(id);
    const record = this.records.find(task => task.id === id);
    if (!record) throw new RangeError(this.retiredIds.has(id) ? "This task's retained answer has expired. Its request must not be submitted again." : "Unknown task. List tasks in this session before resubmitting.");
    return copy(record);
  }
  find(id: string): TerminalTask | undefined {
    if (this.retiredIds.has(id)) throw new Error("This task ID has already been used. Its answer expired; do not resubmit the request.");
    return this.records.some(task => task.id === id) ? this.get(id) : undefined;
  }
  begin(task: Omit<TerminalTask, "status" | "revision" | "startedAt" | "updatedAt" | "outputObserved">): TerminalTask {
    validateTaskId(task.id);
    if (this.retiredIds.has(task.id) || this.retiredIds.size >= 4096) throw new Error("Task ID was already used or this session's task limit was reached");
    if (this.records.some(record => record.id === task.id)) throw new Error("Task ID already exists");
    if (this.pending.length) throw new Error("Collect the previous answer before starting another task. Keep this session connected.");
    const now = Date.now();
    const record = { ...task, status: "waiting" as const, revision: 1, startedAt: now, updatedAt: now, outputObserved: false };
    TerminalTasks.validate([record]); this.records.push(record);
    if (this.records.length > 32) this.retiredIds.add(this.records.shift()!.id);
    this.changed.fire(task.id); return this.get(task.id);
  }
  output(): void {
    for (const task of this.records) if (["waiting", "needs_attention"].includes(task.status) && !task.outputObserved) this.update(task.id, { outputObserved: true });
  }
  attention(note: string): void {
    for (const task of this.records) if (task.status === "waiting") this.update(task.id, { status: "needs_attention", note: note.slice(0, 1024) });
  }
  complete(id: string, result: TerminalTaskResult): TerminalTask {
    const task = this.get(id);
    if (task.status === "collected" || task.status === "cancelled") throw new Error("This task is already closed");
    if (!result.completion) throw new TypeError("Completion requires an explicit source");
    return this.update(id, { status: "completed", result: this.validateResult(result), note: undefined });
  }
  collect(id: string, partial?: TerminalTaskResult): TerminalTask {
    const task = this.get(id);
    if (task.status === "collected" || task.status === "cancelled") return task;
    if (task.status === "completed") return this.update(id, { status: "collected", collectedAt: Date.now() });
    // Reading partial output never promotes an unfinished task to completed.
    if (partial) {
      if (partial.completion) throw new TypeError("Report completion explicitly before collecting the final answer");
      return this.update(id, { result: this.validateResult(partial) });
    }
    return task;
  }
  cancel(id: string, note: string): TerminalTask {
    const task = this.get(id);
    if (task.status === "collected" || task.status === "cancelled") return task;
    return this.update(id, { status: "cancelled", note: note.slice(0, 1024) });
  }
  serialize(): TerminalTask[] { return this.list(); }
  retired(): string[] { return [...this.retiredIds]; }
  static validateRetired(value: unknown, records: TerminalTask[]): string[] {
    if (!Array.isArray(value) || value.length > 4096) throw new TypeError("Invalid retired task IDs");
    const seen = new Set(records.map(task => task.id));
    for (const id of value) { validateTaskId(id); if (seen.has(id)) throw new TypeError("Duplicate task ID"); seen.add(id); }
    return [...value] as string[];
  }
  static validate(value: unknown): TerminalTask[] {
    if (!Array.isArray(value) || value.length > 32 || JSON.stringify(value).length > 2 * 1024 * 1024) throw new TypeError("Invalid task history");
    const records = copy(value) as TerminalTask[], ids = new Set<string>();
    const validNumber = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
    for (const task of records) {
      if (!task || typeof task !== "object") throw new TypeError("Invalid task");
      validateTaskId(task.id);
      if (ids.has(task.id) || !["command", "message"].includes(task.kind) || typeof task.prompt !== "string" || !task.prompt.trim() || task.prompt.length > 8192 || !statuses.includes(task.status) || typeof task.outputObserved !== "boolean") throw new TypeError("Invalid task");
      for (const field of ["revision", "submittedSequence", "startedAt", "updatedAt"] as const) if (!validNumber(task[field])) throw new TypeError("Invalid task metadata");
      if (!task.revision || task.commandId !== undefined && !validNumber(task.commandId) || task.collectedAt !== undefined && !validNumber(task.collectedAt) || task.note !== undefined && (typeof task.note !== "string" || task.note.length > 1024)) throw new TypeError("Invalid task metadata");
      if (task.result !== undefined) TerminalTasks.prototype.validateResult(task.result);
      if (["completed", "collected"].includes(task.status) && !task.result?.completion) throw new TypeError("Completed task has no completion evidence");
      ids.add(task.id);
    }
    if (records.filter(task => !["collected", "cancelled"].includes(task.status)).length > 1) throw new TypeError("Only one handoff may be outstanding");
    return records;
  }
  restore(records: TerminalTask[], retired: string[] = []): void {
    const validated = TerminalTasks.validate(records);
    const ids = TerminalTasks.validateRetired(retired, validated);
    this.records = validated; this.retiredIds = new Set(ids);
    this.attention("Restored task. Inspect the live application before continuing; restoring a snapshot does not restart a process.");
    this.changed.fire(undefined);
  }
  dispose(): void { this.records = []; this.retiredIds.clear(); this.changed.dispose(); }
  private validateResult(result: TerminalTaskResult): TerminalTaskResult {
    if (!result || typeof result.text !== "string" || result.text.length > 32768 || typeof result.truncated !== "boolean" || !Number.isSafeInteger(result.sequence) || result.sequence < 0 || result.completion !== undefined && !completions.includes(result.completion) || result.exitCode !== undefined && (!Number.isSafeInteger(result.exitCode) || result.exitCode < 0 || result.exitCode > 255)) throw new TypeError("Invalid task result");
    return copy(result);
  }
  private update(id: string, changes: Partial<TerminalTask>): TerminalTask {
    const record = this.records.find(task => task.id === id)!;
    Object.assign(record, changes, { revision: record.revision + 1, updatedAt: Date.now() });
    this.changed.fire(id); return this.get(id);
  }
}
