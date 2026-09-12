import { describe, expect, it, vi } from "vitest";
import { TerminalCore } from "../../src/core.js";
import { NativeTerminal } from "../../src/native.js";
import { TerminalSession } from "../../src/session.js";
import { CommandTracker } from "../../src/commands.js";
import { TerminalRecorder, replayRecording } from "../../src/recording.js";
import { Utf8Decoder } from "../../src/utf8.js";

const encoder = new TextEncoder();
const model = (core: TerminalCore) => ({
  cols: core.cols, rows: core.rows, cursor: [core.cursorX, core.cursorY], mode: { ...core.modes }, type: core.type,
  title: core.title, directory: core.directory,
  lines: Array.from({ length: core.length }, (_, row) => core.getLine(row)!.cells.map(cell => ({ text: cell.text, width: cell.width, attributes: cell.attributes }))),
});
const prompt = "\x1b]133;A\x07$ \x1b]133;B\x07";

describe("lossless terminal state", () => {
  it("resumes every byte boundary across Unicode, OSC, CSI, margins, charsets, saved cursors and alternate screens", () => {
    const stream = encoder.encode('head\r\n' + prompt + 'echo 界👩🏽‍💻\r\n\x1b]133;C\x07\x1b[38;2;12;34;56mcolored\x1b7\x1b[2;5r\x1b[?1h\x1b[?2004h\x1b]8;;https://example.com/\x07link\x1b]8;;\x07\x1b[?1049h\x1b[2J\x1b(0lqqqk\x1b(B世界\x1b[?1049l\x1b8!');
    for (let cut = 0; cut <= stream.length; cut++) {
      const original = new TerminalCore({ cols: 20, rows: 6, scrollback: 30 });
      original.write(stream.slice(0, cut), 1000);
      const restored = new TerminalCore();
      restored.restore(JSON.parse(JSON.stringify(original.serialize())));
      original.write(stream.slice(cut), 2000); restored.write(stream.slice(cut), 2000);
      expect(model(restored), `byte boundary ${cut}`).toEqual(model(original));
    }
  });

  it("matches TextDecoder for malformed UTF-8 and arbitrary chunk boundaries", () => {
    let seed = 7;
    for (let sample = 0; sample < 100; sample++) {
      const bytes = Uint8Array.from({ length: 100 }, () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed >>> 24; });
      const expected = new TextDecoder().decode(bytes, { stream: true });
      for (const chunk of [3, 83, 100]) {
        let decoder = new Utf8Decoder(); let text = "";
        for (let offset = 0; offset < bytes.length; offset += chunk) {
          text += decoder.decode(bytes.slice(offset, offset + chunk));
          const next = new Utf8Decoder(); next.state = JSON.parse(JSON.stringify(decoder.state)); decoder = next;
        }
        expect(text).toBe(expected);
      }
    }
  });

  it("keeps complete UTF-8 fast paths and all incomplete tails equivalent to streaming TextDecoder", () => {
    for (const prefix of ["", "\ufeff", "text\ufeff"]) {
      const bytes = encoder.encode(prefix + "x".repeat(90) + "界👩🏽‍💻");
      for (let cut = 64; cut <= bytes.length; cut++) {
        const decoder = new Utf8Decoder(); const native = new TextDecoder();
        expect(decoder.decode(bytes.slice(0, cut))).toBe(native.decode(bytes.slice(0, cut), { stream: true }));
        expect(decoder.decode(bytes.slice(cut))).toBe(native.decode(bytes.slice(cut), { stream: true }));
      }
    }
  });

  it("preserves a split surrogate pair and rejects invalid states without changing the live model", () => {
    const core = new TerminalCore(); core.write("\ud83d");
    const restored = new TerminalCore(); restored.restore(core.serialize()); restored.write("\ude80");
    expect(restored.getLine(0)!.translateToString(true)).toBe("🚀");
    const before = model(restored);
    const invalid = restored.serialize(); invalid.cols = 100_000;
    expect(() => restored.restore(invalid)).toThrow();
    expect(model(restored)).toEqual(before);
    const outside = restored.serialize(); outside.primary.x = outside.cols;
    expect(() => restored.restore(outside)).toThrow();
    const hostile = restored.serialize(); hostile.styles[0] = { ...hostile.styles[0], link: "javascript:alert(1)" };
    expect(() => restored.restore(hostile)).toThrow();
    const overflow = restored.serialize(); overflow.parser.utf8 = { point: 0x10ffff, needed: 1, seen: 0, lower: 128, upper: 191, bomSeen: true };
    expect(() => restored.restore(overflow)).toThrow();
  });
});

describe("command semantics and replay", () => {
  it("tracks command text, directory, exit status, duration and output through reflow", () => {
    const core = new TerminalCore({ cols: 14, rows: 5 }); const commands = new CommandTracker(core);
    core.write("\x1b]7;file:///work/project\x07" + prompt + "printf hello", 1000);
    core.resize(9, 5);
    core.write("\r\n\x1b]133;C\x07hello\r\n", 1100);
    core.write("\x1b]133;D;0\x07" + prompt, 1350);
    const [command] = commands.list();
    expect(command).toMatchObject({ command: "printf hello", directory: "/work/project", status: "completed", exitCode: 0, durationMs: 250, output: "hello", truncated: false });
    expect(commands.rowFor(command.id)).toBeDefined();
    expect(commands.atPrompt).toBe(true); expect(commands.inputText).toBe("");
    commands.dispose();
  });

  it("reports missing completion and expired output instead of inventing a successful command", () => {
    const core = new TerminalCore({ cols: 10, rows: 3, scrollback: 2 }); const commands = new CommandTracker(core);
    core.write(prompt + "long\r\n\x1b]133;C\x07" + "log\r\n".repeat(20) + "\x1b]133;D\x07" + prompt);
    expect(commands.list()[0]).toMatchObject({ status: "unknown", truncated: true });
    expect(commands.list()[0].exitCode).toBeUndefined(); commands.dispose();
  });

  it("replays exact state at intermediate times and rotates to a valid checkpoint at its memory limit", () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    try {
      const core = new TerminalCore({ cols: 20, rows: 5 }); const recorder = new TerminalRecorder(core, 1024);
      vi.setSystemTime(1100); core.write("first\r\n"); const first = model(core);
      vi.setSystemTime(1200); core.write("\x1b[?1049h\x1b[2Jeditor"); core.resize(25, 6);
      const replay = new TerminalCore(); replay.restore(recorder.seek(1100)); expect(model(replay)).toEqual(first);
      replay.restore(recorder.seek(1200)); expect(model(replay)).toEqual(model(core));
      vi.setSystemTime(1300); core.write("x".repeat(2000));
      expect(recorder.truncated).toBe(true); expect(recorder.eventCount).toBe(0);
      replay.restore(replayRecording(JSON.parse(JSON.stringify(recorder.export()))));
      expect(model(replay)).toEqual(model(core)); recorder.dispose();
    } finally { vi.useRealTimers(); }
  });
});

describe("persistent live session API", () => {
  it("reserves a submitted prompt before the PTY echoes input and preserves that reservation in snapshots", () => {
    const terminal = new NativeTerminal(); const session = new TerminalSession(terminal);
    terminal.write(prompt); session.execute("pwd", "delayed_echo", session.sequence);
    expect(session.read()).toMatchObject({ atPrompt: false, executionPending: true });
    expect(() => session.execute("ls", "too_soon", session.sequence)).toThrow("awaiting");
    const clone = new NativeTerminal(); const resumed = new TerminalSession(clone); resumed.restore(session.snapshot());
    expect(resumed.read()).toMatchObject({ atPrompt: false, executionPending: true });
    terminal.write("pwd\r\n\x1b]133;C\x07/work\r\n\x1b]133;D;0\x07" + prompt);
    expect(session.read()).toMatchObject({ atPrompt: true, executionPending: false });
    session.dispose(); terminal.dispose(); resumed.dispose(); clone.dispose();
  });

  it("keeps rejected input as unknown and protects an occupied prompt at the right margin", () => {
    const terminal = new NativeTerminal({ cols: 3, rows: 4 }); const session = new TerminalSession(terminal);
    terminal.write(prompt + "x");
    expect(session.commands.inputText).toBe("x");
    expect(() => session.execute("pwd", "occupied")).toThrow("empty");
    terminal.write("\r\nsyntax error\r\n" + prompt);
    expect(session.commands.list()[0]).toMatchObject({ status: "unknown", truncated: true });
    expect(session.commands.list()[0].exitCode).toBeUndefined();
    expect(session.commands.atPrompt).toBe(true);
    expect(() => session.sendKey({ key: "Unsupported" }, "bad_key")).toThrow("cannot be sent");
    expect(() => session.sendText("", "empty")).toThrow("empty");
    session.dispose(); terminal.dispose();
  });

  it("sends input once, rejects stale state and keeps the same terminal and command identity across calls", async () => {
    const terminal = new NativeTerminal(); const session = new TerminalSession(terminal); const input: string[] = [];
    terminal.onData(data => input.push(data)); terminal.write(prompt);
    const before = session.sequence;
    const receipt = session.execute("pwd", "command_1", before);
    expect(session.execute("pwd", "command_1", before)).toEqual(receipt);
    expect(input).toEqual(["pwd", "\r"]);
    expect(() => session.execute("ls", "command_1")).toThrow("different action");
    expect(() => session.sendText("danger", "command_2", before)).toThrow("state changed");
    const waiting = session.wait(session.sequence, 1000);
    terminal.write("pwd\r\n\x1b]133;C\x07/work\r\n\x1b]133;D;0\x07" + prompt);
    expect((await waiting).timedOut).toBe(false);
    expect(session.commands.get(receipt.commandId!)?.output).toBe("/work");
    const snapshot = session.snapshot(); const second = new NativeTerminal(); const resumed = new TerminalSession(second);
    resumed.restore(snapshot);
    expect(model(second.core)).toEqual(model(terminal.core));
    expect(resumed.commands.list()).toEqual(session.commands.list());
    session.dispose(); resumed.dispose(); terminal.dispose(); second.dispose();
  });

  it("refuses execution inside a TUI or a partially typed prompt and cancels waits on disposal", async () => {
    const terminal = new NativeTerminal(); const session = new TerminalSession(terminal);
    terminal.write(prompt + "already typed"); expect(() => session.execute("pwd", "first")).toThrow("empty");
    terminal.write("\x1b[?1049h"); expect(() => session.execute("pwd", "second")).toThrow("prompt");
    terminal.options.disableStdin = true; expect(() => session.sendKey({ key: "Enter" }, "third")).toThrow("unavailable");
    const pending = session.wait(session.sequence, 1000); session.dispose(); await expect(pending).rejects.toThrow("cancelled");
    terminal.dispose();
  });
});
