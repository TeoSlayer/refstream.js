import { expect, test } from "vitest";
import { detectTerminalLinks, fileReference, TerminalLinkCache } from "../../src/links.js";
import { TerminalCore } from "../../src/core.js";

test("detects URLs, file locations, Unicode and quoted paths without resolving anything", () => {
  const input = 'See https://example.com/a_(b). Then src/app.ts:42:7 and "src/my file.ts" plus C:\\work\\test.py:12.';
  const links = detectTerminalLinks(input, true);
  expect(links.map(link => link.kind)).toEqual(["url", "file", "file", "file"]);
  expect(links[0]).toMatchObject({ url: "https://example.com/a_(b)" });
  expect(links[1]).toMatchObject({ path: "src/app.ts", line: 42, column: 7 });
  expect(links[2]).toMatchObject({ path: "src/my file.ts" });
  expect(links[3]).toMatchObject({ path: "C:\\work\\test.py", line: 12 });
  for (const link of links) expect(input.slice(link.start, link.end)).toBe(link.text);
  expect(fileReference("lib/日本語.ts(12,4)")).toEqual({ path: "lib/日本語.ts", line: 12, column: 4 });
  expect(fileReference("file:///workspace/src/a.ts#L15C3")).toEqual({ path: "/workspace/src/a.ts", line: 15, column: 3 });
  expect(detectTerminalLinks("README.md /work/photo.png", false)).toEqual([]);
  expect(detectTerminalLinks("Ctrl/Cmd key · input/output · 1/2", true)).toEqual([]);
});

test("rejects executable schemes, network file authorities, invisible controls and invalid locations", () => {
  for (const value of ["javascript:alert(1)", "data:text/html,a", "file://server/share/secret", "file:///work/%00secret.txt", "file:///work/a?token=x", "//server/share/a", "\\\\server\\share\\a", "src/a.ts:0", "src/a.ts:2:0", "src/a.ts:99999999999999999999", "src/evil\u202etxt.exe", "https://user:password@example.com/a.txt"]) expect(fileReference(value), value).toBeUndefined();
  expect(detectTerminalLinks("https://user:password@example.com/a.txt")).toEqual([]);
  expect(detectTerminalLinks("a".repeat(8193), true)).toEqual([]);
  expect(detectTerminalLinks(Array.from({ length: 100 }, (_, index) => `src/${index}.ts`).join(" "), true)).toHaveLength(32);
});

test("maps wrapped and ANSI-colored file references to cells, refreshes edited links, and survives eviction", () => {
  const core = new TerminalCore({ cols: 14, rows: 6, scrollback: 8 }); const cache = new TerminalLinkCache();
  core.write("界 \x1b[32msrc/components/button.ts:42:7\x1b[0m\r\n");
  const ranges = cache.rows(core, 0, core.length, true, true);
  const targets = [...ranges.values()].flatMap(row => row.map(link => link.target));
  expect(targets.length).toBeGreaterThan(1);
  expect(targets[0].file).toMatchObject({ path: "src/components/button.ts", line: 42, column: 7, columnInBuffer: 3 });
  expect(targets.every(target => target === targets[0])).toBe(true);
  core.write("\x1b[H\x1b[2Kplain text\x1b[2;1H\x1b[2K\x1b[3;1H\x1b[2K");
  expect([...cache.rows(core, 0, core.length, true, true).values()].flat()).toEqual([]);
  core.reset(); core.write("\x1b]8;;https://example.com\x07src/hidden.ts\x1b]8;;\x07\r\n\x1b[8msecret.txt\x1b[0m");
  expect([...cache.rows(core, 0, core.length, true, true).values()].flat()).toEqual([]);
});
