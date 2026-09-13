import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeTerminal } from "../../src/native.js";
import { getTerminalSession, TerminalSession } from "../../src/session.js";
import { getTerminalAgentAccess } from "../../src/agent-access.js";
import { createTerminalAgentInvitation, type TerminalAgentInvitationOptions } from "../../src/invitation.js";

vi.mock("../../src/invitation.js", () => ({ createTerminalAgentInvitation: vi.fn() }));
const created = vi.mocked(createTerminalAgentInvitation);
const terminals: NativeTerminal[] = [];
afterEach(() => { for (const terminal of terminals.splice(0)) terminal.dispose(); vi.resetAllMocks(); });
function fixture() {
  const terminal = new NativeTerminal(); terminals.push(terminal);
  const session = getTerminalSession(terminal), access = getTerminalAgentAccess(session), dispose = vi.fn();
  let callback: TerminalAgentInvitationOptions["onStatus"];
  created.mockImplementation(async (_session, options) => {
    callback = options.onStatus;
    return { invitation: "test-only", message: "Test invitation", expiresAt: Date.now() + 10000, sessionExpiresAt: Date.now() + 60000, dispose };
  });
  return { terminal, session, access, dispose, status: (status: "connected" | "disconnected") => callback?.(status) };
}

describe("session-owned access", () => {
  it("reuses the invitation, connection and session after a view unsubscribes", async () => {
    const { terminal, session, access, dispose, status } = fixture();
    const subscription = access.onChange(vi.fn());
    const options = { relayUrl: "https://relay.example", permission: "control" as const };
    const invitation = await access.create(options);
    expect(await access.create(options)).toBe(invitation); expect(created).toHaveBeenCalledOnce();
    status("connected"); subscription.dispose();
    expect(dispose).not.toHaveBeenCalled();
    expect(getTerminalSession(terminal)).toBe(session);
    expect(getTerminalAgentAccess(getTerminalSession(terminal))).toBe(access);
    expect(access.state).toMatchObject({ phase: "connected", permission: "control" });
    await expect(access.create(options)).rejects.toThrow("already connected");
  });

  it("allows immediate owner revocation without discarding a pending handoff", async () => {
    const { terminal, session, access, dispose, status } = fixture();
    terminal.write("\x1b[?1049h"); session.ask("Question", "retained", session.sequence, { confirmEmptyInput: true });
    await access.create({ relayUrl: "https://relay.example", permission: "control" }); status("connected");
    expect(() => session.assertCanDisconnect()).toThrow();
    access.revoke("Owner revoked access");
    expect(dispose).toHaveBeenCalledOnce(); expect(access.state.phase).toBe("idle");
    expect(session.tasks.get("retained").status).toBe("waiting");
    expect(session.signal.aborted).toBe(false);
  });

  it("ends the grant when its terminal ends, even without any mounted UI", async () => {
    const { terminal, session, access, dispose, status } = fixture();
    await access.create({ relayUrl: "https://relay.example", permission: "read" }); status("connected");
    terminal.dispose();
    expect(session.signal.aborted).toBe(true); expect(access.state.phase).toBe("idle");
    expect(dispose).toHaveBeenCalledOnce();
    expect(() => new TerminalSession(terminal)).toThrow("ended");
  });

  it("ignores obsolete connection callbacks after a grant is replaced", async () => {
    const { access, status } = fixture();
    const options = { relayUrl: "https://relay.example", permission: "read" as const };
    await access.create(options);
    const firstCallback = created.mock.calls[0][1].onStatus!;
    access.revoke(); await access.create(options); status("connected");
    firstCallback("disconnected", "old connection closed");
    expect(access.state.phase).toBe("connected");
  });
});
