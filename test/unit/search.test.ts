import { describe, expect, it } from "vitest";
import { TerminalCore } from "../../src/core.js";
import { findInTerminal, terminalTranscript } from "../../src/search.js";
import type { ReadableBuffer } from "../../src/types.js";

function buffer(output: string, cols = 16, rows = 5) {
  const core = new TerminalCore({ cols, rows }); core.write(output);
  const readable: ReadableBuffer = {
    type: core.type, baseY: core.baseY, viewportY: core.baseY, cursorX: core.cursorX,
    cursorY: core.cursorY, length: core.length, getLine: (row) => core.getLine(row),
  };
  return readable;
}

describe("terminal search and local export", () => {
  it("finds soft-wrapped text and maps it to real terminal cells", () => {
    const found = findInTerminal(buffer("abcdefghijklmnopqrstuv", 8), 8, "ghijk");
    expect(found.map(({ row, column, length }) => ({ row, column, length }))).toEqual([{ row: 0, column: 6, length: 5 }]);
  });
  it("never joins unrelated hard lines", () => {
    expect(findInTerminal(buffer("hello\r\nworld"), 16, "helloworld")).toEqual([]);
  });
  it("counts wide characters and combining marks in cells", () => {
    const found = findInTerminal(buffer("A界é 🚀 B"), 16, "界é 🚀");
    expect(found[0]).toMatchObject({ row: 0, column: 1, length: 6 });
  });
  it("supports case-sensitive literals without treating patterns as regex", () => {
    expect(findInTerminal(buffer("Error error [.*]"), 16, "error")).toHaveLength(2);
    expect(findInTerminal(buffer("Error error [.*]"), 16, "error", true)).toHaveLength(1);
    expect(findInTerminal(buffer("Error error [.*]"), 16, "[.*]")[0].column).toBe(12);
  });
  it("reports overlapping matches and caps a huge result set", () => {
    expect(findInTerminal(buffer("aaaaa"), 16, "aaa")).toHaveLength(3);
    expect(findInTerminal(buffer("a".repeat(20_000)), 16, "a", false, 20)).toHaveLength(20);
    expect(findInTerminal(buffer("hello"), 16, "")).toEqual([]);
  });
  it("does not lose positions when case folding expands a character", () => {
    expect(findInTerminal(buffer("İx"), 16, "x")[0]).toMatchObject({ column: 1, length: 1 });
  });
  it("exports plain text with logical line breaks and no control sequences", () => {
    const text = terminalTranscript(buffer("\x1b[31mabcdefghijklmnopqrstuv\x1b[0m\r\n$ ", 8));
    expect(text).toBe("abcdefghijklmnopqrstuv\n$ \n");
  });
  it("preserves blank output lines but excludes the unused screen", () => {
    expect(terminalTranscript(buffer("\r\nhello\r\n\r\nworld"))).toBe("\nhello\n\nworld\n");
    expect(terminalTranscript(buffer(""))).toBe("");
  });
});
