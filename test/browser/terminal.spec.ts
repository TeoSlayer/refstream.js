/* eslint-disable no-control-regex -- Tests assert exact terminal protocol bytes. */
import { expect, test, type Page } from "@playwright/test";
import type * as Library from "../../src/index.js";

declare global {
  interface Window {
    fixture: {
      terminal: Library.Terminal; library: typeof Library; input: string[]; binary: string[];
      sizes: Library.TerminalSize[]; copies: string[]; titles: string[]; commands: Library.CommandMarker[];
    };
  }
}

const paintedText = (page: Page) => page.locator(".shell-terminal-rows");
async function write(page: Page, data: string) {
  await page.evaluate(data => window.fixture.terminal.write(data), data);
}

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/test/browser/harness.html");
  await expect(page.getByRole("status")).toHaveText("Ready");
  // Let the initial font-ready fit finish before recording protocol input.
  await page.evaluate(async () => { await document.fonts.ready; });
  expect(errors).toEqual([]);
});

test("renders fragmented UTF-8, wide characters and combining graphemes in aligned cells", async ({ page }) => {
  const value = "A界e\u0301👩🏽‍💻🇯🇵";
  const snapshot = await page.evaluate(value => {
    const { terminal } = window.fixture;
    for (const byte of new TextEncoder().encode(value)) terminal.write(Uint8Array.of(byte));
    const line = terminal.buffer.active.getLine(0)!;
    return { text: line.translateToString(true), cursor: terminal.buffer.active.cursorX,
      cells: [0, 1, 3, 4, 6].map(column => [line.getCell(column)!.getChars(), line.getCell(column)!.getWidth()]) };
  }, value);
  expect(snapshot).toEqual({ text: value, cursor: 8, cells: [["A", 1], ["界", 2], ["é", 1], ["👩🏽‍💻", 2], ["🇯🇵", 2]] });
  await expect(paintedText(page)).toContainText(value);
  const widths = await page.locator(".shell-terminal-row").first().locator(".shell-terminal-run").evaluateAll(nodes => nodes.slice(0, 5).map(node => node.getBoundingClientRect().width));
  expect(widths[1]).toBeCloseTo(widths[0] * 2, 0);
});

test("renders colors, safe links and hostile output without interpreting HTML", async ({ page }) => {
  await write(page, '\x1b[38;2;12;34;56mRGB\x1b[0m\r\n<img src=x onerror=alert(1)>\r\n\x1b]8;;javascript:alert(1)\x07bad\x1b]8;;https://example.com/\x07safe\x1b]8;;\x07\x1b]52;c;c2VjcmV0\x07');
  await expect(paintedText(page)).toContainText("RGB");
  await expect(page.locator(".shell-terminal img, .shell-terminal script")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "safe" })).toHaveAttribute("href", "https://example.com/");
  await expect(page.getByRole("link", { name: "safe" })).toHaveAttribute("rel", "noopener noreferrer");
  await expect(page.locator(".shell-terminal a")).toHaveCount(1);
  await expect(page.locator(".shell-terminal-run").filter({ hasText: /^RGB$/ })).toHaveCSS("color", "rgb(12, 34, 56)");
  expect(await page.evaluate(() => window.fixture.input)).toEqual([]);
});

test("encodes real keyboard, control and application cursor input", async ({ page }) => {
  await page.getByRole("button", { name: "Focus terminal" }).click();
  await page.keyboard.type("abc");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Control+c");
  await page.keyboard.press("ArrowUp");
  await write(page, "\x1b[?1h");
  await page.keyboard.press("ArrowUp");
  expect(await page.evaluate(() => window.fixture.input)).toEqual(["a", "b", "c", "\r", "\x03", "\x1b[A", "\x1bOA"]);
});

test("handles IME commits and mobile beforeinput without duplicate characters", async ({ page }) => {
  const input = await page.evaluate(() => {
    const { terminal } = window.fixture;
    const input = terminal.textarea!;
    input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    input.value = "日本";
    input.dispatchEvent(new InputEvent("input", { isComposing: true, data: "日本", bubbles: true }));
    input.dispatchEvent(new CompositionEvent("compositionend", { data: "日本", bubbles: true }));
    input.value = "日本";
    input.dispatchEvent(new InputEvent("input", { inputType: "insertFromComposition", data: "日本", bubbles: true }));
    input.dispatchEvent(new InputEvent("beforeinput", { inputType: "deleteContentBackward", cancelable: true }));
    input.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertLineBreak", cancelable: true }));
    return window.fixture.input;
  });
  expect(input).toEqual(["日本", "\x7f", "\r"]);
});

test("keeps bracketed paste and read-only mode separate from host replies", async ({ page }) => {
  await write(page, "\x1b[?2004h");
  const input = await page.evaluate(() => {
    const { terminal } = window.fixture;
    const data = new DataTransfer(); data.setData("text/plain", "one\ntwo\x1b[201~");
    // Firefox strips clipboardData from a constructed ClipboardEvent. Supply
    // the fixture's data explicitly; real clipboard events are browser-owned.
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", { value: data });
    terminal.textarea!.dispatchEvent(paste);
    terminal.options.disableStdin = true;
    terminal.paste("ignored"); terminal.write("\x1b[6n");
    terminal.textarea!.dispatchEvent(new KeyboardEvent("keydown", { key: "x", cancelable: true }));
    return { sent: window.fixture.input, readOnly: terminal.textarea!.readOnly };
  });
  expect(input).toEqual({ sent: ["\x1b[200~one\rtwo[201~\x1b[201~"], readOnly: true });
});

test("copies selected retained output through the browser copy event", async ({ page }) => {
  await write(page, "copy 世界\r\n");
  await page.getByRole("button", { name: "Focus terminal" }).click();
  await page.evaluate(() => window.fixture.terminal.select(0, 0, 9));
  await page.keyboard.press("ControlOrMeta+c");
  await expect.poll(() => page.evaluate(() => window.fixture.copies)).toEqual(["copy 世界"]);
  expect(await page.evaluate(() => window.fixture.input)).toEqual([]);
});

test("restores the shell after an alternate-screen application and reports metadata", async ({ page }) => {
  await write(page, "shell$ \x1b]2;build logs\x07\x1b]133;A\x07\x1b]133;B\x07\x1b]133;C\x07\x1b[?1049h\x1b[2J\x1b[Heditor");
  await expect(paintedText(page)).toContainText("editor");
  expect(await page.evaluate(() => window.fixture.terminal.buffer.active.type)).toBe("alternate");
  await write(page, "\x1b[?1049lback\x1b]133;D;0\x07");
  await expect(paintedText(page)).toContainText("shell$ back");
  const state = await page.evaluate(() => ({ type: window.fixture.terminal.buffer.active.type, titles: window.fixture.titles, markers: window.fixture.commands.map(marker => marker.kind) }));
  expect(state).toEqual({ type: "normal", titles: ["build logs"], markers: ["prompt", "command", "output", "finished"] });
});

test("restores a serialized session, selection and split parser state without sending input", async ({ page }) => {
  const state = await page.evaluate(() => {
    const { terminal, library, input } = window.fixture;
    const session = new library.TerminalSession(terminal);
    const prompt = "\x1b]133;A\x07$ \x1b]133;B\x07";
    terminal.write(prompt + "pwd\r\n\x1b]133;C\x07/work\r\n\x1b]133;D;0\x07" + prompt);
    terminal.select(0, 1, 5);
    terminal.write(Uint8Array.of(0xf0, 0x9f));
    const snapshot = JSON.parse(JSON.stringify(session.snapshot()));
    terminal.reset(); session.restore(snapshot);
    const selection = terminal.getSelection();
    terminal.write(Uint8Array.of(0x9a, 0x80));
    const result = { selection, commands: session.commands.list(), input, transcript: library.terminalTranscript(terminal.buffer.active) };
    session.dispose(); return result;
  });
  expect(state.selection).toBe("/work");
  expect(state.commands[0]).toMatchObject({ command: "pwd", status: "completed", exitCode: 0, output: "/work" });
  expect(state.input).toEqual([]);
  expect(state.transcript).toContain("🚀");
  await expect(paintedText(page)).toContainText("🚀");
});

test("fits desktop and mobile content boxes, respects padding and emits distinct resize events", async ({ page }) => {
  const state = await page.evaluate(() => {
    const { terminal, sizes } = window.fixture;
    const host = document.querySelector<HTMLElement>("#terminal")!;
    host.style.padding = "7px 11px";
    sizes.length = 0;
    const fit = terminal.fit(); terminal.fit();
    const rect = terminal.element!.getBoundingClientRect();
    const metrics = terminal.getCellMetrics();
    host.style.display = "none";
    const hidden = terminal.fit();
    host.style.display = "";
    return { fit, hidden, sizes, metrics, width: rect.width, height: rect.height,
      availableWidth: host.clientWidth - 22, availableHeight: host.clientHeight - 14,
      scrollWidth: document.documentElement.scrollWidth, viewport: window.innerWidth };
  });
  expect(state.fit!.cols).toBeGreaterThan(10);
  expect(state.hidden).toBeUndefined();
  expect(state.sizes).toHaveLength(1);
  expect(state.width).toBeLessThanOrEqual(state.availableWidth + 1);
  expect(state.height).toBeLessThanOrEqual(state.availableHeight + 1);
  expect(state.scrollWidth).toBeLessThanOrEqual(state.viewport);
  expect(state.metrics.width).toBeGreaterThan(0);
  expect(state.metrics.height).toBeGreaterThan(0);
});

test("falls back to measured DOM font metrics when canvas omits its bounding box", async ({ page }) => {
  await page.addInitScript(() => {
    for (const name of ["fontBoundingBoxAscent", "fontBoundingBoxDescent"]) {
      Object.defineProperty(TextMetrics.prototype, name, { configurable: true, get: () => undefined });
    }
  });
  await page.reload();
  await expect(page.getByRole("status")).toHaveText("Ready");
  const metrics = await page.evaluate(() => {
    const { terminal } = window.fixture;
    terminal.options.fontSize = 19; terminal.fit();
    return { ...terminal.getCellMetrics(), cols: terminal.cols, host: document.querySelector<HTMLElement>("#terminal")!.clientWidth, width: terminal.element!.getBoundingClientRect().width };
  });
  expect(metrics.height).toBeGreaterThanOrEqual(19);
  expect(metrics.width).toBeLessThanOrEqual(metrics.host + 1);
  expect(metrics.cols).toBeGreaterThan(10);
  await write(page, "fallback works");
  await expect(paintedText(page)).toContainText("fallback works");
});

test("bounds the rendered DOM and preserves a retained line while output continues", async ({ page }) => {
  await write(page, Array.from({ length: 10_000 }, (_, index) => `line-${index}\r\n`).join(""));
  await expect(paintedText(page)).toContainText("line-9999");
  const state = await page.evaluate(() => {
    const { terminal } = window.fixture;
    terminal.scrollToLine(300);
    const before = terminal.buffer.active.getLine(300)!.translateToString(true);
    terminal.write("new\r\n".repeat(20));
    return { before, after: terminal.buffer.active.getLine(terminal.buffer.active.viewportY)!.translateToString(true), rows: terminal.rows, length: terminal.buffer.active.length, viewport: terminal.buffer.active.viewportY };
  });
  expect(state.before).toBe(state.after);
  expect(state.viewport).toBe(280);
  expect(state.length).toBe(1000 + state.rows);
  await expect.poll(() => page.locator(".shell-terminal-row").count()).toBeLessThanOrEqual(state.rows + 4);
  await page.evaluate(() => window.fixture.terminal.scrollToBottom());
  await expect(paintedText(page)).toContainText("new");
});

test("scrolls with browser wheel input and restores it after terminal mouse mode", async ({ page, isMobile }) => {
  test.skip(isMobile, "Desktop wheel input; touch remains browser-owned on mobile");
  await write(page, Array.from({ length: 1500 }, (_, index) => `wheel-${index}\r\n`).join(""));
  await expect(paintedText(page)).toContainText("wheel-1499");
  const viewport = page.locator(".shell-terminal-viewport");
  await viewport.hover();
  await page.mouse.wheel(0, -240);
  await expect.poll(() => page.evaluate(() => window.fixture.terminal.buffer.active.viewportY)).toBeLessThan(1000);
  await page.evaluate(() => window.fixture.terminal.scrollToBottom());
  await expect(paintedText(page)).toContainText("wheel-1499");
  const before = await page.evaluate(() => window.fixture.terminal.buffer.active.viewportY);
  await write(page, "\x1b[?1000h\x1b[?1006h");
  // Wait for the newly enabled terminal mode to reach a frame before scrolling.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.mouse.wheel(0, 80);
  await expect.poll(() => page.evaluate(() => window.fixture.input.join(""))).toMatch(/\x1b\[<65;\d+;\d+M/u);
  expect(await page.evaluate(() => window.fixture.terminal.buffer.active.viewportY)).toBe(before);
  await write(page, "\x1b[?1000l\x1b[?1006l");
  await page.mouse.wheel(0, -240);
  await expect.poll(() => page.evaluate(() => window.fixture.terminal.buffer.active.viewportY)).toBeLessThan(before);
  await expect.poll(() => page.evaluate(() => {
    const { terminal } = window.fixture;
    const top = terminal.buffer.active.viewportY;
    const node = document.querySelector<HTMLElement>(`.shell-terminal-row[data-row="${top}"]`);
    return node?.textContent?.trimEnd() === terminal.buffer.active.getLine(top)?.translateToString(true);
  })).toBe(true);
});

test("searches soft wraps and selects Unicode from the retained model", async ({ page }) => {
  const state = await page.evaluate(() => {
    const { terminal, library } = window.fixture;
    terminal.resize(12, 5);
    terminal.write("0123456789世界needle\r\nlast");
    const [match] = library.findInTerminal(terminal.buffer.active, terminal.cols, "世界needle");
    terminal.select(match.column, match.row, match.length);
    return { match, selection: terminal.getSelection(), transcript: library.terminalTranscript(terminal.buffer.active) };
  });
  expect(state.match).toMatchObject({ row: 0, column: 10, length: 10 });
  expect(state.selection).toBe("世界needle");
  expect(state.transcript).toBe("0123456789世界needle\nlast\n");
});

test("supports mouse reporting without browser text selection", async ({ page }) => {
  await write(page, "\x1b[?1000h\x1b[?1006h");
  await page.locator(".shell-terminal-viewport").click({ position: { x: 15, y: 8 } });
  const input = await page.evaluate(() => window.fixture.input);
  expect(input).toHaveLength(2);
  expect(input[0]).toMatch(/^\x1b\[<0;\d+;\d+M$/u);
  expect(input[1]).toMatch(/^\x1b\[<0;\d+;\d+m$/u);
});

test("mounts in another document and disposes all browser listeners", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const frame = document.createElement("iframe");
    const ready = new Promise<void>(resolve => frame.addEventListener("load", () => resolve(), { once: true }));
    frame.src = "/test/browser/iframe.html"; document.body.append(frame); await ready;
    const { Terminal } = window.fixture.library;
    const terminal = new Terminal({ cols: 20, rows: 5 });
    const sent: string[] = [];
    terminal.onData(data => sent.push(data));
    const host = frame.contentDocument!.querySelector<HTMLElement>("#terminal")!;
    terminal.open(host); terminal.fit(); terminal.write("embedded");
    await new Promise<void>(resolve => frame.contentWindow!.requestAnimationFrame(() => resolve()));
    const text = host.querySelector(".shell-terminal-rows")!.textContent;
    const correctDocument = terminal.element!.ownerDocument === frame.contentDocument;
    const input = terminal.textarea!;
    terminal.dispose();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "x", cancelable: true }));
    return { text, correctDocument, children: host.childElementCount, sent };
  });
  expect(result.text).toContain("embedded");
  expect(result.correctDocument).toBe(true);
  expect(result.children).toBe(0);
  expect(result.sent).toEqual([]);
});

test("ships a standalone classic script", async ({ page }) => {
  await page.goto("/test/browser/global.html");
  await expect(paintedText(page)).toContainText("Classic script: ready 世界");
});

test("opens the terminal input from a mobile tap", async ({ page, isMobile }) => {
  test.skip(!isMobile, "Touch interaction is exercised by the mobile projects");
  await page.locator(".shell-terminal-viewport").tap({ position: { x: 25, y: 25 } });
  await expect(page.getByRole("textbox", { name: "Terminal input" })).toBeFocused();
});
