// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NativeTerminal } from "../../src/native.js";

let terminals: NativeTerminal[] = [];
const paint = () => vi.advanceTimersByTime(20);
function open(scrollback = 1000) {
  const element = document.createElement("div");
  document.body.append(element);
  const terminal = new NativeTerminal({ cols: 20, rows: 4, scrollback, lineHeight: 1 });
  terminals.push(terminal); terminal.open(element); paint();
  return { terminal, element, viewport: element.querySelector<HTMLDivElement>(".shell-terminal-viewport")! };
}
function output(count: number, prefix = "line") { return Array.from({ length: count }, (_, index) => `${prefix}-${index}\r\n`).join(""); }

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    font: "", measureText: () => ({ width: 8, fontBoundingBoxAscent: 12, fontBoundingBoxDescent: 4 }),
  } as unknown as CanvasRenderingContext2D);
});
afterEach(() => {
  for (const terminal of terminals) terminal.dispose();
  terminals = []; document.body.replaceChildren(); vi.restoreAllMocks(); vi.useRealTimers();
});

describe("native browser renderer", () => {
  it("keeps DOM work bounded to the visible rows", () => {
    const { terminal, element } = open();
    terminal.write(output(10_000)); paint();
    expect(element.querySelectorAll(".shell-terminal-row").length).toBeLessThanOrEqual(terminal.rows + 3);
    expect(terminal.buffer.active.length).toBe(1004);
    expect(element.querySelector(".shell-terminal-rows")!.textContent).toContain("line-9999");
  });

  it("does not mistake an older programmatic scroll event for a user leaving the tail", () => {
    const { terminal, element, viewport } = open();
    terminal.write(output(100)); paint();
    // A new model update arrives before the scroll event from the last paint.
    terminal.write(output(100, "new"));
    viewport.dispatchEvent(new Event("scroll"));
    paint();
    expect(terminal.buffer.active.viewportY).toBe(terminal.buffer.active.baseY);
    expect(element.querySelector(".shell-terminal-rows")!.textContent).toContain("new-99");
  });

  it("holds a user's place while new output arrives", () => {
    const { terminal, viewport } = open();
    terminal.write(output(30)); paint();
    viewport.scrollTop = 32; viewport.dispatchEvent(new Event("scroll")); paint();
    expect(terminal.buffer.active.viewportY).toBe(2);
    terminal.write(output(30, "new")); paint();
    expect(terminal.buffer.active.viewportY).toBe(2);
    terminal.scrollToBottom(); paint();
    expect(terminal.buffer.active.viewportY).toBe(terminal.buffer.active.baseY);
  });

  it("keeps DOM reading order aligned with screen order after scrolling back", () => {
    const { terminal, element } = open();
    terminal.write(output(30)); paint(); terminal.scrollToLine(2); paint();
    const rows = [...element.querySelectorAll<HTMLElement>(".shell-terminal-row")].map((row) => Number(row.dataset.row));
    expect(rows).toEqual([...rows].sort((a, b) => a - b));
  });

  it("bounds overscan during large native scroll jumps", () => {
    const { terminal, element, viewport } = open();
    terminal.resize(80, 24); terminal.write(output(1000)); paint();
    for (const line of [300, 700, 200]) {
      viewport.scrollTop = line * terminal.getCellMetrics().height;
      viewport.dispatchEvent(new Event("scroll")); paint();
      expect(element.querySelectorAll(".shell-terminal-row").length).toBeLessThanOrEqual(terminal.rows + 16);
      expect(element.querySelector(`[data-row="${line}"]`)?.textContent).toContain(`line-${line}`);
    }
  });

  it("keeps the same rendered line and text nodes while older scrollback expires", () => {
    const { terminal, element } = open(20);
    terminal.write(output(30)); paint(); terminal.scrollToLine(8); paint();
    const row = element.querySelector<HTMLElement>('[data-row="8"]')!;
    const run = row.firstElementChild;
    const text = row.textContent;
    terminal.write(output(3, "new")); paint();
    expect(terminal.buffer.active.viewportY).toBe(5);
    expect(element.querySelector('[data-row="5"]')).toBe(row);
    expect(row.firstElementChild).toBe(run);
    expect(row.textContent).toBe(text);
  });

  it("reuses a text run during redraw and clears superseded styling", () => {
    const { terminal, element } = open();
    terminal.write("\x1b[1;3;4mold"); paint();
    const row = element.querySelector('[data-row="0"]')!;
    const run = row.firstElementChild as HTMLElement;
    terminal.write("\r\x1b[0m\x1b[2Knew"); paint();
    expect(row.firstElementChild).toBe(run);
    expect(run.textContent).toContain("new");
    expect(run.style.fontWeight).toBe("");
    expect(run.style.fontStyle).toBe("");
    expect(run.style.textDecorationLine).toBe("");
  });

  it("only intercepts wheel input while a terminal application needs it", () => {
    const { terminal, viewport } = open();
    const sent: string[] = []; terminal.onData(value => sent.push(value));
    const wheel = () => new WheelEvent("wheel", { deltaY: 16, cancelable: true });
    const normal = wheel(); viewport.dispatchEvent(normal); expect(normal.defaultPrevented).toBe(false);
    terminal.write("\x1b[?1049h\x1b[?1h");
    const application = wheel(); viewport.dispatchEvent(application); expect(application.defaultPrevented).toBe(true);
    expect(sent).toEqual(["\x1bOB"]);
    terminal.write("\x1b[?1049l");
    const restored = wheel(); viewport.dispatchEvent(restored); expect(restored.defaultPrevented).toBe(false);
  });

  it("preserves fractional native scrolling while output arrives", () => {
    const { terminal, viewport } = open();
    terminal.write(output(30)); paint();
    viewport.scrollTop = 35; viewport.dispatchEvent(new Event("scroll")); paint();
    expect(terminal.buffer.active.viewportY).toBe(2);
    expect(viewport.scrollTop).toBe(35);
    terminal.write("more\r\n"); paint();
    expect(viewport.scrollTop).toBe(35);
  });

  it("keeps drag selection aligned with an auto-scroll scheduled for the next paint", () => {
    const { terminal, viewport } = open();
    terminal.write(output(40)); paint(); terminal.scrollToLine(10); paint();
    viewport.setPointerCapture = vi.fn();
    vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 160, 64));
    viewport.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "mouse", button: 0, pointerId: 1, clientX: 0, clientY: 0 }));
    viewport.dispatchEvent(new PointerEvent("pointermove", { pointerType: "mouse", buttons: 1, pointerId: 1, clientX: 0, clientY: 80 }));
    viewport.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 1 }));
    expect(terminal.buffer.active.viewportY).toBe(12);
    expect(terminal.getSelection()).toBe(Array.from({ length: 7 }, (_, index) => `line-${index + 10}`).join("\n"));
  });

  it("renders hostile output as text and applies safe link attributes", () => {
    const { terminal, element } = open();
    terminal.write('<img src=x onerror=alert(1)>\r\n\x1b]8;;javascript:alert(1)\x07bad\x1b]8;;https://example.com/\x07good\x1b]8;;\x07'); paint();
    expect(element.querySelectorAll("img, script").length).toBe(0);
    const links = element.querySelectorAll<HTMLAnchorElement>("a");
    expect(links.length).toBe(1);
    expect(links[0].href).toBe("https://example.com/");
    expect(links[0].rel).toBe("noopener noreferrer");
  });

  it("selects across virtualized scrollback, soft wraps, Unicode and blank lines", () => {
    const { terminal } = open();
    terminal.write("\r\nhello\r\n世界\r\n" + output(20)); paint();
    terminal.select(0, 0, 43);
    expect(terminal.getSelection()).toBe("\nhello\n世界");
    terminal.clearSelection(); expect(terminal.hasSelection()).toBe(false);
  });

  it("never sends keyboard, paste or protocol replies when input is disabled", () => {
    const { terminal } = open(); const sent: string[] = [];
    terminal.onData((data) => sent.push(data));
    terminal.options.disableStdin = true;
    terminal.textarea!.dispatchEvent(new KeyboardEvent("keydown", { key: "c", ctrlKey: true, cancelable: true }));
    terminal.paste("danger"); terminal.write("\x1b[6n");
    expect(sent).toEqual([]);
    terminal.options.disableStdin = false;
    terminal.textarea!.dispatchEvent(new KeyboardEvent("keydown", { key: "c", ctrlKey: true, cancelable: true }));
    expect(sent).toEqual(["\x03"]);
  });

  it("emits one IME commit instead of duplicating composition input", () => {
    const { terminal } = open(); const sent: string[] = [];
    terminal.onData((data) => sent.push(data));
    const input = terminal.textarea!;
    input.dispatchEvent(new CompositionEvent("compositionstart"));
    input.value = "日"; input.dispatchEvent(new InputEvent("input", { isComposing: true, data: "日" }));
    input.dispatchEvent(new CompositionEvent("compositionend", { data: "日" }));
    input.value = "日"; input.dispatchEvent(new InputEvent("input", { inputType: "insertFromComposition", data: "日" }));
    expect(sent).toEqual(["日"]);
    paint();
    input.value = "日"; input.dispatchEvent(new InputEvent("input", { data: "日" }));
    expect(sent).toEqual(["日", "日"]);
  });

  it("holds synchronized redraws and recovers if the app never ends one", () => {
    const { terminal, element } = open();
    terminal.write("old"); paint();
    terminal.write("\x1b[?2026h\r\x1b[2Knew"); paint();
    expect(element.querySelector(".shell-terminal-rows")!.textContent).toContain("old");
    vi.advanceTimersByTime(1050);
    expect(element.querySelector(".shell-terminal-rows")!.textContent).toContain("new");
    expect(terminal.modes.synchronizedOutputMode).toBe(false);
  });

  it("disposes scheduled rendering and input listeners", () => {
    const { terminal, element } = open(); const sent: string[] = [];
    terminal.onData((data) => sent.push(data));
    terminal.write(output(30)); terminal.dispose(); paint();
    terminal.textarea!.dispatchEvent(new KeyboardEvent("keydown", { key: "x", cancelable: true }));
    expect(sent).toEqual([]);
    expect(element.childElementCount).toBe(0);
  });
});
