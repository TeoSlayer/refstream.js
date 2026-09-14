import { afterEach, describe, expect, it } from "vitest";
import { NativeTerminal } from "../../src/native.js";
import { TerminalSession } from "../../src/session.js";
import { handleTerminalAgentRequest } from "../../src/mcp.js";
import type { TerminalApplicationReport } from "../../src/application.js";

const sessions: TerminalSession[] = [];
function fixture() {
  const terminal = new NativeTerminal({ cols: 80, rows: 8 }), session = new TerminalSession(terminal), sent: string[] = [];
  sessions.push(session); terminal.onData(value => sent.push(value));
  terminal.write("\x1b[?1049h\x1b[?2004h\u276f \x1b[2;90mTry reviewing the changes\x1b[0m\r\x1b[2C");
  return { terminal, session, sent };
}
afterEach(() => { for (const session of sessions.splice(0)) { session.dispose(); session.terminal.dispose(); } });

describe("application state and composer evidence", () => {
  it("keeps visible suggestions distinct from input, without authorizing from color or cursor position", () => {
    const { session, sent } = fixture(), input = session.read().input;
    expect(input).toMatchObject({ state: "unknown", content: "unknown", protected: false, verifiedBy: null,
      screen: { semantics: "display_only", beforeCursor: "\u276f ", afterCursor: "Try reviewing the changes", cursorColumn: 2 } });
    expect(input.screen.styles).toContainEqual({ startColumn: 2, endColumn: 27, foreground: 8, dim: true, concealed: false });
    expect(() => session.ask("Review", "unverified", session.sequence)).toThrow("unknown, not a confirmed draft");
    expect(sent).toEqual([]);
  });

  it.each(["empty", "placeholder", "suggestion"] as const)("lets a host report %s without a clearance prompt, and keeps it through redraws", composer => {
    const { terminal, session, sent } = fixture();
    session.reportApplicationState({ status: "ready", composer }, session.sequence);
    terminal.write("\x1b[2;1HUnrelated redraw\x1b[1;3H");
    expect(session.input).toMatchObject({ state: "empty", content: composer, owner: "none", verifiedBy: "host", protected: false });
    session.ask("Review", composer, session.sequence);
    expect(sent).toEqual(["\x1b[200~Review\x1b[201~", "\r"]);
    expect(session.input.content).toBe("unknown");
    expect(session.application).toMatchObject({ status: "unknown", source: null });
  });

  it("requires a new report after local input, and does not claim a navigation key is a confirmed draft", () => {
    const { terminal, session, sent } = fixture();
    session.reportApplicationState({ status: "ready", composer: "suggestion" }, session.sequence);
    terminal.sendKey({ key: "ArrowUp" });
    expect(session.input).toMatchObject({ state: "unknown", content: "unknown", owner: "local", protected: true, verifiedBy: null });
    expect(() => session.ask("Review", "blocked", session.sequence, { confirmEmptyInput: true })).toThrow("Local input is protected");
    expect(sent).toEqual(["\x1b[A"]);
    session.reportApplicationState({ status: "ready", composer: "suggestion" }, session.sequence);
    session.ask("Review", "resumed", session.sequence);
    expect(sent).toHaveLength(3);
  });

  it("protects a host-reported draft even when it is dim and the cursor is at its start", () => {
    const { session, sent } = fixture();
    session.reportApplicationState({ status: "ready", composer: "draft" }, session.sequence);
    expect(session.input).toMatchObject({ state: "occupied", content: "draft", owner: "local", protected: true, verifiedBy: "host" });
    expect(() => session.confirmInputEmpty(session.input.revision)).toThrow("Input changed");
    expect(() => session.ask("Review", "draft", session.sequence, { confirmEmptyInput: true })).toThrow("Local input is protected");
    expect(sent).toEqual([]);
  });

  it("rejects stale host observations and any attempted text/hook-payload forwarding before changing state", () => {
    const { terminal, session } = fixture();
    const observed = session.sequence;
    terminal.paste("private draft");
    const before = session.read();
    expect(() => session.reportApplicationState({ status: "ready", composer: "suggestion" }, observed)).toThrow("state changed");
    for (const report of [null, { status: "ready", composer: "password" }, { status: "ready", composer: "empty", value: "secret" }, { status: "ready", prompt: "secret" }]) {
      expect(() => session.reportApplicationState(report as TerminalApplicationReport, session.sequence)).toThrow("Invalid application state");
    }
    expect(session.read()).toEqual(before);
  });

  it("never accepts semantic reports through a control or read-only relay grant", async () => {
    const { session } = fixture();
    for (const permission of ["control", "read"] as const) {
      await expect(handleTerminalAgentRequest(session, { method: "report_application_state", args: { status: "ready", composer: "suggestion", expectedSequence: session.sequence } }, permission)).rejects.toThrow("Unsupported");
    }
    expect(session.application.source).toBeNull();
  });

  it("keeps a handoff through authentication, reports working, then retrieves an explicitly completed answer", async () => {
    const { terminal, session, sent } = fixture();
    session.ask("Review", "review", session.sequence, { confirmEmptyInput: true });
    let task = session.tasks.get("review");
    const authWait = session.waitTask(task.id, task.revision, 1000);
    session.reportApplicationState({ status: "authentication_required", taskId: task.id }, session.sequence);
    expect(await authWait).toMatchObject({ next: "authenticate", timedOut: false, terminal: { application: { status: "authentication_required", source: "host" } } });
    expect(() => session.sendText("Question", "during-auth", session.sequence, true)).toThrow("Authentication required");
    // The owner can still use the underlying terminal. Credentials never enter a semantic report.
    terminal.sendKey({ key: "Enter" });
    expect(session.tasks.get(task.id).status).toBe("waiting");
    session.reportApplicationState({ status: "working", taskId: task.id }, session.sequence);
    expect(session.readTask(task.id)).toMatchObject({ next: "wait", terminal: { application: { status: "working" } } });
    expect(() => session.sendText("New question", "during-work", session.sequence, true)).toThrow("working");
    task = session.tasks.get(task.id);
    const readyWait = session.waitTask(task.id, task.revision, 1000);
    session.reportApplicationState({ status: "answer_ready", taskId: task.id, composer: "suggestion" }, session.sequence);
    expect(await readyWait).toMatchObject({ next: "inspect", timedOut: false, task: { status: "waiting" } });
    expect(session.tasks.get(task.id).result).toBeUndefined();
    const partial = session.collectTask(task.id, { expectedSequence: session.sequence });
    expect(partial.task.status).toBe("waiting");
    session.completeTask(task.id, "Actual findings from the host.");
    expect(session.readTask(task.id).next).toBe("collect");
    expect(session.collectTask(task.id).task).toMatchObject({ status: "collected", result: { completion: "host", text: "Actual findings from the host." } });
    expect(sent).toHaveLength(3);
  });

  it("does not associate an unscoped or preceding answer-ready report with a new task", () => {
    const { session } = fixture();
    session.ask("First", "first", session.sequence, { confirmEmptyInput: true });
    session.reportApplicationState({ status: "answer_ready" }, session.sequence);
    expect(session.readTask("first").next).toBe("wait");
    session.completeTask("first", "First answer"); session.collectTask("first");
    session.ask("Second", "second", session.sequence, { confirmEmptyInput: true });
    expect(session.application.status).toBe("unknown");
    expect(session.readTask("second").next).toBe("wait");
    expect(() => session.reportApplicationState({ status: "answer_ready", taskId: "first" }, session.sequence)).toThrow("closed task");
    expect(session.tasks.get("second").result).toBeUndefined();
  });

  it("wakes for composer recovery but not identical reports or harmless redraws", async () => {
    const { terminal, session } = fixture();
    session.ask("Review", "review", session.sequence, { confirmEmptyInput: true });
    session.reportApplicationState({ status: "ready", composer: "draft", taskId: "review" }, session.sequence);
    const waiting = session.waitTask("review", session.tasks.get("review").revision, 1000);
    session.reportApplicationState({ status: "ready", composer: "suggestion", taskId: "review" }, session.sequence);
    expect((await waiting).timedOut).toBe(false);
    const revision = session.tasks.get("review").revision;
    session.reportApplicationState({ status: "ready", composer: "suggestion", taskId: "review" }, session.sequence);
    terminal.write("redraw"); // First output is a separate event; later redraws are not progress.
    const afterOutput = session.tasks.get("review").revision;
    terminal.write("another redraw");
    expect(session.tasks.get("review").revision).toBe(afterOutput);
    expect(afterOutput - revision).toBeLessThanOrEqual(1);
    expect((await session.waitTask("review", afterOutput, 10)).timedOut).toBe(true);
  });

  it("clears live semantic claims on snapshot restore, reset, or application buffer change", () => {
    const { terminal, session } = fixture();
    session.reportApplicationState({ status: "ready", composer: "suggestion" }, session.sequence);
    const snapshot = session.snapshot();
    session.restore(snapshot);
    expect(session.application.status).toBe("unknown"); expect(session.input.verifiedBy).toBeNull();
    session.reportApplicationState({ status: "ready", composer: "suggestion" }, session.sequence);
    terminal.write("\x1b[?1049l");
    expect(session.application.source).toBeNull(); expect(session.input.content).toBe("unknown");
    session.reportApplicationState({ status: "ready", composer: "empty" }, session.sequence);
    terminal.reset();
    expect(session.application.status).toBe("unknown"); expect(session.input.verifiedBy).toBeNull();
  });

  it("revokes an agent's old input ownership when a different application buffer takes over", () => {
    const { terminal, session, sent } = fixture();
    session.sendText("agent draft", "draft", session.sequence, true);
    const revision = session.input.revision;
    terminal.write("\x1b[?1049l");
    expect(session.input).toMatchObject({ state: "unknown", content: "unknown", owner: "unknown" });
    expect(session.input.revision).toBeGreaterThan(revision);
    expect(() => session.sendKey({ key: "Enter" }, "wrong-application", session.sequence)).toThrow("No agent-owned draft");
    expect(sent).toEqual(["\x1b[200~agent draft\x1b[201~"]);
  });

  it.each(["draft", "suggestion"] as const)("does not submit after an intervening host %s report changes input ownership", composer => {
    const { terminal, session, sent } = fixture();
    session.reportApplicationState({ status: "ready", composer: "suggestion" }, session.sequence);
    terminal.onData(data => { if (data.includes("[200~")) session.reportApplicationState({ status: "ready", composer }, session.sequence); });
    expect(() => session.ask("Review", "review", session.sequence)).toThrow("Input changed before submission");
    expect(sent).toEqual(["\x1b[200~Review\x1b[201~"]);
    expect(session.tasks.get("review").status).toBe("needs_attention");
    session.ask("Review", "review", session.sequence);
    expect(sent).toHaveLength(1);
  });

  it("bounds visual evidence, preserves Unicode columns and masks concealed text", () => {
    const { terminal, session } = fixture();
    terminal.resize(600, 8); terminal.write("\x1b[H\x1b[2K\u754c\x1b[8mhidden\x1b[0m" + "x".repeat(560) + "\x1b[1;2H");
    const screen = session.read().input.screen;
    expect(screen.truncated).toBe(true); expect(screen.endColumn - screen.startColumn).toBeLessThanOrEqual(256);
    expect(screen.beforeCursor).toBe("\u754c"); expect(JSON.stringify(screen)).not.toContain("hidden");
    expect(screen.styles.some(style => style.concealed)).toBe(true);
  });
});
