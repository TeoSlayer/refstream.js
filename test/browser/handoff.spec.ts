import { expect, test } from "@playwright/test";
import type { TerminalSession } from "../../src/session.js";

declare global { interface Window { handoffSession: TerminalSession } }

test.beforeEach(async ({ page }) => {
  await page.goto("/test/browser/harness.html");
  await expect(page.locator("#status")).toHaveText("Ready");
  await page.evaluate(async () => {
    await document.fonts.ready;
    const { terminal, library } = window.fixture;
    window.handoffSession = library.getTerminalSession(terminal);
    terminal.reset(); terminal.write("\x1b]133;A\x07$ \x1b]133;B\x07");
  });
});

test("real typing protects an un-echoed local draft from a fresh remote submit", async ({ page }) => {
  await page.getByRole("textbox", { name: "Terminal input" }).focus();
  await page.keyboard.type("my draft");
  const state = await page.evaluate(async () => {
    const session = window.handoffSession;
    let error = "";
    try { await window.fixture.library.handleTerminalAgentRequest(session, { method: "execute", args: { command: "pwd", inputId: "agent", expectedSequence: session.sequence } }, "control"); }
    catch (failure) { error = String(failure); }
    return { input: session.read().input, sent: window.fixture.input.join(""), error };
  });
  expect(state).toMatchObject({ input: { state: "occupied", owner: "local" }, sent: "my draft" });
  expect(state.error).toContain("empty");
});

test("IME composition blocks a handoff before any characters are committed", async ({ page }) => {
  const state = await page.evaluate(() => {
    const { terminal } = window.fixture, session = window.handoffSession;
    terminal.write("\x1b[?1049h");
    terminal.textarea!.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    let error = "";
    try { session.ask("Question", "composition", session.sequence, { confirmEmptyInput: true }); }
    catch (failure) { error = String(failure); }
    return { composing: session.read().input.composing, sent: window.fixture.input, error, tasks: session.tasks.list() };
  });
  expect(state.composing).toBe(true); expect(state.sent).toEqual([]); expect(state.tasks).toEqual([]);
  expect(state.error).toContain("draft");
});

test("UI remount preserves the default session and labels partial output as unconfirmed", async ({ page }) => {
  await page.evaluate(async () => {
    const { attachTerminalTools } = await import("/dist/ui.js");
    const style = document.createElement("link"); style.rel = "stylesheet"; style.href = "/dist/ui.css"; document.head.append(style);
    const toolbar = document.createElement("div"), overlay = document.createElement("div");
    overlay.style.cssText = "position:relative;width:100%;height:520px";
    document.body.append(toolbar, overlay);
    const { terminal } = window.fixture;
    const first = await attachTerminalTools({ terminal, toolbar, overlay });
    terminal.write("\x1b[?1049h");
    first.session!.ask("Review", "review", first.session!.sequence, { confirmEmptyInput: true });
    terminal.write("Background job started");
    first.session!.collectTask("review", { expectedSequence: first.session!.sequence });
    first.dispose();
    const second = await attachTerminalTools({ terminal, toolbar, overlay });
    if (second.session !== window.handoffSession) throw new Error("The UI replaced its logical session");
    second.openExplore("agent");
  });
  await expect(page.locator("[data-task-status]")).toHaveText("Waiting for answer");
  await expect(page.locator("[data-task-result-label]")).toHaveText("Output so far · completion unconfirmed");
  await page.evaluate(() => { window.handoffSession.completeTask("review", "The requested findings."); window.handoffSession.collectTask("review"); });
  await expect(page.locator("[data-task-status]")).toHaveText("Answer collected");
  await page.locator("[data-task-result-label]").click();
  await expect(page.locator("[data-task-result-text]")).toHaveText("The requested findings.");
  expect(await page.evaluate(() => window.handoffSession.signal.aborted)).toBe(false);
});
