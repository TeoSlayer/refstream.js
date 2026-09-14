import { expect, test } from "@playwright/test";
import type { TerminalSession } from "../../src/session.js";
import type { TerminalApplicationReport, TerminalApplicationCompletion } from "../../src/application.js";

declare global { interface Window { handoffSession: TerminalSession; handoffHost: { report(state: TerminalApplicationReport): void; complete(result: TerminalApplicationCompletion): void; dispose(): void } } }

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
  expect(state).toMatchObject({ input: { state: "unknown", content: "unknown", owner: "local", protected: true }, sent: "my draft" });
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

test("suggested prompt reports survive rendering and cannot override active IME input", async ({ page }) => {
  const initial = await page.evaluate(() => {
    const { terminal } = window.fixture, session = window.handoffSession;
    terminal.write("\x1b[?1049h\u276f \x1b[2;90mTry reviewing the changes\x1b[0m\r\x1b[2C");
    session.reportApplicationState({ status: "ready", composer: "suggestion" }, session.sequence);
    terminal.write("\x1b[2;1HRedraw\x1b[1;3H");
    return session.read().input;
  });
  expect(initial).toMatchObject({ state: "empty", content: "suggestion", protected: false, verifiedBy: "host", screen: { semantics: "display_only", afterCursor: "Try reviewing the changes" } });
  const composing = await page.evaluate(() => {
    const { terminal } = window.fixture, session = window.handoffSession;
    terminal.textarea!.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    let reportError = "", submitError = "";
    try { session.reportApplicationState({ status: "ready", composer: "suggestion" }, session.sequence); }
    catch (error) { reportError = String(error); }
    try { session.ask("Review", "ime", session.sequence, { confirmEmptyInput: true }); }
    catch (error) { submitError = String(error); }
    return { reportError, submitError, input: session.input, sent: window.fixture.input };
  });
  expect(composing.reportError).toContain("composition is still active");
  expect(composing.submitError).toContain("protected");
  expect(composing.input.protected).toBe(true); expect(composing.sent).toEqual([]);
  const recovered = await page.evaluate(() => {
    const { terminal } = window.fixture, session = window.handoffSession;
    const beforeCancel = session.sequence;
    terminal.textarea!.dispatchEvent(new CompositionEvent("compositionend", { data: "", bubbles: true }));
    if (session.sequence === beforeCancel || session.input.composing) throw new Error("Cancelled composition did not notify the session");
    session.reportApplicationState({ status: "ready", composer: "placeholder" }, session.sequence);
    session.ask("Review", "after-ime", session.sequence);
    return window.fixture.input;
  });
  expect(recovered).toEqual(["Review", "\r"]);
});

test("application progress is customizable and answer readiness does not collect a task", async ({ page }) => {
  await page.evaluate(async () => {
    const { attachTerminalTools } = await import("/dist/ui.js");
    const toolbar = document.createElement("div"), overlay = document.createElement("div");
    overlay.style.cssText = "position:relative;width:100%;height:520px";
    document.body.append(toolbar, overlay);
    const { terminal } = window.fixture, session = window.handoffSession;
    const controls = await attachTerminalTools({ terminal, session, toolbar, overlay, ui: { labels: { "agentApplication.working": "Review in progress" } } });
    terminal.write("\x1b[?1049h");
    session.ask("Review", "lifecycle", session.sequence, { confirmEmptyInput: true });
    controls.openExplore("agent");
    session.reportApplicationState({ status: "authentication_required", taskId: "lifecycle" }, session.sequence);
  });
  await expect(page.locator("[data-task-status]")).toHaveText("Authentication required");
  await expect(page.locator("[data-task-note]")).toContainText("Sign in in the terminal");
  await page.evaluate(() => { const session = window.handoffSession; session.reportApplicationState({ status: "working", taskId: "lifecycle" }, session.sequence); });
  await expect(page.locator("[data-task-status]")).toHaveText("Review in progress");
  await page.evaluate(() => { const session = window.handoffSession; session.reportApplicationState({ status: "answer_ready", taskId: "lifecycle", composer: "suggestion" }, session.sequence); });
  await expect(page.locator("[data-task-status]")).toHaveText("Answer ready");
  expect(await page.evaluate(() => window.handoffSession.readTask("lifecycle").task.status)).toBe("waiting");
  await page.evaluate(() => { window.handoffSession.completeTask("lifecycle", "Verified findings."); });
  await expect(page.locator("[data-task-status]")).toHaveText("Answer ready to collect");
  await page.evaluate(() => { window.handoffSession.collectTask("lifecycle"); });
  await expect(page.locator("[data-task-status]")).toHaveText("Answer collected");
});

test("a bound host reports input and completion, including an answer ready before a wait begins", async ({ page }) => {
  await page.evaluate(() => {
    const { terminal, library } = window.fixture, session = window.handoffSession;
    terminal.write("\x1b[?1049h\x1b[?2004h");
    let state: TerminalApplicationReport = { status: "ready", composer: "suggestion" };
    let changed: (() => void) | undefined, completed: ((result: TerminalApplicationCompletion) => void) | undefined;
    const binding = library.attachTerminalApplication(session, {
      getState: () => state,
      onStateChange(listener) { changed = listener; return { dispose() { changed = undefined; } }; },
      onTaskComplete(listener) { completed = listener; return { dispose() { completed = undefined; } }; },
    });
    window.handoffHost = { report(value) { state = value; changed?.(); }, complete(result) { completed?.(result); }, dispose: () => binding.dispose() };
    session.ask("Review", "bound", session.sequence);
    window.handoffHost.report({ status: "working", taskId: "bound" });
  });
  expect(await page.evaluate(() => window.handoffSession.application)).toMatchObject({ status: "working", source: "host" });
  await page.evaluate(() => window.handoffHost.report({ status: "answer_ready", composer: "suggestion", taskId: "bound" }));
  const ready = await page.evaluate(() => {
    const session = window.handoffSession;
    return session.waitTask("bound", session.tasks.get("bound").revision, 50);
  });
  expect(ready).toMatchObject({ next: "inspect", timedOut: false, terminal: { input: { state: "empty", content: "suggestion", verifiedBy: "host" } } });
  await page.evaluate(() => window.handoffHost.complete({ taskId: "bound", answer: "The actual final answer." }));
  const answer = await page.evaluate(() => {
    const session = window.handoffSession;
    window.fixture.terminal.write("\x1b[1;1HBackground redraw");
    return session.collectTask("bound");
  });
  expect(answer).toMatchObject({ next: "done", task: { status: "collected", result: { text: "The actual final answer.", completion: "host" } } });
  await page.evaluate(() => window.handoffHost.dispose());
  expect(await page.evaluate(() => window.handoffSession.application.source)).toBeNull();
});
