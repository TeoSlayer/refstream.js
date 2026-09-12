import type { CommandMarker, TerminalCore } from "./core.js";
import { Signal, type Disposable } from "./types.js";

export interface CommandRecord {
  id: number; command: string; directory: string;
  status: "pending" | "running" | "completed" | "unknown";
  promptMarker?: number; inputMarker?: number; outputMarker?: number; endMarker?: number;
  startedAt?: number; endedAt?: number; durationMs?: number; exitCode?: number;
  output?: string; truncated?: boolean;
}

/** Semantic command records come from explicit OSC 133 boundaries, never prompt guessing. */
export class CommandTracker implements Disposable {
  private records: CommandRecord[] = [];
  private current?: CommandRecord;
  private promptMarker?: number;
  private subscriptions: Disposable[];
  readonly changed = new Signal<void>();

  constructor(readonly core: TerminalCore) {
    this.subscriptions = [core.command.event(marker => this.mark(marker)), core.activity.event(event => {
      if (event.type === "reset") { this.records = []; this.current = undefined; this.promptMarker = undefined; this.changed.fire(); }
    })];
  }
  get active(): Readonly<CommandRecord> | undefined { return this.current; }
  list(): CommandRecord[] { return this.records.filter(record => record.status !== "pending").map(record => ({ ...record })); }
  get(id: number): CommandRecord | undefined { const record = this.records.find(record => record.id === id); return record && { ...record }; }
  get atPrompt(): boolean {
    const input = this.marker(this.current?.inputMarker);
    return this.core.type === "normal" && this.current?.status === "pending" && !!input && this.row(input.lineId) !== undefined;
  }
  get inputText(): string { return this.range(this.current?.inputMarker).text; }
  rowFor(id: number): number | undefined {
    const record = this.records.find(record => record.id === id);
    const marker = this.marker(record?.promptMarker ?? record?.inputMarker ?? record?.outputMarker);
    return marker ? this.row(marker.lineId) : undefined;
  }
  output(id: number): { text: string; truncated: boolean; alternateScreen: boolean } {
    const record = this.records.find(record => record.id === id);
    if (!record) throw new RangeError("Unknown command");
    if (record.output !== undefined) return { text: record.output, truncated: record.truncated ?? false, alternateScreen: false };
    return { ...this.range(record.outputMarker, record.endMarker), alternateScreen: this.core.type === "alternate" };
  }
  serialize(): CommandRecord[] { return this.records.map(record => ({ ...record })); }
  restore(value: unknown): void {
    if (!Array.isArray(value) || value.length > 200) throw new TypeError("Invalid command history");
    const encoded = JSON.stringify(value);
    if (encoded.length > 10 * 1024 * 1024) throw new TypeError("Command history is too large");
    const records = JSON.parse(encoded) as CommandRecord[];
    const ids = new Set<number>();
    for (const record of records) {
      if (!record || !Number.isSafeInteger(record.id) || record.id < 1 || typeof record.command !== "string" || record.command.length > 8192 || typeof record.directory !== "string" || record.directory.length > 4096 || !["pending", "running", "completed", "unknown"].includes(record.status) || (record.output !== undefined && (typeof record.output !== "string" || record.output.length > 32768))) throw new TypeError("Invalid command record");
      for (const key of ["promptMarker", "inputMarker", "outputMarker", "endMarker", "startedAt", "endedAt", "durationMs", "exitCode"] as const) {
        if (record[key] !== undefined && (!Number.isSafeInteger(record[key]) || record[key]! < 0)) throw new TypeError("Invalid command metadata");
      }
      if (ids.has(record.id) || (record.exitCode !== undefined && record.exitCode > 255) || (record.truncated !== undefined && typeof record.truncated !== "boolean")) throw new TypeError("Invalid command metadata");
      ids.add(record.id);
    }
    this.records = records;
    this.current = records[records.length - 1]; this.promptMarker = this.current?.promptMarker;
    this.changed.fire();
  }
  dispose(): void { for (const item of this.subscriptions) item.dispose(); this.changed.dispose(); }

  private marker(id?: number): CommandMarker | undefined { return this.core.markers.find(marker => marker.id === id); }
  private row(lineId: number): number | undefined {
    if (this.core.type !== "normal") return;
    for (let row = this.core.length - 1; row >= 0; row--) if (this.core.getLine(row)?.id === lineId) return row;
    return undefined;
  }
  private range(from?: number, to?: number): { text: string; truncated: boolean } {
    if (this.core.type !== "normal" || from === undefined) return { text: "", truncated: true };
    const first = this.marker(from); const last = this.marker(to);
    const firstRow = first && this.row(first.lineId);
    const lastRow = last ? this.row(last.lineId) : this.core.baseY + this.core.cursorY;
    if (lastRow === undefined) return { text: "", truncated: true };
    let text = "";
    let truncated = firstRow === undefined;
    for (let row = firstRow ?? 0; row <= lastRow; row++) {
      const line = this.core.getLine(row)!;
      if (row > (firstRow ?? 0) && !line.isWrapped) text += "\n";
      const end = row === lastRow ? last?.column ?? (this.core.pendingWrap ? this.core.cols : this.core.cursorX) : this.core.cols;
      const start = row === firstRow ? first!.column : 0;
      text += line.translateToString(!this.core.getLine(row + 1)?.isWrapped, start, end);
      if (text.length > 32768) { text = text.slice(0, 32768); truncated = true; break; }
    }
    return { text: text.replace(/\n$/u, ""), truncated };
  }
  private mark(marker: CommandMarker): void {
    if (marker.kind === "prompt") {
      if (this.current?.status === "running") this.current.status = "unknown";
      if (this.current?.status === "pending") {
        const pending = this.range(this.current.inputMarker, marker.id);
        if (pending.text) {
          // Syntax/history errors can return to the prompt without preexec.
          // Keep the evidence, but do not invent an output boundary or exit code.
          this.current.status = "unknown"; this.current.output = pending.text;
          this.current.truncated = true; this.current.endedAt = marker.timestamp;
        }
      }
      this.promptMarker = marker.id;
    } else if (marker.kind === "command") {
      this.current = { id: marker.id, command: "", directory: this.core.directory, status: "pending", promptMarker: this.promptMarker, inputMarker: marker.id };
      this.records.push(this.current);
      if (this.records.length > 200) this.records.shift();
    } else if (marker.kind === "output") {
      if (!this.current || this.current.status !== "pending") {
        this.current = { id: marker.id, command: "", directory: this.core.directory, status: "pending" };
        this.records.push(this.current); if (this.records.length > 200) this.records.shift();
      }
      const command = this.range(this.current.inputMarker, marker.id);
      this.current.command = command.text.slice(0, 8192);
      this.current.outputMarker = marker.id; this.current.startedAt = marker.timestamp;
      this.current.directory = this.core.directory; this.current.status = "running";
    } else if (marker.kind === "finished" && this.current?.status === "running") {
      this.current.endMarker = marker.id; this.current.endedAt = marker.timestamp;
      this.current.exitCode = marker.exitCode;
      this.current.durationMs = Math.max(0, marker.timestamp - this.current.startedAt!);
      this.current.status = marker.exitCode === undefined ? "unknown" : "completed";
      const output = this.range(this.current.outputMarker, marker.id);
      this.current.output = output.text; this.current.truncated = output.truncated;
    }
    this.changed.fire();
  }
}
