import { afterEach, describe, expect, it, vi } from "vitest";
import { attachTerminalApplication, type TerminalApplicationReport, type TerminalApplicationCompletion } from "../../src/application.js";
import { NativeTerminal } from "../../src/native.js";
import { TerminalSession } from "../../src/session.js";
import { Signal } from "../../src/types.js";

const sessions: TerminalSession[] = [];
function fixture() {
  const terminal = new NativeTerminal({ cols: 80, rows: 8 }), session = new TerminalSession(terminal);
  sessions.push(session);
  terminal.write("\x1b[?1049h\x1b[?2004h");
  return { terminal, session };
}
function model() {
  const changes = new Signal<void>(), completions = new Signal<TerminalApplicationCompletion>();
  let state: TerminalApplicationReport = { status: "ready", composer: "placeholder" };
  return { adapter: { getState: () => state, onStateChange: changes.event, onTaskComplete: completions.event },
    report(value: TerminalApplicationReport) { state = value; changes.fire(); }, complete: completions.fire.bind(completions) };
}
afterEach(() => { for (const session of sessions.splice(0)) session.terminal.dispose(); vi.useRealTimers(); });

describe("host application integration", () => {
  it("wires real model changes and final answers through one persistent binding", async () => {
    const { session } = fixture(), host = model();
    const binding = attachTerminalApplication(session, host.adapter);
    expect(session.read()).toMatchObject({ application: { status: "ready", source: "host" }, input: { content: "placeholder", state: "empty" } });
    host.report({ status: "ready", composer: "draft" });
    expect(() => session.ask("Review", "review", session.sequence)).toThrow("protected");
    host.report({ status: "ready", composer: "suggestion" });
    session.ask("Review", "review", session.sequence);
    host.report({ status: "working", taskId: "review" });
    const waiting = session.waitTask("review", session.tasks.get("review").revision, 1000);
    host.complete({ taskId: "review", answer: "Verified findings." });
    expect(await waiting).toMatchObject({ next: "collect", timedOut: false, terminal: { application: { status: "answer_ready", source: "host" } }, task: { result: { completion: "host", text: "Verified findings." } } });
    host.report({ status: "answer_ready", composer: "suggestion", taskId: "review" });
    expect(session.input).toMatchObject({ state: "empty", verifiedBy: "host" });
    session.collectTask("review");
    host.report({ status: "ready", composer: "suggestion" });
    session.ask("Follow up", "followup", session.sequence);
    host.report({ status: "working", taskId: "followup" });
    // A retried final event from the preceding request must not replace this turn.
    host.complete({ taskId: "review", answer: "Verified findings." });
    expect(session.application).toMatchObject({ status: "working", taskId: "followup" });
    binding.dispose();
    expect(session.application.status).toBe("unknown");
    expect(session.input.content).toBe("unknown");
    host.report({ status: "ready", composer: "empty" });
    host.complete({ taskId: "followup", answer: "Stale source" });
    expect(session.application.status).toBe("unknown");
    expect(session.tasks.get("followup").result).toBeUndefined();
  });

  it("accepts a host observation through redraws but rejects any intervening input or context", () => {
    const { terminal, session } = fixture();
    const observation = session.observeApplication();
    terminal.write("\x1b[1;1HBackground redraw"); terminal.resize(90, 10);
    session.reportApplicationState({ status: "ready", composer: "empty" }, observation);
    const beforeInput = session.observeApplication();
    terminal.paste("private local draft");
    expect(() => session.reportApplicationState({ status: "ready", composer: "empty" }, beforeInput)).toThrow("observe the host again");
    expect(session.input.protected).toBe(true);
    const beforeReset = session.observeApplication(); terminal.reset();
    expect(() => session.reportApplicationState({ status: "ready", composer: "empty" }, beforeReset)).toThrow("state changed");
    const beforeRestore = session.observeApplication(); session.restore(session.snapshot());
    expect(() => session.reportApplicationState({ status: "ready", composer: "empty" }, beforeRestore)).toThrow("state changed");
    const beforeBuffer = session.observeApplication(); terminal.write("\x1b[?1049h");
    expect(() => session.reportApplicationState({ status: "ready", composer: "empty" }, beforeBuffer)).toThrow("state changed");
  });

  it("invalidates observations on agent input and on newer lifecycle evidence", () => {
    const { session } = fixture();
    const beforeInput = session.observeApplication();
    session.sendText("agent draft", "draft", session.sequence, true);
    expect(() => session.reportApplicationState({ status: "ready", composer: "empty" }, beforeInput)).toThrow("state changed");
    const beforeReport = session.observeApplication();
    session.reportApplicationState({ status: "authentication_required" }, beforeReport);
    expect(() => session.reportApplicationState({ status: "ready", composer: "empty" }, beforeReport)).toThrow("state changed");
    expect(session.application.status).toBe("authentication_required");
    const other = fixture();
    expect(() => other.session.reportApplicationState({ status: "ready", composer: "empty" }, session.observeApplication())).toThrow("state changed");
  });

  it("does not manufacture progress from duplicate state reports", () => {
    const { session } = fixture(), host = model();
    attachTerminalApplication(session, host.adapter);
    const sequence = session.sequence, observation = session.observeApplication(), revision = session.application.revision;
    host.report({ status: "ready", composer: "placeholder" });
    expect(session.sequence).toBeGreaterThan(sequence);
    expect(session.application.revision).toBe(revision);
    expect(session.observeApplication().revision).toBeGreaterThan(observation.revision);
  });

  it("a newer identical draft report rejects an older in-flight empty observation", () => {
    const { session } = fixture();
    session.reportApplicationState({ status: "ready", composer: "draft" }, session.observeApplication());
    const inFlight = session.observeApplication(), sequence = session.sequence;
    session.reportApplicationState({ status: "ready", composer: "draft" }, session.observeApplication());
    for (const old of [inFlight, sequence]) {
      expect(() => session.reportApplicationState({ status: "ready", composer: "empty" }, old)).toThrow("state changed");
    }
    expect(session.input).toMatchObject({ content: "draft", protected: true });
  });

  it("keeps live host observations separate from a restored logical session identity", () => {
    const { session } = fixture(), restored = fixture();
    restored.session.restore(session.snapshot());
    expect(restored.session.id).toBe(session.id);
    expect(restored.session.observeApplication().contextId).not.toBe(session.observeApplication().contextId);
    const wrongContext = { ...restored.session.observeApplication(), contextId: session.observeApplication().contextId };
    expect(() => restored.session.reportApplicationState({ status: "ready", composer: "empty" }, wrongContext)).toThrow("state changed");
    const observation = JSON.parse(JSON.stringify(restored.session.observeApplication()));
    restored.session.reportApplicationState({ status: "ready", composer: "empty" }, observation);
    expect(restored.session.input.verifiedBy).toBe("host");
  });

  it("invalidates outstanding observations on detachment even when the host was already unknown", () => {
    const { session } = fixture(), host = model();
    const binding = attachTerminalApplication(session, host.adapter);
    host.report({ status: "unknown" });
    const observation = session.observeApplication();
    binding.dispose();
    expect(() => session.reportApplicationState({ status: "ready", composer: "empty" }, observation)).toThrow("state changed");
    expect(session.application.source).toBeNull();
  });

  it("detachment revokes submission of an earlier agent-owned draft", () => {
    const { session } = fixture(), host = model();
    const binding = attachTerminalApplication(session, host.adapter);
    session.sendText("Earlier draft", "draft", session.sequence);
    const revision = session.input.revision;
    binding.dispose();
    expect(session.input.owner).toBe("unknown");
    expect(session.input.revision).toBeGreaterThan(revision);
    expect(() => session.sendKey({ key: "Enter" }, "after-detach", session.sequence)).toThrow("No agent-owned draft");
  });

  it.each(["unknown", "authentication_required", "input_required", "working"] as const)("%s cannot retain an older agent's right to submit", status => {
    const { session } = fixture();
    session.sendText("Earlier draft", "draft", session.sequence, true);
    session.reportApplicationState({ status }, session.observeApplication());
    session.reportApplicationState({ status: "ready" }, session.observeApplication());
    expect(session.input.owner).toBe("unknown");
    expect(() => session.sendKey({ key: "Enter" }, "after-transition", session.sequence)).toThrow("No agent-owned draft");
  });

  it("revokes failed and replaced model subscriptions instead of retaining stale input permission", () => {
    const { session } = fixture(), first = model(), second = model();
    const old = attachTerminalApplication(session, first.adapter);
    attachTerminalApplication(session, second.adapter);
    first.report({ status: "authentication_required" }); old.dispose();
    expect(session.application.status).toBe("ready");
    expect(() => second.report({ status: "ready", composer: "empty", value: "secret" } as TerminalApplicationReport)).toThrow("never composer text");
    expect(session.application.status).toBe("unknown");
    expect(() => session.ask("Question", "blocked", session.sequence)).toThrow("unknown");
    expect(JSON.stringify(session.read())).not.toContain("secret");
    session.dispose();
    expect(() => second.report({ status: "ready", composer: "empty" })).not.toThrow();
    expect(() => attachTerminalApplication(session, second.adapter)).toThrow("ended");
  });

  it("a repeated unknown host state also revokes subsequently typed agent input", () => {
    const { session } = fixture();
    session.reportApplicationState({ status: "unknown" }, session.observeApplication());
    session.sendText("Earlier draft", "draft", session.sequence, true);
    session.reportApplicationState({ status: "unknown" }, session.observeApplication());
    expect(() => session.sendKey({ key: "Enter" }, "submit", session.sequence)).toThrow("No agent-owned draft");
  });

  it("publishes completion and its application state atomically, without overwriting a final result", () => {
    const { session } = fixture();
    session.ask("Review", "review", session.sequence, { confirmEmptyInput: true });
    const observed: unknown[] = [];
    session.tasks.onChange(() => observed.push(session.readTask("review")));
    expect(() => session.completeTask("review", "x".repeat(32769))).toThrow("Invalid task result");
    expect(observed).toEqual([]);
    expect(session.application.status).toBe("unknown");
    session.completeTask("review", "Actual answer");
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ task: { status: "completed" }, terminal: { application: { status: "answer_ready", taskId: "review" } } });
    expect(() => session.completeTask("review", "Different answer")).toThrow("final result");
    session.completeTask("review", "Actual answer");
    expect(observed).toHaveLength(1);
  });

  it("labels a marked shell's ready state without claiming a running TUI has a known composer", () => {
    const { terminal, session } = fixture();
    terminal.reset(); terminal.write("\x1b]133;A\x07$ \x1b]133;B\x07");
    expect(session.application).toMatchObject({ status: "ready", source: "shell" });
    session.restore(session.snapshot());
    expect(session.application).toMatchObject({ status: "unknown", source: null });
    terminal.write("\x1b]133;A\x07$ \x1b]133;B\x07");
    expect(session.application).toMatchObject({ status: "ready", source: "shell" });
    terminal.write("claude\r\n\x1b]133;C\x07\x1b[?1049h");
    expect(session.application).toMatchObject({ status: "unknown", source: null });
    expect(session.input.state).toBe("unknown");
  });
});
