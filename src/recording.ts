import { TerminalCore, type TerminalActivity } from "./core.js";
import { validateState, type TerminalState } from "./state.js";
import type { Disposable } from "./types.js";

export type RecordingEvent = { at: number } & ({ type: "write"; data: string | number[] } | { type: "resize"; cols: number; rows: number } | { type: "reset" });
export interface TerminalRecording {
  version: 1; startedAt: number; checkpointAt: number; checkpoint: TerminalState;
  events: RecordingEvent[]; truncated: boolean;
}

/** Bounded output recording with exact checkpoints; it never records input or sends replies. */
export class TerminalRecorder implements Disposable {
  private recording: TerminalRecording;
  private bytes = 0;
  private subscription?: Disposable;
  private limit: number;
  constructor(readonly core: TerminalCore, maxBytes = 2 * 1024 * 1024) {
    this.limit = Math.max(1024, Math.min(8 * 1024 * 1024, Number.isFinite(maxBytes) ? maxBytes : 2 * 1024 * 1024));
    const now = Date.now();
    this.recording = { version: 1, startedAt: now, checkpointAt: now, checkpoint: core.serialize(), events: [], truncated: false };
    this.subscription = core.activity.event(event => this.append(event));
  }
  get start(): number { return this.recording.checkpointAt; }
  get end(): number { return this.recording.events[this.recording.events.length - 1]?.at ?? this.start; }
  get truncated(): boolean { return this.recording.truncated; }
  get eventCount(): number { return this.recording.events.length; }
  export(): TerminalRecording { return JSON.parse(JSON.stringify(this.recording)) as TerminalRecording; }
  seek(at: number): TerminalState { return replayRecording(this.recording, at); }
  dispose(): void { this.subscription?.dispose(); this.subscription = undefined; }
  private append(activity: TerminalActivity): void {
    const at = Math.max(this.end, activity.type === "write" ? activity.timestamp : Date.now());
    const size = activity.type === "write" ? typeof activity.data === "string" ? activity.data.length * 2 : activity.data.byteLength : 32;
    if (activity.type === "restore" || this.bytes + size > this.limit || this.recording.events.length >= 20_000) {
      this.recording.checkpoint = this.core.serialize(); this.recording.checkpointAt = at;
      this.recording.events = []; this.recording.truncated = true; this.bytes = 0;
      return;
    }
    const event: RecordingEvent = activity.type === "write"
      ? { type: "write", at, data: typeof activity.data === "string" ? activity.data : Array.from(activity.data) }
      : { ...activity, at };
    this.recording.events.push(event); this.bytes += size;
  }
}

/** Reconstruct a separate headless model. Live terminal/PTY state is never touched. */
export function replayRecording(value: TerminalRecording, at = Infinity): TerminalState {
  if (!value || value.version !== 1 || !Number.isFinite(value.startedAt) || !Number.isFinite(value.checkpointAt) || !Array.isArray(value.events) || value.events.length > 20_000) throw new TypeError("Invalid terminal recording");
  const checkpoint = validateState(value.checkpoint);
  const core = new TerminalCore(); core.restore(checkpoint);
  let previous = value.checkpointAt;
  let bytes = 0;
  for (const event of value.events) {
    if (!Number.isFinite(event.at) || event.at < previous) throw new TypeError("Invalid recording timestamp");
    previous = event.at;
    if (event.at > at) break;
    if (event.type === "write") {
      if (typeof event.data !== "string" && (!Array.isArray(event.data) || event.data.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255))) throw new TypeError("Invalid recording bytes");
      bytes += event.data.length * (typeof event.data === "string" ? 2 : 1);
      if (bytes > 8 * 1024 * 1024) throw new RangeError("Recording is too large");
      core.write(typeof event.data === "string" ? event.data : Uint8Array.from(event.data), event.at);
    } else if (event.type === "resize") {
      if (!Number.isInteger(event.cols) || event.cols < 1 || event.cols > 500 || !Number.isInteger(event.rows) || event.rows < 1 || event.rows > 300) throw new TypeError("Invalid recording dimensions");
      core.resize(event.cols, event.rows);
    } else if (event.type === "reset") core.reset();
    else throw new TypeError("Unknown recording event");
  }
  return core.serialize();
}
