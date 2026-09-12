import { Terminal as CompatibilityTerminal } from "@xterm/xterm";
import { describe, expect, it } from "vitest";
import { TerminalCore } from "../../src/core.js";
import { encodeTerminalKey, encodeTerminalMouse, encodeTerminalPaste } from "../../src/input.js";
import { safeHyperlink } from "../../src/unicode.js";

// Use the shipped compatibility engine as an independent oracle, without a DOM.
// It is a test dependency only: the native engine never imports or calls it.
const encoder = new TextEncoder();
const lines = (core: TerminalCore): string[] => Array.from({ length: core.length }, (_, row) => core.getLine(row)!.translateToString(true));
const snapshot = (core: TerminalCore) => ({ lines: lines(core), x: core.cursorX, y: core.cursorY, base: core.baseY, type: core.type });

async function compatible(stream: string | Uint8Array, cols = 16, rows = 5, scrollback = 20) {
  const term = new CompatibilityTerminal({ cols, rows, scrollback, allowProposedApi: true });
  await new Promise<void>((resolve) => term.write(stream, resolve));
  const buffer = term.buffer.active;
  const value = {
    lines: Array.from({ length: buffer.length }, (_, row) => buffer.getLine(row)!.translateToString(true)),
    x: buffer.cursorX, y: buffer.cursorY, base: buffer.baseY, type: buffer.type,
  };
  term.dispose();
  return value;
}

const CASES: [string, string][] = [
  ["ordinary shell output", "hello\r\nworld\r\n$ "],
  ["progress bar overwrites", "Downloading 10%\r\x1b[2KDone\r\n$ "],
  ["backspace and tabs", "abc\bX\tend\r\nnext"],
  ["delayed autowrap", "1234567890123456Z"],
  ["carriage return cancels delayed wrap", "1234567890123456\rX"],
  ["bounded scrollback", "line\r\n".repeat(40)],
  ["cursor addressing", "hello\x1b[3;4Hhere\x1b[1A\x1b[2D!"],
  ["cursor save and attributes", "abc\x1b7\x1b[3;3Hother\x1b8!"],
  ["erase right", "long text here\r\x1b[5C\x1b[K!"],
  ["erase left", "long text here\r\x1b[5C\x1b[1K!"],
  ["erase below", "one\r\ntwo\r\nthree\x1b[2;2H\x1b[Jx"],
  ["erase above", "one\r\ntwo\r\nthree\x1b[2;2H\x1b[1Jx"],
  ["clear screen", "one\r\ntwo\x1b[2J\x1b[Hclear"],
  ["clear scrollback", "line\r\n".repeat(10) + "\x1b[3J"],
  ["insert characters", "abcdef\r\x1b[2C\x1b[2@XY"],
  ["delete characters", "abcdef\r\x1b[2C\x1b[2P"],
  ["erase characters", "abcdef\r\x1b[2C\x1b[2X"],
  ["insert mode", "abcdef\r\x1b[2C\x1b[4hXY\x1b[4l!"],
  ["insert lines", "one\r\ntwo\r\nthree\x1b[2;1H\x1b[Linserted"],
  ["delete lines", "one\r\ntwo\r\nthree\x1b[2;1H\x1b[M"],
  ["scrolling region", "head\r\none\r\ntwo\r\nthree\r\nfoot\x1b[2;4r\x1b[4;1H\nnew"],
  ["origin mode", "\x1b[2;4r\x1b[?6h\x1b[2;2HX\x1b[?6l"],
  ["reverse index", "head\r\none\x1b[1;1H\x1bMnew"],
  ["alternate screen restore", "shell$ \x1b[?1049h\x1b[2J\x1b[2;3Hvim\x1b[?1049lback"],
  ["alternate screen active", "shell$ \x1b[?1049h\x1b[2J\x1b[2;3Hvim"],
  ["alternate scrolling cannot pollute history", "shell$ \x1b[?1049h" + "line\r\n".repeat(12) + "\x1b[?1049l"],
  ["repeated alternate entry is idempotent", "shell$ \x1b[?1049h\x1b[?1049hfull\x1b[?1049l!"],
  ["wrapping disabled", "\x1b[?7l12345678901234567890\x1b[?7h!"],
  ["DEC line drawing", "\x1b(0lqqqk\r\nx   x\r\nmqqqj\x1b(B"],
  ["CJK and combining text", "cafe\u0301 世界\r\n日本語"],
  ["wide character across right margin", "123456789012345界!"],
  ["erase half of a wide character", "A界B\x1b[1;3H\x1b[X!"],
  ["OSC title never prints", "before\x1b]2;hello title\x07after"],
  ["OSC terminator split semantics", "before\x1b]2;hello title\x1b\\after"],
  ["discard DCS payload", "before\x1bPqimage data\x1b\\after"],
  ["cancel incomplete control", "before\x1b[123\x18after"],
  ["SGR does not move cursor", "\x1b[1;31mred\x1b[0m plain\x1b[38;2;3;4;5m RGB"],
  ["repeat preceding character", "ab\x1b[4b"],
];

describe("native VT compatibility", () => {
  it.each(CASES)("matches the compatibility renderer: %s", async (_name, stream) => {
    const core = new TerminalCore({ cols: 16, rows: 5, scrollback: 20 });
    core.write(encoder.encode(stream));
    expect(snapshot(core)).toEqual(await compatible(stream));
  });

  it.each(CASES)("is independent of every byte boundary: %s", (_name, stream) => {
    const complete = new TerminalCore({ cols: 16, rows: 5, scrollback: 20 });
    const fragmented = new TerminalCore({ cols: 16, rows: 5, scrollback: 20 });
    const bytes = encoder.encode(stream);
    complete.write(bytes);
    for (const byte of bytes) fragmented.write(new Uint8Array([byte]));
    expect(snapshot(fragmented)).toEqual(snapshot(complete));
  });

  it("retains screen and cursor across realistic mixed redraws", async () => {
    const pieces = ["hello", "\r\n", "\x1b[A", "\x1b[3C", "\x1b[2D", "\r", "\b", "\x1b[K", "\x1b[2K", "\x1b[2;2H", "\x1b[1;3H", "\x1b[2P", "\x1b[2@", "\x1b[2X", "\x1b[1m", "\x1b[0m"];
    let seed = 17;
    for (let run = 0; run < 20; run++) {
      let stream = "";
      for (let index = 0; index < 150; index++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        stream += pieces[seed % pieces.length];
      }
      const core = new TerminalCore({ cols: 16, rows: 5, scrollback: 20 });
      core.write(stream);
      expect(snapshot(core), `redraw corpus ${run}`).toEqual(await compatible(stream));
    }
  });
});

describe("native terminal state and safety", () => {
  it("retains truecolor, indexed colors, and independent SGR attributes", () => {
    const core = new TerminalCore();
    core.write("\x1b[1;2;3;4;7;9;38;2;12;34;56;48;5;123mA\x1b[22;23;24;27;29;39;49mB");
    expect(core.getLine(0)!.cells[0].attributes).toMatchObject({
      fg: "#0c2238", bg: 123, bold: true, dim: true, italic: true, underline: 1, inverse: true, strike: true,
    });
    expect(core.getLine(0)!.cells[1].attributes).toMatchObject({ fg: null, bg: null, bold: false, dim: false, italic: false, underline: 0, inverse: false, strike: false });
  });

  it("understands colon-delimited truecolor and underline styles", () => {
    const core = new TerminalCore();
    core.write("\x1b[38:2::255:0:127;48:5:42;4:2mX");
    expect(core.getLine(0)!.cells[0].attributes).toMatchObject({ fg: "#ff007f", bg: 42, underline: 2 });
  });

  it("keeps emoji graphemes intact across independent UTF-8 writes", () => {
    const core = new TerminalCore();
    for (const byte of encoder.encode("👩🏽‍💻🇧🇬é!")) core.write(new Uint8Array([byte]));
    expect(core.getLine(0)!.cells.slice(0, 6).map((cell) => [cell.text, cell.width])).toEqual([
      ["👩🏽‍💻", 2], ["", 0], ["🇧🇬", 2], ["", 0], ["é", 1], ["!", 1],
    ]);
    expect(core.cursorX).toBe(6);
  });

  it("keeps UTF-16 surrogate pairs intact in string writes", () => {
    const core = new TerminalCore();
    core.write("\ud83d"); core.write("\ude80");
    expect(core.getLine(0)!.cells[0].text).toBe("🚀");
    expect(core.cursorX).toBe(2);
  });

  it("does not turn ordinary letters into wide emoji or join them through a ZWJ", () => {
    const core = new TerminalCore();
    core.write("A\u200dB\ufe0f C🏽!");
    expect(core.getLine(0)!.cells.slice(0, 7).map((cell) => [cell.text, cell.width])).toEqual([
      ["A\u200d", 1], ["B\ufe0f", 1], [" ", 1], ["C", 1], ["🏽", 2], ["", 0], ["!", 1],
    ]);
    expect(core.cursorX).toBe(7);
  });

  it("replies to status, cursor, size, attributes and mode queries", () => {
    const core = new TerminalCore({ cols: 80, rows: 24 });
    const replies: string[] = [];
    core.reply.event((value) => replies.push(value));
    core.write("\x1b[3;7H\x1b[5n\x1b[6n\x1b[18t\x1b[c\x1b[?2004h\x1b[?2004$p\x1b[?2026$p\x1b[?999$p");
    expect(replies).toEqual(["\x1b[0n", "\x1b[3;7R", "\x1b[8;24;80t", "\x1b[?1;2c", "\x1b[?2004;1$y", "\x1b[?2026;2$y", "\x1b[?999;0$y"]);
  });

  it("bounds unterminated control strings and discards the entire payload", () => {
    const core = new TerminalCore();
    core.write("safe\x1b]2;" + "x".repeat(200_000));
    core.write("discard this too\x07after");
    expect(lines(core)[0]).toBe("safeafter");
    expect(core.title).toBe("");
    expect(core.unsupported.get("oversized control string")).toBe(1);
  });

  it("bounds huge CSI parameters, combining clusters, diagnostics and scrollback", () => {
    const core = new TerminalCore({ cols: 10, rows: 3, scrollback: 5 });
    core.write("x" + "\u0301".repeat(10_000));
    expect(core.getLine(0)!.cells[0].text.length).toBeLessThanOrEqual(128);
    core.write("\x1b[" + "9".repeat(1000) + "Hsafe");
    core.write("row\r\n".repeat(1000));
    for (let index = 5000; index < 6000; index++) core.write(`\x1b[?${index}h`);
    expect(core.length).toBe(8);
    expect(core.unsupported.size).toBeLessThanOrEqual(32);
    expect(core.cursorX).toBeGreaterThanOrEqual(0);
    expect(core.cursorY).toBeLessThan(core.rows);
  });

  it("ignores clipboard controls and only retains explicit HTTP(S) links", () => {
    const core = new TerminalCore();
    core.write("\x1b]52;c;c2VjcmV0\x07\x1b]8;;javascript:alert(1)\x07X\x1b]8;;https://example.com/docs\x07Y\x1b]8;;\x07Z");
    expect(core.getLine(0)!.cells[0].attributes.link).toBeUndefined();
    expect(core.getLine(0)!.cells[1].attributes.link).toBe("https://example.com/docs");
    expect(core.getLine(0)!.cells[2].attributes.link).toBeUndefined();
    expect(core.unsupported.get("OSC 52 (blocked)")).toBe(1);
    for (const href of ["data:text/html,<h1>x</h1>", "file:///etc/passwd", "https://user:password@example.com", "//example.com", "https://example.com/\nsecret"]) expect(safeHyperlink(href)).toBeUndefined();
  });

  it("tracks explicit command boundaries and bounded exit metadata", () => {
    const core = new TerminalCore();
    core.write("\x1b]133;A\x07$ \x1b]133;B\x07npm test\r\n\x1b]133;C\x07passed\r\n\x1b]133;D;0\x07");
    expect(core.markers.map(({ kind, exitCode }) => ({ kind, exitCode }))).toEqual([
      { kind: "prompt", exitCode: undefined }, { kind: "command", exitCode: undefined },
      { kind: "output", exitCode: undefined }, { kind: "finished", exitCode: 0 },
    ]);
  });

  it("reflows normal scrollback and preserves the prompt when the grid changes", () => {
    const core = new TerminalCore({ cols: 16, rows: 4 });
    core.write("abcdefghijklmnopqrstuv\r\n$ ");
    core.resize(8, 4);
    expect(lines(core)).toEqual(["abcdefgh", "ijklmnop", "qrstuv", "$ "]);
    expect([core.cursorX, core.cursorY]).toEqual([2, 3]);
    core.resize(16, 4);
    expect(lines(core)).toEqual(["abcdefghijklmnop", "qrstuv", "$ ", ""]);
    expect([core.cursorX, core.cursorY]).toEqual([2, 2]);
  });

  it("preserves the underlying shell when resized in the alternate buffer", () => {
    const core = new TerminalCore({ cols: 16, rows: 5 });
    core.write("shell$ \x1b[?1049hfull screen");
    core.resize(10, 4);
    core.write("\x1b[?1049l");
    expect(lines(core)[0]).toBe("shell$ ");
    expect([core.cursorX, core.cursorY]).toEqual([7, 0]);
  });

  it("restores a wrapped shell prompt to its reflowed position after a full-screen resize", () => {
    const core = new TerminalCore({ cols: 16, rows: 5 });
    core.write("a-long-directory$ \x1b[?1049hfull screen");
    core.resize(8, 4);
    core.write("\x1b[?1049lecho");
    expect(lines(core)).toEqual(["a-long-d", "irectory", "$ echo", ""]);
    expect([core.cursorX, core.cursorY]).toEqual([6, 2]);
  });

  it("keeps the saved shell cursor aligned when a shorter viewport moves lines into history", () => {
    const core = new TerminalCore({ cols: 16, rows: 5 });
    core.write("one\r\ntwo\r\nthree\r\nfour\r\n$ \x1b[?1049hfull screen");
    core.resize(16, 3);
    core.write("\x1b[?1049lecho");
    expect(lines(core)).toEqual(["one", "two", "three", "four", "$ echo"]);
    expect([core.cursorX, core.cursorY, core.baseY]).toEqual([6, 2, 2]);
  });

  it("reapplies the retained-cell memory budget after widening a terminal", () => {
    const core = new TerminalCore({ cols: 20, rows: 5, scrollback: 10_000 });
    core.write(Array.from({ length: 5000 }, (_, index) => `line ${index}\r\n`).join(""));
    core.resize(500, 5);
    expect(core.history.capacity).toBe(4000);
    expect(core.history.length * core.cols).toBeLessThanOrEqual(2_000_000);
    expect(lines(core).join("\n")).toContain("line 4999");
    core.resize(20, 5);
    expect(core.history.capacity).toBe(10_000);
  });

  it("reset discards partial decoding, escape state and prior modes", () => {
    const core = new TerminalCore();
    core.write("\x1b[?1049h\x1b[?2004h\x1b]2;partial");
    core.reset(); core.write("fresh");
    expect(lines(core)[0]).toBe("fresh");
    expect(core.type).toBe("normal");
    expect(core.modes.bracketedPasteMode).toBe(false);
  });
});

describe("native input protocols", () => {
  it("encodes cursor, modified keys, function keys and control chords", () => {
    const { modes } = new TerminalCore();
    expect(encodeTerminalKey({ key: "ArrowUp" }, modes)).toBe("\x1b[A");
    modes.applicationCursorKeysMode = true;
    expect(encodeTerminalKey({ key: "ArrowUp" }, modes)).toBe("\x1bOA");
    expect(encodeTerminalKey({ key: "ArrowLeft", ctrlKey: true }, modes)).toBe("\x1b[1;5D");
    expect(encodeTerminalKey({ key: "Tab", shiftKey: true }, modes)).toBe("\x1b[Z");
    expect(encodeTerminalKey({ key: "F5" }, modes)).toBe("\x1b[15~");
    expect(encodeTerminalKey({ key: "c", ctrlKey: true }, modes)).toBe("\x03");
    expect(encodeTerminalKey({ key: "d", ctrlKey: true }, modes)).toBe("\x04");
    expect(encodeTerminalKey({ key: "b", altKey: true }, modes)).toBe("\x1bb");
    expect(encodeTerminalKey({ key: " ", ctrlKey: true }, modes)).toBe("\0");
  });

  it("leaves IME composition and operating-system shortcuts to the browser", () => {
    const { modes } = new TerminalCore();
    expect(encodeTerminalKey({ key: "x", metaKey: true }, modes)).toBeNull();
    expect(encodeTerminalKey({ key: "Process", isComposing: true }, modes)).toBeNull();
    expect(encodeTerminalKey({ key: "@", ctrlKey: true, altKey: true, getModifierState: () => true }, modes)).toBe("@");
  });

  it("frames paste without allowing an embedded terminator to escape it", () => {
    expect(encodeTerminalPaste("one\r\ntwo\n", true)).toBe("\x1b[200~one\rtwo\r\x1b[201~");
    expect(encodeTerminalPaste("\x1b[201~danger", true)).toBe("\x1b[200~[201~danger\x1b[201~");
  });

  it("encodes SGR and binary mouse reports without corrupting high bytes", () => {
    const { modes } = new TerminalCore();
    modes.mouseTrackingMode = "vt200";
    expect(encodeTerminalMouse({ kind: "down", button: 0, x: 120, y: 10 }, modes)).toEqual({ data: "\x1b[M " + String.fromCharCode(152, 42), binary: true });
    modes.sgrMouse = true;
    expect(encodeTerminalMouse({ kind: "up", button: 0, x: 120, y: 10 }, modes)).toEqual({ data: "\x1b[<0;120;10m", binary: false });
    expect(encodeTerminalMouse({ kind: "wheel", button: 1, x: 2, y: 3 }, modes)).toEqual({ data: "\x1b[<65;2;3M", binary: false });
    expect(encodeTerminalMouse({ kind: "move", button: 3, x: 2, y: 3 }, modes)).toBeNull();
  });


});
