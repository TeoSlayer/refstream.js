import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeTerminal } from "../../src/native.js";
import { TerminalSession } from "../../src/session.js";
import { connectRemoteAgent, handleTerminalAgentRequest } from "../../src/mcp.js";

const prompt = "\x1b]133;A\x07$ \x1b]133;B\x07";
const sessions: TerminalSession[] = [];
function fixture(application = false) {
  const terminal = new NativeTerminal({ cols: 80, rows: 8 }), session = new TerminalSession(terminal), sent: string[] = [];
  sessions.push(session); terminal.onData(value => sent.push(value));
  terminal.write(application ? "\x1b[?1049h\x1b[?2004hColleague's application\r\n> " : prompt);
  return { terminal, session, sent };
}
afterEach(() => { for (const session of sessions.splice(0)) { session.dispose(); session.terminal.dispose(); } });

describe("persistent agent handoffs", () => {
  it("submits once, waits for explicit shell completion, collects, then reuses the same session", () => {
    const { terminal, session, sent } = fixture();
    const id = session.id, sequence = session.sequence;
    const task = session.ask("pwd", "first", sequence, { kind: "command" });
    expect(task.status).toBe("waiting"); expect(sent).toEqual(["pwd", "\r"]);
    expect(session.ask("pwd", "first", sequence, { kind: "command" }).id).toBe(task.id);
    expect(sent).toHaveLength(2);
    expect(() => session.ask("ls", "first", session.sequence, { kind: "command" })).toThrow("different request");
    expect(() => session.assertCanDisconnect()).toThrow("needs an answer");
    terminal.write("pwd\r\n\x1b]133;C\x07/work\r\n\x1b]133;D;0\x07" + prompt);
    expect(session.readTask("first").task).toMatchObject({ status: "completed", result: { text: "/work", completion: "shell", exitCode: 0 } });
    expect(() => session.assertCanDisconnect()).toThrow("collection");
    expect(session.collectTask("first").task.status).toBe("collected");
    expect(() => session.assertCanDisconnect()).not.toThrow();
    session.ask("ls", "second", session.sequence, { kind: "command" });
    expect(session.id).toBe(id); expect(session.tasks.get("first").result?.text).toBe("/work");
    expect(sent).toEqual(["pwd", "\r", "ls", "\r"]);
  });

  it("does not confuse output, a background-job acknowledgement, or quiet time with an answer", async () => {
    const { terminal, session } = fixture(true);
    session.ask("Review the change", "review", session.sequence, { confirmEmptyInput: true });
    terminal.write("Background task started.\r\n");
    const task = session.tasks.get("review");
    const waited = await session.waitTask(task.id, task.revision, 12);
    expect(waited).toMatchObject({ timedOut: true, next: "wait", task: { status: "waiting", outputObserved: true } });
    expect(waited.task.result?.completion).toBeUndefined();
    const partial = session.collectTask(task.id, { expectedSequence: session.sequence });
    expect(partial.task).toMatchObject({ status: "waiting", result: { truncated: true } });
    expect(partial.task.result?.completion).toBeUndefined();
    expect(() => session.assertCanDisconnect()).toThrow("needs an answer");
    expect(() => session.ask("Next question", "next", session.sequence, { confirmEmptyInput: true })).toThrow("previous answer");
  });

  it("distinguishes trusted application completion from an agent's observed final answer", async () => {
    const { session } = fixture(true);
    session.ask("Review", "host", session.sequence, { confirmEmptyInput: true });
    const waiting = session.waitTask("host", session.tasks.get("host").revision, 1000);
    session.completeTask("host", "The host reported the completed answer.");
    expect((await waiting).task.result?.completion).toBe("host");
    session.collectTask("host");
    session.ask("Follow up", "observed", session.sequence, { confirmEmptyInput: true });
    expect(() => session.collectTask("observed", { expectedSequence: session.sequence, completion: "agent_observed" })).toThrow("actual answer");
    expect(session.collectTask("observed", { expectedSequence: session.sequence, answer: "The colleague found a missing bounds check.", completion: "agent_observed" })).toMatchObject({ next: "done", task: { status: "collected", result: { completion: "agent_observed" } } });
    expect((await handleTerminalAgentRequest(session, { method: "tasks" }, "read"))).toMatchObject({ terminalSessionId: session.id, tasks: [{ id: "host" }, { id: "observed" }] });
    expect(JSON.stringify(session.read().tasks)).not.toContain("missing bounds check");
  });

  it("restores handoffs and identity without restoring grants or replaying submission", () => {
    const { terminal, session, sent } = fixture(true);
    session.ask("Find the cause", "investigation", session.sequence, { confirmEmptyInput: true });
    terminal.write("Investigating…");
    const snapshot = JSON.parse(JSON.stringify(session.snapshot()));
    const second = fixture(true); second.session.restore(snapshot);
    expect(second.session.id).toBe(session.id);
    expect(second.session.tasks.get("investigation").status).toBe("needs_attention");
    expect(second.session.ask("Find the cause", "investigation", 0, { confirmEmptyInput: true }).id).toBe("investigation");
    expect(second.sent).toEqual([]); expect(sent).toHaveLength(2);
    expect(JSON.stringify(snapshot)).not.toMatch(/shell-invite|relayUrl|browserToken|agentToken/u);
    second.session.collectTask("investigation", { expectedSequence: second.session.sequence, answer: "Retained findings", completion: "agent_observed" });
    const completed = second.session.snapshot();
    const changed = vi.fn(); session.tasks.onChange(changed);
    session.restore(completed);
    expect(changed).toHaveBeenLastCalledWith(undefined);
    expect(session.tasks.get("investigation")).toMatchObject({ status: "collected", result: { text: "Retained findings" } });
  });

  it("rejects a corrupt task snapshot before changing the terminal", () => {
    const { session } = fixture();
    session.ask("pwd", "job", session.sequence, { kind: "command" });
    const before = session.snapshot(), invalid = session.snapshot();
    invalid.tasks![0].status = "collected";
    expect(() => session.restore(invalid)).toThrow("completion evidence");
    expect(session.snapshot()).toEqual(before);
    for (const result of [null, "", false, 0]) {
      const malformed = { ...before, tasks: [{ ...before.tasks![0], result }] };
      expect(() => session.restore(malformed as unknown as typeof before)).toThrow("Invalid task result");
      expect(session.snapshot()).toEqual(before);
    }
  });

  it("bounds retained answers and preserves explicit abandonment without interrupting the application", () => {
    const { session, sent } = fixture(true);
    for (let i = 0; i < 35; i++) {
      session.ask("Question", `task-${i}`, session.sequence, { confirmEmptyInput: true });
      expect(() => session.completeTask(`task-${i}`, "x".repeat(32769))).toThrow("Invalid task result");
      session.completeTask(`task-${i}`, `Answer ${i}`); session.collectTask(`task-${i}`);
    }
    expect(session.tasks.list()).toHaveLength(32);
    const countBeforeRetry = sent.length;
    expect(() => session.ask("Question", "task-0", session.sequence, { confirmEmptyInput: true })).toThrow("already been used");
    const restored = fixture(true); restored.session.restore(session.snapshot());
    expect(() => restored.session.ask("Question", "task-0", restored.session.sequence, { confirmEmptyInput: true })).toThrow("already been used");
    expect(sent).toHaveLength(countBeforeRetry); expect(restored.sent).toHaveLength(0);
    session.ask("Next", "cancel", session.sequence, { confirmEmptyInput: true });
    const count = sent.length;
    session.cancelTask("cancel", "User cancelled the handoff");
    expect(sent).toHaveLength(count); expect(() => session.assertCanDisconnect()).not.toThrow();
  });

  it("cancels outstanding task waits when the logical session ends", async () => {
    const { session } = fixture(true);
    const task = session.ask("Wait", "waiting", session.sequence, { confirmEmptyInput: true });
    const waiting = session.waitTask(task.id, task.revision, 1000);
    session.dispose(); await expect(waiting).rejects.toThrow("cancelled");
  });

  it("refuses both reads and writes after connection cancellation or session disposal", async () => {
    const { session, sent } = fixture();
    const abort = new AbortController(); abort.abort();
    for (const request of [{ method: "read" }, { method: "ask", args: { prompt: "pwd", taskId: "revoked", kind: "command", expectedSequence: session.sequence } }]) {
      await expect(handleTerminalAgentRequest(session, request, "control", abort.signal)).rejects.toThrow("access has ended");
    }
    expect(session.tasks.list()).toEqual([]); expect(sent).toEqual([]);
    session.dispose();
    await expect(handleTerminalAgentRequest(session, { method: "read" }, "read")).rejects.toThrow("access has ended");
  });

  it("closes a direct relay connection when the session ends without an invitation controller", () => {
    const { session } = fixture();
    const closed = vi.fn();
    class Socket extends EventTarget {
      readyState = 0; binaryType = "";
      close() { this.readyState = 3; closed(); }
    }
    vi.stubGlobal("WebSocket", Socket);
    const pair = { relayUrl: "https://relay.example", origin: "https://page.example", id: "a".repeat(24), token: "b".repeat(64), key: "c".repeat(64) };
    try {
      const connection = connectRemoteAgent(session, { pairingUrl: "", permission: "read" }, pair);
      session.dispose(); expect(closed).toHaveBeenCalledOnce();
      connection.dispose(); expect(closed).toHaveBeenCalledOnce();
      expect(() => connectRemoteAgent(session, { pairingUrl: "", permission: "read" }, pair)).toThrow("access has ended");
    } finally { vi.unstubAllGlobals(); }
  });
});

describe("draft and concurrency protection", () => {
  it("blocks an unverified application composer unless its empty state was explicitly inspected", () => {
    const { session, sent } = fixture(true);
    expect(session.read().input.state).toBe("unknown");
    expect(() => session.ask("Review", "review", session.sequence)).toThrow("does not report an empty composer");
    expect(sent).toEqual([]); expect(session.tasks.list()).toEqual([]);
    session.ask("Review", "review", session.sequence, { confirmEmptyInput: true });
    expect(sent).toEqual(["\x1b[200~Review\x1b[201~", "\r"]);
  });

  it("blocks a local draft even before the PTY has echoed it and after the agent refreshes state", async () => {
    const { terminal, session, sent } = fixture();
    const before = session.sequence; terminal.paste("someone else's draft");
    expect(session.commands.inputText).toBe("");
    expect(session.read().input).toMatchObject({ state: "occupied", owner: "local" });
    expect(() => session.execute("pwd", "stale", before)).toThrow("state changed");
    expect(() => session.execute("pwd", "fresh", session.sequence)).toThrow("empty");
    for (const args of [{ key: "Enter" }, { key: "m", ctrl: true }, { key: "j", ctrl: true }]) {
      await expect(handleTerminalAgentRequest(session, { method: "send_key", args: { ...args, inputId: `key-${args.key}`, expectedSequence: session.sequence } }, "control")).rejects.toThrow("draft");
    }
    expect(sent).toEqual(["someone else's draft"]);
  });

  it("does not allow an empty-composer assertion to override a detected draft", () => {
    const { terminal, session, sent } = fixture(true);
    terminal.paste("my draft");
    expect(() => session.ask("Question", "draft", session.sequence, { confirmEmptyInput: true })).toThrow("draft");
    expect(sent).toHaveLength(1); expect(session.tasks.list()).toHaveLength(0);
  });

  it("requires a fresh sequence for all remote input and refuses a blind Enter", async () => {
    const { session, sent } = fixture(true);
    for (const request of [{ method: "send_text", args: { text: "x", inputId: "x" } }, { method: "send_key", args: { key: "Enter", inputId: "enter" } }]) {
      await expect(handleTerminalAgentRequest(session, request, "control")).rejects.toThrow("expectedSequence");
    }
    expect(() => session.sendKey({ key: "Enter" }, "enter", session.sequence)).toThrow("No agent-owned draft");
    expect(() => session.sendKey({ key: "m", ctrlKey: true }, "ctrl-m", session.sequence)).toThrow("No agent-owned draft");
    session.sendKey({ key: "ArrowUp" }, "up", session.sequence);
    expect(() => session.sendKey({ key: "Enter" }, "after-up", session.sequence)).toThrow("No agent-owned draft");
    expect(sent).toHaveLength(1);
  });

  it("takes away draft ownership when a colleague types between low-level text and Enter", () => {
    const { terminal, session, sent } = fixture(true);
    session.sendText("agent draft", "text", session.sequence, true);
    terminal.paste(" local edit");
    expect(() => session.sendKey({ key: "Enter" }, "submit", session.sequence)).toThrow("draft");
    expect(sent).toHaveLength(2);
  });

  it("waits for progress after an attention revision has already been observed", async () => {
    const { terminal, session } = fixture(true);
    session.ask("Review", "attention", session.sequence, { confirmEmptyInput: true });
    terminal.paste("someone else's draft");
    const task = session.tasks.get("attention");
    expect(task.status).toBe("needs_attention");
    const waited = await session.waitTask(task.id, task.revision, 10);
    expect(waited.timedOut).toBe(true); expect(waited.next).toBe("inspect");
  });

  it("refuses Enter if host input re-enters while the agent's text is being delivered", () => {
    const { terminal, session, sent } = fixture(true);
    let edited = false;
    terminal.onData(() => { if (!edited) { edited = true; terminal.paste("local edit"); } });
    expect(() => session.ask("Question", "race", session.sequence, { confirmEmptyInput: true })).toThrow("Input changed");
    expect(sent.some(value => value === "\r")).toBe(false);
    expect(session.tasks.get("race").status).toBe("needs_attention");
    session.ask("Question", "race", session.sequence, { confirmEmptyInput: true });
    expect(sent).toHaveLength(2);
  });

  it("supports a host-confirmed empty composer while keeping shell execution separate", () => {
    const { terminal, session } = fixture(true);
    session.confirmInputEmpty(session.read().input.revision);
    expect(session.read().input).toMatchObject({ state: "empty", verifiedBy: "host" });
    expect(() => session.execute("pwd", "not-shell", session.sequence)).toThrow("shell prompt");
    terminal.write("redraw"); expect(session.read().input.state).toBe("unknown");
    session.confirmInputEmpty(session.read().input.revision);
    session.ask("Question", "host-composer", session.sequence);
    expect(session.tasks.get("host-composer").status).toBe("waiting");
  });

  it("does not let terminal protocol replies claim a local or agent draft", () => {
    const { terminal, session } = fixture();
    terminal.write("\x1b[6n");
    expect(session.read().input).toMatchObject({ state: "empty", owner: "none" });
    session.execute("pwd", "after-reply", session.sequence);
  });

  it("enforces read-only grants and rejects forged host completion", async () => {
    const { session, sent } = fixture(true);
    for (const method of ["ask", "collect_task", "cancel_task"]) {
      await expect(handleTerminalAgentRequest(session, { method }, "read")).rejects.toThrow("read access only");
    }
    await expect(handleTerminalAgentRequest(session, { method: "collect_task", args: { taskId: "x", completion: "host" } }, "control")).rejects.toThrow("Only the host");
    expect(sent).toEqual([]);
  });
});
